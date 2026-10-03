export interface LocaleMessages { [key: string]: string | LocaleMessages }
export interface TranslationOverride { key: string; value: string }

export function parseTranslationOverrides(value: unknown, messages: LocaleMessages): TranslationOverride[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid translation overrides');
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string' || typeof item.value !== 'string' || getMessage(messages, item.key) === undefined) {
      throw new TypeError('Invalid translation override');
    }
    return { key: item.key, value: item.value };
  });
}

export function messageParameters(message: string): string[] {
  return [...new Set([...message.matchAll(/\{(\w+)\}/g)].map(match => match[1]!))].sort();
}

export function normalizeTranslation(message: string, reference: string): string {
  for (const parameter of messageParameters(reference)) {
    message = message.replace(new RegExp(':' + parameter + '(?![\\w])', 'g'), '{' + parameter + '}');
  }
  return message;
}

const reserved = new Set(['__proto__', 'constructor', 'prototype']);

export function isMessageKey(key: string): boolean {
  return key.length <= 200 && /^[a-zA-Z][\w-]*(?:\.[\w-]+)*$/.test(key) && !key.split('.').some(part => reserved.has(part));
}

export function getMessage(messages: LocaleMessages, key: string): string | undefined {
  if (!isMessageKey(key)) return undefined;
  let value: string | LocaleMessages = messages;
  for (const part of key.split('.')) {
    if (typeof value === 'string' || !Object.hasOwn(value, part)) return undefined;
    value = value[part]!;
  }
  return typeof value === 'string' ? value : undefined;
}

export function flattenMessages(messages: LocaleMessages, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(messages).flatMap(([key, value]) => typeof value === 'string'
    ? [[prefix + key, value]] : Object.entries(flattenMessages(value, prefix + key + '.'))));
}

export function withTranslations(messages: LocaleMessages, entries: readonly TranslationOverride[]): LocaleMessages {
  const result = structuredClone(messages);
  for (const { key, value } of entries) {
    if (!isMessageKey(key) || getMessage(messages, key) === undefined) continue;
    const parts = key.split('.');
    let node = result;
    for (const part of parts.slice(0, -1)) node = node[part] as LocaleMessages;
    node[parts.at(-1)!] = normalizeTranslation(value, getMessage(messages, key)!);
  }
  return result;
}
