import { describe, expect, it } from 'vitest';
import {
  matchSearch, parseBooleanLiteral, parseDateLiteral, parseNumberLiteral, parseSearchExpression,
  parseSearchExpressionLenient, literalSearchTerm, expressionMentionsValue,
  SEARCH_SCHEMAS, searchSchema, fallbackFields, findField,
} from '../src/search/index.ts';
import type { SearchNode, SearchRecord, SearchSchemaKey } from '../src/search/index.ts';

const schema = SEARCH_SCHEMAS.textures;

function parse(input: string, key: SearchSchemaKey = 'textures') {
  return parseSearchExpression(input, searchSchema(key));
}

/** 断言解析成功并取出 AST —— 语法用例里失败即测试失败。 */
function astOf(input: string, key: SearchSchemaKey = 'textures'): SearchNode | null {
  const result = parse(input, key);
  if (!result.ok) throw new Error(`unexpected issue: ${result.issue.code}`);
  return result.ast;
}

describe('search expression literals', () => {
  it('parses plain and suffixed numbers', () => {
    expect(parseNumberLiteral('42')).toBe(42);
    expect(parseNumberLiteral('-3.5')).toBe(-3.5);
    expect(parseNumberLiteral('2k')).toBe(2000);
    expect(parseNumberLiteral('3mb')).toBe(3 * 1024 ** 2);
    expect(parseNumberLiteral('abc')).toBeNull();
    expect(parseNumberLiteral('2.5.5')).toBeNull();
  });

  it('parses dates in UTC with month and year granularity', () => {
    const day = parseDateLiteral('2024-03-05')!;
    expect(day.start).toBe(Date.UTC(2024, 2, 5));
    expect(day.end - day.start).toBe(86_400_000);
    const month = parseDateLiteral('2024-03')!;
    expect(month.start).toBe(Date.UTC(2024, 2, 1));
    expect(month.end).toBe(Date.UTC(2024, 3, 1));
    expect(parseDateLiteral('2024')!.end).toBe(Date.UTC(2025, 0, 1));
    // 不存在的日期必须被判为非法，而不是被 Date 归一化成 3 月 1 日
    expect(parseDateLiteral('2024-02-30')).toBeNull();
    expect(parseDateLiteral('2024-13')).toBeNull();
    const relative = parseDateLiteral('7d', 1_000_000_000_000)!;
    expect(relative.start).toBe(1_000_000_000_000 - 7 * 86_400_000);
    expect(relative.start).toBe(relative.end);
  });

  it('parses booleans in several spellings', () => {
    for (const value of ['true', 'TRUE', 'yes', '1', 'on', '是']) expect(parseBooleanLiteral(value)).toBe(true);
    for (const value of ['false', 'no', '0', 'off', '否']) expect(parseBooleanLiteral(value)).toBe(false);
    expect(parseBooleanLiteral('maybe')).toBeNull();
  });
});

