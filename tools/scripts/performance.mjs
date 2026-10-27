import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './paths.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split('=')));
const duration = Number(args.seconds ?? 1800);
const tag = args.tag ?? new Date().toISOString().replaceAll(':', '-');
const scales = (args.scales ?? '1,10').split(',').map(Number);
const output = resolve(repoRoot, 'reports/cloudflare', tag);
await mkdir(output, { recursive: true });
const { SETTING_DEFAULTS } = await import(pathToFileURL(resolve(repoRoot, 'apps/server/src/core/env.ts')));
const { makePng } = await import(pathToFileURL(resolve(repoRoot, 'packages/minecraft/test/png-builder.ts')));
const { mintWebAccessToken } = await import(pathToFileURL(resolve(repoRoot, 'packages/auth/src/jwt.ts')));
const compiled = args.bundle ? { outputFiles: [{ text: await readFile(resolve(repoRoot, args.bundle), 'utf8') }] } : await build({ entryPoints: [resolve(repoRoot, 'tools/scripts/performance-worker.ts')], alias: { 'pigeon:worker': resolve(repoRoot, 'apps/server/src/index.ts') }, bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['browser', 'module', 'main'], conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], target: 'es2022' });
const migrationDirectory = resolve(repoRoot, 'packages/db/migrations');
const migrations = await Promise.all((await readdir(migrationDirectory)).filter(name => name.endsWith('.sql') && (!args.legacy || name <= '0031_texture_sanitized.sql')).sort().map(name => readFile(resolve(migrationDirectory, name), 'utf8')));
await writeFile(resolve(output, 'worker.mjs'), compiled.outputFiles[0].text);

function statements(sql) {
  const result = []; let current = ''; let trigger = false;
  for (const line of sql.split(/\r?\n/)) {
    if (line.trim().startsWith('--')) continue;
    current += line + '\n';
    if (/CREATE\s+TRIGGER/i.test(line)) trigger = true;
    if (trigger ? /^END\b/i.test(line.trim()) : line.trim().endsWith(';')) { result.push(current); current = ''; trigger = false; }
  }
  if (current.trim()) result.push(current);
  return result;
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
async function assets(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const root = resolve(repoRoot, 'apps/web/dist');
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + '/')) return new Response(null, { status: 404 });
  try { return new Response(await readFile(file), { headers: { 'content-type': mime[extname(file)] ?? 'application/octet-stream' } }); }
  catch { return new Response(null, { status: 404 }); }
}

