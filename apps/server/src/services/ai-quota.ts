import { and, eq, sql } from 'drizzle-orm';
import { aiRuntimeState, createDb } from '@pigeon-skin/db';
import type { Bindings } from '../core/env.ts';

export interface WorkersAiQuota {
  paused: boolean;
  pausedUntil: number;
  revision: number;
  fingerprint: string;
}

async function deploymentFingerprint(env: Bindings): Promise<string> {
  const input = JSON.stringify([env.AI_MODERATION_DRIVER, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, env.TYPESAFE_API_KEY, env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_BASE_URL, Boolean(env.AI)]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readWorkersAiQuota(env: Bindings): Promise<WorkersAiQuota> {
  const [row] = await createDb(env.DB).select().from(aiRuntimeState).where(eq(aiRuntimeState.provider, 'workers'));
  const fingerprint = await deploymentFingerprint(env);
  const pausedUntil = row?.configFingerprint === fingerprint ? row.pausedUntil : 0;
  return { paused: pausedUntil > Date.now(), pausedUntil, revision: row?.revision ?? 0, fingerprint };
}

export async function pauseWorkersAiToday(env: Bindings, observed: WorkersAiQuota): Promise<void> {
  const now = Date.now();
  const pausedUntil = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  await createDb(env.DB).update(aiRuntimeState).set({ pausedUntil, configFingerprint: observed.fingerprint })
    .where(and(eq(aiRuntimeState.provider, 'workers'), eq(aiRuntimeState.revision, observed.revision)));
}

export async function resetWorkersAiQuota(env: Bindings): Promise<void> {
  await createDb(env.DB).update(aiRuntimeState).set({ pausedUntil: 0, configFingerprint: '', revision: sql`${aiRuntimeState.revision}+1` })
    .where(eq(aiRuntimeState.provider, 'workers'));
}
