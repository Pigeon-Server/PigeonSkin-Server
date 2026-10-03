// analyze 命令 —— 迁移前必跑的第一步。
//
// 它是只读的，且在写入任何东西之前回答"这次迁移是否可能"。
// 它的存在意义是把"切换当天的意外"变成"办公桌前的决策"：
// 每一个阻塞项都必须在动数据之前解决，每一个警告都必须被知晓或显式接受。
//
// 对应文档：docs/rewrite/09-migration-tool.md §3
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceAdapter } from '../sources/types.ts';
import {
  ALGOS_REQUIRING_LEGACY_SALT,
  DROPPED_LEGACY_TABLES,
  DROPPED_OPTION_KEYS,
  LEGACY_DEFAULT_TIMEZONE,
  LOCALE_ALIASES,
  MIGRATED_PLUGIN_TABLES,
  OPTION_KEY_MAP,
  PWD_METHOD_TO_ALGO,
  REQUIRED_LEGACY_TABLES,
  OPTIONAL_LEGACY_TABLES,
  splitLocalizedOptionKey,
  type LegacyPasswordAlgo,
} from '../schema/legacy.ts';
import { decideVerdict, type AnalyzeReport, type Finding, type TableStatus } from '../lib/report.ts';

export interface AnalyzeOptions {
  readonly source: SourceAdapter;
  /** 旧站 storage/textures 目录；不给就跳过文件检查 */
  readonly texturesDir?: string | undefined;
  readonly timeZone?: string;
  /** 旧站 .env 里的 PWD_METHOD；决定密码算法 */
  readonly pwdMethod?: string | undefined;
  /** 旧站 .env 里的 SALT；仅 SALTED2* 需要 */
  readonly legacySalt?: string | null | undefined;
  /** 已知 locale 列表，用于识别 site_name_en 这类本地化键 */
  readonly knownLocales?: readonly string[];
  /** 跳过文件哈希校验（大库预检时可以省时间，但会漏掉哈希不符） */
  readonly skipFileHash?: boolean;
}

const DEFAULT_LOCALES = ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU'];
const SAMPLE_LIMIT = 20;

function finding(
  code: string,
  severity: Finding['severity'],
  title: string,
  count: number,
  samples: readonly (string | number)[] = [],
  remediation?: string,
): Finding {
  return {
    code,
    severity,
    title,
    count,
    samples: samples.slice(0, SAMPLE_LIMIT).map(String),
    ...(remediation ? { remediation } : {}),
  };
}

