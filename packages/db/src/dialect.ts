// 跨方言 SQL 支撑层。
//
// 运行时通过 setDialect() 声明当前数据库方言（Worker 上恒为 sqlite，Node
// 入口在连接数据库后设置一次），业务代码用这里的 helper 生成对应方言的
// SQL 片段。所有 helper 必须在函数体内调用（运行时求值），不得在模块
// 顶层缓存结果。
//
// 已探测验证（Phase 0，PG 15 / node:sqlite 实测）：
// - sqlite: json_each / json_extract / json_array_length / json_group_array /
//   randomblob / strftime 原生可用
// - postgres: jsonb_array_elements_text / #>> / jsonb_agg / gen_random_uuid
// - mysql: JSON_TABLE / JSON_EXTRACT / JSON_LENGTH / JSON_ARRAYAGG / UUID

export type Dialect = 'sqlite' | 'postgres' | 'mysql';

let current: Dialect = 'sqlite';

/** 声明当前方言。Worker 路径不需要调用（默认 sqlite）。 */
export function setDialect(value: Dialect): void {
  current = value;
}

export function dialect(): Dialect {
  return current;
}

/** 方言能力开关：MySQL 没有 RETURNING 子句（适配器只兜住 INSERT...RETURNING id） */
export function supportsReturning(): boolean {
  return current !== 'mysql';
}

/**
 * 把 JSON 数组（参数占位符或列表达式）展开成行，等价 sqlite 的
 * `json_each(…)` 表值函数。结果列名统一为 `value`（TEXT）。
 *
 * SQLite 保留原生 TVF 形态（D1 的解析器不接受无别名派生表包裹，
 * 且 TVF 形态与历史语句逐字节一致）；PG/MySQL 没有表值 json_each，
 * 用集合返回函数/JSON_TABLE 的派生表形态，外层可加别名或 LATERAL。
 */
export function jsonArrayEachRows(expr: string): string {
  if (current === 'postgres') {
    // 元素统一 text 形态（与 json_each 的 text value 对齐）；派生表自带别名 je
    // 防 "subquery in FROM must have an alias"；ord 列 0 起（对齐 sqlite 的 key），
    // 按位置取元素的站点用 jsonArrayPairRows。IN 子查询消费数值列的站点用 CAST。
    return `(SELECT (elem)::text AS value, ord - 1 AS ord FROM jsonb_array_elements_text(CAST((${expr}) AS text)::jsonb) WITH ORDINALITY AS je)`;
  }
  if (current === 'mysql') return `(SELECT value AS value, ord AS ord FROM JSON_TABLE(CAST(${expr} AS JSON), '$[*]' COLUMNS (value TEXT PATH '$', ord FOR ORDINALITY)) AS je)`;
  return `json_each(${expr})`;
}

/**
 * 按位置取元素的场景（元素形如 [a, b] 的数组）：把参数展开成行后，
 * 用 1 起下标定位行、再从元素中取第 field 个分量。输出列名 value/ord。
 * 参数占位符只出现一次；比较列 value0/value1 已是 TEXT。
 */
export function jsonArrayPairRows(expr: string, _field0: string, _field1: string): string {
  if (current === 'postgres') {
    return `(SELECT (value)::text::jsonb #>> '{0}' AS value0, (value)::text::jsonb #>> '{1}' AS value1, ord FROM (SELECT (elem)::text AS value, ord - 1 AS ord FROM jsonb_array_elements_text(CAST((${expr}) AS text)::jsonb) WITH ORDINALITY AS je) AS jp)`;
  }
  if (current === 'mysql') {
    return `(SELECT JSON_UNQUOTE(JSON_EXTRACT(elem, '$[0]')) AS value0, JSON_UNQUOTE(JSON_EXTRACT(elem, '$[1]')) AS value1, ord FROM JSON_TABLE(CAST(${expr} AS JSON), '$[*]' COLUMNS (elem JSON PATH '$', ord FOR ORDINALITY)) AS jt)`;
  }
  return `(SELECT json_extract(value, '$[0]') AS value0, json_extract(value, '$[1]') AS value1, key AS ord FROM json_each(${expr}))`;
}

/**
 * IN 子查询用的行源：`IN ${jsonArrayInRows('?')}`。三个分支都输出可独立作
 * FROM 项的形态——sqlite 保持 json_each TVF，PG/MySQL 输出自带别名（je）的
 * 单层派生表，外层不得再包无名派生表（MySQL 报 1248）。
 */
