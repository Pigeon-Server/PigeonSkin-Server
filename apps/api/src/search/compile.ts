// 搜索表达式的 SQL 编译。
//
// 产物是带 `?` 占位符的片段 + 顺序参数：D1 的 `prepare(...).bind(...)` 直接可用，
// Drizzle 查询用 fragmentToSql 嵌进去。之所以不直接产出 Drizzle 的 SQL 对象，
// 是因为后台还有一批原生 SQL 服务（审计日志、工单、投票、Yggdrasil 日志），
// 它们拼的是字符串，共用同一种产物才能只维护一套编译逻辑。
//
// 值一律走占位符，只有列引用、运算符与方言片段进入 SQL 文本 —— 表达式来自 URL，
// 不能出现可注入的拼接。
import { sql, type SQL } from 'drizzle-orm';
import { noCaseEq, textContains } from '@pigeon-skin/db';
import {
  fallbackFields, findField, parseBooleanLiteral, parseDateLiteral, parseNumberLiteral,
} from '@pigeon-skin/shared/search';
import type { SearchField, SearchIssue, SearchNode, SearchSchema } from '@pigeon-skin/shared/search';

/** 带 `?` 占位符的 SQL 片段 + 顺序绑定的参数。 */
export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/**
 * 复杂度预算：表达式来自 URL。语法层已限制长度/词数/节点数，但展开成 SQL 后
 * 谓词数量还会被放大（一个词要匹配多个默认字段，AND/OR 再翻倍），
 * 这里对编译结果再兜一层，避免把 CPU 成本转嫁给数据库。
 */
const MAX_FRAGMENT_PARAMS = 64;
const MAX_FRAGMENT_LENGTH = 4096;

/**
 * 硬性不变量：`?` 的个数必须与参数个数一一对应。
 *
 * 用户值只允许出现在 params 里，绝不出现在 sql 文本中 —— 占位符一旦与参数错位，
 * 轻则查错数据，重则让参数被当成 SQL 片段执行。把它做成运行时断言：
 * 未来任何改动破坏这条不变量，都会在测试里立刻炸出来，而不是悄悄变成注入面。
 */
function assertPlaceholders(fragment: SqlFragment): SqlFragment {
  if (fragment.sql.split('?').length - 1 !== fragment.params.length) {
    throw new Error('搜索片段占位符数量与参数个数不一致');
  }
  if (fragment.params.length > MAX_FRAGMENT_PARAMS || fragment.sql.length > MAX_FRAGMENT_LENGTH) {
    throw new SearchExpressionError({ code: 'too_complex' });
  }
  return fragment;
}

/** 一个字段如何落到 SQL 上。 */
export type FieldBinding =
  /** 文本列：contains 走 LIKE，配了 fts 且长度 ≥3 时走全文索引 */
  | { kind: 'text'; column: string; fts?: { table: string; column: string; key: string } }
  /** 字符串表达式（枚举、派生的状态 CASE、文本形态的 id）：只做等值与不等值 */
  | { kind: 'string'; expr: string }
  /** 序值列（数值、存 epoch 毫秒的日期）：支持大小比较与区间 */
  | { kind: 'value'; expr: string }
  /** 布尔谓词：表达式本身就是真值，不参与取值比较 */
  | { kind: 'boolean'; expr: string };

/** 一个搜索入口的字段绑定表。键必须与 SEARCH_SCHEMAS 的字段名一一对应（有测试锁住）。 */
export type SearchTarget = Record<string, FieldBinding | readonly FieldBinding[]>;

export class SearchExpressionError extends Error {
  readonly issue: SearchIssue;
  constructor(issue: SearchIssue) {
    super(issue.code);
    this.name = 'SearchExpressionError';
    this.issue = issue;
  }
}

/** 把片段嵌进 Drizzle 查询：文本原样、`?` 处绑定参数。 */
export function fragmentToSql(fragment: SqlFragment | { sql: string; binds: readonly unknown[] }): SQL {
  if (!('params' in fragment)) fragment = { sql: fragment.sql, params: [...fragment.binds] };
  assertPlaceholders(fragment);
  const parts = fragment.sql.split('?');
  const chunks: SQL[] = [];
  for (let index = 0; index < parts.length; index++) {
    const text = parts[index]!;
    if (text !== '') chunks.push(sql.raw(text));
    if (index < fragment.params.length) chunks.push(sql`${fragment.params[index]}`);
  }
  return chunks.length === 0 ? sql`1=1` : sql.join(chunks, sql.raw(''));
}

