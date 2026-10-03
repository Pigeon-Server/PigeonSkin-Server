import { getSetting } from '../lib.ts';
import type { Bindings } from '../env.ts';

export type EmailPolicyEnv = Pick<Bindings, 'DB'>;

export async function readEmailDomainList(env: EmailPolicyEnv, key: 'restricted_email_allow' | 'restricted_email_deny'): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await getSetting(env, key));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

export async function checkEmailDomain(env: EmailPolicyEnv, email: string): Promise<'email.domain_denied' | 'email.domain_not_allowed' | null> {
  if (!email.includes('@')) return null;
  const domain = email.split('@').pop()!.toLowerCase();
  const [allow, deny] = await Promise.all([readEmailDomainList(env, 'restricted_email_allow'), readEmailDomainList(env, 'restricted_email_deny')]);
  if (allow.length && !allow.some(value => value.toLowerCase() === domain)) return 'email.domain_not_allowed';
  if (deny.some(value => value.toLowerCase() === domain)) return 'email.domain_denied';
  return null;
}
