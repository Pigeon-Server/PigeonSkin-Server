// phpMyAdmin / mysqldump SQL dump → 临时 SQLite 只读源。
//
// 解析策略：字节级状态机扫描 dump，只保留目标表的 INSERT 元组；
// 建表列类型按 MySQL 类型名归一化为 SQLite 声明（INTEGER/TEXT/REAL）。
// 不模拟 MySQL 语义 —— 目标只是把元组按列放进 SQLite，供 mapper 读取。
//
// 目标表清单是代码内白名单；其余表（oauth_*、ps_*、uuid、jobs 等）整段跳过。

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSqlite } from './sqlite-builtin.ts';

/** 迁移涉及的全部旧表（与 tools/migrate schema/legacy.ts 的必需+可选表一致；uuid 支撑 yggdrasil 改名保 UUID） */
export const LEGACY_TABLES = [
  'users', 'players', 'textures', 'options',
  'user_closet', 'textures_description', 'reports', 'notifications', 'uuid',
] as const;

type Sqlite = InstanceType<typeof import('node:sqlite').DatabaseSync>;

interface ParsedDump {
  /** 表名 → 建表列名清单（按 CREATE TABLE 顺序） */
  readonly columns: ReadonlyMap<string, readonly string[]>;
  /** 表名 → INSERT 元组的原始 SQL 值片段列表（不含外层括号） */
  readonly rows: ReadonlyMap<string, readonly string[]>;
}

// ── 字节级状态机 ─────────────────────────────────────────────────────────────

interface ScanState {
  /** 当前是否在 '...' 字符串内 */
  inString: boolean;
  /** 当前是否在 `...` 标识符内 */
  inBacktick: boolean;
}

/**
 * 从语句流中扫描出"表名 → INSERT 值区"与"表名 → 列清单"。
 * MySQL 字符串转义语义：字符串内 \' 与 '' 都是字面引号 ——
 * 用"前瞻"判定：字符串内遇 ' 时，下一个字符也是 ' 则消费两字符继续，否则关闭。
 * 不能用 prev 记忆法：'' 空串（进入后立即关闭）会被误判为转义引号。
 */
function parseDump(sql: string): ParsedDump {
  const columns = new Map<string, string[]>();
  const rows = new Map<string, string[]>();

  let i = 0;
  const n = sql.length;
  let stmtStart = 0;
  const st: ScanState = { inString: false, inBacktick: false };
  let currentDelimiter = ';';

  const pushStatement = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    handleStatement(trimmed, columns, rows);
  };

  while (i < n) {
    const ch = sql[i]!;
    if (st.inString) {
      if (ch === '\\') { i += 2; continue; } // \' \\ \n 等转义都吃两字符
      if (ch === "'") {
        if (sql[i + 1] === "'") { i += 2; continue; } // '' 转义引号
        st.inString = false; i++; continue;          // 关闭
      }
      i++; continue;
    }
    if (st.inBacktick) {
      if (ch === '`') st.inBacktick = false;
      i++; continue;
    }
    // 不在字符串/标识符内：检测 DELIMITER 指令
    if (ch === 'D' && sql.slice(i, i + 10).toUpperCase() === 'DELIMITER ') {
      const lineEnd = sql.indexOf('\n', i);
      currentDelimiter = sql.slice(i + 10, lineEnd === -1 ? n : lineEnd).trim();
      pushStatement(sql.slice(stmtStart, i));
      i = lineEnd === -1 ? n : lineEnd + 1;
      stmtStart = i;
      continue;
    }
    if (ch === "'") { st.inString = true; i++; continue; }
    if (ch === '`') { st.inBacktick = true; i++; continue; }
    if (ch === '-' && sql.slice(i, i + 2) === '--') {
      // 行注释：跳到行尾（不切语句）
      const lineEnd = sql.indexOf('\n', i);
      i = lineEnd === -1 ? n : lineEnd;
      continue;
    }
    if (ch === '/' && sql.slice(i, i + 2) === '/*') {
      // 条件注释（/*!40101 ... */）与普通块注释都跳过
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // 语句分隔符判定（当前 delimiter 可能是多字符，如 $$）
    if (currentDelimiter !== ';' && sql.startsWith(currentDelimiter, i)) {
      pushStatement(sql.slice(stmtStart, i));
      i += currentDelimiter.length;
      stmtStart = i;
      continue;
    }
    if (ch === ';' && currentDelimiter === ';') {
      pushStatement(sql.slice(stmtStart, i));
      i++;
      stmtStart = i;
      continue;
    }
    i++;
  }
  pushStatement(sql.slice(stmtStart));

  return { columns, rows };
}

const INSERT_RE = /(^|\n)INSERT\s+(?:IGNORE\s+)?INTO\s+`?([A-Za-z0-9_]+)`?\s*\(([^)]*)\)\s*VALUES\s*([\s\S]+)$/i;
const CREATE_RE = /(^|\n)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?\s*\(([\s\S]+)\)(?:\s*ENGINE[^;]*)?;?$/i;

