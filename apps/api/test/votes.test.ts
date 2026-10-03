import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { hashToken } from '@pigeon-skin/auth';
import { runMigrations, makeAdmin } from './setup.ts';

let adminCookie = '', voterCookie = '', secondCookie = '', voterId = 0;
async function account(name: string, admin = false) {
  const email = `${name}@example.com`, password = 'Pigeon-voting-9-pass';
  const r = await api('/auth/register', { email, password, playerName: name }, 'POST', ''); expect(r.status).toBe(201);
  const id = (await r.json<{ id: number }>()).id;
  if (admin) await makeAdmin(id);
  const login = await api('/auth/login', { identifier: email, password }, 'POST', ''); expect(login.status).toBe(200);
  return { id, cookie: login.headers.get('set-cookie')!.split(';')[0]! };
}
function api(path: string, body?: unknown, method = 'GET', cookie = adminCookie) {
  return SELF.fetch(`https://x/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
interface Vote { id: string; version: number; status: string; options: Array<{ id: string; votes: number | null }>; participants: number | null; resultsVisible: boolean; ballot: { optionIds: string[] } | null }
function content(overrides: Record<string, unknown> = {}) { const now = Date.now(); return { title: 'Choose the next server event', description: 'One ballot per account.', startsAt: now - 1000, endsAt: now + 86400000, maxChoices: 1, resultsPolicy: 'after_close', registeredBefore: null, minScore: 0, requireVerified: false, playRules: [], options: [{ title: 'Building event', description: 'Build together' }, { title: 'Exploration event', description: 'Explore together' }], ...overrides }; }
async function draft(overrides: Record<string, unknown> = {}) { const r = await api('/admin/votes', content(overrides), 'POST'); expect(r.status).toBe(201); return r.json<Vote>(); }
async function publish(v: Vote) { const r = await api(`/admin/votes/${v.id}/publish`, { version: v.version }, 'POST'); expect(r.status).toBe(200); return r.json<Vote>(); }
function cast(v: Vote, ids = [v.options[0]!.id], cookie = voterCookie) { return api(`/votes/${v.id}/ballot`, { version: v.version, optionIds: ids }, 'POST', cookie); }
beforeAll(async () => {
  await runMigrations(); adminCookie = (await account('VoteAdmin', true)).cookie;
  const voter = await account('VotePlayer'); voterCookie = voter.cookie; voterId = voter.id;
  secondCookie = (await account('VoteSecond')).cookie;
});
beforeEach(async () => {
  const response = await api('/admin/settings', { settings: [{ key: 'votes_enabled', value: 'true' }, { key: 'pigeon_api_request_limit', value: '60' }, { key: 'pigeon_api_window_seconds', value: '30' }] }, 'PATCH');
  expect(response.status).toBe(200);
});
describe('Complete voting lifecycle', () => {
  it('requires login to browse polls and results or submit a ballot', async () => {
    const v = await publish(await draft({ resultsPolicy: 'always' }));
    expect((await api('/votes', undefined, 'GET', '')).status).toBe(401);
    expect((await api(`/votes/${v.id}`, undefined, 'GET', '')).status).toBe(401);
    expect((await cast(v, undefined, '')).status).toBe(401);
    expect((await api('/votes', undefined, 'GET', voterCookie)).status).toBe(200);
    expect((await api(`/votes/${v.id}`, undefined, 'GET', voterCookie)).status).toBe(200);
  });
  it('saves incomplete options as a draft but requires complete options to publish', async () => {
    const v = await draft({ options: [{ title: '', description: '' }, { title: '', description: '' }] });
    expect((await api(`/admin/votes/${v.id}/publish`, { version: v.version }, 'POST')).status).toBe(422);
    const fixed = await (await api(`/admin/votes/${v.id}`, { version: v.version, content: content() }, 'PUT')).json<Vote>();
    expect((await api(`/admin/votes/${v.id}/publish`, { version: fixed.version }, 'POST')).status).toBe(200);
  });
  it('keeps drafts private and supports atomic draft editing with version checks', async () => {
    const v = await draft(); expect((await api(`/votes/${v.id}`, undefined, 'GET', voterCookie)).status).toBe(404);
    const edited = await api(`/admin/votes/${v.id}`, { version: v.version, content: content({ title: 'Updated title' }) }, 'PUT'); expect(edited.status).toBe(200);
    expect((await api(`/admin/votes/${v.id}`, { version: v.version, content: content() }, 'PUT')).status).toBe(409);
    expect((await api('/votes', undefined, 'GET', voterCookie)).status).toBe(200);
  });
  it('accepts a ballot once, hides counts until closing and retains the chosen options', async () => {
    const v = await publish(await draft());
    const submitted = await cast(v); expect(submitted.status).toBe(201);
    const hidden = await submitted.json<Vote>(); expect(hidden.ballot!.optionIds).toEqual([v.options[0]!.id]); expect(hidden.resultsVisible).toBe(false); expect(hidden.participants).toBeNull(); expect(hidden.options.every(o => o.votes === null)).toBe(true);
    expect((await cast(v, [v.options[1]!.id])).status).toBe(409);
    const closed = await api(`/admin/votes/${v.id}/close`, { version: v.version }, 'POST'); expect(closed.status).toBe(200);
    const results = await (await api(`/votes/${v.id}`, undefined, 'GET', voterCookie)).json<Vote>(); expect(results.resultsVisible).toBe(true); expect(results.participants).toBe(1); expect(results.options.map(o => o.votes)).toEqual([1, 0]);
    expect((await cast(await closed.json<Vote>(), undefined, secondCookie)).status).toBe(403);
  });
  it('freezes published content even before its opening time and provides no ballot editing endpoint', async () => {
    const v = await publish(await draft({ startsAt: Date.now() + 60000 }));
    expect(v.status).toBe('scheduled');
    expect((await api(`/admin/votes/${v.id}`, { version: v.version, content: content() }, 'PUT')).status).toBe(409);
    expect((await cast(v)).status).toBe(403);
    expect((await api(`/votes/${v.id}/ballot`, { optionIds: [] }, 'PUT')).status).toBe(404);
    expect((await api(`/admin/votes/${v.id}/ballot`, { optionIds: [] }, 'PATCH')).status).toBe(404);
  });
  it('commits only one ballot and one event under concurrent submissions', async () => {
    const v = await publish(await draft());
    const responses = await Promise.all([cast(v), cast(v)]); expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM pigeon_ballots WHERE vote_id = ?').bind(v.id).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM pigeon_ballot_events WHERE ballot_id IN (SELECT id FROM pigeon_ballots WHERE vote_id = ?)').bind(v.id).first<{ n: number }>())!.n).toBe(1);
    await expect(env.DB.prepare('UPDATE pigeon_ballots SET option_ids = ? WHERE vote_id = ?').bind(JSON.stringify([v.options[1]!.id]), v.id).run()).rejects.toThrow(/ballot_immutable/);
  });
  it('counts multi-select participants separately from option counts', async () => {
    const v = await publish(await draft({ maxChoices: 2, resultsPolicy: 'always' }));
    expect((await cast(v, v.options.map(o => o.id))).status).toBe(201);
    expect((await cast(v, [v.options[1]!.id], secondCookie)).status).toBe(201);
    const result = await (await api(`/votes/${v.id}`, undefined, 'GET', voterCookie)).json<Vote>(); expect(result.participants).toBe(2); expect(result.options.map(o => o.votes)).toEqual([1, 2]);
  });
  it('rejects duplicate, foreign, excess and impersonating choices', async () => {
    const v = await publish(await draft()), other = await publish(await draft());
    expect((await cast(v, [v.options[0]!.id, v.options[0]!.id])).status).toBe(422);
    expect((await cast(v, v.options.map(o => o.id))).status).toBe(422);
    expect((await cast(v, [other.options[0]!.id])).status).toBe(422);
    expect((await api(`/votes/${v.id}/ballot`, { version: v.version, optionIds: [v.options[0]!.id], userId: 1 }, 'POST', voterCookie)).status).toBe(422);
    expect((await cast(v, undefined, '')).status).toBe(401);
  });
  it('rechecks registration, score and email eligibility without spending points', async () => {
    for (const rule of [{ registeredBefore: 1 }, { minScore: 1000000 }, { requireVerified: true }]) {
      const v = await publish(await draft(rule)); expect((await cast(v)).status).toBe(403);
    }
    const points = await env.DB.prepare('SELECT score FROM users WHERE id = ?').bind(voterId).first<{ score: number }>();
    const v = await publish(await draft({ minScore: 1 })); expect((await cast(v)).status).toBe(201);
    expect((await env.DB.prepare('SELECT score FROM users WHERE id = ?').bind(voterId).first<{ score: number }>())!.score).toBe(points!.score);
  });
  it('refuses to publish unavailable playtime requirements', async () => {
    const v = await draft({ playRules: [{ kind: 'modpack', target: 'legacy-pack', minSeconds: 3600 }] });
    const response = await api(`/admin/votes/${v.id}/publish`, { version: v.version }, 'POST'); expect(response.status).toBe(422);
    expect((await response.json<{ error: string }>()).error).toBe('votes.requirements_unavailable');
  });
  it('handles the ending boundary without a scheduled job and cancels without losing records', async () => {
    const v = await publish(await draft()); expect((await cast(v)).status).toBe(201);
    await env.DB.prepare('UPDATE pigeon_votes SET ends_at = ? WHERE id = ?').bind(Date.now(), v.id).run();
    expect((await cast(v, undefined, secondCookie)).status).toBe(403);
    const result = await (await api(`/votes/${v.id}`, undefined, 'GET', voterCookie)).json<Vote>(); expect(result.status).toBe('ended'); expect(result.participants).toBe(1);
    const cancel = await publish(await draft()); expect((await cast(cancel)).status).toBe(201);
    expect((await api(`/admin/votes/${cancel.id}/cancel`, { version: cancel.version }, 'POST')).status).toBe(200);
    expect((await cast(cancel, undefined, secondCookie)).status).toBe(409);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM pigeon_ballots WHERE vote_id = ?').bind(cancel.id).first<{ n: number }>())!.n).toBe(1);
  });
  it('applies after-vote visibility only to users who have submitted', async () => {
    const v = await publish(await draft({ resultsPolicy: 'after_vote' })); expect((await cast(v)).status).toBe(201);
    expect((await (await api(`/votes/${v.id}`, undefined, 'GET', voterCookie)).json<Vote>()).resultsVisible).toBe(true);
    expect((await (await api(`/votes/${v.id}`, undefined, 'GET', secondCookie)).json<Vote>()).resultsVisible).toBe(false);
    expect((await api(`/votes/${v.id}`, undefined, 'GET', '')).status).toBe(401);
  });
  it('limits records to administrators and retains archived ballots', async () => {
    const v = await publish(await draft()); await cast(v);
    expect((await api(`/admin/votes/records?vote=${v.id}`, undefined, 'GET', voterCookie)).status).toBe(403);
    const records = await (await api(`/admin/votes/records?vote=${v.id}`)).json<{ items: Array<{ userId: number; optionTitles: string[] }> }>(); expect(records.items).toHaveLength(1); expect(records.items[0]!.userId).toBe(voterId); expect(records.items[0]!.optionTitles).toEqual(['Building event']);
    const closed = await (await api(`/admin/votes/${v.id}/close`, { version: v.version }, 'POST')).json<Vote>();
    const archived = await (await api(`/admin/votes/${v.id}/archive`, { version: closed.version }, 'POST')).json<Vote>();
    expect(archived.status).toBe('archived'); expect((await api(`/votes/${v.id}`, undefined, 'GET', voterCookie)).status).toBe(404);
    expect((await api(`/admin/votes/${v.id}/restore`, { version: archived.version }, 'POST')).status).toBe(200);
  });
  it('checks CSRF, admin authority and disabled voting', async () => {
    expect((await api('/admin/votes', content(), 'POST', voterCookie)).status).toBe(403);
    const v = await publish(await draft());
    const unsafe = await SELF.fetch(`https://x/api/v1/votes/${v.id}/ballot`, { method: 'POST', headers: { cookie: voterCookie, origin: 'https://evil.example', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ version: v.version, optionIds: [v.options[0]!.id] }) }); expect(unsafe.status).toBe(403);
    await api('/admin/settings', { settings: [{ key: 'votes_enabled', value: 'false' }] }, 'PATCH');
    expect((await cast(v)).status).toBe(503); expect((await api('/votes', undefined, 'GET', voterCookie)).status).toBe(503);
    expect((await api(`/admin/votes/${v.id}`)).status).toBe(200);
  });
  it('exports authorized records without spreadsheet formula execution', async () => {
    const v = await publish(await draft({ title: '=IMPORT("payload")' })); expect((await cast(v)).status).toBe(201);
    expect((await api(`/admin/votes/export?vote=${v.id}`, undefined, 'GET', voterCookie)).status).toBe(403);
    const response = await api(`/admin/votes/export?vote=${v.id}`); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/csv');
    expect(await response.text()).toContain("'=IMPORT");
  });
  it('blocks imported rule anomalies until an administrator explicitly reviews the draft', async () => {
    const v = await draft();
    await env.DB.prepare('UPDATE pigeon_votes SET review_required = 1, review_notes = ? WHERE id = ?').bind(JSON.stringify([{ type: 1, data: 'invalid-date' }]), v.id).run();
    expect((await api(`/admin/votes/${v.id}/publish`, { version: v.version }, 'POST')).status).toBe(422);
    expect((await api(`/admin/votes/${v.id}`, { version: v.version, content: content() }, 'PUT')).status).toBe(422);
    expect((await api(`/admin/votes/${v.id}`, { version: v.version, content: content(), reviewAcknowledged: true }, 'PUT')).status).toBe(200);
  });
});

