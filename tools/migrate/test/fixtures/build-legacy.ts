// 旧库 fixture 生成器。
//
// 为什么需要它：迁移工具的每一处逻辑（映射、去重、冲突检测、报告）
// 都必须对着**真实的脏数据**验证，而不是干净数据。真实旧库里存在
// 大小写重名、重复哈希、缺失文件、空邮箱、悬空引用、重复收藏行等等，
// 这些正是迁移会出错的地方。
//
// 本文件刻意造出文档 10 §12 列出的每一种场景，并导出一份 manifest，
// 让测试可以精确断言 analyze 的结果。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { makePng } from './png.ts';

// 与 src/sources/sqlite.ts 同样的原因：Vite/Vitest 会把 `node:sqlite`
// 剥成 `sqlite` 再按包名解析而失败。getBuiltinModule 对打包器不透明。
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export const FIXTURE_TIMEZONE = 'Asia/Shanghai';

/** 把 Date 格式化成旧库那种"不带时区的本地时间"字符串 */
function naive(d: Date, timeZone = FIXTURE_TIMEZONE): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(d);
}

const T0 = Date.UTC(2023, 0, 15, 2, 30, 0); // 2023-01-15 10:30 Asia/Shanghai
const at = (dayOffset: number) => naive(new Date(T0 + dayOffset * 86_400_000));
const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * 旧库的最终有效 schema —— 应用全部 20 个迁移之后的形态。
 * 注意：datetime 存 TEXT、布尔存 INTEGER、没有外键（旧版一个都没有）。
 */