/** 把片段附加到原生 SQL 的条件列表上（后台的字符串拼接服务用）。 */
export function appendFragment(conditions: string[], binds: unknown[], fragment: SqlFragment | null): void {
  if (!fragment) return;
  assertPlaceholders(fragment);
  conditions.push(fragment.sql);
  binds.push(...fragment.params);
}

function bindingsFor(target: SearchTarget, field: SearchField): readonly FieldBinding[] {
  const binding = target[field.name];
  if (!binding) throw new SearchExpressionError({ code: 'unknown_field', field: field.name });
  return Array.isArray(binding) ? binding : [binding as FieldBinding];
}

/** 文本包含：多列之间取 OR（例如衣柜里"材质名或收藏名"）。 */
function containsFragment(bindings: readonly FieldBinding[], value: string): SqlFragment {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const binding of bindings) {
    if (binding.kind !== 'text') continue;
    const fragment = textContains({ column: binding.column, value, ...(binding.fts ? { fts: binding.fts } : {}) });
    parts.push(fragment.sql);
    params.push(...fragment.binds);
  }
  if (parts.length === 0) throw new SearchExpressionError({ code: 'unsupported_operator' });
  return { sql: parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`, params };
}

function equalityFragment(bindings: readonly FieldBinding[], value: string, negate: boolean): SqlFragment {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const binding of bindings) {
    if (binding.kind === 'boolean') {
      const wanted = parseBooleanLiteral(value);
      if (wanted === null) throw new SearchExpressionError({ code: 'invalid_value', value });
      parts.push(wanted ? `(${binding.expr})` : `NOT (${binding.expr})`);
      continue;
    }
    if (binding.kind !== 'text' && binding.kind !== 'string') continue;
    parts.push(noCaseEq(binding.kind === 'text' ? binding.column : binding.expr, '?'));
    params.push(value);
  }
  if (parts.length === 0) throw new SearchExpressionError({ code: 'unsupported_operator' });
  const joined = parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
  return negate ? negated(joined, params) : { sql: joined, params };
}

const COMPARE_SQL: Readonly<Record<string, string>> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };

/**
 * 取反并兜住 NULL。
 *
 * SQL 的三值逻辑会让 `NOT (col = ?)` 在 col 为 NULL 时得到 NULL —— 行被排除。
 * 但搜索里的"不等于"应当包含"这个字段没有值"的行（例如 `uploader!=alice`
 * 应该带上没有上传者的官方材质），所以否定一律包一层 COALESCE。
 * 客户端 match.ts 采用同一套语义。
 */
function negated(sql: string, params: unknown[]): SqlFragment {
  return { sql: `NOT COALESCE((${sql}), FALSE)`, params };
}

function valueComparisonFragment(bindings: readonly FieldBinding[], op: string, value: string, upper: string | undefined, field: SearchField): SqlFragment {
  const expr = bindings.find(binding => binding.kind === 'value');
  if (!expr || expr.kind !== 'value') throw new SearchExpressionError({ code: 'unsupported_operator', field: field.name });

  if (field.type === 'date') {
    const low = value === '' ? null : parseDateLiteral(value);
    const high = upper === undefined || upper === '' ? null : parseDateLiteral(upper);
    const isRange = upper !== undefined;
    if (!isRange && !low) throw new SearchExpressionError({ code: 'invalid_value', field: field.name, value });

    const parts: string[] = [];
    const params: unknown[] = [];
    const push = (text: string, param: unknown) => { parts.push(text); params.push(param); };

    if (isRange) {
      if (low) push(`${expr.expr} >= ?`, low.start);
      if (high) push(`${expr.expr} < ?`, high.end);
      if (parts.length === 0) throw new SearchExpressionError({ code: 'invalid_value', field: field.name, value: '..' });
      return { sql: parts.join(' AND '), params };
    }
    // 整日/整月这类粒度下 low.start < low.end；`>` 表示"晚于该粒度末尾"。
    switch (op) {
      case 'eq': return { sql: `(${expr.expr} >= ? AND ${expr.expr} < ?)`, params: [low!.start, low!.end] };
      case 'ne': return negated(`(${expr.expr} >= ? AND ${expr.expr} < ?)`, [low!.start, low!.end]);
      case 'gt': return { sql: `${expr.expr} >= ?`, params: [low!.end] };
      case 'gte': return { sql: `${expr.expr} >= ?`, params: [low!.start] };
      case 'lt': return { sql: `${expr.expr} < ?`, params: [low!.start] };
      case 'lte': return { sql: `${expr.expr} < ?`, params: [low!.end] };
      default: throw new SearchExpressionError({ code: 'unsupported_operator', field: field.name });
    }
  }

  if (upper !== undefined) {
    // 区间两端各自解析：空串表示该端无界，因此不能在进入区间分支前就要求 value 有值。
    const parts: string[] = [];
    const params: unknown[] = [];
    if (value !== '') {
      const low = parseNumberLiteral(value);
      if (low === null) throw new SearchExpressionError({ code: 'invalid_value', field: field.name, value });
      parts.push(`${expr.expr} >= ?`);
      params.push(low);
    }
    if (upper !== '') {
      const high = parseNumberLiteral(upper);
      if (high === null) throw new SearchExpressionError({ code: 'invalid_value', field: field.name, value: upper });
      parts.push(`${expr.expr} <= ?`);
      params.push(high);
    }
    if (parts.length === 0) throw new SearchExpressionError({ code: 'invalid_value', field: field.name, value: '..' });
    return { sql: parts.join(' AND '), params };
  }
  const number = parseNumberLiteral(value);
  if (number === null) throw new SearchExpressionError({ code: 'invalid_value', field: field.name, value });
  if (op === 'eq') return { sql: `${expr.expr} = ?`, params: [number] };
  if (op === 'ne') return negated(`${expr.expr} = ?`, [number]);
  const operator = COMPARE_SQL[op];
  if (!operator) throw new SearchExpressionError({ code: 'unsupported_operator', field: field.name });
  return { sql: `${expr.expr} ${operator} ?`, params: [number] };
}

function nodeFragment(node: SearchNode, schema: SearchSchema, target: SearchTarget): SqlFragment {
  switch (node.type) {
    case 'and': {
      const parts = node.children.map(child => nodeFragment(child, schema, target));
      return { sql: parts.map(part => `(${part.sql})`).join(' AND '), params: parts.flatMap(part => part.params) };
    }
    case 'or': {
      const parts = node.children.map(child => nodeFragment(child, schema, target));
      return { sql: `(${parts.map(part => `(${part.sql})`).join(' OR ')})`, params: parts.flatMap(part => part.params) };
    }
    case 'not': {
      const inner = nodeFragment(node.child, schema, target);
      return negated(inner.sql, inner.params);
    }
    case 'term': {
      const fields = fallbackFields(schema);
      const parts = fields.map(field => containsFragment(bindingsFor(target, field), node.value));
      if (parts.length === 1) return parts[0]!;
      return { sql: `(${parts.map(part => `(${part.sql})`).join(' OR ')})`, params: parts.flatMap(part => part.params) };
    }
    case 'field': {
      const field = findField(schema, node.field);
      if (!field) throw new SearchExpressionError({ code: 'unknown_field', field: node.field });
      const bindings = bindingsFor(target, field);
      if (node.op === 'contains') return containsFragment(bindings, node.value);
      // 数值与日期有大小语义（含区间）；文本/枚举/布尔只做等值与不等值。
      if (field.type === 'number' || field.type === 'date') {
        return valueComparisonFragment(bindings, node.op, node.value, node.upper, field);
      }
      return equalityFragment(bindings, node.value, node.op === 'ne');
    }
  }
}

/**
 * 按已解析的 AST 编译。AST 必须来自带 schema 的解析（字段名已规范化、运算符已具体化），
 * 否则抛 SearchExpressionError。
 */
export function compileNode(ast: SearchNode, schema: SearchSchema, target: SearchTarget): SqlFragment {
  return assertPlaceholders(nodeFragment(ast, schema, target));
}
