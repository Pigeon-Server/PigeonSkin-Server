// 设置读取：几乎每个请求都要读，因此在 isolate 内缓存 60 秒。
import { bumpCacheGeneration, currentCacheGeneration } from './cache-generation.ts';
import { flag, SETTING_DEFAULTS, type Bindings, type SettingKey } from './env.ts';

import { EXTRA_DEFAULTS } from '../services/settings.ts';
import { readSettingsSnapshot } from './settings-snapshot.ts';
import { invalidatePublicCache } from './public-cache.ts';
import { requestPending } from './request-cache.ts';

const settingsCache = new WeakMap<object, { values: Record<string, string>; generation: number; expiresAt: number }>();

/**
 * 让本 isolate 的设置缓存立即失效。
 *
 * 设置写入必须调用它，否则管理员改完之后、在 TTL 到期之前，同一个 isolate
 * 上的请求仍会读到旧值 —— 表现为"改了设置但没生效"，而且要等一分钟才自愈。
 *
 * 注意这只是**本 isolate** 的失效。其它 isolate 仍会在 TTL（60 秒）内看到旧值，
 * 这是缓存换来的代价，对站名这类展示项无影响；对计费参数也只在窗口内
 * 按旧价收费，不构成正确性问题。
 */
export function invalidateSettingsCache(): void {
  invalidatePublicCache();
  // 配置读缓存（configuration.ts）与设置同源：任何 settings 写入都要一并失效。
  // 代数计数器是零依赖模块，两处缓存同步读取它；递增后配置缓存条目因
  // 代数不匹配立即过期，不需要（也不能）静态导入 configuration.ts —— 会成环。
  bumpCacheGeneration();
}

export async function readSettings(env: Pick<Bindings, 'DB'>): Promise<Record<string, string>> {
  const now = Date.now();
  const cached = settingsCache.get(env.DB as object);
  if (cached && cached.generation === currentCacheGeneration() && cached.expiresAt > now) return cached.values;
  const pending = requestPending('settings', env.DB as object);
  const existing = pending.get('');
  if (existing) return existing as Promise<Record<string, string>>;

  const load = (async () => {
    // 快照代数：查询飞行期间若发生失效，旧结果带着旧代数入缓存，
    // 下个请求会立即判过期重新查库，不会把旧设置当成新值缓存 60 秒。
    const generation = currentCacheGeneration();
    const stored = await readSettingsSnapshot(env);

    // EXTRA_DEFAULTS（settings.ts 里仅超管可见项的默认值）也要兜底：
    // 网关等直接走 readSettings 的读取方拿不到 settings.ts 的合并结果，
    // 缺了它 ai_driver 这类 EXTRA 键会变 undefined 而不是 ''。
    const values: Record<string, string> = { ...SETTING_DEFAULTS, ...EXTRA_DEFAULTS };
    Object.assign(values, stored);

    settingsCache.set(env.DB as object, { values, generation, expiresAt: Date.now() + 60_000 });
    return values;
  })();
  pending.set('', load);
  try {
    return await load;
  } finally {
    pending.delete('');
  }
}

export async function getSetting(env: Pick<Bindings, 'DB'>, key: SettingKey): Promise<string> {
  const values = await readSettings(env);
  return values[key] ?? SETTING_DEFAULTS[key];
}

export async function getSettingInt(env: Pick<Bindings, 'DB'>, key: SettingKey): Promise<number> {
  const n = Number(await getSetting(env, key));
  return Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key]);
}

export async function getSettingBool(env: Pick<Bindings, 'DB'>, key: SettingKey): Promise<boolean> {
  return flag(await getSetting(env, key));
}
