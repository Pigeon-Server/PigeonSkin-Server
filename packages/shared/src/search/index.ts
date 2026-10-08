// 高级搜索表达式 —— 共享入口。
//
// 词法/语法/字面量（expression.ts）、字段表（schemas.ts）、内存求值（match.ts）
// 一起构成前后端共用的搜索契约。
export {
  SEARCH_LIMITS,
  expressionMentionsValue,
  fallbackFields,
  literalSearchTerm,
  findField,
  parseBooleanLiteral,
  parseDateLiteral,
  parseNumberLiteral,
  parseSearchExpression,
  parseSearchExpressionLenient,
} from './expression.ts';
export type {
  DateRange,
  SearchAndNode,
  SearchCompareOp,
  SearchField,
  SearchFieldNode,
  SearchFieldType,
  SearchIssue,
  SearchIssueCode,
  SearchNode,
  SearchNotNode,
  SearchOrNode,
  SearchParseResult,
  SearchSchema,
  SearchTermNode,
} from './expression.ts';
export { SEARCH_SCHEMAS, searchSchema } from './schemas.ts';
export type { SearchSchemaKey } from './schemas.ts';
export { matchSearch } from './match.ts';
export type { SearchRecord, SearchRecordValue } from './match.ts';
