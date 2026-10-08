// settings 命令组：list / get / set。
// 键白名单来自 apps/api/src/env.ts 的 SETTING_DEFAULTS（复制为字面量列表，
// 因为 CLI 不能 import apps/api 的 env.ts —— 那会拖入 Worker 类型依赖）。
// 值语义由 API 侧解释；CLI 只做字符串读写，不猜测布尔/数字类型。

import type { TargetEnv } from '../lib/env.ts';
import { d1Query, d1ExecuteFile } from '../lib/wrangler.ts';
import { sqlText } from '../lib/sql.ts';
import { flagString, hasFlag, type ParsedArgs } from '../lib/args.ts';
import { assertApiKeyValued, resolveHttpChannel, adminRequest, expectOk, type HttpChannel } from './http-admin.ts';

const SETTING_KEYS: readonly string[] = [
  'votes_enabled', 'pigeon_api_window_seconds', 'pigeon_api_request_limit',
  'site_name', 'csl_first', 'theme_color', 'site_description',
  'registration_enabled', 'regs_per_ip', 'require_email_verification',
  'register_with_player_name', 'player_name_rule', 'player_name_length_min', 'player_name_length_max',
  'initial_score', 'score_per_player', 'free_player_count', 'max_player_count',
  'score_per_kb_public', 'score_per_kb_private', 'score_per_closet_item', 'refund_on_delete',
  'max_upload_size_kb', 'max_texture_width', 'allow_texture_download', 'allow_anonymous_download', 'private_texture_status',
  'sign_score_min', 'sign_score_max', 'sign_gap_hours', 'sign_reset_mode',
  'score_award_per_texture', 'clawback_award_on_delete', 'score_award_per_like',
  'reporter_score_delta', 'reporter_reward_score',
  'player_name_regexp', 'texture_name_regexp',
  'meta_extras', 'textures_description_limit', 'adsense_client_id', 'gtag_id',
  'mojang_verification_score_award',
  'ygg_uuid_algorithm', 'ygg_token_expire_1', 'ygg_token_expire_2', 'ygg_tokens_limit',
  'ygg_rate_limit', 'ygg_skin_domain', 'ygg_search_profile_max', 'ygg_show_config_section',
  'ygg_enable_ali', 'ygg_private_key', 'ygg_connect_enabled', 'ygg_disable_authserver',
  'oauth_enabled', 'comments_enabled', 'comments_ai_moderation', 'official_resources_auto_update',
  'restricted_email_allow', 'restricted_email_deny', 'sitemap_max_urls',
];

const SETTING_COLUMNS = 'key, locale, value, updated_at';

export async function runSettings(env: TargetEnv, action: string, parsed: ParsedArgs): Promise<number> {
  const { flags } = parsed;
  assertApiKeyValued(flags);
  const channel = resolveHttpChannel(env, flags);
  switch (action) {
    case 'list': return channel ? settingsListHttp(channel, hasFlag(flags, 'json')) : settingsList(env, hasFlag(flags, 'json'));
    case 'get': return channel ? settingsGetHttp(channel, flagString(flags, 'key') ?? '') : settingsGet(env, flagString(flags, 'key') ?? '');
    case 'set': return channel ? settingsSetHttp(channel, flagString(flags, 'key') ?? '', flagString(flags, 'value') ?? '') : settingsSet(env, flagString(flags, 'key') ?? '', flagString(flags, 'value') ?? '');
    default:
      throw new Error(`未知 settings 子命令 "${action}"（可用: list | get | set）`);
  }
}

// ── HTTP 通道（scope: admin.settings.write）────────────────────────────────
// GET /settings 返回合并后的生效值（含默认值），secret 键为占位符，
// superAdminOnly 键不出现 —— 与 wrangler 通道的"仅覆盖行"视图不同，更贴近真实语义。

async function settingsListHttp(channel: HttpChannel, json: boolean): Promise<number> {
  const result = await adminRequest(channel, 'GET', '/api/v1/pigeon/admin/settings');
  const body = expectOk(result, '读取设置');
  const values = (body.values ?? {}) as Record<string, string>;
  const keys = Object.keys(values).sort();
  if (json) { console.log(JSON.stringify(values, null, 2)); return 0; }
  if (keys.length === 0) { console.log('无设置项'); return 0; }
  for (const k of keys) {
    console.log(`  ${k} = ${values[k]}`);
  }
  return 0;
}

async function settingsGetHttp(channel: HttpChannel, key: string): Promise<number> {
  if (!key) throw new Error('需要 --key <键名>');
  const result = await adminRequest(channel, 'GET', '/api/v1/pigeon/admin/settings');
  const body = expectOk(result, '读取设置');
  const values = (body.values ?? {}) as Record<string, string>;
  if (!(key in values)) { console.log(`（${key} 无覆盖值或不可见）`); return 0; }
  console.log(`${key} = ${values[key]}`);
  return 0;
}

async function settingsSetHttp(channel: HttpChannel, key: string, value: string): Promise<number> {
  if (!key) throw new Error('需要 --key <键名>');
  const result = await adminRequest(channel, 'PATCH', '/api/v1/pigeon/admin/settings', {
    settings: [{ key, value }],
  });
  const body = expectOk(result, '写入设置');
  console.log(`已写入（管理 API，written=${body.written}）: ${key} = ${value}`);
  return 0;
}

function settingsList(env: TargetEnv, json: boolean): number {
  const rows = d1Query(env, `SELECT ${SETTING_COLUMNS} FROM settings ORDER BY key, locale`);
  if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  if (rows.length === 0) { console.log('settings 表为空（全部使用内置默认值）'); return 0; }
  for (const r of rows) {
    const locale = r.locale ? ` [${r.locale}]` : '';
    console.log(`  ${r.key}${locale} = ${r.value}`);
  }
  return 0;
}

function settingsGet(env: TargetEnv, key: string): number {
  if (!key) throw new Error('需要 --key <键名>');
  if (!SETTING_KEYS.includes(key)) throw new Error(`未知设置键: ${key}`);
  const rows = d1Query(env, `SELECT ${SETTING_COLUMNS} FROM settings WHERE key = ${sqlText(key)}`);
  if (rows.length === 0) { console.log(`（${key} 未覆盖，使用内置默认值）`); return 0; }
  for (const r of rows) {
    const locale = r.locale ? ` [${r.locale}]` : '';
    console.log(`${key}${locale} = ${r.value}`);
  }
  return 0;
}

function settingsSet(env: TargetEnv, key: string, value: string): number {
  if (!key) throw new Error('需要 --key <键名>');
  if (!SETTING_KEYS.includes(key)) throw new Error(`未知设置键: ${key}（可用键见 apps/api/src/env.ts SETTING_DEFAULTS）`);
  const ts = Date.now();
  d1ExecuteFile(env, [
    `INSERT INTO settings (key, locale, value, updated_at) VALUES (${sqlText(key)}, '', ${sqlText(value)}, ${ts}) `
    + `ON CONFLICT (key, locale) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ]);
  console.log(`已写入 ${env.label}: ${key} = ${value}`);
  return 0;
}
