// textures 命令组：import / export。
// 关键不变量：textures.hash = sha256(字节) = R2 键 textures/<hash>.png。
// 管理导入不扣积分、不发通知 —— 这是运维通道，不是用户上传通道。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validateTexture, textureObjectKey } from '@pigeon-skin/minecraft';
import type { TextureKind, TextureModel } from '@pigeon-skin/shared';
import type { TargetEnv } from '../lib/env.ts';
import { d1Query, d1ExecuteFile, r2Put, r2Get } from '../lib/wrangler.ts';
import { sqlText, sqlIntOrNull, isHashHex } from '../lib/sql.ts';
import { resolveExistingDir, resolveOutputPath } from '../lib/paths.ts';
import { flagString, flagInt, hasFlag, type ParsedArgs } from '../lib/args.ts';
import { resolveHttpChannel, httpUploadBatch } from './http-import.ts';

export async function runTextures(env: TargetEnv, action: string, parsed: ParsedArgs): Promise<number> {
  switch (action) {
    case 'import': return texturesImport(env, parsed.flags);
    case 'export': return texturesExport(env, parsed.flags);
    default:
      throw new Error(`未知 textures 子命令 "${action}"（可用: import | export）`);
  }
}

// ── import ──────────────────────────────────────────────────────────────────

interface ManifestEntry {
  name?: string;
  kind?: string;
  model?: string | null;
  visibility?: string;
  origin?: string;
}

interface ImportPlanItem {
  file: string;
  bytes: Uint8Array;
  hash: string;
  width: number;
  height: number;
  kind: TextureKind;
  model: TextureModel | null;
  name: string;
  visibility: 'public' | 'private';
  origin: 'original' | 'repost';
}

function parseKindModel(
  kindText: string | undefined,
  modelText: string | undefined,
  entry: ManifestEntry,
): { kind: TextureKind; model: TextureModel | null } {
  const kind = (entry.kind ?? kindText) as TextureKind | undefined;
  if (kind !== 'skin' && kind !== 'cape') {
    throw new Error('需要 --kind skin|cape（manifest 里可用 kind 覆盖）');
  }
  let model: TextureModel | null;
  const modelStr = kind === 'cape' ? null : (entry.model !== undefined ? entry.model : (modelText ?? 'default'));
  if (kind === 'cape') {
    model = null;
  } else if (modelStr === 'default' || modelStr === 'slim') {
    model = modelStr;
  } else {
    throw new Error(`model 只支持 default|slim（收到 ${modelStr}）`);
  }
  return { kind, model };
}

function parseVisibility(v: string | undefined, fallback: 'public' | 'private'): 'public' | 'private' {
  if (v === undefined) return fallback;
  if (v === 'public' || v === 'private') return v;
  throw new Error(`visibility 只支持 public|private（收到 ${v}）`);
}

function parseOrigin(v: string | undefined, fallback: 'original' | 'repost'): 'original' | 'repost' {
  if (v === undefined) return fallback;
  if (v === 'original' || v === 'repost') return v;
  throw new Error(`origin 只支持 original|repost（收到 ${v}）`);
}

