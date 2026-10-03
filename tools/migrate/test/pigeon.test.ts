import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteSource } from '../src/sources/sqlite.ts';
import { SqliteTarget } from '../src/targets/types.ts';
import { stagePigeon } from '../src/commands/stages-pigeon.ts';
import type { StageContext } from '../src/commands/stages.ts';
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture(dryRun = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pigeon-import-')); dirs.push(dir);
  const path = join(dir, 'legacy.sqlite'), db = new DatabaseSync(path);
  for (const sql of [
    'CREATE TABLE users (uid INTEGER PRIMARY KEY)',
    'CREATE TABLE ps_ApiKeys (id INTEGER, key TEXT, text TEXT, keyCreateUser INTEGER, keyEnable INTEGER, keyCreateTime TEXT, keyLastUsedTime TEXT, keyUsageCount INTEGER)',
    'CREATE TABLE ps_VoteList (uuid TEXT, title TEXT, description TEXT, uid INTEGER, active INTEGER, single INTEGER, choice INTEGER, startTime TEXT, endTime TEXT, addTime TEXT)',
    'CREATE TABLE ps_VoteData (id INTEGER, uuid TEXT, number INTEGER, content TEXT, description TEXT)',
    'CREATE TABLE ps_VoteRequire (id INTEGER, uuid TEXT, type INTEGER, data TEXT)',
    'CREATE TABLE ps_VoteRecord (id INTEGER, uuid TEXT, uid INTEGER, optionId INTEGER, voteTime TEXT, username TEXT, ip TEXT)',
    'CREATE TABLE ps_ModPackList (id INTEGER, name TEXT, type TEXT)',
    'INSERT INTO users VALUES (1)',
    "INSERT INTO ps_ApiKeys VALUES (1, 'apikey_legacysecret', 'Legacy service', 1, 1, '23-09-01', NULL, 4)",
    "INSERT INTO ps_VoteList VALUES ('aabbccdd-1122-3344-5566-778899aabbcc', 'Historical vote', '', 1, 2, 0, 2, '2023-09-01T08:00', '2023-09-30T20:00', '2023-09-01 08-00-00')",
    "INSERT INTO ps_VoteData VALUES (1, 'aabbccdd-1122-3344-5566-778899aabbcc', 1, 'One', ''), (2, 'aabbccdd-1122-3344-5566-778899aabbcc', 2, 'Two', '')",
    "INSERT INTO ps_VoteRecord VALUES (1, 'aabbccdd-1122-3344-5566-778899aabbcc', 1, 1, '2023-09-02 10:00:00', 'Voter', '127.0.0.1'), (2, 'aabbccdd-1122-3344-5566-778899aabbcc', 1, 2, '2023-09-02 10:00:00', 'Voter', '127.0.0.1'), (3, 'missing-vote', 1, 3, '2023-09-02 10:00:00', 'Voter', '')",
    "INSERT INTO ps_ModPackList VALUES (1, 'Test pack', 'LTS')",
  ]) db.prepare(sql).run();
  db.close();
  const source = new SqliteSource({ path }), target = SqliteTarget.open(join(dir, 'target.sqlite'));
  const migrations = resolve(import.meta.dirname, '../../../packages/db/migrations');
  await target.applySchema(readdirSync(migrations).filter(n => n.endsWith('.sql')).sort().map(n => readFileSync(join(migrations, n), 'utf8')).join('\n'));
  await target.runBatch([{ sql: "INSERT INTO users (id, email, nickname, password_hash, created_at, updated_at) VALUES (1, 'legacy@example.com', 'Legacy', 'hash', 1, 1)", params: [] }]);
  const ctx: StageContext = { source, target, tz: 'Asia/Shanghai', algo: 'bcrypt', batchSize: 500, dryRun, log() {}, presentHashes: null, texturesDir: null };
  return { source, target, ctx, path };
}
describe('Pigeon plugin migration', () => {
  it('hashes legacy secrets, preserves vote IDs and combines option rows into one ballot', async () => {
    const f = await fixture();
    try {
      const report = await stagePigeon(f.ctx);
      expect(report.skipped.ballot_invalid).toBe(1);
      const keys = await f.target.query<{ secret_hash: string; usage_count: number }>('SELECT secret_hash, usage_count FROM pigeon_api_keys'); expect(keys[0]!.secret_hash).toBe(createHash('sha256').update('apikey_legacysecret').digest('hex')); expect(keys[0]!.usage_count).toBe(4);
      const votes = await f.target.query<{ id: string; status: string; starts_at: number }>('SELECT id, status, starts_at FROM pigeon_votes'); expect(votes[0]).toMatchObject({ id: 'aabbccdd-1122-3344-5566-778899aabbcc', status: 'closed', starts_at: Date.parse('2023-09-01T00:00:00Z') });
      const ballots = await f.target.query<{ option_ids: string }>('SELECT option_ids FROM pigeon_ballots'); expect(ballots).toHaveLength(1); expect(JSON.parse(ballots[0]!.option_ids)).toHaveLength(2);
      expect(await f.target.query('SELECT * FROM pigeon_legacy_archive')).toHaveLength(1);
      await stagePigeon(f.ctx); expect(await f.target.query('SELECT * FROM pigeon_ballots')).toHaveLength(1);
    } finally { await f.source.close(); await f.target.close(); }
  });
  it('quarantines malformed qualification rules instead of silently dropping restrictions', async () => {
    const f = await fixture(); await f.source.close();
    const db = new DatabaseSync(f.path); db.prepare("UPDATE ps_VoteList SET active = 1, startTime = '2099-09-01T08:00', endTime = '2099-09-30T20:00'").run(); db.prepare("INSERT INTO ps_VoteRequire VALUES (1, 'aabbccdd-1122-3344-5566-778899aabbcc', 1, 'invalid-date')").run(); db.close();
    const source = new SqliteSource({ path: f.path });
    try {
      const report = await stagePigeon({ ...f.ctx, source }); expect(report.skipped.vote_requires_backend).toBe(1);
      const vote = (await f.target.query<{ status: string; review_required: number; review_notes: string }>('SELECT status, review_required, review_notes FROM pigeon_votes'))[0]!;
      expect(vote.status).toBe('draft'); expect(vote.review_required).toBe(1); expect(JSON.parse(vote.review_notes)[0].data).toBe('invalid-date');
    } finally { await source.close(); await f.target.close(); }
  });
  it('does not write plugin rows in dry-run mode', async () => {
    const f = await fixture(true);
    try { const report = await stagePigeon(f.ctx); expect(report.total).toBeGreaterThan(0); expect(report.written).toBe(0); expect(await f.target.query('SELECT * FROM pigeon_votes')).toHaveLength(0); expect(await f.target.query('SELECT * FROM pigeon_api_keys')).toHaveLength(0); }
    finally { await f.source.close(); await f.target.close(); }
  });
});
