// 跨模块共享的缓存代数计数器：刻意保持零导入，让 lib（settings 缓存）与
// configuration（配置缓存）都能同步读写它而不形成导入环。
// 任一方失效时递增代数，另一方的缓存条目因代数不匹配而立即过期。
let generation = 0;

export function bumpCacheGeneration(): void {
  generation++;
}

export function currentCacheGeneration(): number {
  return generation;
}
