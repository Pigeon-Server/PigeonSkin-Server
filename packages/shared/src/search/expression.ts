// 高级搜索表达式 —— 语法层。
//
// 同一份解析结果同时供三处使用：后端把 AST 编译成 SQL、前端做提交前即时校验、
// 客户端列表用 AST 直接过滤内存数据。三处共用一套语法，才不会出现"前端说合法、
// 后端说非法"的漂移。
//
// 语法（大小写不敏感的字段名与关键字）：
//   词                默认字段包含该词        skin
//   "短语"            默认字段包含完整短语     "夏日 沙滩"
//   字段:值           文本包含 / 其它类型相等  uploader:alice
//   字段=值 字段!=值   相等 / 不等             kind=skin  visibility!=public
//   字段~值           文本包含                name~cat
//   字段>值 >= < <=   数值 / 日期比较          likes>100  created>=2024-01-01
//   字段:起..止       闭区间（任一端可省略）    likes:10..100  created:..2024-06
//   -条件 NOT 条件     取反                   -kind:cape
//   A B   A AND B     与（相邻即与）          kind:skin likes>50
//   A OR B            或                    kind:skin OR kind:cape
//   ( … )             分组                   (kind:skin OR kind:cape) likes>50

const SPACE_WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

export function isSearchSpace(ch: string): boolean {
  return SPACE_WHITESPACE.has(ch);
}

/** 字段类型决定可用的比较运算、字面量解析方式与默认运算符。 */
export type SearchFieldType = 'text' | 'enum' | 'number' | 'date' | 'boolean';

export type SearchCompareOp = 'contains' | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** 书写形式（尚未按字段类型具体化）：`:` 表示"该类型的默认比较"，其余是显式运算符。 */
type RawCompare = ':' | '~' | '=' | '!=' | '>' | '>=' | '<' | '<=';

export interface SearchField {
  /** 表达式中书写的字段名 */
  readonly name: string;
  readonly type: SearchFieldType;
  /** 帮助面板里的名称与说明所用的 i18n 键 */
  readonly labelKey: string;
  /** 同义写法 */
  readonly aliases?: readonly string[];
  /** 无字段限定的词是否参与匹配（text 字段默认参与） */
  readonly fallback?: boolean;
  /** enum 的合法取值（小写），用于前端校验与规范 */
  readonly values?: readonly string[];
  /** 数值字段的单位说明 i18n 键（如字节） */
  readonly unitKey?: string;
}

export interface SearchSchema {
  readonly fields: readonly SearchField[];
}

// ── AST ─────────────────────────────────────────────────────────────────────

export interface SearchTermNode {
  readonly type: 'term';
  readonly value: string;
  /** 由引号包裹：整段作为一个短语匹配 */
  readonly phrase: boolean;
}

export interface SearchFieldNode {
  readonly type: 'field';
  /** 已规范化为 schema 中的字段名 */
  readonly field: string;
  readonly op: SearchCompareOp;
  readonly value: string;
  /** 区间上界；仅 op 为比较运算时存在，空串表示无界 */
  readonly upper?: string;
  /**
   * 运算符来自 `:`（含义随字段类型而定，文本为包含、其余为相等）。
   * 只在校验前存在：经 parseSearchExpression(schema) 返回的 AST 已折算为具体运算符。
   */
  readonly implicit?: boolean;
}

export interface SearchAndNode {
  readonly type: 'and';
  readonly children: readonly SearchNode[];
}

export interface SearchOrNode {
  readonly type: 'or';
  readonly children: readonly SearchNode[];
}

export interface SearchNotNode {
  readonly type: 'not';
  readonly child: SearchNode;
}

export type SearchNode = SearchTermNode | SearchFieldNode | SearchAndNode | SearchOrNode | SearchNotNode;

// ── 结果 ─────────────────────────────────────────────────────────────────────

export type SearchIssueCode =
  | 'unclosed_quote'
  | 'unbalanced_paren'
  | 'unexpected_token'
  | 'missing_value'
  | 'unknown_field'
  | 'unsupported_operator'
  | 'invalid_value'
  | 'too_long'
  | 'too_complex';