const LEGACY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE users (
    uid                INTEGER PRIMARY KEY AUTOINCREMENT,
    email              TEXT    NOT NULL,
    nickname           TEXT    NOT NULL DEFAULT '',
    locale             TEXT,
    score              INTEGER NOT NULL DEFAULT 0,
    avatar             INTEGER NOT NULL DEFAULT 0,
    password           TEXT    NOT NULL,
    ip                 TEXT    NOT NULL,
    is_dark_mode       INTEGER NOT NULL DEFAULT 0,
    permission         INTEGER NOT NULL DEFAULT 0,
    last_sign_at       TEXT    NOT NULL,
    register_at        TEXT    NOT NULL,
    verified           INTEGER NOT NULL DEFAULT 0,
    verification_token TEXT    NOT NULL DEFAULT '',
    remember_token     TEXT
  )`,
  `CREATE TABLE players (
    pid           INTEGER PRIMARY KEY AUTOINCREMENT,
    uid           INTEGER NOT NULL,
    name          TEXT    NOT NULL,
    tid_cape      INTEGER NOT NULL DEFAULT 0,
    last_modified TEXT    NOT NULL,
    tid_skin      INTEGER NOT NULL DEFAULT -1
  )`,
  `CREATE TABLE textures (
    tid       INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    type      TEXT    NOT NULL,
    hash      TEXT    NOT NULL,
    size      INTEGER NOT NULL,
    uploader  INTEGER NOT NULL,
    public    INTEGER NOT NULL,
    upload_at TEXT    NOT NULL,
    likes     INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE options (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    option_name   TEXT NOT NULL,
    option_value  TEXT NOT NULL
  )`,
  `CREATE TABLE user_closet (
    user_uid    INTEGER NOT NULL,
    texture_tid INTEGER NOT NULL,
    item_name   TEXT
  )`,
  `CREATE TABLE reports (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tid       INTEGER NOT NULL,
    uploader  INTEGER NOT NULL,
    reporter  INTEGER NOT NULL,
    reason    TEXT NOT NULL,
    status    INTEGER NOT NULL DEFAULT 0,
    report_at TEXT NOT NULL
  )`,
  `CREATE TABLE notifications (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    notifiable_type TEXT NOT NULL,
    notifiable_id   INTEGER NOT NULL,
    data            TEXT NOT NULL,
    read_at         TEXT,
    created_at      TEXT,
    updated_at      TEXT
  )`,
  `CREATE TABLE language_lines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    "group"    TEXT NOT NULL,
    key        TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE uuid (
    name TEXT PRIMARY KEY,
    uuid TEXT UNIQUE
  )`,
  `CREATE TABLE textures_description (
    tid INTEGER PRIMARY KEY,
    description TEXT,
    created_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE TABLE scopes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL
  )`,
  `CREATE TABLE jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    queue        TEXT NOT NULL,
    payload      TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    reserved_at  INTEGER,
    available_at INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  )`,
];

/**
 * 该函数会**递归删除**目标目录，所以必须校验路径，避免误传 '/'、家目录
 * 或项目目录把真实文件删掉。只允许写入系统临时目录或路径中带 .tmp 段的目录。
 */
function assertSafeFixtureDir(dir: string): string {
  const abs = resolve(dir);
  const inTmp = abs === tmpdir() || abs.startsWith(tmpdir() + sep);
  const hasTmpSegment = abs.split(sep).includes('.tmp');
  if (!inTmp && !hasTmpSegment) {
    throw new Error(
      `拒绝在非临时目录生成 fixture（该操作会递归删除目标目录）: ${abs}\n` +
      `允许：系统临时目录（${tmpdir()}）或路径中含 .tmp 段的目录。`,
    );
  }
  if (abs === resolve('/') || abs.split(sep).filter(Boolean).length < 2) {
    throw new Error(`拒绝使用过于宽泛的路径: ${abs}`);
  }
  return abs;
}

export interface FixtureManifest {
  readonly dir: string;
  readonly dbPath: string;
  readonly texturesDir: string;
  /**
   * analyze 应当报告出来的内容。测试直接断言这些，因此这里是
   * "fixture 与 analyze 之间的契约" —— 改了 fixture 就要同步改这里。
   */
  readonly expected: {
    /** 每张表的行数 */
    readonly counts: Readonly<Record<string, number>>;
    /** 必须出现的阻塞项 code */
    readonly blockerCodes: readonly string[];
    /** 必须出现的警告 code */
    readonly warningCodes: readonly string[];
    /** 必须出现的提示 code */
    readonly infoCodes: readonly string[];
    /** 特定 code 的计数；不在表里的 code 不校验计数 */
    readonly findingCounts: Readonly<Record<string, number>>;
    /** 纹理文件对照的真实数字，供文件相关测试使用 */
    readonly textureFiles: {
      /** 磁盘上的文件总数（含孤儿） */
      readonly onDiskTotal: number;
      /** 被数据行引用且确实存在的唯一哈希数 */
      readonly referencedPresent: number;
      /** 数据行存在但磁盘缺文件的行数 */
      readonly missingRows: number;
      /** 磁盘上有、数据行里没有的文件数 */
      readonly orphanFiles: number;
      /** 内容与声明哈希不符的行数 */
      readonly hashMismatchRows: number;
      /** 共享哈希的行数合计（R2 侧只需更少的对象） */
      readonly rowsSharingHash: number;
    };
    /** 选项键分类计数 */
    readonly optionKeys: {
      readonly mapped: number;
      readonly localized: number;
      readonly dropped: number;
      readonly unknown: number;
    };
  };
}

/** 生成 fixture 到指定目录；目录会被清空重建（见 assertSafeFixtureDir 的护栏）。 */
export function buildLegacyFixture(targetDir: string): FixtureManifest {
  const dir = assertSafeFixtureDir(targetDir);
  rmSync(dir, { recursive: true, force: true });
  const texturesDir = resolve(dir, 'storage', 'textures');
  mkdirSync(texturesDir, { recursive: true });
  const dbPath = resolve(dir, 'legacy.sqlite');
  const db = new DatabaseSync(dbPath);

  for (const stmt of LEGACY_SCHEMA_STATEMENTS) db.prepare(stmt).run();

  // ── 纹理文件 ───────────────────────────────────────────────────────────────
  // 旧库把文件放在扁平目录里、无扩展名、文件名即 sha256。
  // 这里造出：正常文件、重复哈希、内容与哈希不符、缺失文件、孤儿文件。
  const files = new Map<number, { hash: string; bytes: Buffer; onDisk: boolean }>();
  const makeTex = (tid: number, w: number, h: number, seed: number, onDisk = true) => {
    const bytes = makePng(w, h, { pixel: (x, y) => [(x * seed) % 256, (y * seed) % 256, seed, 255] });
    const hash = sha256(bytes);
    files.set(tid, { hash, bytes, onDisk });
    return hash;
  };

  // 皮肤：64x64（default）、64x64（slim/alex）、64x32（旧版 default）、披风 64x32
  const h1 = makeTex(1, 64, 64, 1);
  const h2 = makeTex(2, 64, 64, 2);
  const h3 = makeTex(3, 64, 64, 3);
  const h4 = makeTex(4, 64, 32, 4);
  const h5 = makeTex(5, 128, 128, 5);
  // tid=6 与 tid=7 共享同一份字节 → 重复哈希，R2 侧只需要一个对象
  const hDup = makeTex(6, 64, 64, 6);
  files.set(7, { hash: hDup, bytes: files.get(6)!.bytes, onDisk: false });
  // tid=8：行存在、磁盘上没有对应文件
  const hMissing = makeTex(8, 64, 64, 8, false);
  // tid=9：磁盘文件存在，但内容与存储的 hash 不符
  const hMismatchStored = sha256(Buffer.from('这个哈希对应的文件根本没写过'));
  files.set(9, { hash: hMismatchStored, bytes: makePng(64, 64, { pixel: () => [9, 9, 9, 255] }), onDisk: true });

  for (const [, f] of files) {
    if (f.onDisk) writeFileSync(resolve(texturesDir, f.hash), f.bytes);
  }
  // 孤儿文件：磁盘上有、库里没有对应行
  const orphanHash = sha256(makePng(64, 64, { pixel: () => [7, 7, 7, 255] }));
  writeFileSync(resolve(texturesDir, orphanHash), makePng(64, 64, { pixel: () => [7, 7, 7, 255] }));

  const insUser = db.prepare(
    `INSERT INTO users (uid,email,nickname,locale,score,avatar,password,ip,is_dark_mode,
       permission,last_sign_at,register_at,verified,verification_token,remember_token)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const U = (
    uid: number, email: string, nickname: string, locale: string | null, score: number,
    avatar: number, permission: number, registerOffset: number,
    opts: { verified?: boolean; lastSignOffset?: number | null } = {},
  ) => {
    insUser.run(
      uid, email, nickname, locale, score, avatar,
      '$2y$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      '203.0.113.7', 0, permission,
      // last_sign_at 是 NOT NULL；旧版用 now()->subDay() 表示"从未签到"
      at(opts.lastSignOffset ?? registerOffset - 1),
      at(registerOffset),
      opts.verified ? 1 : 0, '', null,
    );
  };

  U(1, 'admin@example.com', 'Admin', 'zh_CN', 1000, 0, 2, 0, { verified: true });
  U(2, 'normal@example.com', 'Normal', 'zh_HANS_CN', 500, 0, 0, 1, { verified: true }); // locale 别名
  U(3, 'banned@example.com', 'Banned', null, 100, 0, -1, 2);                            // 被封禁
  U(4, 'helper@example.com', 'Helper', 'en_US', 800, 0, 1, 3, { verified: true });      // 管理员
  U(5, '', 'NoEmail', null, 300, 0, 0, 4);                                              // 空邮箱 → 阻塞项
  U(6, 'a@example.com', 'DupA', null, 100, 0, 0, 5);                                    // 大小写重复邮箱 → 阻塞项
  U(7, 'A@EXAMPLE.COM', 'DupB', null, 100, 0, 0, 6);
  U(8, 'signed@example.com', 'Signed', null, 900, 0, 0, 7, { lastSignOffset: 10 });     // 真签过到
  U(9, 'avatar@example.com', 'AvatarGuy', null, 700, 999_999, 0, 8);                    // 头像指向不存在的 tid
  U(10, 'dark@example.com', 'Dark', null, 200, 3, 0, 9);

  const insPlayer = db.prepare(
    `INSERT INTO players (pid,uid,name,tid_cape,last_modified,tid_skin) VALUES (?,?,?,?,?,?)`,
  );
  const P = (pid: number, uid: number, name: string, skin: number, cape: number, off: number) =>
    insPlayer.run(pid, uid, name, cape, at(off), skin);

  P(1, 1, 'AdminPlayer', 1, 4, 10);
  P(2, 2, 'Notch', 2, 0, 11);            // tid_cape=0 表示无披风
  P(3, 6, 'notch', 3, 0, 12);            // 与 pid=2 大小写冲突 → 阻塞项
  P(4, 4, 'OldSkin', -1, 0, 13);         // tid_skin=-1 是旧的"无"默认值
  P(5, 4, 'NoSkin', 0, 0, 14);           // 0 也表示"无"
  P(6, 5, 'OphanRef', 999_999, 0, 15);   // 指向不存在的纹理 → 警告
  P(7, 8, 'Caped', 5, 4, 16);

  const insTex = db.prepare(
    `INSERT INTO textures (tid,name,type,hash,size,uploader,public,upload_at,likes) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const T = (tid: number, name: string, type: string, hash: string, uploader: number, pub: number, off: number, likes = 0) => {
    const bytes = files.get(tid)?.bytes ?? Buffer.alloc(0);
    insTex.run(tid, name, type, hash, Math.ceil(bytes.length / 1024), uploader, pub, at(off), likes);
  };

  T(1, 'Admin 的皮肤', 'steve', h1, 1, 1, 1, 3);
  T(2, 'Normal 的皮肤', 'steve', h2, 2, 1, 2, 1);
  T(3, '细长皮肤', 'alex', h3, 2, 1, 3, 0);
  T(4, '披风一', 'cape', h4, 1, 0, 4, 0);
  T(5, '高清皮肤', 'steve', h5, 4, 1, 5, 0);
  T(6, '重复哈希 A', 'steve', hDup, 2, 1, 6, 0);   // 与 tid=7 同哈希
  T(7, '重复哈希 B', 'steve', hDup, 2, 1, 7, 0);
  T(8, '文件缺失的皮肤', 'steve', hMissing, 2, 1, 8, 0);
  T(9, '哈希不符', 'steve', hMismatchStored, 2, 1, 9, 0);
  T(10, '私有皮肤', 'steve', h1, 5, 0, 10, 0);         // 同一哈希、不同 uploader、私有
  T(11, '已注销用户的纹理', 'steve', h2, 0, 1, 11, 0); // uploader=0

  const insCloset = db.prepare(`INSERT INTO user_closet (user_uid,texture_tid,item_name) VALUES (?,?,?)`);
  insCloset.run(1, 1, '我的皮肤');
  insCloset.run(1, 1, '重复的收藏行');   // 重复 (user,texture) → 去重并报告
  insCloset.run(1, 2, null);
  insCloset.run(4, 5, '高清');
  insCloset.run(2, 899_999, '悬空引用'); // 指向不存在的纹理 → 丢弃并报告

  const insReport = db.prepare(
    `INSERT INTO reports (id,tid,uploader,reporter,reason,status,report_at) VALUES (?,?,?,?,?,?,?)`,
  );
  insReport.run(1, 2, 2, 4, '内容不当', 0, at(20));   // pending
  insReport.run(2, 2, 2, 4, '重复举报', 0, at(21));   // 重复 (reporter,tid) → 去重
  insReport.run(3, 3, 2, 1, '侵权', 1, at(22));       // resolved
  insReport.run(4, 888_888, 2, 1, '纹理已不存在', 0, at(23)); // 纹理不存在 → 丢弃并报告

  const insUuid = db.prepare(`INSERT INTO uuid (name,uuid) VALUES (?,?)`);
  const insDesc = db.prepare(`INSERT INTO textures_description (tid,description,created_at,updated_at) VALUES (?,?,?,?)`);
  const insNotif = db.prepare(
    `INSERT INTO notifications (id,type,notifiable_type,notifiable_id,data,read_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  insNotif.run('11111111-1111-4111-8111-111111111111', 'App\\Notifications\\SiteMessage',
    'App\\Models\\User', 1, JSON.stringify({ title: '欢迎', content: '**你好**' }), null, at(30), at(30));
  insNotif.run('22222222-2222-4222-8222-222222222222', 'App\\Notifications\\SiteMessage',
    'App\\Models\\User', 2, JSON.stringify({ title: '已读消息', content: '内容' }), at(31), at(31), at(31));
  // data 结构异常（没有 title）→ analyze 应抽样报告
  insNotif.run('33333333-3333-4333-8333-333333333333', 'Some\\Plugin\\Thing',
    'App\\Models\\User', 3, JSON.stringify({ foo: 'bar' }), null, at(32), at(32));

  // uuid 表（yggdrasil）：一条已知映射 + 一条指向不存在角色的行
  insUuid.run('KnownPlayer', '11111111111111111111111111111111');
  insUuid.run('GhostPlayer', '22222222222222222222222222222222');
  // textures_description：一条有效 + 一条悬空 tid
  insDesc.run(1, '第一条描述', at(40), at(40));
  insDesc.run(99999, '悬空描述', at(41), at(41));

  const insOpt = db.prepare(`INSERT INTO options (option_name,option_value) VALUES (?,?)`);
  const O = (k: string, v: string) => insOpt.run(k, v);
  O('site_name', '测试皮肤站');
  O('site_name_en', 'Test Skin Server');     // 本地化变体
  O('site_name_zh_CN', '测试皮肤站');
  O('site_description', '一个测试站');
  O('announcement', '欢迎');
  O('sign_score', '10,100');                 // 逗号对 → 拆成 min/max
  O('score_per_storage', 'true');            // 字符串布尔当数字 1 用
  O('private_score_per_storage', '10');
  O('user_initial_score', '1000');
  O('register_with_player_name', 'true');
  O('require_verification', 'false');
  O('regs_per_ip', '3');
  O('return_score', 'true');
  O('max_upload_file_size', '1024');
  O('max_texture_width', '8192');
  O('allow_downloading_texture', 'true');
  O('status_code_for_private', '403');
  O('custom_css', 'body{color:red}');
  O('custom_js', 'console.log(1)');
  O('hide_intro', 'true');
  O('fixed_bg', 'false');
  O('version', '6.0.2');                     // 有意丢弃
  O('cdn_address', '');                      // 有意丢弃
  O('force_ssl', 'false');                   // 有意丢弃
  O('plugins_enabled', '');                  // 有意丢弃
  O('recaptcha_sitekey', '');                // 有意丢弃
  O('some_plugin_option', '未知插件留下的配置'); // 未识别 → 报告但保留

  db.prepare(`INSERT INTO language_lines ("group",key,text,created_at,updated_at) VALUES (?,?,?,?,?)`)
    .run('front-end', 'skinlib.title', JSON.stringify({ zh_CN: '皮肤库', en: 'Skin Library' }), at(40), at(40));

  db.prepare(`INSERT INTO scopes (name,description) VALUES (?,?)`).run('User.Read', '读取用户信息');
  db.prepare(`INSERT INTO jobs (queue,payload,attempts,available_at,created_at) VALUES (?,?,?,?,?)`)
    .run('default', '{}', 0, 1, 1);

  const uniquePresent = new Set(
    [...files.values()].filter((f) => f.onDisk).map((f) => f.hash),
  );

  const expected: FixtureManifest['expected'] = {
    counts: {
      users: 10,
      players: 7,
      textures: 11,
      options: 27,
      user_closet: 5,
      reports: 4,
      notifications: 3,
      language_lines: 1,
    },
    blockerCodes: [
      'empty-email',
      'player-name-case-collision',
      'texture-hash-mismatch',
    ],
    warningCodes: [
      'duplicate-email',
      'orphan-user-avatar',
      'orphan-player-texture-ref',
      'texture-file-missing',
      'orphan-texture-file',
      'dropped-option-keys',
      'unknown-option-keys',
      'duplicate-closet-rows',
      'dangling-closet-ref',
      'duplicate-reports',
      'missing-report-texture',
      'notification-data-shape',
    ],
    infoCodes: [
      'password-algorithm',
      'locale-alias',
      'duplicate-texture-hash',
      'texture-file-summary',
      'option-summary',
    ],
    findingCounts: {
      'empty-email': 1,                    // uid=5
      'duplicate-email': 1,                // 一组：a@example.com → uid 6,7
      'player-name-case-collision': 1,     // 一组：notch → pid 2,3
      'texture-hash-mismatch': 1,          // tid=9
      'texture-file-missing': 1,           // tid=8
      'orphan-texture-file': 1,            // 那个孤儿 PNG
      'orphan-user-avatar': 1,             // uid=9
      'orphan-player-texture-ref': 1,      // pid=6
      'duplicate-closet-rows': 1,          // 多出来的那 1 行
      'dangling-closet-ref': 1,            // uid=2 tid=899999
      'duplicate-reports': 1,              // 多出来的那 1 行
      'missing-report-texture': 1,         // report=4
      'notification-data-shape': 1,        // 缺 title 的那条
      'dropped-option-keys': 5,
      'unknown-option-keys': 1,
      'locale-alias': 2,                   // uid=2, uid=4
      // 三组共享哈希：tid 6/7、1/10、2/11 → 合计 6 行
      'duplicate-texture-hash': 6,
    },
    textureFiles: {
      onDiskTotal: uniquePresent.size + 1, // +1 是孤儿文件
      referencedPresent: uniquePresent.size,
      missingRows: 1,                      // tid=8
      orphanFiles: 1,
      hashMismatchRows: 1,                 // tid=9
      rowsSharingHash: 6,
    },
    optionKeys: { mapped: 19, localized: 2, dropped: 5, unknown: 1 },
  };

  db.close();

  const manifest: FixtureManifest = { dir, dbPath, texturesDir, expected };
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// 直接运行时生成到固定位置（不接受命令行路径参数：该目录会被递归删除）
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = resolve(import.meta.dirname, '..', '.tmp', 'legacy');
  const m = buildLegacyFixture(target);
  console.log(`fixture 已生成: ${m.dbPath}`);
  console.log(`纹理目录: ${m.texturesDir}`);
  console.log(`期望值: ${JSON.stringify(m.expected, null, 2)}`);
}