export async function analyze(opts: AnalyzeOptions): Promise<AnalyzeReport> {
  const { source } = opts;
  const timeZone = opts.timeZone ?? LEGACY_DEFAULT_TIMEZONE;
  const knownLocales = opts.knownLocales ?? DEFAULT_LOCALES;
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};

  // ── 表存在性与行数 ─────────────────────────────────────────────────────────
  const existingTables = new Set(await source.listTables());
  const tables: TableStatus[] = [];

  for (const name of REQUIRED_LEGACY_TABLES) {
    const present = existingTables.has(name);
    tables.push({ name, present, rows: present ? await source.count(name) : null });
    if (!present) {
      findings.push(finding('missing-required-table', 'blocker',
        `必需表缺失: ${name}`, 1, [name], '确认连接的是 Blessing Skin 数据库'));
    }
  }
  for (const name of OPTIONAL_LEGACY_TABLES) {
    const present = existingTables.has(name);
    tables.push({
      name,
      present,
      rows: present ? await source.count(name) : null,
      // exactOptionalPropertyTypes 下不能传 note: undefined，只能条件展开
      ...(present ? {} : { note: 'optional' }),
    });
    if (!present) {
      findings.push(finding('missing-optional-table', 'info',
        `可选表不存在，相关内容将不迁移: ${name}`, 1, [name]));
    }
  }
  for (const name of DROPPED_LEGACY_TABLES) {
    if (existingTables.has(name)) {
      tables.push({ name, present: true, rows: await source.count(name), note: 'dropped' });
    }
  }
  for (const name of MIGRATED_PLUGIN_TABLES) {
    if (existingTables.has(name)) tables.push({name,present:true,rows:await source.count(name),note:'plugin'});
  }
  const classified = new Set(tables.map(table=>table.name));
  const unmapped: TableStatus[] = [];
  for (const name of existingTables) {
    if (!classified.has(name)) {
      const table={name,present:true,rows:await source.count(name),note:'unmapped'};
      tables.push(table);unmapped.push(table);
    }
  }
  const nonemptyUnmapped=unmapped.filter(table=>(table.rows ?? 0)>0);
  if(nonemptyUnmapped.length) findings.push(finding('unmapped-legacy-tables','warning','存在未映射的非空旧表，相关数据不会导入',nonemptyUnmapped.length,nonemptyUnmapped.map(table=>`${table.name} (${table.rows} 行)`),'保留旧快照，并为这些表确认迁移映射后再导入相关数据'));

  for (const t of tables) {
    if (t.rows !== null) counts[t.name] = t.rows;
  }

  const has = (t: string) => existingTables.has(t);

  // ── 密码算法 ───────────────────────────────────────────────────────────────
  // 算法是部署级设置（PWD_METHOD），不在行里 —— 绝不能靠嗅探哈希字符串，
  // 因为裸十六进制家族有歧义（64 位可能是 sha256 也可能是 salted2sha256）。
  if (has('users')) {
    let algo: LegacyPasswordAlgo | null = null;
    if (opts.pwdMethod) {
      algo = PWD_METHOD_TO_ALGO[opts.pwdMethod.toUpperCase()] ?? null;
      if (!algo) {
        findings.push(finding('unknown-pwd-method', 'blocker',
          `无法识别的 PWD_METHOD: ${opts.pwdMethod}`, 1, [opts.pwdMethod],
          '确认旧站 .env 的 PWD_METHOD，或在 app/Services/Cipher/ 下找到对应实现'));
      }
    } else {
      findings.push(finding('pwd-method-missing', 'warning',
        '未提供 PWD_METHOD，无法确定密码算法', 1, [],
        '从旧站 .env 读取 PWD_METHOD 后通过 --pwd-method 传入；' +
        '默认值为 BCRYPT（其哈希忽略 SALT 参数）'));
    }

    if (algo) {
      const needsSalt = ALGOS_REQUIRING_LEGACY_SALT.has(algo);
      if (needsSalt && !opts.legacySalt) {
        const userCount = await source.count('users');
        findings.push(finding('legacy-salt-missing', 'blocker',
          `PWD_METHOD=${opts.pwdMethod} 需要旧站 SALT，但未提供`, userCount,
          [],
          '这些账号用任何代码都验证不了。要么找回旧站 .env 里的 SALT 并传 --legacy-salt，' +
          '要么接受这部分用户强制重置密码'));
      }
      findings.push(finding('password-algorithm', 'info',
        `密码算法: ${algo}${needsSalt ? '（需要 SALT，已提供）' : '（不需要 SALT）'}`, 0));
    }
  }

  // ── users ─────────────────────────────────────────────────────────────────
  if (has('users')) {
    const emptyEmails = await source.query<{ uid: number }>(
      `SELECT uid FROM users WHERE email IS NULL OR TRIM(email) = ''`);
    if (emptyEmails.length > 0) {
      findings.push(finding('empty-email', 'blocker',
        '存在空邮箱账号', emptyEmails.length,
        emptyEmails.map((r) => `uid=${r.uid}`),
        '新 schema 要求 email 唯一非空，空值无法满足。需人工提供占位地址' +
        '（如 uid-{uid}@invalid.local）或把这些账号标记走补填流程'));
    }

    const dupEmails = await source.query<{ email: string; n: number; uids: string }>(
      `SELECT LOWER(email) AS email, COUNT(*) AS n, GROUP_CONCAT(uid) AS uids
         FROM users WHERE TRIM(email) <> '' GROUP BY LOWER(email) HAVING COUNT(*) > 1`);
    if (dupEmails.length > 0) {
      findings.push(finding('duplicate-email', 'warning',
        '存在重复邮箱，关联账号将保留并在登录时处理冲突', dupEmails.length,
        dupEmails.map((r) => `${r.email} → uid ${r.uids}`),
        '旧库只在应用层校验唯一性且没有唯一索引，因此可能产生重复。' +
        '登录时验证关联账号凭据，由用户选择保留账号并合并数据'));
    }

    const aliasLocales = await source.query<{ uid: number; locale: string }>(
      `SELECT uid, locale FROM users WHERE locale IS NOT NULL AND locale <> ''`);
    const aliased = aliasLocales.filter((r) => LOCALE_ALIASES[r.locale]);
    if (aliased.length > 0) {
      findings.push(finding('locale-alias', 'info',
        '存在需要归一化的 locale 别名', aliased.length,
        aliased.map((r) => `uid=${r.uid} ${r.locale}→${LOCALE_ALIASES[r.locale]}`)));
    }

    const badPermission = await source.query<{ uid: number; permission: number }>(
      `SELECT uid, permission FROM users WHERE permission NOT IN (-1, 0, 1, 2)`);
    if (badPermission.length > 0) {
      findings.push(finding('unknown-permission', 'warning',
        '存在无法映射的角色值，将回落为 normal', badPermission.length,
        badPermission.map((r) => `uid=${r.uid} permission=${r.permission}`),
        '旧 permission 是 -1/0/1/2 的有序等级，其他值没有对应语义'));
    }

    // 头像指向不存在的纹理
    if (has('textures')) {
      const badAvatar = await source.query<{ uid: number; avatar: number }>(
        `SELECT uid, avatar FROM users
          WHERE avatar > 0 AND avatar NOT IN (SELECT tid FROM textures)`);
      if (badAvatar.length > 0) {
        findings.push(finding('orphan-user-avatar', 'warning',
          '用户的头像 tid 指向不存在的纹理，将置空', badAvatar.length,
          badAvatar.map((r) => `uid=${r.uid} avatar=${r.avatar}`)));
      }
    }
  }

  // ── players ───────────────────────────────────────────────────────────────
  if (has('players')) {
    const collides = await source.query<{ name: string; n: number; pids: string }>(
      `SELECT LOWER(name) AS name, COUNT(*) AS n, GROUP_CONCAT(pid) AS pids
         FROM players GROUP BY LOWER(name) HAVING COUNT(*) > 1`);
    if (collides.length > 0) {
      findings.push(finding('player-name-case-collision', 'blocker',
        '玩家名存在不区分大小写的冲突', collides.length,
        collides.map((r) => `${r.name} → pid ${r.pids}`),
        '新 schema 有 UNIQUE(name COLLATE NOCASE)。静默改名会改变 Minecraft 客户端' +
        '解析的结果，必须由人工决定哪个账号保留该名字'));
    }

    const orphanOwner = await source.query<{ pid: number; uid: number }>(
      `SELECT pid, uid FROM players WHERE uid NOT IN (SELECT uid FROM users)`);
    if (orphanOwner.length > 0) {
      findings.push(finding('orphan-player-owner', 'blocker',
        '玩家所属的用户不存在，该玩家将不可达', orphanOwner.length,
        orphanOwner.map((r) => `pid=${r.pid} uid=${r.uid}`),
        '旧库没有外键，这类悬空行是可能的。需人工决定归属或删除'));
    }

    if (has('textures')) {
      const orphanTex = await source.query<{ pid: number; tid: number }>(
        `SELECT pid, tid_skin AS tid FROM players
          WHERE tid_skin > 0 AND tid_skin NOT IN (SELECT tid FROM textures)`);
      if (orphanTex.length > 0) {
        findings.push(finding('orphan-player-texture-ref', 'warning',
          '玩家皮肤指向不存在的纹理，将置空', orphanTex.length,
          orphanTex.map((r) => `pid=${r.pid} tid_skin=${r.tid}`)));
      }
      const orphanCape = await source.query<{ pid: number; tid: number }>(
        `SELECT pid, tid_cape AS tid FROM players
          WHERE tid_cape > 0 AND tid_cape NOT IN (SELECT tid FROM textures)`);
      if (orphanCape.length > 0) {
        findings.push(finding('orphan-player-cape-ref', 'warning',
          '玩家披风指向不存在的纹理，将置空', orphanCape.length,
          orphanCape.map((r) => `pid=${r.pid} tid_cape=${r.tid}`)));
      }
    }
  }

  // ── textures ──────────────────────────────────────────────────────────────
  let textureHashes: Array<{ tid: number; hash: string }> = [];
  if (has('textures')) {
    const badType = await source.query<{ tid: number; type: string }>(
      `SELECT tid, type FROM textures WHERE type NOT IN ('steve','alex','cape')`);
    if (badType.length > 0) {
      findings.push(finding('unknown-texture-type', 'warning',
        '存在无法识别的纹理类型，将回落为 steve/default', badType.length,
        badType.map((r) => `tid=${r.tid} type=${r.type}`)));
    }

    const dupHash = await source.query<{ hash: string; n: number; tids: string }>(
      `SELECT hash, COUNT(*) AS n, GROUP_CONCAT(tid) AS tids
         FROM textures GROUP BY hash HAVING COUNT(*) > 1`);
    if (dupHash.length > 0) {
      const totalRows = dupHash.reduce((s, r) => s + r.n, 0);
      findings.push(finding('duplicate-texture-hash', 'info',
        '存在多行共享同一哈希（R2 侧只需一个对象）', totalRows,
        dupHash.slice(0, 5).map((r) => `${r.hash.slice(0, 12)}… → tid ${r.tids}`),
        '新 schema 有意不加 hash 唯一约束：加约束会强制重映射 tid，' +
        '而 R2 的对象身份已由哈希键去重'));
    }

    textureHashes = await source.query<{ tid: number; hash: string }>(
      `SELECT tid, hash FROM textures`);

    const orphanUploader = await source.query<{ tid: number; uploader: number }>(
      `SELECT tid, uploader FROM textures
        WHERE uploader <> 0 AND uploader NOT IN (SELECT uid FROM users)`);
    if (orphanUploader.length > 0) {
      findings.push(finding('orphan-texture-uploader', 'warning',
        '纹理的上传者不存在，将置为 NULL（显示为已注销用户）', orphanUploader.length,
        orphanUploader.map((r) => `tid=${r.tid} uploader=${r.uploader}`)));
    }
  }

  // ── 纹理文件 ───────────────────────────────────────────────────────────────
  if (opts.texturesDir && textureHashes.length > 0) {
    findings.push(...checkTextureFiles(opts.texturesDir, textureHashes, opts.skipFileHash ?? false));
  }

  // ── options ───────────────────────────────────────────────────────────────
  if (has('options')) {
    const rows = await source.query<{ option_name: string; option_value: string }>(
      `SELECT option_name, option_value FROM options`);
    const mapped: string[] = [];
    const localized: string[] = [];
    const dropped: string[] = [];
    const unknown: string[] = [];

    for (const r of rows) {
      const key = r.option_name;
      if (key in OPTION_KEY_MAP) { mapped.push(key); continue; }
      if (key in DROPPED_OPTION_KEYS) { dropped.push(key); continue; }
      if (splitLocalizedOptionKey(key, knownLocales)) { localized.push(key); continue; }
      unknown.push(key);
    }

    if (dropped.length > 0) {
      findings.push(finding('dropped-option-keys', 'warning',
        '存在有意丢弃的配置项', dropped.length,
        dropped.map((k) => `${k}（${DROPPED_OPTION_KEYS[k]}）`),
        '这些配置在新架构里没有对应物（多被 Cloudflare 吸收）。' +
        '报告在此点名，避免运维以为配置被忘了'));
    }
    if (unknown.length > 0) {
      findings.push(finding('unknown-option-keys', 'warning',
        '存在未识别的配置项，将原样保留', unknown.length,
        unknown.map((k) => {
          const v = rows.find((r) => r.option_name === k)?.option_value ?? '';
          return `${k}=${v.slice(0, 30)}`;
        }),
        '可能是插件留下的配置。原样迁移，不静默丢弃'));
    }

    findings.push(finding('option-summary', 'info',
      `配置项: 已映射 ${mapped.length} · 本地化 ${localized.length} · ` +
      `有意丢弃 ${dropped.length} · 未识别 ${unknown.length}`, 0));
    counts['options.mapped'] = mapped.length;
    counts['options.localized'] = localized.length;
    counts['options.dropped'] = dropped.length;
    counts['options.unknown'] = unknown.length;
  }

  // ── user_closet ───────────────────────────────────────────────────────────
  if (has('user_closet')) {
    const dups = await source.query<{ user_uid: number; texture_tid: number; n: number }>(
      `SELECT user_uid, texture_tid, COUNT(*) AS n FROM user_closet
        GROUP BY user_uid, texture_tid HAVING COUNT(*) > 1`);
    if (dups.length > 0) {
      const extra = dups.reduce((s, r) => s + r.n - 1, 0);
      findings.push(finding('duplicate-closet-rows', 'warning',
        '存在重复的收藏行（旧表无主键）', extra,
        dups.map((r) => `uid=${r.user_uid} tid=${r.texture_tid} ×${r.n}`),
        '新表有 PRIMARY KEY(user_id, texture_id)，需去重（保留最早一条）。' +
        '注意这也会让 textures.likes 相对真实收藏者数偏高'));
    }

    const dangling = await source.query<{ user_uid: number; texture_tid: number }>(
      `SELECT user_uid, texture_tid FROM user_closet
        WHERE texture_tid NOT IN (SELECT tid FROM textures)`);
    if (dangling.length > 0) {
      findings.push(finding('dangling-closet-ref', 'warning',
        '收藏行指向不存在的纹理，将被丢弃', dangling.length,
        dangling.map((r) => `uid=${r.user_uid} tid=${r.texture_tid}`),
        '指向不存在纹理的收藏条目没有意义，直接丢弃'));
    }

    const orphanUser = await source.query<{ user_uid: number }>(
      `SELECT DISTINCT user_uid FROM user_closet WHERE user_uid NOT IN (SELECT uid FROM users)`);
    if (orphanUser.length > 0) {
      findings.push(finding('dangling-closet-user', 'warning',
        '收藏行属于不存在的用户，将被丢弃', orphanUser.length,
        orphanUser.map((r) => `uid=${r.user_uid}`)));
    }
  }

  // ── reports ───────────────────────────────────────────────────────────────
  if (has('reports')) {
    const dups = await source.query<{ reporter: number; tid: number; n: number }>(
      `SELECT reporter, tid, COUNT(*) AS n FROM reports
        GROUP BY reporter, tid HAVING COUNT(*) > 1`);
    if (dups.length > 0) {
      const extra = dups.reduce((s, r) => s + r.n - 1, 0);
      findings.push(finding('duplicate-reports', 'warning',
        '存在重复举报（同一举报人对同一纹理）', extra,
        dups.map((r) => `reporter=${r.reporter} tid=${r.tid} ×${r.n}`),
        '新表有 UNIQUE(reporter_id, texture_id)，需去重（保留最早一条）'));
    }

    const missingTex = await source.query<{ id: number; tid: number }>(
      `SELECT id, tid FROM reports WHERE tid NOT IN (SELECT tid FROM textures)`);
    if (missingTex.length > 0) {
      findings.push(finding('missing-report-texture', 'warning',
        '举报对应的纹理已不存在，该举报将被丢弃', missingTex.length,
        missingTex.map((r) => `report=${r.id} tid=${r.tid}`)));
    }
  }

  // ── notifications ─────────────────────────────────────────────────────────
  if (has('notifications')) {
    const rows = await source.query<{ id: string; data: string }>(
      `SELECT id, data FROM notifications`);
    const badShape: string[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.data) as Record<string, unknown>;
        if (typeof parsed['title'] !== 'string') badShape.push(r.id);
      } catch {
        badShape.push(r.id);
      }
    }
    if (badShape.length > 0) {
      findings.push(finding('notification-data-shape', 'warning',
        '通知的 data 结构不符合预期（缺少 title），将用占位标题', badShape.length,
        badShape.map((id) => `id=${id}`),
        '旧版 SiteMessage::toArray() 返回 {title, content}，但插件可能存过别的结构。' +
        '抽样报告以便在迁移前发现，而不是产生一堆空通知'));
    }
  }

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  return {
    source: source.describe,
    legacyTimeZone: timeZone,
    generatedAt: new Date().toISOString(),
    tables,
    counts,
    findings,
    verdict: decideVerdict(findings),
  };
}

