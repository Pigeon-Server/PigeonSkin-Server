// @pigeon-skin/minecraft —— Minecraft 纹理与协议。
//
// 这个包被 apps/api 与 tools/migrate **同时**引用，这是有意的：
// 上传时与导入时的校验逻辑必须完全一致，否则会出现"迁移能过、上传不过"
// 或反过来的诡异情况，而两边的实现一旦分开就必然漂移。
export {
  inspectPng,
  sha256Hex,
  type PngInfo,
  type PngInspection,
} from './png.ts';

export {
  decodePng,
  encodePng,
  type DecodedPng,
  type DecodeResult,
} from './codec.ts';

export {
  renderAvatar2d,
  renderAvatar3d,
  renderCape,
  renderPreview,
  type Avatar2dResult,
  type PreviewResult,
} from './derive.ts';

export {
  SkinRenderer,
  render2dAvatar,
  render3dAvatar,
  renderSkinDual,
  assertRenderableSize,
  type RgbaImage,
  type RendererOptions,
} from './renderer.ts';

export {
  validateTexture,
  textureObjectKey,
  avatarObjectKey,
  previewObjectKey,
  isAllowedDerivativeSize,
  DEFAULT_TEXTURE_LIMITS,
  type TextureLimits,
  type TextureValidation,
  type ValidatedTexture,
} from './texture.ts';

export {
  buildPlayerProfile,
  serializePlayerProfile,
  textureEtag,
  playerProfileEtag,
  PLAYER_PROFILE_CACHE_CONTROL,
  TEXTURE_CACHE_CONTROL,
  DERIVATIVE_CACHE_CONTROL,
  PLAYER_BANNED_MESSAGE,
  TEXTURE_OBJECT_MISSING_STATUS,
  type PlayerProfile,
  type BuildProfileInput,
  type CslSkinKey,
} from './csl.ts';
