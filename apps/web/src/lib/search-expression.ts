// 高级搜索表达式的前端辅助。
//
// 解析用的是后端同一套实现（@pigeon-skin/shared/search），所以内存过滤与
// SQL 查询对同一个输入的理解不会漂移 —— 包括"解析不了就当普通词"这条回退。
import { computed, type ComputedRef, type Ref } from 'vue';
import { parseSearchExpressionLenient, searchSchema } from '@pigeon-skin/shared/search';
import type { SearchField, SearchNode, SearchSchemaKey } from '@pigeon-skin/shared/search';

/**
 * 解析表达式 → AST。空输入返回 null（不过滤）。
 *
 * 解析失败不做错误反馈：整串退化成一个字面量词（见 parseSearchExpressionLenient），
 * 与后端 compileSearchInput 的行为一致。
 */
export function searchAst(value: string, key: SearchSchemaKey): SearchNode | null {
  return parseSearchExpressionLenient(value, searchSchema(key));
}

/** 响应式版本，供模板与 computed 直接绑定。 */
export function useSearchExpression(value: Ref<string> | ComputedRef<string>, key: SearchSchemaKey): ComputedRef<SearchNode | null> {
  return computed(() => searchAst(value.value, key));
}

/**
 * 把示例追加到已有表达式之后。
 *
 * 追加而不是覆盖：用户往往要按"再加一个条件"的思路组合表达式，
 * 覆盖会把已经写好的条件丢掉（相邻条件本身就是 AND）。
 */
export function appendSearchExample(current: string, example: string): string {
  const left = current.trimEnd();
  return left === '' ? example : `${left} ${example}`;
}

/** 该入口可用的字段（帮助面板用），按 schema 声明顺序。 */
export function searchFieldList(key: SearchSchemaKey): readonly SearchField[] {
  return searchSchema(key).fields;
}

/** 枚举字段的首选示例值：取第一个合法值往往是最边缘的那个（如 role:banned）。 */
const PREFERRED_ENUM_EXAMPLE: Readonly<Record<string, string>> = {
  role: 'admin',
  locale: 'zh_CN',
  visibility: 'public',
  kind: 'skin',
  model: 'default',
};

/** 字段示例：按类型与字段含义生成，示例值本身不需要翻译。 */
export function searchFieldExample(field: SearchField): string {
  switch (field.type) {
    case 'enum':
      return `${field.name}:${PREFERRED_ENUM_EXAMPLE[field.name] ?? field.values?.[0] ?? 'value'}`;
    case 'boolean': return `${field.name}:true`;
    case 'number': return `${field.name}>100`;
    case 'date': return `${field.name}>=2024-01-01`;
    case 'text':
      return `${field.name}:${looksLikePersonField(field) ? 'alice' : 'abc'}`;
  }
}

function looksLikePersonField(field: SearchField): boolean {
  return /uploader|owner|user|actor|nickname|email|reporter/.test(field.labelKey);
}

/** 该入口"字段名"的展示写法（帮助面板左列）。 */
export function fieldDisplayName(field: SearchField): string {
  const aliases = field.aliases ?? [];
  return aliases.length > 0 ? `${field.name} · ${aliases.join(' · ')}` : field.name;
}

export type { SearchField, SearchNode, SearchSchemaKey };
