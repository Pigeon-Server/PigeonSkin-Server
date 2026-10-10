// Node 运行时装配：从环境变量构造完整的 Workers 兼容 Bindings。
//
// Worker 部署的绑定来自 wrangler.jsonc（D1/R2/DO/Queue/限流由平台注入）；
// Node 部署在这里逐一装配同形对象，createApp() 与全部业务代码无感。
// 环境变量清单见 docs/node-deployment.md。

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDatabase, type AnyD1 } from './d1/index.ts';
import type { SqliteD1 } from './d1/sqlite.ts';
import type { PostgresD1 } from './d1/postgres.ts';
import type { MysqlD1 } from './d1/mysql.ts';
import { DatabaseSync } from './sqlite-shim.ts';
import { FileSystemR2Bucket } from './r2-fs.ts';
import { S3R2Bucket } from './r2-s3.ts';
import { installCacheShim } from './cache-shim.ts';
import { createRedisCacheShim, installRedisCacheShim } from './cache-redis.ts';
import { isRedisEnabled, closeRedis } from './redis.ts';
import { createRedisRateLimitBindings } from './ratelimit-redis.ts';
import { createDoNamespace, ensureDoStorageTable, disposeAllDoAlarms } from './do.ts';
import { DerivativeGenerator } from '../do/derivatives.ts';
import { OfficialResourceUpdater } from '../do/official-resources.ts';
import { ensureJobsTable, QueueProducerShim, QueueConsumerRunner } from './queue.ts';
import { createRateLimitBindings, type RateLimiterBinding } from './ratelimit.ts';
import { createRedisQueueSystem, type RedisQueueConsumerRunner } from './queue-redis.ts';
import { AssetsFetcherShim } from './assets.ts';
import { NodeHTMLRewriter } from './rewriter.ts';
import { nodeSmtpConnector } from './smtp-connector.ts';
import { smtpTransport } from '../services/smtp.ts';
import { runMigrationsForNode, runMigrationsPostgres, runMigrationsMysql } from './migrate.ts';
import { runScheduledTasks } from '../tasks.ts';
import { processDueJobs } from '../services/ai-jobs.ts';
import type { Bindings } from '../env.ts';

const here = dirname(fileURLToPath(import.meta.url));

function env(name: string): string { return process.env[name] ?? ''; }
function assignOptional(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined) target[key] = value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export interface NodeRuntime {
  bindings: Bindings;
  db: AnyD1;
  queueRunner: QueueConsumerRunner | RedisQueueConsumerRunner;
  /** 启动每小时一次的定时任务（对应 Workers 的 Cron Triggers） */
  startCron(): void;
  stop(): Promise<void>;
}