async function texturesImport(env: TargetEnv, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const dir = resolveExistingDir(flagString(flags, 'dir') ?? '', '--dir');
  const uploader = flagString(flags, 'uploader');

  // uploader 解析为 users.id；不指定则 NULL（与"已注销用户"同语义）
  let uploaderId: number | null = null;
  let uploaderEmail = '';
  if (uploader !== undefined) {
    const asNumber = Number(uploader);
    // email 列是 COLLATE NOCASE，用 lower(email) 匹配保持一致语义
    const row = Number.isSafeInteger(asNumber) && asNumber > 0
      ? d1Query(env, `SELECT id, email FROM users WHERE id = ${asNumber}`)[0]
      : d1Query(env, `SELECT id, email FROM users WHERE lower(email) = ${sqlText(uploader.trim().toLowerCase())}`)[0];
    if (!row || row.id === null) throw new Error(`uploader 用户不存在: ${uploader}`);
    uploaderId = row.id as number;
    uploaderEmail = row.email as string;
  }

  const defaultKind = flagString(flags, 'kind');
  const defaultModel = flagString(flags, 'model');
  const defaultVisibility = parseVisibility(flagString(flags, 'visibility'), 'public');
  const defaultOrigin = parseOrigin(flagString(flags, 'origin'), 'original');

  // manifest.json（可选）：逐文件覆盖 name/kind/model/visibility/origin；
  // manifest 必须位于 --dir 内（文件名键相对于该目录解析）
  const entries = new Map<string, ManifestEntry>();
  const manifestPath = flagString(flags, 'manifest');
  if (manifestPath !== undefined) {
    const manifestFile = join(dir, basename(manifestPath));
    if (!existsSync(manifestFile)) {
      throw new Error(`--manifest 需是 --dir 内的文件（收到: ${manifestPath}，解析为 ${manifestFile}）`);
    }
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestEntry>;
    for (const [file, entry] of Object.entries(raw)) entries.set(file, entry ?? {});
  }

  // 收集并校验 PNG：校验（结构/尺寸/宽高比）与哈希计算复用与 API 上传同一实现
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png') && statSync(join(dir, f)).isFile());
  if (files.length === 0) throw new Error(`目录内没有 PNG 文件: ${dir}`);
  const plan: ImportPlanItem[] = [];
  const failures: { file: string; reason: string }[] = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(readFileSync(join(dir, file)));
      const entry = entries.get(file) ?? {};
      const { kind, model } = parseKindModel(defaultKind, defaultModel, entry);
      const validated = await validateTexture(bytes, { kind, model });
      if (!validated.ok) {
        failures.push({ file, reason: `${validated.code}: ${validated.message}` });
        continue;
      }
      plan.push({
        file,
        bytes,
        hash: validated.value.hash,
        width: validated.value.info.width,
        height: validated.value.info.height,
        kind,
        model,
        name: (entry.name ?? basename(file, '.png')).slice(0, 64),
        visibility: parseVisibility(entry.visibility, defaultVisibility),
        origin: parseOrigin(entry.origin, defaultOrigin),
      });
    } catch (e) {
      failures.push({ file, reason: (e as Error).message });
    }
  }
  if (plan.length === 0) {
    console.error('没有任何文件通过校验：');
    for (const f of failures) console.error(`  ✗ ${f.file}: ${f.reason}`);
    return 1;
  }

  // 按 hash 去重（同内容文件只上传一次、只插一行元数据）
  const distinct = new Map<string, ImportPlanItem>();
  for (const item of plan) if (!distinct.has(item.hash)) distinct.set(item.hash, item);

  // 已存在判定：同 hash + 同 uploader 的元数据行视为已导入
  const hashes = [...distinct.keys()];
  const existingRows = new Set<string>();
  for (let i = 0; i < hashes.length; i += 40) {
    const chunk = hashes.slice(i, i + 40);
    const inList = chunk.map((h) => `'${h}'`).join(',');
    const rows = d1Query(env, `SELECT hash, uploader_id FROM textures WHERE hash IN (${inList})`);
    for (const r of rows) {
      existingRows.add(`${r.hash}:${r.uploader_id === null ? '' : r.uploader_id}`);
    }
  }
  const pending = [...distinct.values()].filter((item) => !existingRows.has(`${item.hash}:${uploaderId ?? ''}`));
  const skipped = distinct.size - pending.length;

  console.log(`导入计划 → ${env.label}`);
  console.log(`  文件: ${files.length}，通过校验: ${plan.length}，去重后: ${distinct.size}，已存在跳过: ${skipped}，待写入: ${pending.length}`);
  console.log(`  uploader: ${uploaderEmail || '（无，元数据行为 NULL）'}`);
  if (failures.length > 0) {
    console.log(`  校验失败 ${failures.length} 个:`);
    for (const f of failures.slice(0, 20)) console.log(`    ✗ ${f.file}: ${f.reason}`);
  }
  if (pending.length === 0) { console.log('无需写入'); return 0; }

  // HTTP 通道（--api-key）：经站点管理端点上传，warm 连接真实并发；
  // 未提供时回落 wrangler 通道（先 R2 后 D1，本地必须串行）
  if (hasFlag(flags, 'api-key') && flagString(flags, 'api-key') === undefined) {
    throw new Error('--api-key 需要一个值（管理界面「Pigeon API」签发，scope: admin.texture.import）');
  }
  if (flagString(flags, 'api-key') !== undefined) {
    const channel = resolveHttpChannel(env, flags);
    if (!channel) throw new Error('--api-key 需要一个值');
    console.log(`通道: HTTP → ${channel.siteUrl}（并发 ${channel.concurrency}）`);
    const result = await httpUploadBatch(
      channel,
      pending.map((item) => ({
        file: item.file,
        localHash: item.hash,
        params: { kind: item.kind, model: item.model, visibility: item.visibility, origin: item.origin, uploader: uploaderEmail || null, name: item.name },
      })),
      dir,
      (done, total) => console.log(`  进度: ${done}/${total}`),
    );
    console.log(`完成: 新写入 ${result.ok}，服务端跳过已存在 ${result.skipped}，失败 ${result.failures.length}`);
    for (const f of result.failures.slice(0, 20)) console.error(`  ✗ ${f.file}: ${f.reason}`);
    return result.failures.length > 0 ? 1 : 0;
  }

  console.log('通道: wrangler（本地串行；批量导入建议 --api-key 走站点管理端点）');
  // R2 上传（内容寻址键，幂等）+ D1 元数据。先 R2 后 D1：行可见时对象一定在。
  const ts = Date.now();
  let uploaded = 0;
  const statements: string[] = [];
  for (const item of pending) {
    r2Put(env, textureObjectKey(item.hash), join(dir, item.file));
    uploaded++;
    statements.push(
      `INSERT OR IGNORE INTO textures (hash, kind, model, name, uploader_id, origin, size_bytes, visibility, width, height, likes, created_at, updated_at) `
      + `VALUES (${sqlText(item.hash)}, ${sqlText(item.kind)}, ${item.model === null ? 'NULL' : sqlText(item.model)}, ${sqlText(item.name)}, ${sqlIntOrNull(uploaderId)}, ${sqlText(item.origin)}, ${item.bytes.length}, ${sqlText(item.visibility)}, ${item.width}, ${item.height}, 0, ${ts}, ${ts})`,
    );
    if (statements.length >= 50) { d1ExecuteFile(env, statements); statements.length = 0; }
  }
  if (statements.length > 0) d1ExecuteFile(env, statements);

  console.log(`完成: R2 上传 ${uploaded} 个对象，写入 ${pending.length} 行 textures${skipped > 0 ? `，跳过已存在 ${skipped}` : ''}。`);
  return failures.length > 0 ? 1 : 0;
}

