import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { repoRoot } from './paths.mjs';

const source = path => import(pathToFileURL(resolve(repoRoot, path)));
const { PostgresD1 } = await source('apps/server/src/node/d1/postgres.ts');
const { MysqlD1 } = await source('apps/server/src/node/d1/mysql.ts');
const { runMigrationsPostgres, runMigrationsMysql } = await source('apps/server/src/node/migrate.ts');
const { setDialect } = await import('@pigeon-skin/db');
const { writeMany } = await source('apps/server/src/services/settings.ts');
const { invalidateSettingsCache } = await source('apps/server/src/core/settings-reader.ts');
const { resetWorkersAiQuota, pauseWorkersAiToday, readWorkersAiQuota } = await source('apps/server/src/services/ai-quota.ts');
const results = [];

for (const dialect of ['postgres', 'mysql']) {
  setDialect(dialect);
  const db = dialect === 'postgres'
    ? new PostgresD1('postgres://postgres:local-perf-test@127.0.0.1:55432/pigeon')
    : new MysqlD1('mysql://root:local-perf-test@127.0.0.1:53306/pigeon');
  const env = { DB: db, APP_URL: 'https://local.example', ENVIRONMENT: 'production' };
  const id = Date.now();
  const run = (query, ...parameters) => db.prepare(query).bind(...parameters).run();
  const row = (query, ...parameters) => db.prepare(query).bind(...parameters).first();
  const number = async (query, ...parameters) => Number((await row(query, ...parameters))?.n ?? 0);
  const metric = key => number('SELECT value AS n FROM site_stats WHERE metric=?', key);
  try {
    await (dialect === 'postgres' ? runMigrationsPostgres(db) : runMigrationsMysql(db));
    const before = { users: await metric('users'), players: await metric('players'), textures: await metric('textures'), reports: await metric('pending_reports') };
    for (const uid of [id, id + 1]) await run('INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)', uid, `${uid}@example.invalid`, 'local', id, id);
    await run('INSERT INTO players(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)', id, id, `P${id}`, id, id);
    for (const tid of [id, id + 1]) await run("INSERT INTO textures(id,hash,kind,model,name,uploader_id,size_bytes,width,height,visibility,created_at,updated_at) VALUES(?,?,'skin','default','Local',?,1024,64,64,'public',?,?)", tid, String(tid).padStart(64, '0'), id, id, id);
    await run("INSERT INTO reports(texture_id,uploader_id,reporter_id,reason,status,created_at) VALUES(?,?,?,'Local','pending',?)", id, id, id + 1, id);
    assert.equal(await metric('users'), before.users + 2);
    assert.equal(await metric('players'), before.players + 1);
    assert.equal(await metric('textures'), before.textures + 2);
    assert.equal(await metric('pending_reports'), before.reports + 1);
    await run("UPDATE textures SET visibility='private',model='slim' WHERE id=?", id + 1);
    assert.equal(await number('SELECT SUM(value) AS n FROM texture_counts WHERE scope=?', `u:${id}:public`), 1);
    assert.equal(await number('SELECT SUM(value) AS n FROM texture_counts WHERE scope=?', `u:${id}:private`), 1);
    const counterBeforeRollback = await metric('textures');
    let rolledBack = false;
    try {
      await db.batch([
        db.prepare("UPDATE textures SET visibility='private' WHERE id=?").bind(id),
        db.prepare("INSERT INTO players(user_id,name,created_at,updated_at) VALUES(0,'invalid-foreign-key',0,0)"),
      ]);
    } catch { rolledBack = true; }
    assert.equal(rolledBack, true);
    assert.equal((await row('SELECT visibility FROM textures WHERE id=?', id)).visibility, 'public');
    assert.equal(await metric('textures'), counterBeforeRollback);
    invalidateSettingsCache();
    await writeMany(env, [{ key: 'site_name', value: `Local ${dialect}` }], { isSuperAdmin: true });
    const snapshot = JSON.parse((await row("SELECT value FROM settings_snapshots WHERE locale=''" )).value);
    assert.equal(snapshot.site_name, `Local ${dialect}`);
    const observed = await readWorkersAiQuota(env);
    await pauseWorkersAiToday(env, observed);
    assert.equal((await readWorkersAiQuota(env)).paused, true);
    await resetWorkersAiQuota(env);
    await pauseWorkersAiToday(env, observed);
    assert.equal((await readWorkersAiQuota(env)).paused, false);
    await run('DELETE FROM users WHERE id=?', id);
    assert.equal(await metric('players'), before.players);
    assert.equal(await number('SELECT SUM(value) AS n FROM texture_counts WHERE scope IN (?,?)', `u:${id}:public`, `u:${id}:private`), 0);
    await run('DELETE FROM textures WHERE id=?', id);
    assert.equal(await metric('pending_reports'), before.reports);
    await run('DELETE FROM textures WHERE id=?', id + 1);
    await run('DELETE FROM users WHERE id=?', id + 1);
    assert.equal(await metric('textures'), before.textures);
    assert.equal(await metric('users'), before.users);
    results.push({ dialect, success: true, checks: ['migrations', 'counts', 'ownership', 'rollback', 'settings-snapshot', 'ai-quota', 'cascades'] });
    console.log(JSON.stringify(results.at(-1)));
  } finally { await db.close(); }
}
const output = resolve(repoRoot, 'reports/cloudflare');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'database-validation.json'), JSON.stringify(results, null, 2));