describe('search expression syntax', () => {
  it('parses bare terms and phrases', () => {
    expect(astOf('cat')).toEqual({ type: 'term', value: 'cat', phrase: false });
    expect(astOf('"summer beach"')).toEqual({ type: 'term', value: 'summer beach', phrase: true });
    expect(astOf('  ')).toBeNull();
  });

  it('applies the default operator for the field type', () => {
    // 文本字段的 `:` 是包含，其余类型是相等
    expect(astOf('name:cat')).toEqual({ type: 'field', field: 'name', op: 'contains', value: 'cat' });
    expect(astOf('kind:skin')).toEqual({ type: 'field', field: 'kind', op: 'eq', value: 'skin' });
    expect(astOf('likes:100')).toEqual({ type: 'field', field: 'likes', op: 'eq', value: '100' });
  });

  it('supports explicit comparison operators and colon-prefixed forms', () => {
    expect(astOf('likes>100')).toEqual({ type: 'field', field: 'likes', op: 'gt', value: '100' });
    expect(astOf('likes:>=100')).toEqual({ type: 'field', field: 'likes', op: 'gte', value: '100' });
    expect(astOf('likes<=10')).toEqual({ type: 'field', field: 'likes', op: 'lte', value: '10' });
    expect(astOf('kind=skin')).toEqual({ type: 'field', field: 'kind', op: 'eq', value: 'skin' });
    expect(astOf('kind!=cape')).toEqual({ type: 'field', field: 'kind', op: 'ne', value: 'cape' });
    expect(astOf('name~ca')).toEqual({ type: 'field', field: 'name', op: 'contains', value: 'ca' });
  });

  it('supports closed, half-open and open ranges', () => {
    expect(astOf('likes:10..100')).toEqual({ type: 'field', field: 'likes', op: 'eq', value: '10', upper: '100' });
    expect(astOf('likes:..100')).toEqual({ type: 'field', field: 'likes', op: 'eq', value: '', upper: '100' });
    expect(astOf('likes:10..')).toEqual({ type: 'field', field: 'likes', op: 'eq', value: '10', upper: '' });
    expect(astOf('created:2024-01-01..2024-01-31')).toEqual({ type: 'field', field: 'created', op: 'eq', value: '2024-01-01', upper: '2024-01-31' });
  });

  it('resolves aliases and reports unknown fields', () => {
    expect(astOf('author:alice')).toEqual({ type: 'field', field: 'uploader', op: 'contains', value: 'alice' });
    const result = parse('nope:1');
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.issue.code).toBe('unknown_field');
    expect(findField(schema, 'AUTHOR')?.name).toBe('uploader');
    expect(findField(schema, 'nope')).toBeUndefined();
  });

  it('binds AND tighter than OR and supports grouping', () => {
    const flat = astOf('a b OR c') as Extract<SearchNode, { type: 'or' }>;
    expect(flat.type).toBe('or');
    expect(flat.children).toHaveLength(2);
    expect(flat.children[0]!.type).toBe('and');
    const grouped = astOf('(a b) OR c') as Extract<SearchNode, { type: 'or' }>;
    expect(grouped.children[0]!.type).toBe('and');
  });

  it('parses negation written as - or NOT', () => {
    expect(astOf('-kind:cape')).toEqual({ type: 'not', child: { type: 'field', field: 'kind', op: 'eq', value: 'cape' } });
    expect(astOf('NOT kind:cape')).toEqual({ type: 'not', child: { type: 'field', field: 'kind', op: 'eq', value: 'cape' } });
    expect(astOf('-(a OR b)')).toEqual({
      type: 'not',
      child: { type: 'or', children: [
        { type: 'term', value: 'a', phrase: false },
        { type: 'term', value: 'b', phrase: false },
      ] },
    });
  });

  it('rejects malformed input with a specific issue code', () => {
    for (const [input, code] of [
      ['"unterminated', 'unclosed_quote'],
      ['(a OR b', 'unbalanced_paren'],
      ['a)', 'unbalanced_paren'],
      ['name:', 'missing_value'],
      ['and a', 'unexpected_token'],
      ['a OR', 'unexpected_token'],
    ] as const) {
      const result = parse(input);
      expect(result.ok ? 'ok' : result.issue.code, input).toBe(code);
    }
  });

  it('rejects operators and values a field type does not allow', () => {
    const badOp = parse('kind>skin');
    expect(badOp.ok ? 'ok' : badOp.issue.code).toBe('unsupported_operator');
    const badEnum = parse('kind:furniture');
    expect(badEnum.ok ? 'ok' : badEnum.issue.code).toBe('invalid_value');
    const badNumber = parse('likes:many');
    expect(badNumber.ok ? 'ok' : badNumber.issue.code).toBe('invalid_value');
    const badDate = parse('created:not-a-date');
    expect(badDate.ok ? 'ok' : badDate.issue.code).toBe('invalid_value');
    const badBoolean = parse('official:maybe');
    expect(badBoolean.ok ? 'ok' : badBoolean.issue.code).toBe('invalid_value');
    // 区间只对有序类型有意义
    const badRange = parse('kind:skin..cape');
    expect(badRange.ok ? 'ok' : badRange.issue.code).toBe('unsupported_operator');
    expect(parse('likes:1..2').ok).toBe(true);
  });

  it('answers explicit contains only for text fields', () => {
    // `~` 是显式写的"包含"，枚举/数值/布尔没有这个语义；`:` 才随类型折算
    expect(parse('name~ca').ok).toBe(true);
    const explicit = parse('kind~skin');
    expect(explicit.ok ? 'ok' : explicit.issue.code).toBe('unsupported_operator');
    expect(parse('kind:skin').ok).toBe(true);
  });

  it('rejects a range without a field (bare `..` would match everything)', () => {
    for (const input of ['..', 'a..b', '10..100']) {
      const result = parse(input);
      expect(result.ok ? 'ok' : result.issue.code, input).toBe('unexpected_token');
    }
    // 字段限定下区间照常可用
    expect(parse('likes:..100').ok).toBe(true);
  });

  it('allows whitespace between the operator and the value', () => {
    expect(astOf('name: cat')).toEqual({ type: 'field', field: 'name', op: 'contains', value: 'cat' });
    expect(astOf('likes: >= 100')).toEqual({ type: 'field', field: 'likes', op: 'gte', value: '100' });
    expect(astOf('uploader: "John Doe"')).toEqual({ type: 'field', field: 'uploader', op: 'contains', value: 'John Doe' });
  });

  it('bounds expression length and node count', () => {
    expect(parse('a'.repeat(501)).ok).toBe(false);
    const many = Array.from({ length: 40 }, (_, index) => `name:t${index}`).join(' OR ');
    const result = parse(many);
    expect(result.ok ? 'ok' : result.issue.code).toBe('too_complex');
  });

  it('falls back to every text field when no field is marked', () => {
    expect(fallbackFields(schema).map(field => field.name)).toEqual(['name']);
    expect(fallbackFields(searchSchema('adminUsers')).map(field => field.name)).toEqual(['email', 'nickname']);
  });
});

