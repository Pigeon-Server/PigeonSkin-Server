// D1 形状适配器的公共 SQL 重写引擎。
//
// 业务代码里到处是 SQLite 方言的裸 SQL（`env.DB.prepare`），把它们逐条
// 迁到查询构建器需要重写 340+ 站点，风险不可控。适配器层做"机械改写"：
//
// 1. 占位符布局 plan：扫描原始 SQL，把绑定 `?` 与 SQLite 原生函数
//    `changes()` / `last_insert_rowid()` 统一编入槽位序列。bind() 的值
//    依序填入 value 槽，changes/rowid 槽由适配器在执行时注入（batch 内
//    读前一条语句的状态，非 batch 恒 0 —— 与 SQLite 原生语义一致）。
//    注意 ? 只在 SQL 文本层面计数：字符串字面量与 `--` 注释内的 ? 不算。
// 2. `x IS ?`（NULL 安全比较）：PG → IS NOT DISTINCT FROM，MySQL → <=>。
// 3. MySQL：双引号标识符 → 反引号；INSERT OR IGNORE/REPLACE；
//    ON CONFLICT DO NOTHING/DO UPDATE → INSERT IGNORE/ON DUPLICATE KEY；
//    INSERT ... RETURNING id → 去掉 RETURNING（emulateInsertReturning，
//    运行后用 lastInsertId 合成 results）。
// 4. 双引号标识符在 PG 原生支持，无需转换。
//
// 重写只做机械转换。无法机械转换的方言差异（json_each、strftime、
// COLLATE NOCASE 等）由业务代码里的 @pigeon-skin/db dialect helper 处理。

export type TargetDialect = 'sqlite' | 'postgres' | 'mysql';