export interface SearchIssue {
  readonly code: SearchIssueCode;
  /** 出问题的字段名（若有） */
  readonly field?: string;
  /** 出问题的取值（若有） */
  readonly value?: string;
  /** 输入中的字符位置，供 UI 定位 */
  readonly position?: number;
}

export type SearchParseResult =
  | { readonly ok: true; readonly ast: SearchNode | null }
  | { readonly ok: false; readonly issue: SearchIssue };

/**
 * 复杂度上限：表达式来自 URL，必须有界。
 *
 * 编译后每个节点至少产生一个谓词，未限定字段的词还会按默认字段数量放大，
 * 所以节点数就是查询成本的粗略上界 —— 取 32 已经远超正常使用（一般 ≤5 个条件），
 * 同时把"一次请求最多能触发多少个子查询/扫描"钉死。
 */
export const SEARCH_LIMITS = {
  maxLength: 500,
  maxTokens: 48,
  maxNodes: 32,
  maxDepth: 8,
} as const;

// ── 词法 ─────────────────────────────────────────────────────────────────────

interface RawOperand {
  readonly kind: 'operand';
  readonly position: number;
  readonly neg: boolean;
  readonly keyword: 'and' | 'or' | 'not' | null;
  readonly field: string | null;
  readonly compare: RawCompare | null;
  readonly value: string;
  readonly upper: string | null;
  readonly phrase: boolean;
}

interface RawParen {
  readonly kind: 'lparen' | 'rparen';
  readonly position: number;
  readonly neg: boolean;
}

type RawToken = RawOperand | RawParen;

const COMPARE_TOKENS = ['>=', '<=', '!=', ':', '~', '=', '>', '<'] as const;

function readCompare(input: string, at: number): { compare: RawCompare; next: number } | null {
  for (const token of COMPARE_TOKENS) {
    if (input.startsWith(token, at)) return { compare: token, next: at + token.length };
  }
  return null;
}

const FIELD_WORD = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(input: string): { tokens: RawToken[] } | { issue: SearchIssue } {
  const tokens: RawToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (isSearchSpace(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') {
      tokens.push({ kind: ch === '(' ? 'lparen' : 'rparen', position: i, neg: false });
      i++;
      continue;
    }

    const position = i;
    let neg = false;
    if ((ch === '-' || ch === '!') && i + 1 < input.length) {
      const next = input[i + 1]!;
      // `!=` 是字段运算符，不能当作取反前缀；`-` 后跟空格也不是取反。
      if (next !== '=' && !isSearchSpace(next) && next !== ')') { neg = true; i++; }
    }

    // `-(a OR b)`：取反作用在分组上，分组本身由 lparen token 承载。
    if (neg && input[i] === '(') {
      tokens.push({ kind: 'lparen', position, neg: true });
      i++;
      continue;
    }

    let field: string | null = null;
    let compare: RawCompare | null = null;
    const word = FIELD_WORD.exec(input.slice(i))?.[0];
    if (word && word.length > 0) {
      const after = i + word.length;
      const separator = input[after];
      if (separator !== undefined && ':=~><!'.includes(separator)) {
        const first = readCompare(input, after);
        if (first) {
          field = word;
          compare = first.compare;
          i = first.next;
          // `字段:>=100` 这类写法把 `:` 当作可读性分隔符，真正的运算符在后面；
          // 允许中间有空格（`likes: >=100`）。
          if (compare === ':' || compare === '~') {
            let lookahead = i;
            while (lookahead < input.length && isSearchSpace(input[lookahead]!)) lookahead++;
            const second = readCompare(input, lookahead);
            if (second && second.compare !== ':' && second.compare !== '~') {
              compare = second.compare;
              i = second.next;
            }
          }
          // 运算符与取值之间允许空格：`name: cat` 与 `name:cat` 等价。
          while (i < input.length && isSearchSpace(input[i]!)) i++;
        }
      }
    }

    let phrase = false;
    let upper: string | null = null;
    let unclosed = false;
    const readParts = (stopAtRange: boolean): string => {
      let out = '';
      for (;;) {
        if (i >= input.length) break;
        const c = input[i]!;
        if (c === '"') {
          phrase = true;
          i++;
          let closed = false;
          while (i < input.length) {
            const q = input[i]!;
            if (q === '\\' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\')) {
              out += input[i + 1]!;
              i += 2;
              continue;
            }
            if (q === '"') { closed = true; i++; break; }
            out += q;
            i++;
          }
          if (!closed) unclosed = true;
          continue;
        }
        if (isSearchSpace(c) || c === '(' || c === ')') break;
        if (stopAtRange && c === '.' && input[i + 1] === '.') break;
        out += c;
        i++;
      }
      return out;
    };

    const value = readParts(true);
    if (!unclosed && input[i] === '.' && input[i + 1] === '.') {
      i += 2;
      upper = readParts(false);
    }

    if (unclosed) return { issue: { code: 'unclosed_quote', position } };
    if (value.length === 0 && upper === null) {
      return { issue: field ? { code: 'missing_value', field, position } : { code: 'unexpected_token', position } };
    }
    // 区间只在字段限定下有意义：裸 `a..b` 会丢掉上界，裸 `..` 更会退化成"匹配全部"。
    if (field === null && upper !== null) return { issue: { code: 'unexpected_token', position } };

    const keyword = !field && !phrase && compare === null && !neg
      ? (value.toLowerCase() === 'and' || value.toLowerCase() === 'or' || value.toLowerCase() === 'not' ? value.toLowerCase() as 'and' | 'or' | 'not' : null)
      : null;

    tokens.push({ kind: 'operand', position, neg, keyword, field, compare, value, upper, phrase });
  }
  return { tokens };
}