describe('Pigeon API keys', () => {
  async function key(scopes = ['players.read', 'users.read']) {
    const response = await api('/admin/pigeon/keys', { label: 'Server integration', scopes }, 'POST'); expect(response.status).toBe(201);
    return response.json<{ id: string; secret: string }>();
  }
  function legacy(path: string, secret?: string) { return SELF.fetch(`https://x/api/ps-api/${path}`, { headers: secret ? { 'api-key': secret } : {} }); }
  it('provides player UUID and legacy account contracts with hashed keys', async () => {
    const minted = await key();
    expect((await legacy('player/getUUID/VotePlayer')).status).toBe(401);
    const response = await legacy('player/status/voteplayer', minted.secret); expect(response.status).toBe(200);
    const status = await response.json<{ status: string; useruid: number; playeruuid: string }>(); expect(status.status).toBe('1'); expect(status.useruid).toBe(voterId); expect(status.playeruuid).toMatch(/^[0-9a-f]{32}$/);
    const stored = await env.DB.prepare('SELECT secret_hash FROM pigeon_api_keys WHERE id = ?').bind(minted.id).first<{ secret_hash: string }>(); expect(stored!.secret_hash).toBe(await hashToken(minted.secret));
    expect(await (await api('/admin/pigeon/keys')).text()).not.toContain(minted.secret);
  });
  it('rejects private email reads without explicit scope and fixes getEmail', async () => {
    const basic = await key(); expect((await legacy(`user/getEmail/${voterId}`, basic.secret)).status).toBe(403);
    const full = await key(['users.email']);
    const response = await legacy(`user/getEmail/${voterId}`, full.secret); expect((await response.json<{ Email: string }>()).Email).toBe('VotePlayer@example.com');
  });
  it('enforces exact quotas and checks disabled keys even after a successful call', async () => {
    const minted = await key(); await api('/admin/settings', { settings: [{ key: 'pigeon_api_request_limit', value: '2' }] }, 'PATCH');
    expect((await legacy('player/getUUID/VotePlayer', minted.secret)).status).toBe(200); expect((await legacy('player/getUUID/VotePlayer', minted.secret)).status).toBe(200);
    expect((await legacy('player/getUUID/VotePlayer', minted.secret)).status).toBe(429);
    await api(`/admin/pigeon/keys/${minted.id}`, { enabled: false }, 'PATCH'); expect((await legacy('player/getUUID/VotePlayer', minted.secret)).status).toBe(401);
  });
  it('rotates secrets and prevents re-enabling revoked keys', async () => {
    const minted = await key(); const rotated = await (await api(`/admin/pigeon/keys/${minted.id}/rotate`, {}, 'POST')).json<{ secret: string }>();
    expect((await legacy('player/getUUID/VotePlayer', minted.secret)).status).toBe(401); expect((await legacy('player/getUUID/VotePlayer', rotated.secret)).status).toBe(200);
    await api(`/admin/pigeon/keys/${minted.id}`, undefined, 'DELETE'); expect((await legacy('player/getUUID/VotePlayer', rotated.secret)).status).toBe(401);
    expect((await api(`/admin/pigeon/keys/${minted.id}`, { enabled: true }, 'PATCH')).status).toBe(404);
  });
});