export function jsonArrayInRows(expr: string): string {
  if (current === 'postgres') return `(SELECT (elem)::text AS value FROM jsonb_array_elements_text(CAST((${expr}) AS text)::jsonb) AS je)`;
  if (current === 'mysql') return `(SELECT value FROM JSON_TABLE(CAST(${expr} AS JSON), '$[*]' COLUMNS (value TEXT PATH '$')) AS je)`;
  return `(SELECT value FROM json_each(${expr}))`;
}

/** 取 JSON 数组第 index（0 起）个元素的文本值 */
export function jsonArrayElement(expr: string, index: number): string {
  if (current === 'postgres') return `((${expr})::jsonb #>> '{${index}}')`;
  if (current === 'mysql') return `JSON_UNQUOTE(JSON_EXTRACT(${expr}, '$[${index}]'))`;
  return `json_extract(${expr}, '$[${index}]')`;
}

/** JSON 数组长度 */
export function jsonArrayLength(expr: string): string {
  if (current === 'postgres') return `jsonb_array_length((${expr})::jsonb)`;
  if (current === 'mysql') return `JSON_LENGTH(${expr})`;
  return `json_array_length(${expr})`;
}

/** JSON 数组聚合为一列（返回 TEXT 形态的 JSON 数组字符串） */
export function jsonGroupArrayText(expr: string): string {
  if (current === 'postgres') return `jsonb_agg(${expr})::text`;
  if (current === 'mysql') return `CAST(JSON_ARRAYAGG(${expr}) AS CHAR)`;
  return `json_group_array(${expr})`;
}

/** 大小写不敏感相等比较（对应 sqlite 的 `a = b COLLATE NOCASE`）。
 *  sqlite 保留 COLLATE NOCASE 以命中 NOCASE 唯一索引；
 *  PG 用 lower()；MySQL 默认 *_ai_ci 排序规则本身不区分大小写。 */
export function noCaseEq(left: string, right: string): string {
  if (current === 'postgres') return `lower(${left}) = lower(${right})`;
  if (current === 'mysql') return `${left} = ${right}`;
  return `${left} = ${right} COLLATE NOCASE`;
}

/** 转成文本形态：MySQL 没有 TEXT 转换目标，`CAST(x AS CHAR)` 在 PG 会截断成 char(1)。 */
export function textCast(expr: string): string {
  if (current === 'mysql') return `CAST(${expr} AS CHAR)`;
  return `CAST(${expr} AS TEXT)`;
}

/** 数据库当前时间（epoch 毫秒），用于与存 epoch 毫秒的列做窗口比较。 */
export function nowMs(): string {
  if (current === 'postgres') return '(EXTRACT(EPOCH FROM now()) * 1000)::bigint';
  if (current === 'mysql') return '(UNIX_TIMESTAMP() * 1000)';
  return `(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;
}

/** 转义 LIKE 通配符，让 `%`/`_`/`\` 按字面匹配。 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, ch => '\\' + ch);
}

export interface TextMatchFragment {
  sql: string;
  /** 按 `?` 出现顺序绑定 */
  binds: unknown[];
}

/**
 * 子串匹配谓词（大小写不敏感）。返回值带 `?` 占位符，由调用方按顺序绑定 binds。
 *
 * 传入 fts 时优先走全文索引：sqlite 用 FTS5 trigram 子查询、mysql 用 ngram 布尔模式
 * 子查询；postgres 的 pg_trgm GIN 索引本身服务 `ILIKE '%v%'`，不需要子查询。
 * 少于 3 个字符时三者统一回退 LIKE —— trigram/ngram 都无法服务过短查询
 * （中文用户很自然会输入两个字），这条回退行为被 packages/db 的测试锁住。
 */
export function textContains(options: {
  column: string;
  value: string;
  fts?: { table: string; column: string; key: string };
}): TextMatchFragment {
  const { column, value, fts } = options;
  if (value.length >= 3 && fts) {
    if (current === 'postgres') return { sql: `${column} ILIKE ?`, binds: [`%${likeLiteral(value)}%`] };
    if (current === 'mysql') {
      return {
        // BOOLEAN MODE 用双引号界定短语，值里的双引号必须剔除，否则短语边界会被改写
        sql: `${fts.key} IN (SELECT rowid FROM ${fts.table} WHERE MATCH(${fts.column}) AGAINST(? IN BOOLEAN MODE))`,
        binds: [`"*${value.replaceAll('"', '')}*"`],
      };
    }
    return {
      sql: `${fts.key} IN (SELECT rowid FROM ${fts.table} WHERE ${fts.table} MATCH ?)`,
      binds: [`"${value.replaceAll('"', '""')}"`],
    };
  }
  return substringPredicate(column, value);
}

