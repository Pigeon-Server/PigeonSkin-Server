import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, currentUser, currentAdmin, readJson, readPagination, paginate, toErrorResponse } from '../framework.ts';
import { getSettingBool, clientIp, type AppEnv } from '../lib.ts';
import { audit } from '../services/audit.ts';
import { voteInput, draftInput, findVote, voteDetail, voteStatus, eligibility, saveDraft, type VoteRow } from '../services/votes.ts';
import { serverBackendVoteAdapter } from '../services/vote-playtime.ts';

export function registerVoteRoutes(app: Hono<AppEnv>) {
  const r = new Hono<AppEnv>();
  r.onError(toErrorResponse);
  r.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  r.get('/votes', async c => {
    currentUser(c);
    if (!await getSettingBool(c.env, 'votes_enabled')) throw new AppError('votes.disabled', 503);
    const page = readPagination(c, { defaultPerPage: 12 });
    const status = c.req.query('status') || '', now = Date.now();
    const filter = "archived_at IS NULL AND status != 'draft' AND (? = '' OR CASE WHEN status != 'published' THEN status WHEN ends_at <= ? THEN 'ended' WHEN starts_at > ? THEN 'scheduled' ELSE 'active' END = ?)";
    const total = await c.env.DB.prepare(`SELECT count(*) AS n FROM pigeon_votes WHERE ${filter}`).bind(status, now, now, status).first<{ n: number }>();
    const rows = await c.env.DB.prepare(`SELECT * FROM pigeon_votes WHERE ${filter} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).bind(status, now, now, status, page.perPage, page.offset).all<VoteRow>();
    const items = [];
    for (const v of rows.results) {
      const detail = await voteDetail(c, v);
      items.push({ id: detail.id, title: detail.title, description: detail.description, status: detail.status, startsAt: detail.startsAt, endsAt: detail.endsAt, maxChoices: detail.maxChoices, voted: !!detail.ballot, participants: detail.participants });
    }
    return c.json(paginate(items, total?.n ?? 0, page));
  });
  r.get('/votes/:id', async c => {
    currentUser(c);
    if (!await getSettingBool(c.env, 'votes_enabled')) throw new AppError('votes.disabled', 503);
    return c.json(await voteDetail(c, await findVote(c, c.req.param('id'))));
  });
  r.post('/votes/:id/ballot', async c => {
    if (!await getSettingBool(c.env, 'votes_enabled')) throw new AppError('votes.disabled', 503);
    const user = currentUser(c), body = await readJson(c, z.object({ optionIds: z.array(z.string().uuid()).min(1).max(50), version: z.number().int().positive() }).strict());
    if (new Set(body.optionIds).size !== body.optionIds.length) throw new AppError('common.invalid_request', 422);
    const v = await findVote(c, c.req.param('id'));
    if (v.version !== body.version) throw new AppError('votes.changed', 409);
    if (voteStatus(v) !== 'active') throw new AppError('votes.closed', 403);
    if (await c.env.DB.prepare('SELECT id FROM pigeon_ballots WHERE vote_id = ? AND user_id = ?').bind(v.id, user.id).first()) throw new AppError('votes.already_voted', 409);
    const qualified = await eligibility(c, v);
    if (!qualified.eligible) throw new AppError(qualified.reason === 'votes.requirements_unavailable' ? 'votes.requirements_unavailable' : 'votes.ineligible', 403);
    if (body.optionIds.length > v.max_choices) throw new AppError('common.invalid_request', 422);
    const options = await c.env.DB.prepare('SELECT id FROM pigeon_vote_options WHERE vote_id = ?').bind(v.id).all<{ id: string }>();
    if (body.optionIds.some(id => !options.results.some(o => o.id === id))) throw new AppError('common.invalid_request', 422);
    const ballotId = crypto.randomUUID(), now = Date.now(), selected = JSON.stringify(body.optionIds);
    const result = await c.env.DB.batch([
c.env.DB.prepare("INSERT OR IGNORE INTO pigeon_ballots (id, vote_id, user_id, voter_name, option_ids, created_at, updated_at, ip) SELECT ?, v.id, u.id, u.nickname, ?, ?, ?, ? FROM pigeon_votes v JOIN users u ON u.id = ? WHERE v.id = ? AND v.version = ? AND v.status = 'published' AND v.archived_at IS NULL AND v.starts_at <= ? AND v.ends_at > ? AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'votes_enabled' AND locale = '' AND value IN ('false', '0')) AND u.role != 'banned' AND u.score >= v.min_score AND (v.registered_before IS NULL OR u.created_at <= v.registered_before) AND (v.require_verified = 0 OR u.email_verified_at IS NOT NULL) AND json_array_length(?) <= v.max_choices AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM pigeon_vote_options o WHERE o.vote_id = v.id AND o.id = j.value))")
        .bind(ballotId, selected, now, now, clientIp(c), user.id, v.id, body.version, now, now, selected, selected),
      c.env.DB.prepare('INSERT INTO pigeon_ballot_events (ballot_id, option_ids, created_at, revision) SELECT id, option_ids, created_at, revision FROM pigeon_ballots WHERE id = ?').bind(ballotId),
    ]);
    if (!result[0]?.meta.changes) {
      if (await c.env.DB.prepare('SELECT id FROM pigeon_ballots WHERE vote_id = ? AND user_id = ?').bind(v.id, user.id).first()) throw new AppError('votes.already_voted', 409);
      throw new AppError('votes.changed', 409);
    }
    return c.json(await voteDetail(c, await findVote(c, v.id)), 201);
  });
  r.use('/admin/votes/*', async (c, next) => { currentAdmin(c); await next(); });
  r.get('/admin/votes', async c => {
    currentAdmin(c); const page = readPagination(c), status = c.req.query('status') || '', q = c.req.query('q') || '', now = Date.now();
    const filter = "(? = '' OR CASE WHEN archived_at IS NOT NULL THEN 'archived' WHEN status != 'published' THEN status WHEN ends_at <= ? THEN 'ended' WHEN starts_at > ? THEN 'scheduled' ELSE 'active' END = ?) AND (? = 'archived' OR archived_at IS NULL) AND title LIKE ?";
    const binds = [status, now, now, status, status, `%${q}%`];
    const total = await c.env.DB.prepare(`SELECT count(*) AS n FROM pigeon_votes WHERE ${filter}`).bind(...binds).first<{ n: number }>();
    const rows = await c.env.DB.prepare(`SELECT v.*, (SELECT count(*) FROM pigeon_ballots b WHERE b.vote_id = v.id) AS participants FROM pigeon_votes v WHERE ${filter} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).bind(...binds, page.perPage, page.offset).all<VoteRow & { participants: number }>();
    return c.json(paginate(rows.results.map(v => ({ id: v.id, title: v.title, description: v.description, status: voteStatus(v), startsAt: v.starts_at, endsAt: v.ends_at, participants: v.participants })), total?.n ?? 0, page));
  });
  r.get('/admin/votes/records', async c => {
    currentAdmin(c); const page = readPagination(c), vote = c.req.query('vote') || '', user = c.req.query('user') || '';
    const condition = "(? = '' OR b.vote_id = ?) AND (? = '' OR b.user_id = ?)";
    const total = await c.env.DB.prepare(`SELECT count(*) AS n FROM pigeon_ballots b WHERE ${condition}`).bind(vote, vote, user, user).first<{ n: number }>();
    const rows = await c.env.DB.prepare(`SELECT b.id, b.vote_id AS voteId, v.title AS voteTitle, b.user_id AS userId, b.voter_name AS voterName, b.option_ids AS optionIds, b.created_at AS createdAt, b.ip, (SELECT json_group_array(o.title) FROM pigeon_vote_options o, json_each(b.option_ids) j WHERE o.id = j.value AND o.vote_id = b.vote_id) AS optionTitles FROM pigeon_ballots b JOIN pigeon_votes v ON v.id = b.vote_id WHERE ${condition} ORDER BY b.created_at DESC, b.id LIMIT ? OFFSET ?`).bind(vote, vote, user, user, page.perPage, page.offset).all<{ optionIds: string; optionTitles: string }>();
    return c.json(paginate(rows.results.map(b => ({ ...b, optionIds: JSON.parse(b.optionIds), optionTitles: JSON.parse(b.optionTitles) })), total?.n ?? 0, page));
  });
  r.get('/admin/votes/export', async c => {
    const actor = currentAdmin(c), vote = c.req.query('vote') || '', user = c.req.query('user') || '';
    const condition = "(? = '' OR b.vote_id = ?) AND (? = '' OR b.user_id = ?)";
    const total = await c.env.DB.prepare(`SELECT count(*) AS n FROM pigeon_ballots b WHERE ${condition}`).bind(vote, vote, user, user).first<{ n: number }>();
    if ((total?.n ?? 0) > 5000) throw new AppError('votes.export_limit', 422);
    const { results } = await c.env.DB.prepare(`SELECT v.title, b.user_id, b.voter_name, b.created_at, b.ip, (SELECT json_group_array(o.title) FROM pigeon_vote_options o, json_each(b.option_ids) j WHERE o.id = j.value AND o.vote_id = b.vote_id) AS choices FROM pigeon_ballots b JOIN pigeon_votes v ON v.id = b.vote_id WHERE ${condition} ORDER BY b.created_at, b.id LIMIT 5000`).bind(vote, vote, user, user).all<{ title: string; user_id: number | null; voter_name: string; created_at: number; ip: string | null; choices: string }>();
    const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
    const rows = [['投票', '用户 ID', '用户昵称', '所选选项', '提交时间（UTC）', 'IP'], ...results.map(b => [b.title, b.user_id, b.voter_name, (JSON.parse(b.choices) as string[]).join('；'), new Date(b.created_at).toISOString(), b.ip])];
    await audit(c.env, { actorId: actor.id, action: 'admin.vote.export', detail: `vote:${vote};user:${user};count:${results.length}` });
    return c.body(`\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}`, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vote-records.csv"' });
  });
  r.get('/admin/votes/:id', async c => c.json(await voteDetail(c, await findVote(c, c.req.param('id'), true), true)));
  r.post('/admin/votes', async c => {
    const actor = currentAdmin(c), input = await readJson(c, draftInput);
    const id = await saveDraft(c, input, actor.id);
    await audit(c.env, { actorId: actor.id, action: 'admin.vote.create', detail: id });
    return c.json(await voteDetail(c, await findVote(c, id, true), true), 201);
  });
  r.put('/admin/votes/:id', async c => {
    const actor = currentAdmin(c), body = await readJson(c, z.object({ version: z.number().int().positive(), content: draftInput, reviewAcknowledged: z.boolean().optional() }).strict());
    const v = await findVote(c, c.req.param('id'), true);
    if (v.status !== 'draft' || v.archived_at !== null) throw new AppError('votes.frozen', 409);
    if (v.version !== body.version) throw new AppError('votes.changed', 409);
    if (v.review_required && !body.reviewAcknowledged) throw new AppError('votes.legacy_review_required', 422);
    await saveDraft(c, body.content, actor.id, v);
    await audit(c.env, { actorId: actor.id, action: 'admin.vote.update', detail: v.id });
    return c.json(await voteDetail(c, await findVote(c, v.id, true), true));
  });
  r.post('/admin/votes/:id/:action', async c => {
    const actor = currentAdmin(c), action = c.req.param('action'), v = await findVote(c, c.req.param('id'), true);
    const body = await readJson(c, z.object({ version: z.number().int().positive() }).strict());
    if (v.version !== body.version) throw new AppError('votes.changed', 409);
    let statement: D1PreparedStatement;
    const now = Date.now();
    if (action === 'publish') {
      if (v.review_required) throw new AppError('votes.legacy_review_required', 422);
      if (v.status !== 'draft' || v.archived_at !== null || v.ends_at <= now) throw new AppError('votes.frozen', 409);
      if (JSON.parse(v.play_rules).length && !serverBackendVoteAdapter.available) throw new AppError('votes.requirements_unavailable', 422);
      const detail = await voteDetail(c, v, true);
      voteInput.parse({ title: detail.title, description: detail.description, startsAt: detail.startsAt, endsAt: detail.endsAt, maxChoices: detail.maxChoices, resultsPolicy: detail.resultsPolicy, ...detail.requirements, options: detail.options.map(o => ({ id: o.id, title: o.title, description: o.description })) });
      statement = c.env.DB.prepare("UPDATE pigeon_votes SET status = 'published', updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND status = 'draft' AND archived_at IS NULL").bind(now, v.id, v.version);
    } else if (action === 'close' || action === 'cancel') {
      if (v.status !== 'published' || v.archived_at !== null || ['ended', 'closed', 'cancelled'].includes(voteStatus(v))) throw new AppError('votes.frozen', 409);
      statement = c.env.DB.prepare("UPDATE pigeon_votes SET status = ?, closed_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND status = 'published' AND archived_at IS NULL").bind(action === 'close' ? 'closed' : 'cancelled', now, now, v.id, v.version);
    } else if (action === 'archive' || action === 'restore') {
      if (action === 'archive' && ['active', 'scheduled'].includes(voteStatus(v))) throw new AppError('votes.frozen', 409);
      statement = c.env.DB.prepare('UPDATE pigeon_votes SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?').bind(action === 'archive' ? now : null, now, v.id, v.version);
    } else return c.notFound();
    const changed = await statement.run();
    if (!changed.meta.changes) throw new AppError('votes.changed', 409);
    await audit(c.env, { actorId: actor.id, action: action === 'restore' ? 'admin.vote.archive' : `admin.vote.${action}` as 'admin.vote.publish' | 'admin.vote.close' | 'admin.vote.cancel' | 'admin.vote.archive', detail: v.id });
    return c.json(await voteDetail(c, await findVote(c, v.id, true), true));
  });
  app.route('/api/v1', r);
}