async function run(scale, index) {
  const events = [], requests = [], failures = [], cacheEvents = [];
  const port = Number(args.port ?? 8790) + index;
  const secret = 'local-performance-session-secret';
  const mf = new Miniflare({
    name: `performance-${scale}`, port, host: '127.0.0.1',
    modules: [{ type: 'ESModule', path: 'worker.mjs', contents: compiled.outputFiles[0].text }],
    compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR),
    d1Databases: { DB: `performance-${scale}` }, r2Buckets: ['BUCKET'], kvNamespaces: ['PUBLIC_CACHE'],
    durableObjects: {
      DERIVATIVES: { className: 'DerivativeGenerator', useSQLite: true },
      OFFICIAL_RESOURCES: { className: 'OfficialResourceUpdater', useSQLite: true },
      TEXTURE_SANITIZER: { className: 'TextureSanitizer', useSQLite: true },
      ...(!args.legacy ? { CACHE_PUBLISHER: { className: 'CachePublisher', useSQLite: true }, WORKLOADS: { className: 'Workloads', useSQLite: true } } : {}),
    },
    queueProducers: { SEARCH_SUBMISSIONS: 'search', EMAIL_NOTIFICATIONS: 'email' },
    queueConsumers: { search: { maxBatchSize: 1, maxRetries: 1 }, email: { maxBatchSize: 1, maxRetries: 1 } },
    bindings: { ENVIRONMENT: 'development', APP_URL: `http://127.0.0.1:${port}`, SESSION_SECRET: secret, MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), RATE_LIMIT_ENABLED: 'false', DERIVATIVES_ENABLED: 'true', ...(args.journey ? { DIAGNOSTIC_AI: 'quota' } : {}) },
    serviceBindings: { ASSETS: assets, TRACE: async request => { (new URL(request.url).pathname === '/cache' ? cacheEvents : events).push(await request.json()); return new Response(null, { status: 204 }); } },
    outboundService: async () => new Response('Local external fixture unavailable', { status: 503 }),
  });
  try {
    const { DB, BUCKET } = await mf.getBindings();
    for (const sql of migrations) await DB.batch(statements(sql).map(sql => DB.prepare(sql)));
    const now = Date.now(), salt = Buffer.alloc(16, 4);
    const password = `pbkdf2:100000:${salt.toString('base64url')}:${pbkdf2Sync('local-password-9', salt, 100000, 32, 'sha256').toString('base64url')}`;
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO users(id,email,nickname,password_hash,role,score,email_verified_at,created_at,updated_at) SELECT i,'user'||i||'@example.invalid','Local user '||i,?,CASE WHEN i=1 THEN 'super_admin' ELSE 'normal' END,100000,?,?,? FROM n`).bind(4000 * scale, password, now, now, now).run();
    await DB.batch(Object.entries({ ...SETTING_DEFAULTS, ygg_connect_enabled: 'false', official_resources_auto_update: 'false', comments_ai_moderation: 'false', texture_ai_translation: 'false', texture_ai_moderation: 'false' }).map(([key, value]) => DB.prepare('INSERT INTO settings(key,locale,value,updated_at) VALUES(?,\'\',?,?) ON CONFLICT(key,locale) DO UPDATE SET value=excluded.value').bind(key, value, now)));
    const png = makePng({ width: 64, height: 64, seed: 1 });
    const hash = createHash('sha256').update(png).digest('hex');
    await BUCKET.put(`textures/${hash}.png`, png);
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO textures(id,hash,kind,model,name,uploader_id,size_bytes,width,height,visibility,likes,created_at,updated_at,sanitized) SELECT i,?,'skin','default','Local texture '||i,2,?,64,64,CASE WHEN i%10=0 THEN 'private' ELSE 'public' END,i,0,?,1 FROM n`).bind(1200 * scale, hash, png.length, now).run();
    await DB.prepare(`INSERT INTO texture_translations(tid,locale,name,description,created_at,updated_at) SELECT id,'en','English '||id,'',?,? FROM textures WHERE id<=?`).bind(now, now, 150 * scale).run();
    await DB.prepare("INSERT INTO players(user_id,name,skin_texture_id,created_at,updated_at) VALUES(2,'LocalPlayer',1,?,?)").bind(now, now).run();
    await DB.batch(['', 'en', 'ja_JP', 'zh_TW', 'es_ES', 'ru_RU'].map(locale => DB.prepare('INSERT INTO manual_documents(slug,locale,value,updated_at) VALUES(?,?,?,?)').bind('local-guide', locale, JSON.stringify({ title: 'Local guide', description: 'Guide', group: 'Local', content: '# Local guide\n\n## Setup\n\nUse {{ site_url }}.' }), now)));
    for (const id of [1, 2]) await DB.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?)').bind(`local-session-${id}`, id, now, now, now + 7200000, now + 7200000).run();
    const tokens = await Promise.all([1, 2].map(id => mintWebAccessToken(secret, id, `local-session-${id}`, 7200)));
    const start = Date.now();
    let tick = 0;
    const interval = Number(args.interval ?? 15000);
    const phaseAt = () => { const portion = tick * interval / (duration * 1000); return portion < 1 / 6 ? 'cold' : portion < 1 / 2 ? 'normal' : portion < 5 / 6 ? 'idle' : 'concurrent'; };
    async function request(path, { actor, method = 'GET', json, form, scenario = path, expected } = {}) {
      const requestId = crypto.randomUUID(), phase = phaseAt(), started = Date.now();
      const headers = { 'x-diagnostic-id': requestId, 'x-diagnostic-phase': phase, 'x-diagnostic-scenario': scenario, 'sec-fetch-site': 'same-origin' };
      if (actor) headers.authorization = `Bearer ${tokens[actor - 1]}`;
      if (json !== undefined) headers['content-type'] = 'application/json';
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, redirect: 'manual', body: form ?? (json === undefined ? undefined : JSON.stringify(json)) });
        const text = await response.text();
        const item = { requestId, phase, scenario, method, path, status: response.status, durationMs: Date.now() - started };
        requests.push(item);
        if (expected ? !expected.includes(response.status) : response.status >= 400) failures.push(item);
        try { return { ...item, body: JSON.parse(text) }; } catch { return item; }
      } catch (error) { const item = { requestId, phase, scenario, path, error: String(error) }; requests.push(item); failures.push(item); return item; }
    }
    console.log(JSON.stringify({ event: 'ready', tag, scale, port, users: 4000 * scale, textures: 1200 * scale, seconds: duration }));
    let initialization = null;
    if (args.journey) {
      await request('/api/v1/admin/settings', { actor: 1, method: 'PATCH', json: { settings: [{ key: 'votes_enabled', value: 'true' }, { key: 'comments_enabled', value: 'true' }, { key: 'require_email_verification', value: 'false' }] }, scenario: 'journey-configuration' });
      await request('/api/v1/auth/register', { method: 'POST', json: { email: `journey${scale}@example.invalid`, playerName: `Journey${scale}`, password: 'journey-password-9' }, scenario: 'journey-register', expected: [201] });
      const login = await request('/api/v1/auth/login', { method: 'POST', json: { identifier: `journey${scale}@example.invalid`, password: 'journey-password-9' }, scenario: 'journey-login' });
      tokens[2] = login.body?.accessToken;
      for (let round = 0; round < 5; round++) {
        const initialized = await DB.prepare("INSERT INTO users(email,nickname,password_hash,role,score,email_verified_at,created_at,updated_at,needs_initialization) VALUES(?,?,'','normal',1000,?,?,?,1) RETURNING id").bind(`init${scale}-${round}@example.invalid`, 'Pending', now, now, now).first();
        const sessionId = `local-initialization-${scale}-${round}`;
        await DB.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?)').bind(sessionId, initialized.id, now, now, now + 7200000, now + 7200000).run();
        tokens[3] = await mintWebAccessToken(secret, initialized.id, sessionId, 7200);
        const status = await request('/api/v1/auth/initialize', { actor: 4, scenario: 'journey-initialization-status' });
        const input = { ticket: status.body?.ticket, email: `init${scale}-${round}@example.invalid`, nickname: 'Initialized', password: 'local-password-9', playerName: `Init${scale}_${round}`, redirect: '/user' };
        const results = await Promise.all([0, 1].map(() => request('/api/v1/auth/initialize', { actor: 4, method: 'POST', json: input, scenario: 'journey-initialization-race', expected: [200, 401, 409] })));
        if (results.filter(result => result.status === 200).length !== 1) failures.push({ error: 'Initialization race did not commit once', results });
        const email = `merge${scale}-${round}@example.invalid`;
        const ids = [];
        for (const address of [email, email.toUpperCase()]) ids.push((await DB.prepare("INSERT INTO users(email,nickname,password_hash,role,score,email_verified_at,created_at,updated_at,legacy_email_conflict) VALUES(?,'Legacy',?,'normal',100,?,?,?,1) RETURNING id").bind(address, password, now, now, now).first()).id);
        const merged = await Promise.all(ids.map(retainUserId => request('/api/v1/auth/login', { method: 'POST', json: { identifier: email, password: 'local-password-9', retainUserId }, scenario: 'journey-merge-race', expected: [200, 409] })));
        if (merged.filter(result => result.status === 200).length !== 1) failures.push({ error: 'Merge race did not commit once', results: merged });
      }
      await request('/api/v1/textures/1/comments', { actor: 2, method: 'POST', json: { content: 'Local performance comment' }, scenario: 'journey-comment-create', expected: [201] });
      await request('/api/v1/textures/1/comments', { actor: 3, scenario: 'journey-comment-read' });
      await request('/api/v1/textures/10/comments', { actor: 3, scenario: 'journey-private-comment-denied', expected: [404] });
      const category = await request('/api/v1/admin/ticket-categories', { actor: 1, method: 'POST', json: { name: 'Local support' }, scenario: 'journey-category-create', expected: [201] });
      const ticketForm = new FormData(); ticketForm.set('categoryId', String(category.body?.id)); ticketForm.set('title', 'Local support request'); ticketForm.set('description', 'A synthetic support request.');
      const ticket = await request('/api/v1/tickets', { actor: 2, method: 'POST', form: ticketForm, scenario: 'journey-ticket-create', expected: [201] });
      await request(`/api/v1/tickets/${ticket.body?.id}`, { actor: 3, scenario: 'journey-ticket-denied', expected: [403, 404] });
      const reply = new FormData(); reply.set('body', 'Local support response');
      await request(`/api/v1/admin/tickets/${ticket.body?.id}/messages`, { actor: 1, method: 'POST', form: reply, scenario: 'journey-ticket-reply' });
      await request(`/api/v1/tickets/${ticket.body?.id}`, { actor: 2, scenario: 'journey-ticket-read' });
      await request(`/api/v1/admin/tickets/${ticket.body?.id}/status`, { actor: 1, method: 'PATCH', json: { status: 'closed' }, scenario: 'journey-ticket-close' });
      const vote = await request('/api/v1/admin/votes', { actor: 1, method: 'POST', scenario: 'journey-vote-create', expected: [201], json: { title: 'Local event', description: 'Choose one event.', startsAt: Date.now() - 1000, endsAt: Date.now() + 86400000, maxChoices: 1, resultsPolicy: 'always', registeredBefore: null, minScore: 0, requireVerified: false, playRules: [], options: [{ title: 'Build', description: 'Build together' }, { title: 'Explore', description: 'Explore together' }] } });
      const published = await request(`/api/v1/admin/votes/${vote.body?.id}/publish`, { actor: 1, method: 'POST', json: { version: vote.body?.version }, scenario: 'journey-vote-publish' });
      const ballot = { version: published.body?.version, optionIds: [published.body?.options?.[0]?.id] };
      await request(`/api/v1/votes/${vote.body?.id}/ballot`, { actor: 2, method: 'POST', json: ballot, scenario: 'journey-vote-cast', expected: [200, 201] });
      await request(`/api/v1/votes/${vote.body?.id}/ballot`, { actor: 2, method: 'POST', json: ballot, scenario: 'journey-vote-immutable', expected: [409] });
      await request('/api/v1/admin/settings', { actor: 1, method: 'PATCH', json: { settings: [{ key: 'resend_api_key', value: 'local-test-only' }, { key: 'mail_from', value: 'Local <local@example.invalid>' }] }, scenario: 'journey-mail-fixture' });
      const queue = await request('/__diagnostic/queue', { method: 'POST', json: { broadcastId: 'local', receiver: 2, title: 'Local email', content: 'Local message', afterId: 0 }, scenario: 'journey-queue-retry' });
      if (!queue.body?.retryAfter || queue.body?.acknowledged) failures.push({ ...queue, error: 'Expected retry for unavailable external mail fixture' });
      await request('/api/v1/admin/settings', { actor: 1, method: 'PATCH', json: { settings: [{ key: 'texture_ai_translation', value: 'true' }] }, scenario: 'journey-ai-enable' });
      const image = new FormData(); image.set('file', new Blob([makePng({ width: 64, height: 64, seed: 189 })], { type: 'image/png' }), 'local.png'); image.set('name', 'Quota probe'); image.set('kind', 'skin'); image.set('model', 'default'); image.set('visibility', 'private');
      await request('/api/v1/textures', { actor: 2, method: 'POST', form: image, scenario: 'journey-ai-enqueue', expected: [201] });
      await request('/__diagnostic/scheduled?cron=*+*+*+*+*', { scenario: 'journey-ai-first-dispatch' });
      const paused = await request('/api/v1/admin/ai-jobs/quota', { actor: 1, scenario: 'journey-ai-paused' });
      if (!paused.body?.paused) failures.push({ ...paused, error: 'Expected daily Workers AI pause' });
      const beforePolling = events.length;
      for (let minute = 0; minute < 10; minute++) await request('/__diagnostic/scheduled?cron=*+*+*+*+*', { scenario: 'journey-ai-paused-poll' });
      if (events.slice(beforePolling).some(event => /\bai_jobs\b/.test(event.sql))) failures.push({ error: 'Paused scheduler read ai_jobs' });
      await request('/api/v1/admin/ai-jobs/quota/reset', { actor: 1, method: 'POST', scenario: 'journey-ai-reset' });
      await request('/api/v1/auth/logout', { actor: 3, method: 'POST', scenario: 'journey-logout' });
      await request('/api/v1/me', { actor: 3, scenario: 'journey-revoked-session', expected: [401] });
    }
    if (args.warm) {
      await request('/sitemap.xml', { scenario: 'sitemap-initialization' });
      initialization = { rowsRead: events.reduce((sum, event) => sum + (event.rowsRead ?? 0), 0), rowsWritten: events.reduce((sum, event) => sum + (event.rowsWritten ?? 0), 0), failures: [...failures] };
      await writeFile(resolve(output, `scale-${scale}-initialization-sql.ndjson`), events.map(event => JSON.stringify(event)).join('\n'));
      events.length = 0;
      requests.length = 0;
      failures.length = 0;
    }
    if (args.idle) {
      const midnight = Date.now();
      for (let minute = 0; minute < 1440; minute++) {
        const time = midnight + minute * 60_000;
        await request(`/__diagnostic/scheduled?cron=*+*+*+*+*&time=${time}`, { scenario: '24h-minute-cron' });
        if (minute % 60 === 0) await request(`/__diagnostic/scheduled?cron=0+*+*+*+*&time=${time}&alarms=true`, { scenario: '24h-hourly-cron' });
      }
    }
    while (!args.idle && !args.journey && tick < Math.ceil(duration * 1000 / interval)) {
      const phase = phaseAt();
      await request('/.well-known/openid-configuration', { expected: [200, 302, 404], scenario: 'openid-discovery' });
      if (phase !== 'idle') {
        const paths = ['/', '/api/v1/settings/public', '/api/v1/textures?kind=skin', '/api/v1/textures?kind=skin&locale=en', '/api/v1/textures?page=2&locale=ja_JP', '/api/v1/textures/1', '/api/v1/users/2/profile', '/api/v1/manual?locale=ja_JP', '/manual/local-guide?lang=ja_JP', '/api/v1/translations?locale=en', '/api/v1/live2d', '/sitemap.xml', '/robots.txt', '/LocalPlayer.json', `/textures/${hash}`, `/avatar/${hash}?size=64`, `/preview/${hash}`, '/yggc/.well-known/openid-configuration'];
        const chosen = phase === 'concurrent' ? paths : [paths[tick % paths.length], paths[(tick + 3) % paths.length]];
        await Promise.all(chosen.map(path => request(path, { scenario: 'public-browse' })));
        if (tick % 3 === 0) await Promise.all(['/api/v1/me', '/api/v1/closet', '/api/v1/players', '/api/v1/notifications', '/api/v1/tickets', '/api/v1/votes'].map(path => request(path, { actor: 2, scenario: 'member-browse' })));
        if (tick % 6 === 0) {
          await request('/api/v1/admin/stats', { actor: 1, scenario: 'admin-statistics' });
          const saved = await request('/api/v1/admin/manual/local-performance', { actor: 1, method: 'PUT', scenario: 'manual-write', json: { title: 'Performance guide', description: 'Local', content: '# Local guide', group: 'Local', revision: 0 }, expected: [200, 409] });
          if (saved.status === 200) await request(`/api/v1/admin/manual/local-performance?revision=${saved.body.updatedAt}`, { actor: 1, method: 'DELETE', scenario: 'manual-delete' });
        }
        if (tick % 12 === 0) {
          await request('/api/v1/auth/login', { method: 'POST', json: { identifier: 'user3@example.invalid', password: 'local-password-9' }, scenario: 'password-login' });
          const form = new FormData();
          form.set('file', new Blob([makePng({ width: 64, height: 64, seed: tick + 20 })], { type: 'image/png' }), 'local.png');
          form.set('name', `Local upload ${tick}`); form.set('kind', 'skin'); form.set('model', 'default'); form.set('visibility', 'private');
          const uploaded = await request('/api/v1/textures', { method: 'POST', actor: 2, form, scenario: 'texture-upload', expected: [201, 409] });
          if (uploaded.status === 201) {
            const id = uploaded.body.id;
            await request(`/api/v1/textures/${id}`, { scenario: 'private-denied', expected: [403, 404] });
            await request(`/api/v1/textures/${id}`, { actor: 2, method: 'PATCH', json: { name: 'Updated local texture' }, scenario: 'texture-update' });
            await request(`/api/v1/textures/${id}`, { actor: 2, method: 'DELETE', scenario: 'texture-delete' });
          }
          const player = await request('/api/v1/players', { actor: 2, method: 'POST', json: { name: `Probe${scale}_${tick}` }, scenario: 'player-create' });
          if (player.status === 201) await request(`/api/v1/players/${player.body.id}`, { actor: 2, method: 'DELETE', scenario: 'player-delete' });
          await request('/api/v1/closet', { actor: 2, method: 'POST', json: { textureId: 3 }, scenario: 'closet-add', expected: [201, 409] });
          await request('/api/v1/closet/3', { actor: 2, method: 'DELETE', scenario: 'closet-delete' });
          await Promise.all(['zh_CN', 'en', 'zh_TW', 'ja_JP', 'es_ES', 'ru_RU'].map(locale => request(`/api/v1/manual?locale=${locale}`, { scenario: 'manual-locales' })));
        }
      }
      if (tick % 4 === 0) await request('/__diagnostic/scheduled?cron=*+*+*+*+*', { scenario: 'minute-cron' });
      if (tick === 0) await request('/__diagnostic/scheduled?cron=0+*+*+*+*', { scenario: 'hourly-cron' });
      tick++;
      if (tick % 4 === 0) {
        await writeFile(resolve(output, `scale-${scale}-progress.json`), JSON.stringify({ elapsedSeconds: Math.round((Date.now() - start) / 1000), requests: requests.length, sql: events.length, rowsRead: events.reduce((sum, event) => sum + (event.rowsRead ?? 0), 0), failures: failures.length, phase }));
        console.log(JSON.stringify({ event: 'progress', scale, phase, elapsedSeconds: Math.round((Date.now() - start) / 1000), requests: requests.length, sql: events.length }));
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, start + tick * interval - Date.now())));
    }
    await writeFile(resolve(output, `scale-${scale}-sql.ndjson`), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await writeFile(resolve(output, `scale-${scale}-http.json`), JSON.stringify(requests, null, 2));
    await writeFile(resolve(output, `scale-${scale}-cache.json`), JSON.stringify({ scope: 'Public content KV reads; excludes L1 hits and quota metadata', reads: cacheEvents.length, hits: cacheEvents.filter(event => event.hit).length, events: cacheEvents }, null, 2));
    const grouped = new Map();
    for (const event of events) { const key = `${event.route}\n${event.sql}`; const value = grouped.get(key) ?? { route: event.route, sql: event.sql, calls: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0, errors: 0 }; value.calls++; value.rowsRead += event.rowsRead ?? 0; value.rowsWritten += event.rowsWritten ?? 0; value.durationMs += event.durationMs ?? 0; value.errors += event.success ? 0 : 1; grouped.set(key, value); }
    const summary = { tag, scale, initialization, seconds: (Date.now() - start) / 1000, requests: requests.length, failures, sqlCalls: events.length, rowsRead: events.reduce((sum, event) => sum + (event.rowsRead ?? 0), 0), rowsWritten: events.reduce((sum, event) => sum + (event.rowsWritten ?? 0), 0), hotspots: [...grouped.values()].sort((a, b) => b.rowsRead - a.rowsRead) };
    await writeFile(resolve(output, `scale-${scale}-summary.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ event: 'complete', scale, requests: summary.requests, sqlCalls: summary.sqlCalls, rowsRead: summary.rowsRead, failures: failures.length, output }));
  } finally { await mf.dispose(); }
}

await Promise.all(scales.map(run));