/**
 * D1 的 `SQLITE_MAX_LIKE_PATTERN_LENGTH` 被压到 50（SQLite 默认 5 万），
 * 模式超过这个长度会直接报 `LIKE or GLOB pattern too complex` —— 长关键词会变成 500。
 * 因此长值改走 instr/strpos：语义同样是"大小写不敏感的子串匹配"，
 * 但不受模式长度限制（也不需要转义通配符）。
 * 短值仍用 LIKE，保留 trigram/ngram 索引与既有语义。
 */
const LIKE_PATTERN_BUDGET = 48;

function substringPredicate(column: string, value: string): TextMatchFragment {
  if (likeLiteral(value).length <= LIKE_PATTERN_BUDGET) {
    return { sql: likePredicate(column), binds: [`%${likeLiteral(value)}%`] };
  }
  if (current === 'postgres') return { sql: `strpos(lower(${column}), lower(?)) > 0`, binds: [value] };
  if (current === 'mysql') return { sql: `INSTR(LOWER(${column}), LOWER(?)) > 0`, binds: [value] };
  // sqlite 的 lower() 只处理 ASCII，与 LIKE 的大小写不敏感范围一致
  return { sql: `instr(lower(${column}), lower(?)) > 0`, binds: [value] };
}

/**
 * LIKE 谓词。sqlite 没有默认转义符，必须显式声明 ESCAPE 才能让 likeLiteral 生效；
 * pg/mysql 的默认转义符就是反斜杠（mysql 里字面反斜杠要写成 `\\`，故省略 ESCAPE 子句）。
 */
function likePredicate(column: string): string {
  if (current === 'postgres') return `${column} ILIKE ?`;
  if (current === 'mysql') return `${column} LIKE ?`;
  return `${column} LIKE ? ESCAPE '\\'`;
}

/** 32 位十六进制随机 id（等价 sqlite 的 lower(hex(randomblob(16)))） */
export function randomId32(): string {
  if (current === 'postgres') return `replace(gen_random_uuid()::text, '-', '')`;
  if (current === 'mysql') return `lower(replace(uuid(), '-', ''))`;
  return `lower(hex(randomblob(16)))`;
}

/** epoch 毫秒整数列 → 'YYYY-MM-DD'（站点日粒度统计） */
export function dayOfMs(expr: string): string {
  if (current === 'postgres') return `to_char(to_timestamp((${expr}) / 1000.0), 'YYYY-MM-DD')`;
  if (current === 'mysql') return `DATE_FORMAT(FROM_UNIXTIME((${expr}) / 1000), '%Y-%m-%d')`;
  return `strftime('%Y-%m-%d', (${expr}) / 1000, 'unixepoch')`;
}

/** 两参数取大（sqlite 的标量 max(a,b)；PG/MySQL 是 GREATEST）——用于 MAX(0, expr) 形态 */
export function scalarMax(a: string, b: string): string {
  if (current === 'sqlite') return `max(${a}, ${b})`;
  return `GREATEST(${a}, ${b})`;
}

/** 多参数取最小（sqlite 标量 min() 与 SQL 标准的 LEAST 之别） */
export function leastOf(...exprs: string[]): string {
  const inner = exprs.join(', ');
  if (current === 'sqlite') return `min(${inner})`;
  return `LEAST(${inner})`;
}

/** 布尔表达式转整数（sqlite 的 kind='skin' 隐式 0/1 在 PG 会报错） */
export function boolToInt(expr: string): string {
  return `(CASE WHEN ${expr} THEN 1 ELSE 0 END)`;
}

/** 判断驱动抛出的错误是否为唯一键冲突（替代 String(e).includes('UNIQUE')） */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; message?: string } | undefined;
  if (!err) return false;
  if (err.code === '23505') return true; // postgres unique_violation
  if (err.errno === 1062 || err.code === 'ER_DUP_ENTRY') return true; // mysql2
  return typeof err.message === 'string' && err.message.includes('UNIQUE');
}

/**
 * 判断驱动抛出的错误是否为锁冲突（死锁 / 锁等待超时）。
 * MySQL 的 REPEATABLE READ 下，两条并发条件插入可能因间隙锁互相等待而死锁，
 * 被回滚的一方重试即可看到对方的结果，属于可安全重试一次的错误。
 */
export function isLockConflict(e: unknown): boolean {
  const err = e as { code?: string; errno?: number } | undefined;
  if (!err) return false;
  if (err.errno === 1213 || err.errno === 1205) return true; // mysql2: 死锁 / 锁等待超时
  return err.code === '40P01'; // postgres deadlock_detected
}