// ── export ──────────────────────────────────────────────────────────────────

interface ExportedTexture {
  id: number;
  hash: string;
  kind: string;
  model: string | null;
  name: string;
  uploaderId: number | null;
  origin: string;
  sizeBytes: number;
  visibility: string;
  width: number;
  height: number;
  likes: number;
  createdAt: number;
}

async function texturesExport(env: TargetEnv, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const outDir = resolveOutputPath(flagString(flags, 'out') ?? '', '--out');
  const kind = flagString(flags, 'kind');
  if (kind !== undefined && kind !== 'skin' && kind !== 'cape') {
    throw new Error(`--kind 只支持 skin|cape（收到 ${kind}）`);
  }
  const limit = flagInt(flags, 'limit');

  const where = kind ? `WHERE kind = '${kind}'` : '';
  const countRows = d1Query(env, `SELECT COUNT(*) AS n FROM textures ${where}`);
  const total = Number(countRows[0]?.n ?? 0);
  const cap = limit ?? total;
  console.log(`导出 ${env.label} textures（${kind ?? '全部'}）: ${total} 行，本次上限 ${cap}`);

  mkdirSync(outDir, { recursive: true });
  const exported: ExportedTexture[] = [];
  const missing: string[] = [];
  const pageSize = 100;
  let offset = 0;
  while (exported.length < cap) {
    const rows = d1Query(
      env,
      `SELECT id, hash, kind, model, name, uploader_id, origin, size_bytes, visibility, width, height, likes, created_at `
      + `FROM textures ${where} ORDER BY id LIMIT ${pageSize} OFFSET ${offset}`,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (exported.length >= cap) break;
      const hash = row.hash;
      if (!isHashHex(hash)) { missing.push(`${row.id}: hash 非法`); continue; }
      const file = `${hash}.png`;
      const dest = join(outDir, file);
      if (!r2Get(env, textureObjectKey(hash), dest)) {
        missing.push(`#${row.id} ${hash}: R2 对象缺失`);
        continue;
      }
      exported.push({
        id: row.id as number,
        hash,
        kind: row.kind as string,
        model: row.model === null ? null : String(row.model),
        name: row.name as string,
        uploaderId: row.uploader_id === null ? null : Number(row.uploader_id),
        origin: row.origin as string,
        sizeBytes: Number(row.size_bytes),
        visibility: row.visibility as string,
        width: Number(row.width),
        height: Number(row.height),
        likes: Number(row.likes),
        createdAt: Number(row.created_at),
      });
    }
    offset += pageSize;
  }

  // manifest.json 的 name 键 = 文件名，与 textures import --manifest 消费格式一致
  const manifest: Record<string, ManifestEntry> = {};
  for (const t of exported) {
    manifest[`${t.hash}.png`] = {
      name: t.name,
      kind: t.kind,
      model: t.model,
      visibility: t.visibility,
      origin: t.origin,
    };
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  writeFileSync(
    join(outDir, 'export-meta.json'),
    JSON.stringify({ env: env.name, exportedAt: new Date().toISOString(), count: exported.length, missing }, null, 2),
    { mode: 0o600 },
  );
  console.log(`完成: 导出 ${exported.length} 个文件 + manifest.json → ${outDir}`);
  if (missing.length > 0) {
    console.log(`⚠ R2 对象缺失 ${missing.length} 个（已在 export-meta.json 列出）:`);
    for (const m of missing.slice(0, 20)) console.log(`  ✗ ${m}`);
    return 1;
  }
  return 0;
}
