import { createHash } from 'node:crypto';
import type { StageContext } from './stages.ts';
import type { StageResult } from './types.ts';
import type { BoundStatement } from '../targets/types.ts';
import { legacyDateTimeToEpoch } from '../lib/date.ts';

type Row = Record<string, unknown>;
function stableId(value: string) {
  const h = createHash('sha256').update(`pigeon:${value}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function time(value: unknown, tz: string) {
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
  let text = String(value ?? '').trim();
  if (/^\d{2}-\d{2}-\d{2}$/.test(text)) text = `20${text}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += ' 00:00:00';
  text = text.replace(/^(\d{4}-\d{2}-\d{2} )[T]?(\d{2})-(\d{2})-(\d{2})$/, '$1$2:$3:$4');
  return legacyDateTimeToEpoch(text, tz);
}
export async function stagePigeon(ctx: StageContext): Promise<StageResult> {
  const tables = new Set(await ctx.source.listTables()), skipped: Record<string, number> = {};
  const source = async (table: string) => tables.has(table) ? ctx.source.query<Row>(`SELECT * FROM ${table}`) : [];
  const [keys, votes, options, rules, packs] = await Promise.all(['ps_ApiKeys', 'ps_VoteList', 'ps_VoteData', 'ps_VoteRequire', 'ps_ModPackList'].map(source));
  const ids = new Set((await ctx.target.query<{ id: number }>('SELECT id FROM users')).map(u => Number(u.id)));
  if (ctx.dryRun) for (const u of await ctx.source.query<{ uid: number }>('SELECT uid FROM users')) ids.add(Number(u.uid));
  const recordCount = tables.has('ps_VoteRecord') ? await ctx.source.count('ps_VoteRecord') : 0;
  const total = keys!.length + votes!.length + options!.length + rules!.length + packs!.length + recordCount;
  let written = 0, planned = 0;
  const mark = (key: string) => { skipped[key] = (skipped[key] || 0) + 1; };
  const write = async (statements: BoundStatement[]) => { planned += statements.length; if (!ctx.dryRun && statements.length) written += await ctx.target.runBatch(statements); };
  const archive = async (table: string, row: Row) => {
    await write([{ sql: 'INSERT OR IGNORE INTO pigeon_legacy_archive (source_table, legacy_id, payload) VALUES (?, ?, ?)', params: [table, String(row.id ?? stableId(JSON.stringify(row))), JSON.stringify(row)] }]);
  };
  for (const k of keys!) {
    const raw = String(k.key ?? '');
    if (!raw) { mark('key_empty'); continue; }
    const owner = Number(k.keyCreateUser);
    await write([{ sql: 'INSERT OR IGNORE INTO pigeon_api_keys (id, label, secret_hash, prefix, scopes, created_by, enabled, created_at, last_used_at, usage_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params: [stableId(`key:${k.id}`), String(k.text || 'Legacy API key'), createHash('sha256').update(raw).digest('hex'), raw.slice(0, 12), JSON.stringify(['players.read', 'users.read', 'users.email']), ids.has(owner) ? owner : null, Number(k.keyEnable) ? 1 : 0, time(k.keyCreateTime, ctx.tz) ?? Date.now(), time(k.keyLastUsedTime, ctx.tz), Math.max(0, Number(k.keyUsageCount) || 0)] }]);
  }
  for (const p of packs!) await write([{ sql: 'INSERT OR IGNORE INTO pigeon_packs (id, name, server_type) VALUES (?, ?, ?)', params: [Number(p.id), String(p.name), String(p.type || '')] }]);
  const voteMap = new Map<string, { id: string; optionMap: Map<number, string>; max: number }>();
  for (const v of votes!) {
    const legacyUuid = String(v.uuid ?? ''), start = time(v.startTime, ctx.tz), end = time(v.endTime, ctx.tz);
    const ownOptions = options!.filter(o => String(o.uuid) === legacyUuid).sort((a, b) => Number(a.number) - Number(b.number));
    const max = Number(v.single) ? 1 : Number(v.choice);
    if (!legacyUuid || start === null || end === null || end <= start || !String(v.title || '').trim() || ownOptions.length < 2 || ownOptions.length > 50 || !Number.isInteger(max) || max < 1 || max > ownOptions.length || new Set(ownOptions.map(o => Number(o.number))).size !== ownOptions.length) {
      mark('vote_invalid'); await archive('ps_VoteList', v); continue;
    }
    const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(legacyUuid) ? legacyUuid : stableId(`vote:${legacyUuid}`);
    const optionMap = new Map(ownOptions.map(o => [Number(o.number), stableId(`option:${legacyUuid}:${o.number}`)]));
    const requirements = { registered: null as number | null, score: 0, play: [] as Array<{ kind: string; target: string; minSeconds: number }>, unsupported: false, notes: [] as Array<{ type: number; data: string }> };
    for (const r of rules!.filter(r => String(r.uuid) === legacyUuid)) {
      requirements.notes.push({ type: Number(r.type), data: String(r.data) });
      if (Number(r.type) === 1) { requirements.registered = time(r.data, ctx.tz); if (requirements.registered === null) requirements.unsupported = true; }
      else if (Number(r.type) === 2) { const score = Number(r.data); if (!Number.isInteger(score) || score < 0 || score > 100000000) requirements.unsupported = true; else requirements.score = score; }
      else if ([3, 4].includes(Number(r.type))) {
        try {
          const data = JSON.parse(String(r.data)) as Record<string, unknown>;
          const rawTime = String(data.playTime ?? '0'), matched = rawTime.match(/^(\d+(?:\.\d+)?)\s*([smhd])?$/i);
          const seconds = matched ? Math.round(Number(matched[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[matched[2]?.toLowerCase() as 's'] || 1)) : 0;
          if (!matched) requirements.unsupported = true;
          if (matched && !matched[2] && Number(matched[1]) > 0) requirements.unsupported = true;
          requirements.play.push({ kind: Number(r.type) === 3 ? 'modpack' : 'server_type', target: String(data.modPack_ID ?? data.serverType ?? 'unknown'), minSeconds: seconds });
        } catch { requirements.unsupported = true; await archive('ps_VoteRequire', r); }
      } else { requirements.unsupported = true; await archive('ps_VoteRequire', r); }
    }
    const state = Number(v.active);
    if (![-2, -1, 0, 1, 2].includes(state)) { requirements.unsupported = true; requirements.notes.push({ type: -1, data: `Unknown status: ${String(v.active)}` }); }
    let status = state === -2 ? 'draft' : state === -1 ? 'cancelled' : state === 2 ? 'closed' : 'published';
    if ((requirements.play.length || requirements.unsupported) && status === 'published' && end > Date.now()) { status = 'draft'; mark('vote_requires_backend'); }
    const owner = Number(v.uid), added = time(v.addTime, ctx.tz) ?? start;
    await write([
      { sql: 'INSERT OR IGNORE INTO pigeon_votes (id, title, description, status, starts_at, ends_at, max_choices, results_policy, registered_before, min_score, play_rules, created_by, created_at, updated_at, closed_at, review_required, review_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params: [id, String(v.title), String(v.description || ''), status, start, end, max, Number(v.showVoteCount) === 1 ? 'always' : 'after_close', requirements.registered, requirements.score, JSON.stringify(requirements.play), ids.has(owner) ? owner : null, added, added, status === 'closed' ? end : null, Number(requirements.unsupported), JSON.stringify(requirements.notes)] },
      ...ownOptions.map((o, position) => ({ sql: 'INSERT OR IGNORE INTO pigeon_vote_options (id, vote_id, title, description, position) VALUES (?, ?, ?, ?, ?)', params: [optionMap.get(Number(o.number))!, id, String(o.content || ''), String(o.description || ''), position] })),
    ]);
    voteMap.set(legacyUuid, { id, optionMap, max });
  }
  for (const o of options!) if (!voteMap.has(String(o.uuid))) { mark('option_orphan'); await archive('ps_VoteData', o); }
  for (const r of rules!) if (!voteMap.has(String(r.uuid))) { mark('requirement_orphan'); await archive('ps_VoteRequire', r); }
  if (tables.has('ps_VoteRecord')) {
    const batch = Math.max(1, Math.min(1000, Math.trunc(ctx.batchSize || 500)));
    for (let offset = 0; ; offset += batch) {
    const groups = await ctx.source.query<{ uuid: string; uid: number }>('SELECT uuid, uid FROM ps_VoteRecord GROUP BY uuid, uid ORDER BY uuid, uid LIMIT ? OFFSET ?', [batch, offset]);
    for (const group of groups) {
      const rows = await ctx.source.query<Row>('SELECT * FROM ps_VoteRecord WHERE uuid = ? AND uid = ? ORDER BY id', [group.uuid, group.uid]);
      const v = voteMap.get(String(group.uuid));
      const choices = [...new Set(rows.map(r => v?.optionMap.get(Number(r.optionId))).filter((id): id is string => !!id))];
      const times = rows.map(r => time(r.voteTime, ctx.tz)).filter((t): t is number => t !== null);
      if (!v || !choices.length || choices.length > v.max || rows.some(r => !v.optionMap.has(Number(r.optionId))) || !times.length) {
        mark('ballot_invalid'); for (const row of rows) await archive('ps_VoteRecord', row); continue;
      }
      const id = stableId(`ballot:${group.uuid}:${group.uid}`), when = Math.min(...times), user = Number(group.uid);
      if (rows.length > choices.length) {
        skipped.ballot_duplicate_option = (skipped.ballot_duplicate_option || 0) + rows.length - choices.length;
        const seen = new Set<number>();
        for (const row of rows) { const option = Number(row.optionId); if (seen.has(option)) await archive('ps_VoteRecord', row); else seen.add(option); }
      }
      await write([
        { sql: 'INSERT OR IGNORE INTO pigeon_ballots (id, vote_id, user_id, voter_name, option_ids, created_at, updated_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params: [id, v.id, ids.has(user) ? user : null, String(rows[0]!.username || ''), JSON.stringify(choices), when, when, rows[0]!.ip ?? null] },
        { sql: 'INSERT OR IGNORE INTO pigeon_ballot_events (ballot_id, option_ids, created_at, revision) VALUES (?, ?, ?, 1)', params: [id, JSON.stringify(choices), when] },
      ]);
    }
    if (groups.length < batch) break;
    }
  }
  ctx.log(`  pigeon: ${total} source rows, ${written} writes`);
  return { stage: 'pigeon', total, written, ignored: ctx.dryRun ? 0 : Math.max(0, planned - written), skipped };
}
