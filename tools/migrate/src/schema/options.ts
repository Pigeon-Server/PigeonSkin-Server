// options → settings 的映射。
//
// 独立成文件是因为它不是"一行进一行出"：一条旧 option 可能拆成两条新
// setting（sign_score → min/max），一条旧值可能需要变换（'-1' → 关注册），
// 还有本地化后缀（site_name_en → locale 覆盖行）。
import {
  LOCALE_ALIASES, OPTION_KEY_MAP, splitLocalizedOptionKey,
  type OptionTransform,
} from './legacy.ts';

export interface SettingRowOutput {
  key: string;
  locale: string; // '' 为全局值
  value: string;
}

export interface OptionRowInput {
  option_name: string;
  option_value: string;
}

function toBoolean(raw: string): string {
  // 旧库把布尔存成 'true'/'false' 字符串
  return raw === 'true' || raw === '1' ? 'true' : 'false';
}

function toInteger(raw: string): string {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? String(n) : raw;
}

function applyTransform(
  transform: OptionTransform,
  key: string,
  value: string,
): SettingRowOutput[] {
  switch (transform.kind) {
    case 'copy':
      return [{ key, locale: '', value }];
    case 'boolean':
      return [{ key, locale: '', value: toBoolean(value) }];
    case 'boolean-inverted':
      // 旧键是否定式命名（hide_intro），新键是肯定式（home_show_intro）
      return [{ key, locale: '', value: toBoolean(value) === 'true' ? 'false' : 'true' }];
    case 'integer':
      return [{ key, locale: '', value: toInteger(value) }];
    case 'pair': {
      // 旧 sign_score 是 "min,max"
      const [first, second] = value.split(',');
      return [
        { key, locale: '', value: toInteger(first?.trim() ?? '0') },
        { key: transform.secondKey, locale: '', value: toInteger(second?.trim() ?? '0') },
      ];
    }
    case 'special':
      // special 只在 analyze 里说明语义；实际数值变换在这里完成
      return specialTransform(key, value);
  }
}

function specialTransform(key: string, value: string): SettingRowOutput[] {
  // 注意：key 是**映射后**的新键名（OPTION_KEY_MAP 的 to 字段），
  // 不是旧键名 —— 旧 score_per_storage 到这里已经叫 score_per_kb_public。
  if (key === 'regs_per_ip') {
    // -1 表示"关闭注册"：新设计拆成显式布尔 + 正常数值
    if (value.trim() === '-1') {
      return [
        { key: 'registration_enabled', locale: '', value: 'false' },
        { key: 'regs_per_ip', locale: '', value: '-1' },
      ];
    }
    return [
      { key: 'registration_enabled', locale: '', value: 'true' },
      { key: 'regs_per_ip', locale: '', value: toInteger(value) },
    ];
  }
  if (key === 'score_per_kb_public') {
    // 旧默认值是字符串 'true'（历史 bug），语义上是 1
    return [{ key, locale: '', value: value === 'true' ? '1' : toInteger(value) }];
  }
  return [{ key, locale: '', value }];
}

/**
 * 映射全部 option 行。
 *
 * 未识别的键（多半来自插件）**原样保留**迁入 settings —— 迁移工具不替运维
 * 做丢弃决定，analyze 已经把这些键点名过，运维可以在后台自行清理。
 *
 * 去重规则：同一 (key, locale) 后写的行覆盖先写的（旧 options 表无主键，
 * 理论上可能存重复键）。
 */
export function mapOptionRows(
  rows: readonly OptionRowInput[],
  knownLocales: readonly string[],
): SettingRowOutput[] {
  const out = new Map<string, SettingRowOutput>();

  const put = (row: SettingRowOutput) => {
    out.set(`${row.locale}\u0000${row.key}`, row);
  };

  for (const r of rows) {
    const name = r.option_name;

    const localized = splitLocalizedOptionKey(name, knownLocales);
    if (localized) {
      put({
        key: localized.baseKey,
        locale: LOCALE_ALIASES[localized.locale] ?? localized.locale,
        value: r.option_value,
      });
      continue;
    }

    const mapping = OPTION_KEY_MAP[name];
    if (mapping) {
      for (const row of applyTransform(mapping.transform, mapping.to, r.option_value)) {
        put(row);
      }
      continue;
    }

    // 未识别：原样保留。key 冲突时后写覆盖（与上面一致）
    put({ key: name, locale: '', value: r.option_value });
  }

  return [...out.values()];
}
