#!/usr/bin/env node
// Pigeon Skin Server 管理 CLI 入口。
//
// 用法（仓库根目录）:
//   npm run cli -- <命令组> <动作> [选项] [--env local|production]
//
// 命令组:
//   users      创建/列出用户、改角色/积分、重置密码
//   textures   批量导入/导出皮肤与披风 PNG（hash = sha256 = R2 键）
//   data       核心业务表 JSON 备份导出/导入、行数统计
//   settings   站点设置项读写
//
// 设计约定（与 tools/migrate 一致）:
//   • CLI 不持 CF 凭据 —— D1/R2 全部经 spawn wrangler 操作
//   • 未知参数直接报错，不静默忽略
//   • 退出码: 0 成功 / 1 业务失败 / 2 用法错误 / 3 未预期异常
import { parseArgs, assertKnownFlags } from './lib/args.ts';
import { resolveEnv } from './lib/env.ts';
import { runUsers } from './commands/users.ts';
import { runTextures } from './commands/textures.ts';
import { runData } from './commands/data.ts';
import { runSettings } from './commands/settings.ts';
import { runLegacy } from './commands/legacy/index.ts';

const USAGE = `Pigeon Skin Server 管理 CLI

用法: npm run cli -- <命令组> <动作> [选项]

全局选项:
  --env local|production   目标环境，默认 local（生产为 wrangler --remote，
                           需先 wrangler login；写操作需 --yes 确认）
  --json                   JSON 输出（供脚本消费）
  --yes                    确认执行写操作（生产环境必填）
  -h, --help               帮助

users:
  users create --email <e> [--nickname <n>] [--password <p> | --generate-password]
               [--role normal|admin|super_admin|banned] [--api-key <密钥>]
      明文密码只在执行时打印一次；--password 走 argv 会留在 shell history，
      交互场景优先 --generate-password。
      --api-key 走站点管理 API（scope: admin.users.write），此时 score 固定 0
      （不应用 initial_score，可用 set-score 调整），且 reset-password 由服务端
      生成临时密码、不支持指定明文。
  users list [--search <关键词>] [--json] [--api-key <密钥>]
  users set-role (--email <e> | --id <n>) --role <role> [--api-key <密钥>]
  users set-score (--email <e> | --id <n>) --score <n> [--api-key <密钥>]
  users reset-password (--email <e> | --id <n>) [--password <p> | --generate]
                       [--api-key <密钥>]
      明文密码只在执行时打印一次。--api-key 通道由服务端生成临时密码，
      不支持 --password/--generate。

textures:
  textures import --dir <目录> [--manifest <manifest.json>] --kind skin|cape
                  [--model default|slim] [--visibility public|private]
                  [--origin original|repost] [--uploader <email|id>]
                  [--api-key <密钥> [--site-url <url>]]
      目录内全部 PNG 逐一校验（与 API 上传同一实现）→ 按 sha256 上传 R2 →
      写 textures 元数据。管理导入不扣积分。同 hash+uploader 已存在则跳过。
      --api-key 走站点管理端点（warm 连接并发，批量导入推荐）；
      缺省走 wrangler（本地必须串行，慢）。密钥在管理界面「Pigeon API」
      签发，需勾选 admin.texture.import 权限。
      manifest.json 需位于 --dir 内，格式:
        { "<文件名>": { name, kind, model, visibility, origin } }
  textures export --out <目录> [--kind skin|cape] [--limit <n>]
      导出 PNG 文件 + manifest.json（可直接作为 import --manifest 输入）+ export-meta.json。
      注意 manifest 只含 name/kind/model/visibility/origin，不含
      official_key 等官方纹理字段 —— 完整备份请用 data export。

data:
  data export --out <目录> [--tables users,textures,textures_description,players,closet]
      每表一个 JSON + manifest.json。含密码哈希等敏感字段，妥善保管。
  data import --from <备份目录> --yes [--update]
      跳过式合并：按主键/自然键已存在的行不改动（users 按 email，
      textures 按 id —— hash 不唯一，同 hash 可有多行，
      players 按 name，closet 按复合键）。
      支持向空库恢复（外键循环由 avatar_texture_id 回填解决）。--update 暂未实现。
  data stats
      核心表行数概览。

settings:
  settings list [--json] [--api-key <密钥>]
  settings get --key <键名> [--api-key <密钥>]
  settings set --key <键名> --value <值> [--api-key <密钥>]
      可用键见 apps/api/src/env.ts 的 SETTING_DEFAULTS。
      --api-key 通道读写的是站点生效值（secret 键只显示占位符，
      superAdminOnly 键不可见不可写；CONFIGURATION 类键如 smtp/mail 的
      env 绑定值不经此通道反映）。wrangler 通道直写 settings 表。

legacy（旧 Blessing Skin PHP 版迁移）:
  legacy analyze --dir <旧站目录> [--dump <dump.sql>] [--pwd-method <N>] [--legacy-salt <v>]
      只读分析：自动发现 .env（MySQL 连接）或 *.sql dump、storage/textures，
      报告各表行数与映射阻塞项（重复邮箱、悬空引用、未知密码算法等）。
  legacy migrate --dir <旧站目录> [--dump <dump.sql>] [--env production --yes]
                  [--pwd-method <N>] [--legacy-salt <v>] [--timezone <IANA>]
                  [--batch <n>] [--force] [--dry-run] [--site-url <url>]
                  [--skip-r2] [--persist-to <dir>]
      一条命令完成迁移：映射（复用 tools/migrate 的 mapper/stages 语义）→
      R2 按 hash 上传纹理（--skip-r2 可跳过，之后行可见前须补传）→
      写入 --env 对应的 D1。生产环境要求站点未初始化
      （--site-url 指向目标站点做 /setup 检查），且必须 --yes。
      密码算法来源优先级：--pwd-method > .env 的 PWD_METHOD；
      dump 快照模式无 .env 时必须显式传 --pwd-method。
      --persist-to <dir> 用于本地隔离演练（独立 wrangler 持久化目录）。

示例:
  npm run cli -- users create --email op@example.com --generate-password --role admin
  npm run cli -- textures import --dir ./skins --kind skin --uploader admin@example.com
  npm run cli -- data export --out ./backup-2026-10-06
  npm run cli -- legacy analyze --dir /path/to/old-blessing-skin
  npm run cli -- legacy migrate --dir /path/to/old-blessing-skin --env production --yes --site-url https://skin.example.com
  npm run cli -- settings set --key site_name --value "我的皮肤站"
`;

