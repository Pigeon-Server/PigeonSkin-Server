// offlineUuidV3 —— 迁移数据恢复的语义基准，算法漂移会让懒分配玩家的
// UUID 偏离旧站身份（启动器 profileID 与游戏存档都按它索引），必须锁定。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { describe, expect, it } from 'vitest';
import { offlineUuidV3 } from '../src/services/ygg-profiles.ts';

describe('offlineUuidV3', () => {
  it('按 Java nameUUIDFromBytes(OfflinePlayer:name) 派生（黄金值 = 生产迁移回填所用）', () => {
    expect(offlineUuidV3('fsj')).toBe('1949d7b4f3a132f7ab8f6767d0810bba');
    expect(offlineUuidV3('Uranium2006')).toBe('e677c90b885737bbaceea27a2bdc031b');
  });

  it('版本位 = 3、变体位 = IETF，UTF-8 名字按字节散列且结果恒定', () => {
    for (const name of ['Alice', '小明_2026', 'Царь']) {
      const uuid = offlineUuidV3(name);
      expect(uuid).toMatch(/^[0-9a-f]{32}$/);
      expect(uuid[12]).toBe('3');
      // 变体位 10xx：第 17 个 hex 位落在 8..b
      expect(parseInt(uuid[16]!, 16) & 0xc).toBe(0x8);
      expect(offlineUuidV3(name)).toBe(uuid);
    }
  });
});