function handleStatement(
  stmt: string,
  columns: Map<string, string[]>,
  rows: Map<string, string[]>,
): void {
  if (!LEGACY_TABLES.some((t) => stmt.includes(`\`${t}\``) || stmt.includes(` ${t} `))) return;

  const create = CREATE_RE.exec(stmt);
  if (create) {
    const table = create[2]!;
    if (!(LEGACY_TABLES as readonly string[]).includes(table)) return;
    const body = create[3]!;
    const cols: string[] = [];
    // 顶层按逗号切分（引号感知在状态机里已完成，此处 body 内无字符串字面量的括号嵌套需处理）
    for (const line of splitTopLevel(body)) {
      const col = /^\s*`([A-Za-z0-9_]+)`\s+/.exec(line);
      // 只收列定义行，跳过 PRIMARY KEY/CONSTRAINT/KEY/UNIQUE 等表级子句
      if (col && !/^\s*(PRIMARY|UNIQUE|KEY|CONSTRAINT|FULLTEXT|INDEX|SPATIAL)\b/i.test(line)) {
        cols.push(col[1]!);
      }
    }
    columns.set(table, cols);
    return;
  }

  const insert = INSERT_RE.exec(stmt);
  if (insert) {
    const table = insert[2]!;
    if (!(LEGACY_TABLES as readonly string[]).includes(table)) return;
    // 列清单也从 INSERT 里取（有的 dump 没有 CREATE TABLE）
    if (!columns.has(table)) {
      columns.set(table, insert[3]!.split(',').map((c) => c.trim().replaceAll('`', '')));
    }
    // 同表多条 INSERT（大表分块导出）：元组累积合并，不能覆盖
    const tuples = splitTuples(insert[4]!);
    rows.set(table, [...(rows.get(table) ?? []), ...tuples]);
  }
}

/** 括号深度感知的顶层切分（处理 CREATE TABLE body 和多列定义） */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** INSERT VALUES 区：按括号深度切出 (..),(..),.. 元组 */
function splitTuples(valuesText: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  let inString = false;
  while (i < valuesText.length) {
    const ch = valuesText[i]!;
    if (inString) {
      // 与 parseDump 相同的引号语义：\' 转义吃两字符，'' 前瞻判定
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") {
        if (valuesText[i + 1] === "'") { i += 2; continue; }
        inString = false; i++; continue;
      }
      i++; continue;
    }
    if (ch === "'") { inString = true; i++; continue; }
    if (ch === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && start >= 0) {
        tuples.push(valuesText.slice(start + 1, i));
        start = -1;
      }
    }
    i++;
  }
  return tuples;
}

// ── 元组 → SQLite 行 ─────────────────────────────────────────────────────────

/** 把一个元组字符串按顶层逗号切分为值文本（引号语义与 parseDump 相同：前瞻判定 ''） */
function splitValues(tuple: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  let inString = false;
  while (i < tuple.length) {
    const ch = tuple[i]!;
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") {
        if (tuple[i + 1] === "'") { i += 2; continue; }
        inString = false; i++; continue;
      }
      i++; continue;
    }
    if (ch === "'") { inString = true; i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(tuple.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(tuple.slice(start));
  return out;
}

/** 单个 MySQL 值文本 → SQLite 绑定值 */
function convertValue(text: string): string | number | null {
  const t = text.trim();
  if (t.toUpperCase() === 'NULL') return null;
  if (t.startsWith("'") && t.endsWith("'")) {
    // 去外层引号并反转义 MySQL 字符串
    const inner = t.slice(1, -1);
    return inner
      .replace(/\\([0bZ\\nrt'"])/g, (_, e: string) => {
        switch (e) {
          case 'n': return '\n';
          case 'r': return '\r';
          case 't': return '\t';
          case '0': return '\0';
          case 'b': return '\b';
          case 'Z': return '\x1a';
          default: return e; // \' → '、\\ → \、\" → "
        }
      });
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+(e[+-]?\d+)?$/i.test(t)) return Number(t);
  // 非引号非数字（如 CURRENT_TIMESTAMP）按文本保留
  return t;
}

// ── 灌入临时 SQLite ──────────────────────────────────────────────────────────

export interface DumpSourceResult {
  readonly db: Sqlite;
  /** 临时库文件路径（供 SqliteSource 只读打开） */
  readonly dbPath: string;
  readonly close: () => void;
  readonly describe: string;
  /** 各表解析出的行数（供报告） */
  readonly rowCounts: Readonly<Record<string, number>>;
}

/**
 * 解析 dump 并灌入临时 SQLite（只读打开供 SourceAdapter 消费）。
 * 脏数据策略：单行解析失败记警告并跳过，不让整份快照失效。
 */
export function loadDumpIntoSqlite(dumpPath: string, warn: (msg: string) => void): DumpSourceResult {
  const sql = readFileSync(dumpPath, 'utf8');
  const parsed = parseDump(sql);

  const dir = mkdtempSync(join(tmpdir(), 'pigeon-cli-dump-'));
  const dbPath = join(dir, 'dump.sqlite');
  const Sqlite3 = getSqlite().DatabaseSync;
  const db = new Sqlite3(dbPath);

  const rowCounts: Record<string, number> = {};
  for (const table of LEGACY_TABLES) {
    const cols = parsed.columns.get(table);
    const tuples = parsed.rows.get(table) ?? [];
    rowCounts[table] = tuples.length;
    if (!cols || tuples.length === 0) continue;

    // BLOB 亲和：不转换存储类型，number 保持 number、string 保持 string
    const decls = cols.map((c) => `"${c}" BLOB`).join(', ');
    db.exec(`CREATE TABLE "${table}" (${decls})`);
    const insert = db.prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    let failed = 0;
    for (const tuple of tuples) {
      try {
        const values = splitValues(tuple).map(convertValue);
        if (values.length !== cols.length) {
          failed++;
          if (failed <= 3) warn(`${table}: 列数不匹配（期望 ${cols.length}，得到 ${values.length}），行已跳过`);
          continue;
        }
        insert.run(...values);
      } catch (e) {
        failed++;
        if (failed <= 3) warn(`${table}: 行解析失败（${(e as Error).message.slice(0, 80)}）`);
      }
    }
    if (failed > 3) warn(`${table}: 另有 ${failed - 3} 行解析失败已跳过`);
  }

  return {
    db,
    dbPath,
    describe: dumpPath,
    rowCounts,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { parseDump, splitValues, convertValue };
