import { readFileSync } from 'node:fs';
import ts from 'typescript';

export function deploymentConfig(environment, variables) {
  if (!['preview', 'production'].includes(environment)) throw new Error('部署环境必须为 preview 或 production');
  const prefix = environment.toUpperCase();
  const databaseId = variables[`${prefix}_D1_DATABASE_ID`]?.toLowerCase();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId ?? '')) {
    throw new Error(`请通过环境变量配置 ${prefix}_D1_DATABASE_ID`);
  }
  if (variables.PREVIEW_D1_DATABASE_ID && variables.PREVIEW_D1_DATABASE_ID.toLowerCase() === variables.PRODUCTION_D1_DATABASE_ID?.toLowerCase()) {
    throw new Error('预览和生产不能使用同一个 D1 数据库');
  }
  // 配置源已迁到仓库根目录（apps/api 下的旧位置由目录结构重组移除）
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
  if (parsed.error) throw new Error('无法解析 Wrangler 配置');
  const config = parsed.config;
  const target = config.env[environment];
  // 生成的配置落位仓库根目录：根布局下源配置的 main 与 assets.directory
  // 都已经是仓库根相对的正确路径，无需改写（判断保留以防旧布局配置回流）。
  // 注意 wrangler 的相对路径以配置文件所在目录为基准：产物在根目录，
  // 源里 `apps/web/dist` 这类路径天然就是根相对，不能按 apps/api 基准再加前缀。
  if (!config.main.startsWith('apps/api/') && !config.main.startsWith('/')) config.main = `apps/api/${config.main}`;
  // 生产全量采样会把免费层 Workers Logs（20 万事件/天）打穿，超出后事件被
  // 静默丢弃，排障时反而没日志；降采样保留代表性样本。预览环境流量小，保持全量。
  if (environment === 'production' && config.observability?.logs && config.observability?.traces) {
    config.observability = {
      ...config.observability,
      logs: { ...config.observability.logs, head_sampling_rate: 0.25 },
      traces: { ...config.observability.traces, head_sampling_rate: 0.25 },
    };
  }
  const appUrl = variables[`${prefix}_APP_URL`];
  let origin;
  try {
    const url = new URL(appUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    origin = url.origin;
  } catch { throw new Error(`请通过 ${prefix}_APP_URL 配置 HTTPS 站点 Origin`); }
  target.vars.APP_URL = origin;
  if (process.env.DEPLOY_MAIN_ENTRY) {
    config.main = process.env.DEPLOY_MAIN_ENTRY;
  }
  target.d1_databases[0].database_id = databaseId;
  const bucketName = variables[`${prefix}_R2_BUCKET_NAME`];
  if (bucketName) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName)) throw new Error('R2 桶名格式不正确');
    target.r2_buckets[0].bucket_name = bucketName;
  }
  const previewBucket = variables.PREVIEW_R2_BUCKET_NAME || config.env.preview.r2_buckets[0].bucket_name;
  const productionBucket = variables.PRODUCTION_R2_BUCKET_NAME || config.env.production.r2_buckets[0].bucket_name;
  if (previewBucket === productionBucket) throw new Error('预览和生产不能使用同一个 R2 桶');
  return { config, databaseName: target.d1_databases[0].database_name };
}
