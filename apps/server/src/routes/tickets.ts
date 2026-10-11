import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { currentUser, fail } from '../framework.ts';
import type { AppEnv } from '../lib.ts';
import * as tickets from '../services/tickets.ts';
import { isEmailConfigured, sendEmail } from '../services/email.ts';

export const ticketRoutes = new Hono<AppEnv>();
export const multipartLimit = bodyLimit({ maxSize: 26 * 1024 * 1024, onError: c => c.json({ error: 'common.invalid_request' }, 422) });

async function form(c: Parameters<typeof currentUser>[0]) {
  const data = await c.req.raw.formData();
  const files: tickets.TicketFile[] = [];
  for (const value of data.getAll('files')) {
    if (typeof value === 'string' || typeof (value as Blob).arrayBuffer !== 'function') continue;
    const file = value as File;
    files.push({ name: file.name || 'attachment', type: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return { title: String(data.get('title') || '').trim(), categoryId: Number(data.get('categoryId') || 0), description: String(data.get('description') || '').trim(), body: String(data.get('body') || '').trim(), internal: String(data.get('internal') || '') === 'true', files };
}

ticketRoutes.get('/categories', async c => c.json(await tickets.listCategories(c.env)));
ticketRoutes.get('/', async c => c.json(await tickets.listMine(c.env, currentUser(c).id)));
ticketRoutes.post('/', multipartLimit, async c => {
  const user = currentUser(c); const input = await form(c);
  if (input.title.length < 1 || input.title.length > 160 || input.description.length < 1 || input.description.length > 20_000) throw fail.invalid();
  const result = await tickets.create(c.env, user, input);
  if (isEmailConfigured(c.env)) {
    c.executionCtx.waitUntil(sendEmail(c.env, { kind: 'ticket-created', to: user.email, ticketId: result.id, ticketNumber: result.ticketNumber, title: input.title, summary: input.description.slice(0, 240), locale: user.locale }));
    for (const admin of await tickets.recipients(c.env, user.id)) c.executionCtx.waitUntil(sendEmail(c.env, { kind: 'ticket-created', to: admin.email, ticketId: result.id, ticketNumber: result.ticketNumber, title: input.title, summary: input.description.slice(0, 240), locale: admin.locale }));
  }
  return c.json(result, 201);
});
ticketRoutes.get('/:id', async c => c.json(await tickets.get(c.env, currentUser(c), Number(c.req.param('id')), false)));
ticketRoutes.post('/:id/messages', multipartLimit, async c => {
  const user = currentUser(c); const input = await form(c); const id = Number(c.req.param('id'));
  const result = await tickets.addMessage(c.env, user, id, input.body, false, input.files, false);
  const admins = await tickets.recipients(c.env, user.id);
  if (isEmailConfigured(c.env)) for (const admin of admins) c.executionCtx.waitUntil(sendEmail(c.env, { kind: 'ticket-reply', to: admin.email, ticketId: result.ticket.id, ticketNumber: result.ticket.ticketNumber, title: result.ticket.title, summary: input.body.slice(0, 240), status: result.ticket.status, locale: admin.locale }));
  return c.json({ ok: true, messageId: result.messageId });
});
ticketRoutes.get('/:id/attachments/:attachmentId', async c => tickets.attachment(c.env, currentUser(c), Number(c.req.param('id')), Number(c.req.param('attachmentId'))));
