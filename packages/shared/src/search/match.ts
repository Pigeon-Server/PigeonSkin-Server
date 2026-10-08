// 表达式的内存求值 —— 前端列表（手册、官网文案、Live2D、角色页材质选择器）
// 用同一套语法过滤已取回的数据，语义与后端 SQL 编译保持一致。
import {
  fallbackFields, findField, parseBooleanLiteral, parseDateLiteral, parseNumberLiteral,
} from './expression.ts';
import type { SearchField, SearchNode, SearchSchema } from './expression.ts';

export type SearchRecordValue = string | number | boolean | null | undefined;

/** 一条待匹配记录：键为字段名，日期字段用 epoch 毫秒。 */
export interface SearchRecord {
  readonly [field: string]: SearchRecordValue;
}

function asText(value: SearchRecordValue): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

function asNumber(value: SearchRecordValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function contains(haystack: SearchRecordValue, needle: string): boolean {
  const text = asText(haystack);
  return text !== null && text.toLowerCase().includes(needle.toLowerCase());
}

function equalsText(haystack: SearchRecordValue, needle: string): boolean {
  const text = asText(haystack);
  return text !== null && text.toLowerCase() === needle.toLowerCase();
}

function asBoolean(value: SearchRecordValue): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return parseBooleanLiteral(value);
  return null;
}

/**
 * 数值比较。区间为闭区间，空串表示该端无界 —— 因此不能在进入区间判断前
 * 就要求下界可解析（`likes:..100` 的下界是空串）。
 */
function matchNumber(field: SearchField, node: { op: string; value: string; upper?: string | undefined }, record: SearchRecord): boolean {
  const actual = asNumber(record[field.name]);
  // 缺值与后端 NOT COALESCE(...) 对齐：`!=` 视为"没有这个值"，其余运算不匹配
  if (actual === null) return node.op === 'ne' && node.upper === undefined;
  if (node.upper !== undefined) {
    if (node.value !== '') {
      const low = parseNumberLiteral(node.value);
      if (low === null || actual < low) return false;
    }
    if (node.upper !== '') {
      const high = parseNumberLiteral(node.upper);
      if (high === null || actual > high) return false;
    }
    return true;
  }
  const value = parseNumberLiteral(node.value);
  if (value === null) return false;
  switch (node.op) {
    case 'eq': return actual === value;
    case 'ne': return actual !== value;
    case 'gt': return actual > value;
    case 'gte': return actual >= value;
    case 'lt': return actual < value;
    case 'lte': return actual <= value;
    default: return false;
  }
}

/** 日期比较：按 UTC 粒度取区间，`>` 表示"晚于该粒度末尾"，`<=` 表示"不晚于该粒度末尾"。 */
function matchDate(field: SearchField, node: { op: string; value: string; upper?: string | undefined }, record: SearchRecord): boolean {
  const actual = asNumber(record[field.name]);
  if (actual === null) return node.op === 'ne' && node.upper === undefined;
  if (node.upper !== undefined) {
    // 区间两端各自解析，空串表示该端无界
    if (node.value !== '') {
      const low = parseDateLiteral(node.value);
      if (!low || actual < low.start) return false;
    }
    if (node.upper !== '') {
      const high = parseDateLiteral(node.upper);
      if (!high || actual >= high.end) return false;
    }
    return true;
  }
  const low = parseDateLiteral(node.value);
  if (!low) return false;
  switch (node.op) {
    case 'eq': return actual >= low.start && actual < low.end;
    case 'ne': return !(actual >= low.start && actual < low.end);
    case 'gt': return actual >= low.end;
    case 'gte': return actual >= low.start;
    case 'lt': return actual < low.start;
    case 'lte': return actual < low.end;
    default: return false;
  }
}

function matchField(schema: SearchSchema, node: Extract<SearchNode, { type: 'field' }>, record: SearchRecord): boolean {
  const field = findField(schema, node.field);
  if (!field) return false;
  switch (field.type) {
    case 'text':
      if (node.op === 'contains') return contains(record[field.name], node.value);
      if (node.op === 'eq') return equalsText(record[field.name], node.value);
      return !equalsText(record[field.name], node.value);
    case 'enum':
      return node.op === 'eq' ? equalsText(record[field.name], node.value) : !equalsText(record[field.name], node.value);
    case 'boolean': {
      const actual = asBoolean(record[field.name]);
      const wanted = parseBooleanLiteral(node.value);
      if (actual === null) return node.op === 'ne';
      if (wanted === null) return false;
      return node.op === 'eq' ? actual === wanted : actual !== wanted;
    }
    case 'number':
      return matchNumber(field, node, record);
    case 'date':
      return matchDate(field, node, record);
  }
}

function evaluate(node: SearchNode, schema: SearchSchema, record: SearchRecord): boolean {
  switch (node.type) {
    case 'and': return node.children.every(child => evaluate(child, schema, record));
    case 'or': return node.children.some(child => evaluate(child, schema, record));
    case 'not': return !evaluate(node.child, schema, record);
    case 'term': {
      const fields = fallbackFields(schema);
      return fields.some(field => contains(record[field.name], node.value));
    }
    case 'field': return matchField(schema, node, record);
  }
}

/** 无表达式（null）时一律匹配。 */
export function matchSearch(ast: SearchNode | null, schema: SearchSchema, record: SearchRecord): boolean {
  return ast === null ? true : evaluate(ast, schema, record);
}