describe('literal fallback', () => {
  it('degrades any unreadable input to one phrase', () => {
    expect(literalSearchTerm('   ')).toBeNull();
    expect(literalSearchTerm('  nope:1 ')).toEqual({ type: 'term', value: 'nope:1', phrase: true });
    expect(parseSearchExpressionLenient('kind:skin', schema)).toMatchObject({ type: 'field' });
    expect(parseSearchExpressionLenient('kind:nope', schema)).toEqual({ type: 'term', value: 'kind:nope', phrase: true });
  });

  it('detects a field value anywhere in the expression', () => {
    const parse = (input: string) => parseSearchExpressionLenient(input, searchSchema('votes'))!;
    expect(expressionMentionsValue(parse('status:archived'), 'status', 'archived')).toBe(true);
    expect(expressionMentionsValue(parse('title:x AND status:Archived'), 'status', 'archived')).toBe(true);
    expect(expressionMentionsValue(parse('-status:archived'), 'status', 'archived')).toBe(true);
    expect(expressionMentionsValue(parse('status:active'), 'status', 'archived')).toBe(false);
    expect(expressionMentionsValue(parse('archived'), 'status', 'archived')).toBe(false);
  });
});

describe('search expression matching', () => {
  const record: SearchRecord = { name: 'Summer Beach', kind: 'skin', model: 'slim', likes: 120, created: Date.UTC(2024, 5, 15), official: 0, uploader: 'Alice' };

  const match = (input: string, value: SearchRecord = record) => matchSearch(astOf(input), schema, value);

  it('matches bare terms against fallback fields, case-insensitively', () => {
    expect(match('summer')).toBe(true);
    expect(match('SUMMER beach')).toBe(true);
    expect(match('"summer beach"')).toBe(true);
    expect(match('winter')).toBe(false);
  });

  it('matches field comparisons', () => {
    expect(match('kind:skin')).toBe(true);
    expect(match('kind:cape')).toBe(false);
    expect(match('likes>100')).toBe(true);
    expect(match('likes>120')).toBe(false);
    expect(match('likes:100..200')).toBe(true);
    expect(match('likes:..50')).toBe(false);
    expect(match('official:false')).toBe(true);
    expect(match('uploader:ali')).toBe(true);
  });

  it('matches date granularity against epoch-millisecond fields', () => {
    expect(match('created:2024-06-15')).toBe(true);
    expect(match('created:2024-06')).toBe(true);
    expect(match('created:2024')).toBe(true);
    expect(match('created:2024-07')).toBe(false);
    expect(match('created>=2024-06-15')).toBe(true);
    expect(match('created>2024-06-15')).toBe(false);
    expect(match('created<2024-06-16')).toBe(true);
    expect(match('created:2024-06-01..2024-06-30')).toBe(true);
  });

  it('combines conditions with and/or/not', () => {
    expect(match('kind:skin likes>100')).toBe(true);
    expect(match('kind:cape likes>100')).toBe(false);
    expect(match('kind:cape OR likes>100')).toBe(true);
    expect(match('-(kind:cape OR likes>100)')).toBe(false);
    expect(match('NOT kind:skin')).toBe(false);
  });

  it('treats "not equal" as "this row does not carry that value", including missing values', () => {
    // 与后端 compile.ts 的 NOT COALESCE(...) 对齐：没有该字段的行也算"不等于该值"
    expect(match('name!=Summer', { name: null })).toBe(true);
    expect(match('kind!=skin', { kind: null })).toBe(true);
    expect(match('likes!=120', { likes: null })).toBe(true);
    expect(match('official!=true', { official: null })).toBe(true);
    expect(match('created!=2024-06-15', { created: null })).toBe(true);
    // 相等则相反：缺值不匹配
    expect(match('name=Summer', { name: null })).toBe(false);
    expect(match('likes=120', { likes: null })).toBe(false);
  });

  it('treats an empty range endpoint as unbounded for numbers and dates', () => {
    // 客户端此前会在进入区间判断前先解析下界，导致 `..上界` 直接判否
    expect(match('likes:..200')).toBe(true);
    expect(match('likes:..100')).toBe(false);
    expect(match('likes:200..')).toBe(false);
    expect(match('likes:100..')).toBe(true);
    expect(match('created:..2025')).toBe(true);
    expect(match('created:2026..')).toBe(false);
    expect(match('created:2024-06-01..')).toBe(true);
  });

  it('treats a null expression as "match everything"', () => {
    expect(matchSearch(null, schema, record)).toBe(true);
  });
});
