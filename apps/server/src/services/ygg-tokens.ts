import { hashToken, mintOpaqueToken } from '@pigeon-skin/auth';

export interface YggTokenProfile {
  playerId: number | null;
  id: string | null;
  version: number | null;
}

export interface IssueYggTokenInput {
  userId: number;
  clientToken: string;
  profile: YggTokenProfile | null;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export interface YggTokenRow {
  id: string;
  user_id: number;
  client_token: string;
  player_id: number | null;
  profile_uuid: string | null;
  profile_version: number | null;
  source: string;
  expires_at: number;
  refresh_deadline: number;
}

function tokenValues(input: IssueYggTokenInput, id: string, now: number) {
  return [
    id,
    input.userId,
    input.clientToken,
    input.profile?.playerId ?? null,
    input.profile?.id ?? null,
    input.profile?.version ?? null,
    now,
    now + input.accessTtlSeconds * 1000,
    now + input.refreshTtlSeconds * 1000,
  ] as const;
}

export async function issueYggToken(db: D1Database, input: IssueYggTokenInput): Promise<string> {
  const token = mintOpaqueToken();
  const id = await hashToken(token);
  await db.prepare(`INSERT INTO ygg_tokens
    (id, user_id, client_token, player_id, profile_uuid, profile_version, created_at, expires_at, refresh_deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(...tokenValues(input, id, Date.now())).run();
  return token;
}

export async function readYggToken(db: D1Database, token: string, refresh = false): Promise<YggTokenRow | null> {
  const id = await hashToken(token);
  const row = await db.prepare('SELECT id, user_id, client_token, player_id, profile_uuid, profile_version, source, expires_at, refresh_deadline FROM ygg_tokens WHERE id = ?').bind(id).first<YggTokenRow>();
  if (!row || (refresh ? row.refresh_deadline : row.expires_at) <= Date.now()) return null;
  return row;
}

/** Atomically consumes a refreshable traditional token and inserts its successor. */
export async function rotateYggToken(db: D1Database, oldToken: string, input: IssueYggTokenInput): Promise<string | null> {
  const token = mintOpaqueToken();
  const [oldId, newId] = await Promise.all([hashToken(oldToken), hashToken(token)]);
  const now = Date.now();
  const values = tokenValues(input, newId, now);
  const results = await db.batch([
    db.prepare("DELETE FROM ygg_tokens WHERE id = ? AND source = 'traditional' AND refresh_deadline > ? RETURNING id").bind(oldId, now),
    db.prepare(`INSERT INTO ygg_tokens
      (id, user_id, client_token, player_id, profile_uuid, profile_version, created_at, expires_at, refresh_deadline)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`).bind(...values),
  ]);
  return results[1]?.meta.changes ? token : null;
}