// ── 语法 ─────────────────────────────────────────────────────────────────────

interface ParserState {
  readonly tokens: readonly RawToken[];
  index: number;
  nodes: number;
  issue: SearchIssue | null;
}

function fail(state: ParserState, issue: SearchIssue): null {
  state.issue ??= issue;
  return null;
}

function peek(state: ParserState): RawToken | undefined {
  return state.tokens[state.index];
}

function countNode(state: ParserState, position: number): boolean {
  state.nodes++;
  if (state.nodes > SEARCH_LIMITS.maxNodes) {
    fail(state, { code: 'too_complex', position });
    return false;
  }
  return true;
}

function parseOr(state: ParserState, depth: number): SearchNode | null {
  if (depth > SEARCH_LIMITS.maxDepth) return fail(state, { code: 'too_complex' });
  const first = parseAnd(state, depth);
  if (!first) return null;
  const parts: SearchNode[] = [first];
  for (;;) {
    const token = peek(state);
    if (!token || token.kind !== 'operand' || token.keyword !== 'or') break;
    state.index++;
    const next = parseAnd(state, depth);
    if (!next) return null;
    parts.push(next);
  }
  if (parts.length === 1) return first;
  return countNode(state, 0) ? { type: 'or', children: parts } : null;
}

function parseAnd(state: ParserState, depth: number): SearchNode | null {
  const first = parseUnary(state, depth);
  if (!first) return null;
  const parts: SearchNode[] = [first];
  for (;;) {
    const token = peek(state);
    if (!token) break;
    if (token.kind === 'operand' && token.keyword === 'or') break;
    if (token.kind === 'operand' && token.keyword === 'and') {
      state.index++;
      const next = parseUnary(state, depth);
      if (!next) return null;
      parts.push(next);
      continue;
    }
    if (token.kind === 'rparen') break;
    // 相邻的操作数/分组视为隐式 AND
    const next = parseUnary(state, depth);
    if (!next) return null;
    parts.push(next);
  }
  if (parts.length === 1) return first;
  return countNode(state, 0) ? { type: 'and', children: parts } : null;
}

function parseUnary(state: ParserState, depth: number): SearchNode | null {
  if (depth > SEARCH_LIMITS.maxDepth) return fail(state, { code: 'too_complex' });
  const token = peek(state);
  if (token && token.kind === 'operand' && token.keyword === 'not') {
    state.index++;
    const child = parseUnary(state, depth + 1);
    if (!child) return null;
    return countNode(state, token.position) ? { type: 'not', child } : null;
  }
  return parsePrimary(state, depth);
}