function fail(message: string, showUsage = false): number {
  console.error(`错误: ${message}`);
  if (showUsage) { console.error(); console.error(USAGE); }
  return 2;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    return fail((e as Error).message, true);
  }
  const { path, flags } = parsed;
  if (path.length === 0 || flags.has('help') || flags.has('h')) {
    console.log(USAGE);
    return 0;
  }

  const [group, action = ''] = path;
  const env = resolveEnv(flags);

  // 命令级 flag 白名单：打错的 flag 名直接报错，绝不静默忽略
  const FLAG_ALLOWLIST: Record<string, ReadonlySet<string>> = {
    users: new Set(['json', 'yes', 'env', 'email', 'id', 'nickname', 'password', 'generate-password', 'generate', 'role', 'score', 'search', 'api-key', 'site-url']),
    textures: new Set(['yes', 'env', 'dir', 'manifest', 'kind', 'model', 'visibility', 'origin', 'uploader', 'out', 'limit', 'api-key', 'site-url']),
    data: new Set(['yes', 'env', 'out', 'tables', 'from', 'update']),
    settings: new Set(['json', 'yes', 'env', 'key', 'value', 'api-key', 'site-url']),
    legacy: new Set(['yes', 'env', 'dir', 'dump', 'pwd-method', 'legacy-salt', 'timezone', 'batch', 'force', 'dry-run', 'site-url', 'skip-file-hash', 'json', 'persist-to', 'skip-r2']),
  };
  const allowed = FLAG_ALLOWLIST[group!];
  if (allowed) {
    try {
      assertKnownFlags(flags, [...allowed]);
    } catch (e) {
      return fail((e as Error).message, true);
    }
  }

  // 生产环境写操作的防呆：所有变更类动作必须 --yes
  const WRITE_ACTIONS: Record<string, ReadonlySet<string>> = {
    users: new Set(['create', 'set-role', 'set-score', 'reset-password']),
    textures: new Set(['import']),
    data: new Set(['import']),
    settings: new Set(['set']),
  };
  const writes = WRITE_ACTIONS[group!];
  if (env.name === 'production' && writes?.has(action!)) {
    if (flags.get('yes') !== true) {
      return fail(`该命令会写入生产库（${env.label}）。确认后加 --yes 重新执行。`);
    }
  }

  try {
    switch (group) {
      case 'users': return await runUsers(env, action!, parsed);
      case 'textures': return await runTextures(env, action!, parsed);
      case 'data': return await runData(env, action!, parsed);
      case 'settings': return runSettings(env, action!, parsed);
      case 'legacy': return await runLegacy(env, action!, parsed);
      default: return fail(`未知命令组 "${group}"（可用: users | textures | data | settings | legacy）`, true);
    }
  } catch (e) {
    console.error(`错误: ${(e as Error).message}`);
    return 1;
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e: unknown) => {
    console.error('未预期的错误:', e);
    process.exitCode = 3;
  });