const IS_PARAM = /(\b[\w."`\])]+)\s+IS\s+(\?)/g;

export type ParamSlot =
  | { kind: 'value' }
  | { kind: 'changes' }
  | { kind: 'rowid' };

export interface RewriteResult {
  sql: string;
  /** 占位符布局，bind() 值依序填入 value 槽 */
  plan: ParamSlot[];
  /** MySQL 无 RETURNING：该语句是 INSERT ... RETURNING id 且已去掉 RETURNING */
  emulateInsertReturning: boolean;
}

export function rewriteSql(sql: string, target: TargetDialect): RewriteResult {
  let out = sql;
  let emulateInsertReturning = false;

  if (target === 'mysql') {
    out = quoteIdentifiersMysql(out);
    // MySQL 保留字：settings/translation_overrides 的 key 列在裸 SQL 里
    // 以 `key` 引用（迁移文件已处理，运行时语句在此统一替换）。
    // 用与字符串/注释感知的统一替换（同哨兵扫描的循环方式），避免
    // ORDER BY key / GROUP BY key 等位置漏改写、字符串字面量误改写。
    out = quoteReservedKeyMysql(out);
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE');
    out = out.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'REPLACE');
    const upsert = out.match(/^(.*?\bINSERT\s+INTO\s+[\w`.]+(?:\s*\([^)]*\))?)\s*([\s\S]*?)\s+ON\s+CONFLICT\s*\([^)]*\)\s+DO\s+UPDATE\s+SET\s+([\s\S]*)$/i);
    if (upsert) {
      const setters = upsert[3]!.replace(/\bexcluded\./gi, 'VALUES(table_col)///').replace(/VALUES\(table_col\)\/\/\/(\w+)/g, 'VALUES($1)');
      out = upsert[1]!.trimEnd() + ' ' + upsert[2]!.trimEnd() + ' ON DUPLICATE KEY UPDATE ' + setters.trim();
    } else {
      out = out.replace(/\s+ON\s+CONFLICT\s*(\s*\([^)]*\))?\s+DO\s+NOTHING/gi, '');
    }
    const returning = out.match(/\bRETURNING\s+([\w*,\s.]+)\s*$/i);
    if (/^\s*INSERT\b/i.test(out) && returning && /^id$/i.test(returning[1]!.trim())) {
      out = out.slice(0, returning.index).trimEnd();
      emulateInsertReturning = true;
    }
  }

  if (target === 'postgres') {
    out = out.replace(IS_PARAM, (_m, col: string) => `${col} IS NOT DISTINCT FROM ?`);
    // INSERT OR IGNORE → ON CONFLICT DO NOTHING
    // 注意 ON CONFLICT 子句必须落在 VALUES/SELECT 之后、语句末尾：
    // 简单形态直接拼接；INSERT ... SELECT 形态 PG 要求放在 SELECT 之后同样成立。
    const wasInsertOrIgnore = /\bINSERT\s+OR\s+IGNORE\b/i.test(out);
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
    // 仅对真实源自 INSERT OR IGNORE 的语句在末尾（不含 RETURNING 前）追加
    // ON CONFLICT DO NOTHING —— PG 要求子句位于语句末尾。
    if (wasInsertOrIgnore) {
      const ret = out.match(/\sRETURNING[\s\S]*$/i);
      if (ret) {
        out = out.slice(0, ret.index).trimEnd() + ' ON CONFLICT DO NOTHING' + ret[0];
      } else {
        out = out.trimEnd() + ' ON CONFLICT DO NOTHING';
      }
    }
  } else if (target === 'mysql') {
    out = out.replace(IS_PARAM, (_m, col: string) => `${col} <=> ?`);
  }

  // 占位符 plan：扫描 ?（跳过字符串/注释）与 changes()/last_insert_rowid()。
  // SQLite 原生支持这两个函数——sqlite 目标不替换，plan 全是 value 槽。
  // PG/MySQL：替换成 ?，plan 里记为 changes/rowid 槽（PG 用上一语句的
  // RETURNING 求值，MySQL 用受影响行数/lastInsertId 求值）。
  const plan: ParamSlot[] = [];
  const substituteSentinels = target !== 'sqlite';
  let result = '';
  let i = 0;
  let inString = false;
  while (i < out.length) {
    const ch = out[i]!;
    if (ch === "'") {
      inString = !inString;
      result += ch;
      i++;
      continue;
    }
    if (inString) { result += ch; i++; continue; }
    if (ch === '-' && out[i + 1] === '-') {
      const end = out.indexOf('\n', i);
      const stop = end === -1 ? out.length : end;
      result += out.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '?') {
      plan.push({ kind: 'value' });
      result += '?';
      i++;
      continue;
    }
    const rest = out.slice(i);
    if (substituteSentinels && /^changes\s*\(\s*\)/i.test(rest)) {
      plan.push({ kind: 'changes' });
      result += '?';
      i += rest.match(/^changes\s*\(\s*\)/i)![0].length;
      continue;
    }
    if (substituteSentinels && /^last_insert_rowid\s*\(\s*\)/i.test(rest)) {
      plan.push({ kind: 'rowid' });
      result += '?';
      i += rest.match(/^last_insert_rowid\s*\(\s*\)/i)![0].length;
      continue;
    }
    result += ch;
    i++;
  }

  return { sql: result, plan, emulateInsertReturning };
}

/**
 * MySQL 保留字 key 的标识符引用：字符串字面量与 -- 注释之外的裸 key 词
 * （settings/translation_overrides 等表的 key 列）加反引号。
 * 表名/列名位置全量替换——词边界匹配，业务里没有以 key 命名的别名。
 */
function quoteReservedKeyMysql(sql: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") { inString = !inString; result += ch; i++; continue; }
    if (inString) { result += ch; i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      result += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      // ON DUPLICATE KEY 的 KEY 是语法关键字不能加反引号
      const precededByDuplicate = /ON\s+DUPLICATE\s*$/i.test(result);
      if (m[0].toLowerCase() === 'key' && !precededByDuplicate && !result.endsWith('`') && sql[i - 1] !== '.') {
        result += '`key`';
      } else {
        result += m[0];
      }
      i += m[0].length;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/** MySQL 不认双引号字符串/标识符：字面量外的 "x" → `x` */
function quoteIdentifiersMysql(sql: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") { inString = !inString; result += ch; i++; continue; }
    if (!inString && ch === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end > i) {
        result += '`' + sql.slice(i + 1, end) + '`';
        i = end + 1;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}