function parsePrimary(state: ParserState, depth: number): SearchNode | null {
  const token = peek(state);
  if (!token) return fail(state, { code: 'unexpected_token', position: state.tokens.at(-1)?.position ?? 0 });

  if (token.kind === 'lparen') {
    state.index++;
    const inner = parseOr(state, depth + 1);
    if (!inner) return null;
    const closing = peek(state);
    if (!closing || closing.kind !== 'rparen') return fail(state, { code: 'unbalanced_paren', position: token.position });
    state.index++;
    if (!countNode(state, token.position)) return null;
    return token.neg ? { type: 'not', child: inner } : inner;
  }

  if (token.kind !== 'operand') return fail(state, { code: 'unexpected_token', position: token.position });
  if (token.keyword !== null) return fail(state, { code: 'unexpected_token', position: token.position });

  state.index++;
  const node: SearchNode = token.field
    ? {
        type: 'field',
        field: token.field,
        op: toCompareOp(token.compare ?? ':', 'text'),
        value: token.value,
        ...(token.upper !== null ? { upper: token.upper } : {}),
        ...(token.compare === ':' ? { implicit: true } : {}),
      }
    : { type: 'term', value: token.value, phrase: token.phrase };
  if (!countNode(state, token.position)) return null;
  return token.neg ? { type: 'not', child: node } : node;
}

/** 书写形式 → 具体运算符。`:` 的含义随后按字段类型再定（此处先按 text 兜底）。 */
function toCompareOp(raw: RawCompare, type: SearchFieldType): SearchCompareOp {
  switch (raw) {
    case ':': return type === 'text' ? 'contains' : 'eq';
    case '~': return 'contains';
    case '=': return 'eq';
    case '!=': return 'ne';
    case '>': return 'gt';
    case '>=': return 'gte';
    case '<': return 'lt';
    case '<=': return 'lte';
  }
}

function parseAst(input: string): { ast: SearchNode | null } | { issue: SearchIssue } {
  const lexed = tokenize(input);
  if ('issue' in lexed) return lexed;
  if (lexed.tokens.length === 0) return { ast: null };
  if (lexed.tokens.length > SEARCH_LIMITS.maxTokens) return { issue: { code: 'too_complex' } };
  const state: ParserState = { tokens: lexed.tokens, index: 0, nodes: 0, issue: null };
  const ast = parseOr(state, 1);
  if (state.issue) return { issue: state.issue };
  if (!ast) return { issue: { code: 'unexpected_token' } };
  if (state.index < state.tokens.length) {
    const rest = state.tokens[state.index]!;
    return { issue: { code: rest.kind === 'rparen' ? 'unbalanced_paren' : 'unexpected_token', position: rest.position } };
  }
  return { ast };
}

// ── 字面量 ───────────────────────────────────────────────────────────────────

const NUMBER_SUFFIX: Readonly<Record<string, number>> = {
  k: 1e3, m: 1e6, g: 1e9, t: 1e12,
  kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4,
};

/** 数值字面量：纯数字，或带 k/m/g/t（十进制）与 kb/mb/gb/tb（二进制）后缀。 */
export function parseNumberLiteral(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (text.length === 0) return null;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z]*)$/.exec(text);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]!;
  if (suffix === '') return base;
  const multiplier = NUMBER_SUFFIX[suffix];
  return multiplier === undefined ? null : base * multiplier;
}

export interface DateRange {
  /** 含 */
  readonly start: number;
  /** 不含。整日/整月这类粒度下 start < end；瞬时字面量下两者相等。 */
  readonly end: number;
}

const DAY_MS = 86_400_000;
const UNIT_MS: Readonly<Record<string, number>> = {
  h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS, m: 30 * DAY_MS, y: 365 * DAY_MS,
};

