import type { Bindings } from '../env.ts';
import { jsonArrayInRows, noCaseEq } from '@pigeon-skin/db';
import { AppError } from '../framework.ts';

export async function mergeLegacyAccounts(env: { DB: Bindings['DB'] }, email: string, retainedId: number, mergedIds: number[], expected: Array<{ id: number; passwordHash: string; email: string; role: string; version: number }> = []) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const ids = JSON.stringify(mergedIds);
  const exists = "EXISTS (SELECT 1 FROM legacy_account_merges WHERE id = ?)";
  const selected = () => `IN ${jsonArrayInRows('?')}`;
  const archive: Record<string, unknown> = {};
  const guard = expected.map(() => " AND EXISTS (SELECT 1 FROM users JOIN account_security ON account_security.user_id = users.id WHERE users.id = ? AND password_hash = ? AND users.email = ? AND role = ? AND role != 'banned' AND merged_into_user_id IS NULL AND account_security.version = ?)").join('');
  const guardValues = expected.flatMap(account => [account.id, account.passwordHash, account.email, account.role, account.version]);
  for (const [table, column] of [['reports', 'reporter_id'], ['mojang_verifications', 'user_id'], ['pigeon_ballots', 'user_id']]) {
    archive[table!] = (await env.DB.prepare(`SELECT * FROM ${table} WHERE ${column} ${selected()}`).bind(ids).all()).results;
  }
  archive.pigeon_ballot_events = (await env.DB.prepare(`SELECT * FROM pigeon_ballot_events WHERE ballot_id IN (SELECT id FROM pigeon_ballots WHERE user_id ${selected()})`).bind(ids).all()).results;
  const statements = [
    env.DB.prepare('INSERT OR IGNORE INTO legacy_account_merges (id,email,retained_user_id,merged_user_ids,created_at,archived_data) SELECT ?,LOWER(email),id,?,?,? FROM users WHERE id = ? AND legacy_email_conflict = 1 AND merged_into_user_id IS NULL' + guard).bind(id, ids, now, JSON.stringify(archive), retainedId, ...guardValues),
    env.DB.prepare(`UPDATE users SET score = score + COALESCE((SELECT SUM(score) FROM users WHERE id ${selected()}),0), legacy_email_conflict = 0, updated_at = ? WHERE id = ? AND ${exists}`).bind(ids, now, retainedId, id),
    env.DB.prepare(`INSERT OR IGNORE INTO closet (user_id,texture_id,item_name,created_at,is_default) SELECT ?,texture_id,item_name,created_at,is_default FROM closet WHERE user_id ${selected()} AND ${exists}`).bind(retainedId, ids, id),
    env.DB.prepare(`DELETE FROM closet WHERE user_id ${selected()} AND ${exists}`).bind(ids, id),
  ];
  for (const [table, column] of [
    ['players', 'user_id'], ['textures', 'uploader_id'], ['notifications', 'user_id'],
    ['reports', 'uploader_id'], ['reports', 'reviewer_id'],
    ['comments', 'user_id'], ['user_identities', 'user_id'], ['ygg_log', 'user_id'],
    ['tickets', 'user_id'], ['ticket_messages', 'author_id'], ['ticket_events', 'actor_id'],
    ['connect_clients', 'user_id'], ['pigeon_api_keys', 'created_by'], ['pigeon_votes', 'created_by'],
  ]) {
    statements.push(env.DB.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} ${selected()} AND ${exists}`).bind(retainedId, ids, id));
  }
  statements.push(env.DB.prepare(`UPDATE reports SET reporter_id = ? WHERE reporter_id ${selected()} AND id = (SELECT MIN(candidate.id) FROM (SELECT id, texture_id, reporter_id FROM reports WHERE reporter_id ${selected()}) candidate WHERE candidate.texture_id = reports.texture_id) AND NOT EXISTS (SELECT 1 FROM (SELECT reporter_id, texture_id FROM reports WHERE reporter_id = ?) retained WHERE retained.texture_id = reports.texture_id) AND ${exists}`).bind(retainedId, ids, ids, retainedId, id));
  statements.push(env.DB.prepare(`UPDATE mojang_verifications SET user_id = ? WHERE id = (SELECT MIN(id) FROM (SELECT id FROM mojang_verifications WHERE user_id ${selected()}) mv) AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM mojang_verifications WHERE user_id = ?) mv2) AND ${exists}`).bind(retainedId, ids, retainedId, id));
  statements.push(env.DB.prepare(`UPDATE pigeon_ballots SET user_id = ? WHERE user_id ${selected()} AND id = (SELECT MIN(candidate.id) FROM (SELECT id, vote_id FROM pigeon_ballots WHERE user_id ${selected()}) candidate WHERE candidate.vote_id = pigeon_ballots.vote_id) AND NOT EXISTS (SELECT 1 FROM (SELECT user_id, vote_id FROM pigeon_ballots WHERE user_id = ?) retained WHERE retained.vote_id = pigeon_ballots.vote_id) AND ${exists}`).bind(retainedId, ids, ids, retainedId, id));
  for (const [table, column] of [['reports', 'reporter_id'], ['mojang_verifications', 'user_id'], ['pigeon_ballots', 'user_id']]) {
    statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE ${column} ${selected()} AND ${exists}`).bind(ids, id));
  }
  statements.push(env.DB.prepare(`DELETE FROM ygg_sessions WHERE player_id IN (SELECT id FROM players WHERE user_id = ?) AND ${exists}`).bind(retainedId, id));
  const allIds = JSON.stringify([retainedId, ...mergedIds]);
  for (const table of ['account_security', 'passkeys', 'recovery_codes']) statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE user_id ${selected()} AND ${exists}`).bind(ids, id));
  for (const table of ['security_challenges', 'security_reauth']) statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE user_id ${selected()} AND ${exists}`).bind(allIds, id));
  statements.push(env.DB.prepare(`INSERT INTO user_default_catalog (user_id,revision) SELECT ?,COALESCE(MAX(revision),0) FROM user_default_catalog WHERE user_id ${selected()} AND ${exists} HAVING ${exists} ON CONFLICT(user_id) DO UPDATE SET revision = MAX(user_default_catalog.revision,excluded.revision)`).bind(retainedId,allIds,id,id));
  statements.push(env.DB.prepare(`DELETE FROM user_default_catalog WHERE user_id ${selected()} AND ${exists}`).bind(ids,id));
  for (const table of ['sessions', 'verification_tokens', 'password_reset_tokens', 'ygg_tokens', 'connect_grants', 'connect_interactions', 'oauth_login_states', 'connect_responses']) {
    statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE user_id ${selected()} AND ${exists}`).bind(allIds, id));
  }
  statements.push(env.DB.prepare(`UPDATE users SET role = 'banned', score = 0, merged_into_user_id = ?, updated_at = ? WHERE id ${selected()} AND ${exists}`).bind(retainedId, now, ids, id));
  await env.DB.batch(statements);
  const result = await env.DB.prepare(`SELECT retained_user_id FROM legacy_account_merges WHERE ${noCaseEq('email', '?')}`).bind(email).first<{ retained_user_id: number }>();
  if (result?.retained_user_id !== retainedId) throw new AppError('auth.email_conflict', 409);
}