export async function createNodeRuntime(): Promise<NodeRuntime> {
  // ── 数据库 ────────────────────────────────────────────────────────────────
  const dbDriver = (env('DB_DRIVER') || 'sqlite') as 'sqlite' | 'postgres' | 'mysql';
  const databasePath = optional('DATABASE_PATH') ?? './data/pigeon.db';
  if (dbDriver === 'sqlite') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = createDatabase({
    driver: dbDriver,
    path: databasePath,
    url: optional('DATABASE_URL'),
  });
  if (dbDriver === 'sqlite') await runMigrationsForNode(db as SqliteD1);
  else if (dbDriver === 'postgres') await runMigrationsPostgres(db as PostgresD1);
  else await runMigrationsMysql(db as MysqlD1);

  // ── Workers 全局符号（caches / HTMLRewriter）与 SMTP 连接器注入 ───────────
  const dataDir = resolve(optional('DATA_DIR') ?? './data');
  mkdirSync(dataDir, { recursive: true });
  // 缓存装配二选一：REDIS_URL 配置时切 Redis 驱动，否则维持 SQLite 版
  if (isRedisEnabled()) {
    const redisCache = await createRedisCacheShim();
    if (redisCache) installRedisCacheShim(redisCache);
    else installCacheShim({ path: resolve(dataDir, 'cache.db') });
  } else {
    installCacheShim({ path: resolve(dataDir, 'cache.db') });
  }
  (globalThis as unknown as { HTMLRewriter?: unknown }).HTMLRewriter ??= NodeHTMLRewriter;
  smtpTransport.connect = nodeSmtpConnector;

  // ── 对象存储 ──────────────────────────────────────────────────────────────
  // file：本地文件系统（默认）；s3：任意 S3 兼容后端（aws4fetch SigV4）
  const storageDriver = env('STORAGE_DRIVER') || 'file';
  let bucket: FileSystemR2Bucket | S3R2Bucket;
  if (storageDriver === 's3') {
    const endpoint = optional('S3_ENDPOINT');
    const accessKeyId = optional('S3_ACCESS_KEY_ID');
    const secretAccessKey = optional('S3_SECRET_ACCESS_KEY');
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error('STORAGE_DRIVER=s3 需要 S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY');
    }
    bucket = new S3R2Bucket({
      endpoint,
      region: env('S3_REGION') || 'auto',
      bucket: optional('S3_BUCKET'),
      accessKeyId,
      secretAccessKey,
    });
  } else if (storageDriver === 'file') {
    const storagePath = resolve(optional('STORAGE_PATH') ?? resolve(dataDir, 'storage'));
    mkdirSync(storagePath, { recursive: true });
    bucket = new FileSystemR2Bucket({ root: storagePath });
  } else {
    throw new Error(`STORAGE_DRIVER=${storageDriver} 不支持（可用：file、s3）`);
  }

  // ── Durable Objects（storage 落业务库之外的同库新表）──────────────────────
  // node:sqlite 连接不能与业务 D1 适配器共享（语句缓存互不感知），DO/队列
  // 各自持有独立的元数据库文件。
  const doDbPath = resolve(dataDir, 'do-state.db');
  const doDb = new DatabaseSync(doDbPath);
  ensureDoStorageTable(doDb);
  // DO 实例的 env 在 Workers 里是完整 Bindings；这里传同一份（实例构造
  // 时再取用，避免装配顺序问题——闭包引用 bindings 变量）
  const bindings = {} as Bindings;
  const doEnv = bindings;
  bindings.DB = db as never;
  bindings.BUCKET = bucket as never;
  bindings.DERIVATIVES = createDoNamespace('DerivativeGenerator', DerivativeGenerator as never, doEnv, doDb) as never;
  bindings.OFFICIAL_RESOURCES = createDoNamespace('OfficialResourceUpdater', OfficialResourceUpdater as never, doEnv, doDb) as never;
  bindings.ASSETS = new AssetsFetcherShim(resolve(optional('ASSETS_DIR') ?? resolve(here, '../../../web/dist'))) as never;

  // ── 限流 ─────────────────────────────────────────────────────────────────
  // REDIS_URL 配置时优先 Redis（多进程共享计数），失败/未配置回退内存
  const rateLimitEnv = {
    RATE_LIMIT_ENABLED: optional('RATE_LIMIT_ENABLED'),
    RATE_LIMIT_GLOBAL: optional('RATE_LIMIT_GLOBAL'),
    RATE_LIMIT_AUTH: optional('RATE_LIMIT_AUTH'),
    RATE_LIMIT_SKINLIB: optional('RATE_LIMIT_SKINLIB'),
    RATE_LIMIT_SKINLIB_USER: optional('RATE_LIMIT_SKINLIB_USER'),
  };
  let rateLimits:
    | {
      RL_GLOBAL: RateLimiterBinding;
      RL_AUTH: RateLimiterBinding;
      RL_SKINLIB: RateLimiterBinding;
      RL_SKINLIB_USER: RateLimiterBinding;
    }
    | undefined;
  if (isRedisEnabled()) rateLimits = await createRedisRateLimitBindings(rateLimitEnv);
  if (rateLimits === undefined) rateLimits = createRateLimitBindings(rateLimitEnv);
  if (rateLimits) {
    bindings.RL_GLOBAL = rateLimits.RL_GLOBAL as never;
    bindings.RL_AUTH = rateLimits.RL_AUTH as never;
    bindings.RL_SKINLIB = rateLimits.RL_SKINLIB as never;
    bindings.RL_SKINLIB_USER = rateLimits.RL_SKINLIB_USER as never;
  }

  // ── 业务配置（变量名与 wrangler vars/secrets 对齐）────────────────────────
  bindings.ENVIRONMENT = (optional('ENVIRONMENT') as Bindings['ENVIRONMENT']) ?? 'production';
  bindings.APP_URL = env('APP_URL') || 'http://localhost:8787';
  bindings.MAIL_FROM = env('MAIL_FROM') || '';
  assignOptional(bindings as unknown as Record<string, unknown>, 'MAIL_DRIVER', optional('MAIL_DRIVER'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'SMTP_HOST', optional('SMTP_HOST'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'SMTP_PORT', optional('SMTP_PORT'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'SMTP_ENCRYPTION', optional('SMTP_ENCRYPTION'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'SMTP_USERNAME', optional('SMTP_USERNAME'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'SMTP_PASSWORD', optional('SMTP_PASSWORD'));
  bindings.TURNSTILE_ENABLED = env('TURNSTILE_ENABLED') || 'false';
  assignOptional(bindings as unknown as Record<string, unknown>, 'TURNSTILE_SECRET', optional('TURNSTILE_SECRET'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'TURNSTILE_SITE_KEY', optional('TURNSTILE_SITE_KEY'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'CAPTCHA_DRIVER', optional('CAPTCHA_DRIVER'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'CAPTCHA_SITE_KEY', optional('CAPTCHA_SITE_KEY'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'CAPTCHA_SECRET', optional('CAPTCHA_SECRET'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'ALIYUN_CAPTCHA_ACCESS_KEY_ID', optional('ALIYUN_CAPTCHA_ACCESS_KEY_ID'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'RECAPTCHA_V3_THRESHOLD', optional('RECAPTCHA_V3_THRESHOLD'));
  bindings.DERIVATIVES_ENABLED = optional('DERIVATIVES_ENABLED') ?? 'true';
  assignOptional(bindings as unknown as Record<string, unknown>, 'OFFICIAL_CATALOG_ENABLED', optional('OFFICIAL_CATALOG_ENABLED'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'RATE_LIMIT_ENABLED', optional('RATE_LIMIT_ENABLED'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'SKINLIB_GUARD_ENABLED', optional('SKINLIB_GUARD_ENABLED'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'SESSION_SECRET', optional('SESSION_SECRET'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'MFA_ENCRYPTION_KEY', optional('MFA_ENCRYPTION_KEY'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'SETUP_TOKEN', optional('SETUP_TOKEN'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'LEGACY_SALT', optional('LEGACY_SALT'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'RESEND_API_KEY', optional('RESEND_API_KEY'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'DEPLOY_HOOK_URL', optional('DEPLOY_HOOK_URL'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'UPDATE_MANIFEST_URL', optional('UPDATE_MANIFEST_URL'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'GITHUB_CLIENT_ID', optional('GITHUB_CLIENT_ID'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'GITHUB_CLIENT_SECRET', optional('GITHUB_CLIENT_SECRET'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'LITTLESKIN_CLIENT_ID', optional('LITTLESKIN_CLIENT_ID'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'LITTLESKIN_CLIENT_SECRET', optional('LITTLESKIN_CLIENT_SECRET'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'LITTLESKIN_API_ROOT', optional('LITTLESKIN_API_ROOT'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'MICROSOFT_CLIENT_ID', optional('MICROSOFT_CLIENT_ID'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'MICROSOFT_CLIENT_SECRET', optional('MICROSOFT_CLIENT_SECRET'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'MOJANG_CLIENT_ID', optional('MOJANG_CLIENT_ID'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'MOJANG_CLIENT_SECRET', optional('MOJANG_CLIENT_SECRET'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'AI_MODERATION_DRIVER', optional('AI_MODERATION_DRIVER'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'OPENAI_API_KEY', optional('OPENAI_API_KEY'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'OPENAI_BASE_URL', optional('OPENAI_BASE_URL'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'OPENAI_MODERATION_MODEL', optional('OPENAI_MODERATION_MODEL'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'ANTHROPIC_API_KEY', optional('ANTHROPIC_API_KEY'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'ANTHROPIC_MODERATION_MODEL', optional('ANTHROPIC_MODERATION_MODEL'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'TYPESAFE_API_KEY', optional('TYPESAFE_API_KEY'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'CLOUDFLARE_ACCOUNT_ID', optional('CLOUDFLARE_ACCOUNT_ID'));
  assignOptional(bindings as unknown as Record<string, unknown>, 'CLOUDFLARE_API_TOKEN', optional('CLOUDFLARE_API_TOKEN'));

  // ── 队列（REDIS_URL 配置时用 Redis List/ZSET，否则落业务库 node_jobs 表）──
  let queueRunner: QueueConsumerRunner | RedisQueueConsumerRunner;
  const redisQueues = await createRedisQueueSystem(db);
  if (redisQueues) {
    queueRunner = redisQueues.runner(async batch => {
      const { processQueueBatch } = await import('../tasks.ts');
      await processQueueBatch(batch as never, bindings);
    });
    bindings.SEARCH_SUBMISSIONS = redisQueues.producer('search-submissions') as never;
    bindings.EMAIL_NOTIFICATIONS = redisQueues.producer('email-notifications') as never;
  } else {
    await ensureJobsTable(db as SqliteD1);
    queueRunner = new QueueConsumerRunner(db as SqliteD1, async batch => {
      const { processQueueBatch } = await import('../tasks.ts');
      await processQueueBatch(batch as never, bindings);
    });
    bindings.SEARCH_SUBMISSIONS = new QueueProducerShim<never>(db as SqliteD1, 'search-submissions') as never;
    bindings.EMAIL_NOTIFICATIONS = new QueueProducerShim<never>(db as SqliteD1, 'email-notifications') as never;
  }

  return {
    bindings,
    db,
    queueRunner,
    startCron() {
      // 对齐 Workers 的 cron：每小时清理任务（production 配 0 * * * *）+
      // 分钟级 AI 任务派发。启动即各跑一次（补上停机期间错过的任务）。
      const ctx = { waitUntil: (promise: Promise<unknown>) => { promise.catch(error => console.error('scheduled task failed', error)); } };
      const run = () => runScheduledTasks(undefined, bindings, ctx).catch(error => console.error('scheduled task failed', error));
      const runAi = () => processDueJobs(bindings).catch(error => console.error('ai job dispatch failed', error));
      run();
      runAi();
      const timer = setInterval(run, 60 * 60 * 1000);
      timer.unref?.();
      const aiTimer = setInterval(runAi, 60 * 1000);
      aiTimer.unref?.();
    },
    async stop() {
      queueRunner.stop();
      disposeAllDoAlarms();
      await closeRedis();
      if (dbDriver === 'postgres' || dbDriver === 'mysql') await (db as never as { close(): Promise<void> }).close();
      else (db as SqliteD1).close();
    },
  };
}

export { disposeAllDoAlarms };