/** epoch 毫秒 → UTC 日/月/年的起止。日期按 UTC 解释，与 Worker 运行时时区一致。 */
function utcStart(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

function yearRange(year: number): DateRange {
  return { start: utcStart(year, 1, 1), end: utcStart(year + 1, 1, 1) };
}

function monthRange(year: number, month: number): DateRange {
  return { start: utcStart(year, month, 1), end: month === 12 ? utcStart(year + 1, 1, 1) : utcStart(year, month + 1, 1) };
}

function dayRange(year: number, month: number, day: number): DateRange | null {
  const start = utcStart(year, month, day);
  const date = new Date(start);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { start, end: start + DAY_MS };
}

/**
 * 日期字面量：`YYYY` / `YYYY-MM` / `YYYY-MM-DD`、`today` / `yesterday`、`now`，
 * 以及相对时长 `7d` / `2w` / `3m` / `1y` / `12h`（表示"此刻往前 N 个单位"的瞬时）。
 */
export function parseDateLiteral(value: string, now = Date.now()): DateRange | null {
  const text = value.trim().toLowerCase();
  if (text.length === 0) return null;
  if (text === 'now') return { start: now, end: now };
  if (text === 'today') { const d = new Date(now); return dayRange(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  if (text === 'yesterday') { const d = new Date(now - DAY_MS); return dayRange(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }

  const relative = /^(\d+)([hdwmy])$/.exec(text);
  if (relative) {
    const unit = UNIT_MS[relative[2]!]!;
    return { start: now - Number(relative[1]) * unit, end: now - Number(relative[1]) * unit };
  }

  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (ymd) return dayRange(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  const ym = /^(\d{4})-(\d{2})$/.exec(text);
  if (ym) {
    const month = Number(ym[2]);
    return month >= 1 && month <= 12 ? monthRange(Number(ym[1]), month) : null;
  }
  const y = /^(\d{4})$/.exec(text);
  if (y) return yearRange(Number(y[1]));
  return null;
}

const BOOLEAN_TRUE = new Set(['true', 'yes', '1', 'on', '是']);
const BOOLEAN_FALSE = new Set(['false', 'no', '0', 'off', '否']);

export function parseBooleanLiteral(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(text)) return true;
  if (BOOLEAN_FALSE.has(text)) return false;
  return null;
}

/** 字段类型允许的显式运算符（`:`/`~` 已折算为具体运算符）。 */
function allowedOperators(type: SearchFieldType): readonly SearchCompareOp[] {
  switch (type) {
    case 'text': return ['contains', 'eq', 'ne'];
    case 'enum': return ['eq', 'ne'];
    case 'boolean': return ['eq', 'ne'];
    case 'number':
    case 'date': return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
  }
}

// ── 校验 ─────────────────────────────────────────────────────────────────────

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase();
}

export function findField(schema: SearchSchema, name: string): SearchField | undefined {
  const wanted = normalizeFieldName(name);
  return schema.fields.find(field =>
    field.name.toLowerCase() === wanted || field.aliases?.some(alias => alias.toLowerCase() === wanted));
}

export function fallbackFields(schema: SearchSchema): readonly SearchField[] {
  const marked = schema.fields.filter(field => field.fallback);
  return marked.length > 0 ? marked : schema.fields.filter(field => field.type === 'text');
}

function validateLiteral(field: SearchField, value: string): { value: string } | SearchIssue {
  switch (field.type) {
    case 'enum': {
      const normalized = value.trim().toLowerCase();
      if (!field.values || field.values.includes(normalized)) return { value: normalized };
      return { code: 'invalid_value', field: field.name, value };
    }
    case 'boolean': {
      const parsed = parseBooleanLiteral(value);
      return parsed === null ? { code: 'invalid_value', field: field.name, value } : { value: parsed ? 'true' : 'false' };
    }
    case 'number':
      return parseNumberLiteral(value) === null ? { code: 'invalid_value', field: field.name, value } : { value: value.trim() };
    case 'date':
      return parseDateLiteral(value) === null ? { code: 'invalid_value', field: field.name, value } : { value: value.trim() };
    case 'text':
      return { value };
  }
}

function validateNode(schema: SearchSchema, node: SearchNode, depth: number, counter: { n: number }): SearchNode | SearchIssue {
  counter.n++;
  if (counter.n > SEARCH_LIMITS.maxNodes || depth > SEARCH_LIMITS.maxDepth) return { code: 'too_complex' };
  switch (node.type) {
    case 'and':
    case 'or': {
      const children: SearchNode[] = [];
      for (const child of node.children) {
        const result = validateNode(schema, child, depth + 1, counter);
        if ('code' in result) return result;
        children.push(result);
      }
      return { type: node.type, children };
    }
    case 'not': {
      const child = validateNode(schema, node.child, depth + 1, counter);
      return 'code' in child ? child : { type: 'not', child };
    }
    case 'term':
      return node;
    case 'field': {
      const field = findField(schema, node.field);
      if (!field) return { code: 'unknown_field', field: node.field };
      // `:` 的含义随类型而定；显式写的 `~`（包含）只对文本字段成立。
      if (node.op === 'contains' && field.type !== 'text' && !node.implicit) {
        return { code: 'unsupported_operator', field: field.name, value: node.value };
      }
      const op = node.op === 'contains' && field.type !== 'text' ? 'eq' : node.op;
      if (!allowedOperators(field.type).includes(op)) return { code: 'unsupported_operator', field: field.name, value: node.value };
      if (node.upper !== undefined) {
        // 区间只对有序类型有意义；文本/枚举/布尔写 `a..b` 是误用。
        if (field.type !== 'number' && field.type !== 'date') return { code: 'unsupported_operator', field: field.name, value: `${node.value}..${node.upper}` };
        // 区间的两端各自按字段类型校验；空串表示无界。
        if (node.value !== '') {
          const low = validateLiteral(field, node.value);
          if ('code' in low) return low;
        }
        if (node.upper !== '') {
          const high = validateLiteral(field, node.upper);
          if ('code' in high) return high;
        }
        if (node.value === '' && node.upper === '') return { code: 'invalid_value', field: field.name, value: '..' };
        return { type: 'field', field: field.name, op, value: node.value, upper: node.upper };
      }
      const literal = validateLiteral(field, node.value);
      return 'code' in literal
        ? literal
        : { type: 'field', field: field.name, op, value: literal.value };
    }
  }
}

/**
 * 解析并校验表达式。传入 schema 时字段名、运算符与字面量都会被检查，
 * 返回的 AST 中字段名已规范化为 schema 中的写法。
 */
export function parseSearchExpression(input: string, schema?: SearchSchema): SearchParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, ast: null };
  if (trimmed.length > SEARCH_LIMITS.maxLength) return { ok: false, issue: { code: 'too_long' } };
  const parsed = parseAst(trimmed);
  if ('issue' in parsed) return { ok: false, issue: parsed.issue };
  if (!parsed.ast) return { ok: true, ast: null };
  if (!schema) return { ok: true, ast: parsed.ast };
  const validated = validateNode(schema, parsed.ast, 1, { n: 0 });
  return 'code' in validated ? { ok: false, issue: validated } : { ok: true, ast: validated };
}

/**
 * 宽松解析：解析或校验失败时，把整串当作一个普通词（短语）来搜。
 *
 * 搜索是"尽力而为"的入口：用户写错语法时，直接按字面量搜一遍比弹一条语法错误
 * 更符合预期，也不会因为一个笔误就中断整个操作。长度上限仍然生效 ——
 * 那是输入体积限制，不是语法问题。
 *
 * 返回 null 表示空输入（不过滤）。
 */
export function parseSearchExpressionLenient(input: string, schema?: SearchSchema): SearchNode | null {
  const parsed = parseSearchExpression(input, schema);
  if (parsed.ok) return parsed.ast;
  return literalSearchTerm(input);
}

/**
 * 把原始输入退化成一个字面量短语（空输入返回 null）。
 * 解析不了、或编译预算越界时都用它 —— 回退语义只有这一个定义。
 */
export function literalSearchTerm(input: string): SearchTermNode | null {
  const trimmed = input.trim();
  return trimmed === '' ? null : { type: 'term', value: trimmed.slice(0, SEARCH_LIMITS.maxLength), phrase: true };
}

/**
 * AST 中是否存在某个字段的等值条件（例如 `status:archived`）。
 * 供需要按条件调整其它过滤的入口使用（如投票列表里归档行的放行）。
 */
export function expressionMentionsValue(node: SearchNode, field: string, value: string): boolean {
  switch (node.type) {
    case 'field':
      return node.field.toLowerCase() === field.toLowerCase()
        && (node.op === 'eq' || node.op === 'contains')
        && node.value.trim().toLowerCase() === value.toLowerCase();
    case 'not':
      return expressionMentionsValue(node.child, field, value);
    case 'and':
    case 'or':
      return node.children.some(child => expressionMentionsValue(child, field, value));
    case 'term':
      return false;
  }
}
