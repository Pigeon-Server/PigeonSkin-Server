// 搜索的入口层：把 URL 里的表达式编译成 SQL 片段。
//
// 表达式来自 URL：解析、校验与编译都必须发生在查询构造之前，且都不向用户报错 ——
// 读不懂的输入退化成一个字面量短语，编译预算越界也退化成同样的字面量搜索。
// 唯一会被拒绝的是超过长度上限的输入（输入体积限制，由请求校验兜住）。
import type { Context } from 'hono';
import { SEARCH_LIMITS, SEARCH_SCHEMAS, literalSearchTerm, parseSearchExpressionLenient } from '@pigeon-skin/shared/search';
import type { SearchNode } from '@pigeon-skin/shared/search';
import { fail } from '../framework.ts';
import type { AppEnv } from '../lib.ts';
import { compileNode, SearchExpressionError, type SqlFragment } from './compile.ts';
import { searchTarget, type ServerSearchKey } from './targets.ts';

export { compileNode, fragmentToSql, appendFragment, SearchExpressionError, type SqlFragment } from './compile.ts';
export { searchTarget, voteStatusExpr, SERVER_SEARCH_KEYS, type ServerSearchKey } from './targets.ts';

/**
 * 编译表达式文本。空值（未提供或全空白）返回 null，表示不加过滤。
 *
 * 不做错误反馈：解析失败退化成字面量短语；编译预算越界（参数过多）再退一次，
 * 仍不成立就放弃过滤。只有超过长度上限的输入会被拒绝 —— 那是输入体积限制。
 */
export function compileSearchInput(raw: string | undefined | null, key: ServerSearchKey): SqlFragment | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  if (raw.trim().length > SEARCH_LIMITS.maxLength) throw fail.invalid();
  const schema = SEARCH_SCHEMAS[key];
  const target = searchTarget(key);
  const ast = parseSearchExpressionLenient(raw, schema);
  if (!ast) return null;
  try {
    return compileNode(ast, schema, target);
  } catch (error) {
    if (!(error instanceof SearchExpressionError)) throw error;
    // 条件太多导致谓词预算越界：整串退化成一个词再试，仍不行则不过滤
    const literal = literalSearchTerm(raw);
    if (!literal) return null;
    try {
      return compileNode(literal, schema, target);
    } catch (fallbackError) {
      if (fallbackError instanceof SearchExpressionError) return null;
      throw fallbackError;
    }
  }
}

/** 从查询串读取并编译搜索表达式。 */
export function readSearch(c: Context<AppEnv>, key: ServerSearchKey, param = 'q'): SqlFragment | null {
  return compileSearchInput(c.req.query(param), key);
}

/** 解析后的 AST（供需要按条件调整其它过滤的入口使用，例如投票的归档行）。 */
export function readSearchAst(c: Context<AppEnv>, key: ServerSearchKey, param = 'q'): SearchNode | null {
  return parseSearchExpressionLenient(c.req.query(param) ?? '', SEARCH_SCHEMAS[key]);
}
