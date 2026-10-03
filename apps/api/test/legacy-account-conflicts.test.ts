import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@pigeon-skin/auth';
import { runMigrations } from './setup.ts';

beforeAll(runMigrations);

async function createConflict(label: string, differentPasswords = false) {
  const email = `${label}@example.invalid`;
  const now = Date.now();
  const first = await env.DB.prepare("INSERT INTO users (email,nickname,password_hash,score,legacy_email_conflict,created_at,updated_at) VALUES (?,?,?,100,1,?,?) RETURNING id").bind(email, 'First', await hashPassword('first-conflict-password'), now, now).first<{ id: number }>();
  const second = await env.DB.prepare("INSERT INTO users (email,nickname,password_hash,score,legacy_email_conflict,created_at,updated_at) VALUES (?,?,?,200,1,?,?) RETURNING id").bind(email.toUpperCase(), 'Second', await hashPassword(differentPasswords ? 'second-conflict-password' : 'first-conflict-password'), now, now).first<{ id: number }>();
  return { email, first: first!.id, second: second!.id };
}

function login(body: unknown) {
  return SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
}

describe('legacy account conflicts', () => {
  it('does not disclose candidate accounts before credential verification', async () => {
    const group = await createConflict('hidden-conflict');
    const response = await login({ identifier: group.email, password: 'incorrect' });
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('accounts');
  });

  it('keeps email uniqueness for normal registration, inserts and email changes', async () => {
    const group = await createConflict('reserved-conflict');
    const response = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ email: group.email.toUpperCase(), password: 'registration-password', playerName: 'ReservedNew', legacyEmailConflict: true }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'auth.email_taken' });
    const now = Date.now();
    await expect(env.DB.prepare('INSERT INTO users(email,nickname,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)').bind(group.email, 'New', 'hash', now, now).run()).rejects.toThrow(/UNIQUE/);
    const other = await env.DB.prepare('INSERT INTO users(email,nickname,password_hash,created_at,updated_at) VALUES (?,?,?,?,?) RETURNING id').bind('unrelated-conflict@example.invalid', 'Other', 'hash', now, now).first<{ id: number }>();
    await expect(env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(group.email.toUpperCase(), other!.id).run()).rejects.toThrow(/UNIQUE/);
    expect((await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(group.email).all()).results).toHaveLength(2);
  });

  it('keeps both accounts until selection and merges points and players exactly once', async () => {
    const group = await createConflict('merge-conflict');
    await env.DB.prepare('INSERT INTO players (user_id,name,created_at,updated_at) VALUES (?,?,?,?)').bind(group.second, 'MergedPlayer', Date.now(), Date.now()).run();
    const initial = await login({ identifier: group.email, password: 'first-conflict-password' });
    expect(initial.status).toBe(409);
    expect(await initial.json()).toMatchObject({ error: 'auth.email_conflict', requiresPasswords: [], accounts: [{ id: group.first }, { id: group.second }] });
    const selected = await login({ identifier: group.email, password: 'first-conflict-password', retainUserId: group.first });
    expect(selected.status).toBe(200);
    expect(await env.DB.prepare('SELECT score, legacy_email_conflict FROM users WHERE id = ?').bind(group.first).first()).toMatchObject({ score: 300, legacy_email_conflict: 0 });
    expect(await env.DB.prepare('SELECT role, merged_into_user_id FROM users WHERE id = ?').bind(group.second).first()).toMatchObject({ role: 'banned', merged_into_user_id: group.first });
    expect(await env.DB.prepare('SELECT user_id FROM players WHERE name = ?').bind('MergedPlayer').first()).toMatchObject({ user_id: group.first });
    expect((await login({ identifier: group.email, password: 'first-conflict-password', retainUserId: group.first })).status).toBe(200);
    expect(await env.DB.prepare('SELECT score FROM users WHERE id = ?').bind(group.first).first()).toMatchObject({ score: 300 });
  });

  it('requires the other account password and refuses an unrelated retained ID', async () => {
    const group = await createConflict('verified-conflict', true);
    const now = Date.now();
    await env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE id IN (?,?)').bind(now,group.first,group.second).run();
    await env.DB.prepare('INSERT INTO players (user_id,name,created_at,updated_at) VALUES (?,?,?,?)').bind(group.first, 'ConflictPlayer', now, now).run();
    const authenticate = async (password: string) => {
      await env.DB.prepare("DELETE FROM auth_attempts WHERE kind IN ('ygg', 'ygg-ip')").run();
      return SELF.fetch('https://x/api/yggdrasil/authserver/authenticate', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:group.email,password}) });
    };
    expect((await authenticate('first-conflict-password')).status).toBe(403);
    const blocked = await login({ identifier: group.email, password: 'first-conflict-password', retainUserId: group.second });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ requiresPasswords: [group.second] });
    const invalid = await login({ identifier: group.email, password: 'first-conflict-password', retainUserId: 999999, conflictPasswords: [{ userId: group.second, password: 'second-conflict-password' }] });
    expect(invalid.status).toBe(401);
    const selected = await login({ identifier: group.email, password: 'first-conflict-password', retainUserId: group.second, conflictPasswords: [{ userId: group.second, password: 'second-conflict-password' }] });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ id: group.second });
    const gameLogin = await authenticate('second-conflict-password');
    expect(gameLogin.status, JSON.stringify(await gameLogin.json())).toBe(200);
    expect((await authenticate('first-conflict-password')).status).toBe(403);
  });

  it('merges linked records, archives unique collisions and revokes old sessions', async () => {
    const group = await createConflict('linked-conflict');
    const now = Date.now();
    const texture = await env.DB.prepare("INSERT INTO textures (hash,kind,name,uploader_id,size_bytes,width,height,created_at,updated_at) VALUES (?,'skin','Merge skin',?,1,64,64,?,?) RETURNING id").bind('f'.repeat(64), group.second, now, now).first<{ id: number }>();
    const textureId = texture!.id;
    const defaultTexture = await env.DB.prepare("INSERT INTO textures (hash,kind,name,size_bytes,width,height,created_at,updated_at) VALUES (?,'skin','Default skin',1,64,64,?,?) RETURNING id").bind('e'.repeat(64),now,now).first<{id:number}>();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO closet (user_id,texture_id,item_name,created_at) VALUES (?,?,?,?), (?,?,?,?)').bind(group.first, textureId, 'Original', now, group.second, textureId, 'Other', now),
      env.DB.prepare("INSERT INTO reports (texture_id,reporter_id,reason,created_at) VALUES (?,?,'Retained report',?), (?,?,'Other report',?)").bind(textureId, group.first, now, textureId, group.second, now),
      env.DB.prepare("INSERT INTO notifications (user_id,type,title,created_at) VALUES (?,'test','Merge notice',?)").bind(group.second, now),
      env.DB.prepare('INSERT INTO sessions (id,user_id,created_at,last_seen_at,expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?)').bind('obsolete-merge-session', group.second, now, now, now + 60000, now + 60000),
      env.DB.prepare('INSERT INTO closet (user_id,texture_id,item_name,created_at,is_default) VALUES (?,?,?,?,1)').bind(group.second,defaultTexture!.id,'Default',now),
      env.DB.prepare('INSERT INTO user_default_catalog (user_id,revision) VALUES (?,1)').bind(group.second),
    ]);
    const selected = await login({ identifier: group.email, password: 'first-conflict-password', retainUserId: group.first });
    expect(selected.status).toBe(200);
    expect(await env.DB.prepare('SELECT uploader_id FROM textures WHERE id = ?').bind(textureId).first()).toMatchObject({ uploader_id: group.first });
    expect((await env.DB.prepare('SELECT user_id,item_name FROM closet WHERE texture_id = ?').bind(textureId).all()).results).toEqual([{ user_id: group.first, item_name: 'Original' }]);
    expect(await env.DB.prepare("SELECT user_id FROM notifications WHERE title = 'Merge notice'").first()).toMatchObject({ user_id: group.first });
    expect((await env.DB.prepare('SELECT reporter_id,reason FROM reports WHERE texture_id = ?').bind(textureId).all()).results).toEqual([{ reporter_id: group.first, reason: 'Retained report' }]);
    expect(await env.DB.prepare("SELECT id FROM sessions WHERE id = 'obsolete-merge-session'").first()).toBeNull();
    expect(await env.DB.prepare('SELECT is_default FROM closet WHERE user_id = ? AND texture_id = ?').bind(group.first,defaultTexture!.id).first()).toMatchObject({is_default:1});
    expect(await env.DB.prepare('SELECT revision FROM user_default_catalog WHERE user_id = ?').bind(group.first).first()).toMatchObject({revision:1});
    expect(await env.DB.prepare('SELECT revision FROM user_default_catalog WHERE user_id = ?').bind(group.second).first()).toBeNull();
    const archive = await env.DB.prepare('SELECT archived_data FROM legacy_account_merges WHERE retained_user_id = ?').bind(group.first).first<{ archived_data: string }>();
    expect(JSON.parse(archive!.archived_data).reports).toHaveLength(1);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('serializes concurrent selections without adding points twice', async () => {
    const group = await createConflict('concurrent-conflict');
    const responses = await Promise.all([group.first, group.second].map(retainUserId => login({ identifier: group.email, password: 'first-conflict-password', retainUserId })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const rows = (await env.DB.prepare('SELECT score,merged_into_user_id FROM users WHERE id IN (?,?)').bind(group.first, group.second).all<{ score: number; merged_into_user_id: number | null }>()).results;
    expect(rows.map(row => row.score).sort((a,b) => a-b)).toEqual([0, 300]);
    expect(rows.filter(row => row.merged_into_user_id === null)).toHaveLength(1);
  });

  it('keeps merged accounts disabled even if their role is changed', async () => {
    const group=await createConflict('disabled-conflict');
    expect((await login({identifier:group.email,password:'first-conflict-password',retainUserId:group.first})).status).toBe(200);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET email = 'retained-new@example.invalid' WHERE id = ?").bind(group.first),
      env.DB.prepare("UPDATE users SET role = 'normal' WHERE id = ?").bind(group.second),
    ]);
    expect((await login({identifier:group.email,password:'first-conflict-password'})).status).toBe(401);
    expect(await env.DB.prepare('SELECT merged_into_user_id FROM users WHERE id = ?').bind(group.second).first()).toMatchObject({merged_into_user_id:group.first});
  });
});
