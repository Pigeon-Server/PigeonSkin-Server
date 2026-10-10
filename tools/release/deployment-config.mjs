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
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync(new URL('../../apps/api/wrangler.jsonc', import.meta.url), 'utf8'));
  if (parsed.error) throw new Error('无法解析 Wrangler 配置');
  const config = parsed.config;
  const target = config.env[environment];
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
