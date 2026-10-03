// CustomSkinAPI R1 响应构造 —— **外部协议契约，字节级兼容**。
//
// 这是整个系统里唯一"不能自由重设计"的部分：Minecraft 客户端
// （CustomSkinLoader）直接消费它，任何字段变动都会让所有玩家的皮肤不再渲染。
//
// 旧实现的精确形态（app/Models/Player.php:77-92）：
//
//   {
//     "username": "Notch",
//     "skins": { "default": "<64 位 sha256>" },
//     "cape": null
//   }
//
// 几个极易写错的地方：
//   1. `skins` **只有一个**键，不是 default/slim 两键并存
//   2. 键名由**皮肤的 model** 决定；披风不参与这个判断，永远不会产生 "slim"
//   3. 没有皮肤时是 `{"default": null}` —— 键存在且值为 null，不是省略、不是 ""
//   4. 值是**裸哈希**，不是 URL。客户端自己把它拼到 API 根路径上，
//      所以 `/textures/{hash}` 与 `/csl/textures/{hash}` 必须存在。
//   5. 没有 RSA 签名、没有 metadata、没有 capes 数组 —— 旧版就没有，
//      期待 Mojang API 对等是误判。

import type { TextureModel } from '@pigeon-skin/shared';

/** 协议里 `skins` 对象的键名 */
export type CslSkinKey = TextureModel;

export interface PlayerProfile {
  readonly username: string;
  /** 恰好一个键：'default' 或 'slim'；无皮肤时值为 null */
  readonly skins: Readonly<Partial<Record<CslSkinKey, string | null>>>;
  /** 披风哈希，无披风时为 null */
  readonly cape: string | null;
}

export interface BuildProfileInput {
  readonly playerName: string;
  /** 当前皮肤；null 表示未设置 */
  readonly skin: { readonly hash: string; readonly model: TextureModel } | null;
  /** 当前披风；null 表示未设置 */
  readonly cape: { readonly hash: string } | null;
}

/**
 * 构造玩家档案 JSON。
 * 返回的对象可直接 JSON.stringify —— 键的顺序与旧版一致，便于 golden file 对比。
 */
export function buildPlayerProfile(input: BuildProfileInput): PlayerProfile {
  // 无皮肤时回落到 'default'（旧版 model 访问器就是这个行为）
  const key: CslSkinKey = input.skin?.model === 'slim' ? 'slim' : 'default';
  return {
    username: input.playerName,
    skins: { [key]: input.skin?.hash ?? null },
    cape: input.cape?.hash ?? null,
  };
}

/** 序列化为响应体。JSON_UNESCAPED_UNICODE 的效果：中文玩家名不转义。 */
export function serializePlayerProfile(profile: PlayerProfile): string {
  return JSON.stringify(profile);
}

// ── 协议响应头 ───────────────────────────────────────────────────────────────
// 缓存策略与旧版有意不同，理由见 docs/rewrite/07-minecraft-api.md §2.3：
// 旧版给玩家档案发一年 TTL，导致任何不重验证的客户端**一年内看不到换肤**。
// 60 秒新鲜窗口 + 边缘 300 秒，既正确又仍能吸收进服突发。

/** 玩家档案的缓存指令 */
export const PLAYER_PROFILE_CACHE_CONTROL =
  'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

/**
 * 纹理字节的缓存指令。
 * `immutable` 之所以安全，完全依赖"哈希即内容地址"这一不变量：
 * 内容变了 URL 就变了，因此不需要任何缓存失效逻辑。
 */
export const TEXTURE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** 衍生图（头像/预览）与纹理同理：由不可变哈希派生 */
export const DERIVATIVE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * 玩家被封禁时返回给客户端的消息。CSL 会把它呈现给玩家，属于契约的一部分。
 * 旧版 403 体是翻译后的完整句子（Laravel trans('general.player-banned')），
 * 这里必须放消息文本本身，不能放翻译键。
 */
export const PLAYER_BANNED_MESSAGE = 'The owner of this player is banned';

/** 纹理元数据存在但对象缺失时的响应码。用 503 而不是 404：
 *  404 在客户端看来是"纹理已删除"，而这是可恢复的存储故障。 */
export const TEXTURE_OBJECT_MISSING_STATUS = 503;

/** 由内容哈希生成强 ETag（带引号）。比旧版对响应体做 md5 便宜，且正确性相同。 */
export function textureEtag(hash: string): string {
  return `"${hash}"`;
}

/** 玩家档案的弱 ETag，基于玩家 id 与最后修改时间 */
export function playerProfileEtag(playerId: number, updatedAt: number): string {
  return `W/"${playerId}-${updatedAt}"`;
}