function severityRank(s: Finding['severity']): number {
  return s === 'blocker' ? 0 : s === 'warning' ? 1 : 2;
}

/**
 * 纹理文件与数据行的对照。旧库把文件放在扁平目录里、无扩展名、文件名即 sha256。
 * 这里同时找出：缺失文件、哈希不符、孤儿文件。
 */
function checkTextureFiles(
  texturesDir: string,
  rows: readonly { tid: number; hash: string }[],
  skipHash: boolean,
): Finding[] {
  const out: Finding[] = [];
  const dir = resolve(texturesDir);

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    out.push(finding('textures-dir-missing', 'warning',
      `纹理目录不存在或不是目录: ${dir}`, 1, [dir],
      '若旧站使用远程存储（FS_DRIVER 非 local），需要先把文件同步到本地再迁移'));
    return out;
  }

  // 扫描磁盘：文件名即哈希
  const onDisk = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = resolve(dir, name);
    try {
      if (statSync(full).isFile()) onDisk.add(name);
    } catch { /* 读不到的条目跳过 */ }
  }

  const rowHashes = new Set(rows.map((r) => r.hash));
  const missing: string[] = [];
  const mismatch: string[] = [];

  for (const r of rows) {
    if (!onDisk.has(r.hash)) {
      missing.push(`tid=${r.tid} ${r.hash.slice(0, 12)}…`);
      continue;
    }
    if (skipHash) continue;
    // 校验"哈希即内容地址"这一不变量：旧库写入的正是它哈希过的字节，
    // 除非插件用 uploaded_texture_hash 过滤器返回了别的值。
    const actual = createHash('sha256').update(readFileSync(resolve(dir, r.hash))).digest('hex');
    if (actual !== r.hash) {
      mismatch.push(`tid=${r.tid} 声明 ${r.hash.slice(0, 10)}… 实际 ${actual.slice(0, 10)}…`);
    }
  }

  const orphans: string[] = [];
  for (const name of onDisk) {
    if (!rowHashes.has(name)) orphans.push(name.slice(0, 16) + '…');
  }

  if (missing.length > 0) {
    out.push(finding('texture-file-missing', 'warning',
      '纹理行对应的文件不存在', missing.length, missing,
      '默认仍迁移这些行，请求时返回 503（可见、可诊断）；' +
      '带 --skip-missing 可改为丢弃这些行'));
  }
  if (mismatch.length > 0) {
    out.push(finding('texture-hash-mismatch', 'blocker',
      '磁盘文件内容与存储的哈希不符', mismatch.length, mismatch,
      '绝不自动改写哈希：改写会破坏每个客户端已缓存的纹理和每一处玩家皮肤引用。' +
      '需人工排查（常见原因：插件用过 uploaded_texture_hash 过滤器）'));
  }
  if (orphans.length > 0) {
    out.push(finding('orphan-texture-file', 'warning',
      '磁盘上存在没有对应数据行的文件', orphans.length, orphans,
      '不自动导入：孤儿可能是失败上传的残留或已被删除的纹理，' +
      '导入会复活运维有意移除的内容。带 --import-orphans 可显式导入'));
  }

  out.push(finding('texture-file-summary', 'info',
    `纹理文件: 磁盘 ${onDisk.size} 个 · 数据行 ${rows.length} 条 · ` +
    `缺失 ${missing.length} · 哈希不符 ${mismatch.length} · 孤儿 ${orphans.length}`, 0));

  return out;
}
