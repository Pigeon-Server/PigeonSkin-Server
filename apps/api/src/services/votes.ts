import { z } from 'zod';
import type { Context } from 'hono';
import { AppError } from '../framework.ts';
import type { AppEnv } from '../lib.ts';
import { serverBackendVoteAdapter, type PlayRequirement } from './vote-playtime.ts';

export const voteInput = z.object({
  title: z.string().trim().min(1).max(100), description: z.string().max(5000).default(''),
  startsAt: z.number().int().nonnegative(), endsAt: z.number().int().positive(),
  maxChoices: z.number().int().min(1).max(50),
  resultsPolicy: z.enum(['after_close', 'after_vote', 'always']).default('after_close'),
  registeredBefore: z.number().int().nonnegative().nullable().default(null),
  minScore: z.number().int().min(0).max(100000000).default(0),
  requireVerified: z.boolean().default(false),
  playRules: z.array(z.object({ kind: z.enum(['modpack', 'server_type']), target: z.string().trim().min(1).max(200), minSeconds: z.number().int().nonnegative().max(315360000) })).max(20).default([]),
  options: z.array(z.object({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(100), description: z.string().max(1000).default('') })).min(2).max(50),
}).strict().superRefine((v, ctx) => {
  if (v.endsAt <= v.startsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'after_start' });
  if (v.maxChoices > v.options.length) ctx.addIssue({ code: 'custom', path: ['maxChoices'], message: 'too_many_choices' });
  const ids = v.options.flatMap(o => o.id ? [o.id] : []);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'duplicate_id' });
  if (new Set(v.options.map(o => o.title.toLowerCase())).size !== v.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'duplicate_title' });
});
export type VoteInput = z.infer<typeof voteInput>;
export const draftInput = voteInput.innerType().extend({
  options: z.array(z.object({ id: z.string().uuid().optional(), title: z.string().trim().max(100), description: z.string().max(1000).default('') })).max(50),
}).superRefine((v, ctx) => {
  if (v.endsAt <= v.startsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'after_start' });
  const ids = v.options.flatMap(o => o.id ? [o.id] : []);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'duplicate_id' });
});
export interface VoteRow {
  id: string; title: string; description: string; status: 'draft' | 'published' | 'closed' | 'cancelled';
  starts_at: number; ends_at: number; max_choices: number; results_policy: string;
  registered_before: number | null; min_score: number; require_verified: number; play_rules: string;
  created_at: number; updated_at: number; closed_at: number | null; archived_at: number | null; version: number;
  review_required: number; review_notes: string;
}
export interface OptionRow { id: string; title: string; description: string; position: number; votes?: number }
export function voteStatus(v: VoteRow, now = Date.now()) {
  if (v.archived_at !== null) return 'archived';
  if (v.status !== 'published') return v.status;
  if (v.ends_at <= now) return 'ended';
  return v.starts_at > now ? 'scheduled' : 'active';
}
export async function findVote(c: Context<AppEnv>, id: string, admin = false) {
  const row = await c.env.DB.prepare('SELECT * FROM pigeon_votes WHERE id = ?').bind(id).first<VoteRow>();
  if (!row || (!admin && (row.status === 'draft' || row.archived_at !== null))) throw new AppError('votes.not_found', 404);
  return row;
}
export async function eligibility(c: Context<AppEnv>, v: VoteRow) {
  const actor = c.get('user');
  if (!actor) return { eligible: false, reason: 'auth.login' };
  const user = await c.env.DB.prepare('SELECT role, score, created_at, email_verified_at FROM users WHERE id = ?').bind(actor.id).first<{ role: string; score: number; created_at: number; email_verified_at: number | null }>();
  if (!user || user.role === 'banned') return { eligible: false, reason: 'votes.requirement_account' };
  if (v.registered_before !== null && user.created_at > v.registered_before) return { eligible: false, reason: 'votes.requirement_registration' };
  if (user.score < v.min_score) return { eligible: false, reason: 'votes.requirement_score' };
  if (v.require_verified && user.email_verified_at === null) return { eligible: false, reason: 'votes.requirement_email' };
  const rules = JSON.parse(v.play_rules) as PlayRequirement[];
  if (rules.length) {
    if (!serverBackendVoteAdapter.available) return { eligible: false, reason: 'votes.requirements_unavailable' };
    const { results } = await c.env.DB.prepare('SELECT uuid FROM uuid WHERE player_id IN (SELECT id FROM players WHERE user_id = ?)').bind(actor.id).all<{ uuid: string }>();
    const result = await serverBackendVoteAdapter.check({ userId: actor.id, playerUuids: results.map(p => p.uuid), requirements: rules });
    if (result !== 'eligible') return { eligible: false, reason: result === 'unavailable' ? 'votes.requirements_unavailable' : 'votes.requirement_playtime' };
  }
  return { eligible: true, reason: null };
}
export async function voteDetail(c: Context<AppEnv>, v: VoteRow, admin = false) {
  const actor = c.get('user');
  const ballot = actor ? await c.env.DB.prepare('SELECT option_ids AS optionIds, created_at AS createdAt FROM pigeon_ballots WHERE vote_id = ? AND user_id = ?').bind(v.id, actor.id).first<{ optionIds: string; createdAt: number }>() : null;
  const status = voteStatus(v);
  const resultsVisible = admin || v.results_policy === 'always' || (v.results_policy === 'after_vote' && !!ballot) || (v.results_policy === 'after_close' && ['closed', 'ended'].includes(status));
  const options = await c.env.DB.prepare('SELECT id, title, description, position FROM pigeon_vote_options WHERE vote_id = ? ORDER BY position').bind(v.id).all<OptionRow>();
  let participants: number | null = null;
  let counts = new Map<string, number>();
  if (resultsVisible) {
    participants = (await c.env.DB.prepare('SELECT count(*) AS n FROM pigeon_ballots WHERE vote_id = ?').bind(v.id).first<{ n: number }>())!.n;
    const { results } = await c.env.DB.prepare('SELECT j.value AS id, count(*) AS n FROM pigeon_ballots b, json_each(b.option_ids) j WHERE b.vote_id = ? GROUP BY j.value').bind(v.id).all<{ id: string; n: number }>();
    counts = new Map(results.map(r => [r.id, r.n]));
  }
  return { id: v.id, title: v.title, description: v.description, status, startsAt: v.starts_at, endsAt: v.ends_at, maxChoices: v.max_choices, resultsPolicy: v.results_policy,
    requirements: { registeredBefore: v.registered_before, minScore: v.min_score, requireVerified: !!v.require_verified, playRules: JSON.parse(v.play_rules) as PlayRequirement[] },
    version: v.version, createdAt: v.created_at, updatedAt: v.updated_at, closedAt: v.closed_at, participants, resultsVisible,
    ballot: ballot ? { optionIds: JSON.parse(ballot.optionIds) as string[], createdAt: ballot.createdAt } : null,
    eligibility: await eligibility(c, v),
    ...(admin ? { reviewRequired: !!v.review_required, reviewNotes: JSON.parse(v.review_notes) as Array<{ type: number; data: string }> } : {}),
    options: options.results.map(o => ({ ...o, votes: resultsVisible ? counts.get(o.id) ?? 0 : null })),
  };
}
export async function saveDraft(c: Context<AppEnv>, raw: z.input<typeof draftInput>, actorId: number, current?: VoteRow) {
  const input = draftInput.parse(raw);
  const id = current?.id ?? crypto.randomUUID(), now = Date.now(), marker = crypto.randomUUID();
  const options = input.options.map((o, position) => ({ ...o, id: o.id ?? crypto.randomUUID(), position }));
  const statement = current
    ? c.env.DB.prepare("UPDATE pigeon_votes SET title = ?, description = ?, starts_at = ?, ends_at = ?, max_choices = ?, results_policy = ?, registered_before = ?, min_score = ?, require_verified = ?, play_rules = ?, updated_at = ?, version = version + 1, mutation_key = ?, review_required = 0, review_notes = '[]' WHERE id = ? AND status = 'draft' AND archived_at IS NULL AND version = ?")
      .bind(input.title, input.description, input.startsAt, input.endsAt, input.maxChoices, input.resultsPolicy, input.registeredBefore, input.minScore, Number(input.requireVerified), JSON.stringify(input.playRules), now, marker, id, current.version)
    : c.env.DB.prepare("INSERT INTO pigeon_votes (id, title, description, status, starts_at, ends_at, max_choices, results_policy, registered_before, min_score, require_verified, play_rules, created_by, created_at, updated_at, mutation_key) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.title, input.description, input.startsAt, input.endsAt, input.maxChoices, input.resultsPolicy, input.registeredBefore, input.minScore, Number(input.requireVerified), JSON.stringify(input.playRules), actorId, now, now, marker);
  const guard = 'EXISTS (SELECT 1 FROM pigeon_votes WHERE id = ? AND mutation_key = ?)';
  const result = await c.env.DB.batch([
    statement,
    c.env.DB.prepare(`DELETE FROM pigeon_vote_options WHERE vote_id = ? AND ${guard}`).bind(id, id, marker),
    ...options.map(o => c.env.DB.prepare(`INSERT INTO pigeon_vote_options (id, vote_id, title, description, position) SELECT ?, ?, ?, ?, ? WHERE ${guard}`).bind(o.id, id, o.title, o.description, o.position, id, marker)),
  ]);
  if (!result[0]?.meta.changes) throw new AppError('votes.changed', 409);
  return id;
}
