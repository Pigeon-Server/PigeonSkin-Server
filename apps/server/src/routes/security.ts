import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { currentUser, readJson, fail } from '../framework.ts';
import { emailSchema } from '@pigeon-skin/shared/schemas';
import type { AppEnv } from '../lib.ts';
import * as security from '../services/security.ts';
import * as repo from '../repositories/security.ts';

const responseSchema = z.object({ id: z.string().min(1).max(2048), rawId: z.string().max(2048), type: z.literal('public-key'), response: z.record(z.unknown()), clientExtensionResults: z.record(z.unknown()) }).passthrough();
const proofSchema = z.object({ method: z.enum(['email', 'totp', 'passkey', 'recovery']), code: z.string().max(128).default(''), response: responseSchema.optional() });
const codeSchema = z.object({ code: z.string().min(1).max(128) });
export const securityAuthRoutes = new Hono<AppEnv>();
securityAuthRoutes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
securityAuthRoutes.get('/2fa', async c => c.json(await security.challengeInfo(c)));
securityAuthRoutes.post('/2fa/email', async c => { await security.sendChallengeEmail(c); return c.json({ ok: true }); });
securityAuthRoutes.post('/2fa/passkey/options', async c => c.json(await security.authenticationOptions(c)));
securityAuthRoutes.post('/2fa/verify', async c => {
  const body = await readJson(c, proofSchema);
  return c.json(await security.verifyChallenge(c, body.method, body.code ?? '', body.response as unknown as AuthenticationResponseJSON | undefined));
});
securityAuthRoutes.post('/passkeys/options', async c => {
  const body = await readJson(c, z.object({ remember: z.boolean().default(false), destination: z.string().max(2000).default('/user') }));
  return c.json(await security.beginPasskeyLogin(c, body.remember ?? false, body.destination ?? '/user'));
});
securityAuthRoutes.post('/passkeys/verify', async c => {
  const body = await readJson(c, responseSchema);
  return c.json(await security.verifyPasskeyLogin(c, body as unknown as AuthenticationResponseJSON));
});
export const securityMeRoutes = new Hono<AppEnv>();
securityMeRoutes.use('*', async (c, next) => {
  currentUser(c);
  if (!c.get('sessionId')) throw fail.unauthorized();
  c.header('Cache-Control', 'no-store'); await next();
});
securityMeRoutes.get('/', async c => c.json(await security.status(c)));
securityMeRoutes.post('/reauth', async c => {
  const body = await readJson(c, z.object({ password: z.string().max(256).default('') }));
  const row = await security.passwordReauth(c, body.password ?? '');
  return c.json({ requiresTwoFactor: row !== null });
});
securityMeRoutes.post('/:method/email', async c => {
  if (!['email', 'change-email'].includes(c.req.param('method'))) throw fail.notFound();
  await security.sendChallengeEmail(c); return c.json({ ok: true });
});
securityMeRoutes.post('/email/begin', async c => c.json(await security.beginEnrollment(c, 'email')));
securityMeRoutes.post('/totp/begin', async c => c.json(await security.beginEnrollment(c, 'totp')));
securityMeRoutes.post('/:method/confirm', async c => {
  const method = c.req.param('method'), body = await readJson(c, codeSchema);
  if (method === 'change-email') return c.json(await security.confirmEmailChange(c, body.code));
  if (method !== 'email' && method !== 'totp') throw fail.notFound();
  return c.json(await security.confirmEnrollment(c, method, body.code));
});
securityMeRoutes.post('/passkeys/options', async c => c.json(await security.registrationOptions(c)));
securityMeRoutes.post('/passkeys/verify', async c => {
  const body = await readJson(c, z.object({ name: z.string().trim().min(1).max(100), response: responseSchema }));
  return c.json(await security.confirmPasskey(c, body.response as unknown as RegistrationResponseJSON, body.name));
});
securityMeRoutes.delete('/methods/:method', async c => {
  const method = c.req.param('method');
  if (method !== 'email' && method !== 'totp' && method !== 'passkey') throw fail.notFound();
  return c.json(await security.removeMethod(c, method, c.req.query('id')));
});
securityMeRoutes.post('/disable', async c => c.json(await security.disable(c)));
securityMeRoutes.post('/recovery', async c => {
  if (!(await repo.methods(c.env, currentUser(c).id)).length) throw fail.forbidden();
  return c.json(await security.mutateSecurity(c, () => [], true));
});
securityMeRoutes.post('/change-email/begin', async c => {
  const body = await readJson(c, z.object({ email: emailSchema }));
  await security.beginEmailChange(c, body.email); return c.json({ ok: true });
});
