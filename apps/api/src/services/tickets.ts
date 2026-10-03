import type { Bindings } from '../env.ts';
import type { AuthedUser } from '../lib.ts';
import { fail } from '../framework.ts';
import { isAdmin } from '../lib.ts';

export const TICKET_STATUSES = ['pending', 'in_progress', 'waiting_user', 'resolved', 'closed'] as const;
export type TicketStatus = typeof TICKET_STATUSES[number];

export interface TicketFile { name: string; type: string; bytes: Uint8Array; }
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 5;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv', 'application/zip']);
function signatureMatches(type: string, bytes: Uint8Array): boolean {
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (type === 'image/png') return bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/gif') return text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a';
  if (type === 'image/webp') return text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP';
  if (type === 'application/pdf') return text(0, 5) === '%PDF-';
  if (type === 'application/zip') return text(0, 2) === 'PK';
  return true;
}

export function validateFiles(files: TicketFile[]): void {
  if (files.length > MAX_FILES) throw fail.invalid('common.invalid_request', { files: 'too_many' });
  let total = 0;
  for (const file of files) {
    if (!file.bytes.byteLength || file.bytes.byteLength > MAX_FILE_BYTES || (total += file.bytes.byteLength) > MAX_FILE_BYTES) throw fail.invalid('common.invalid_request', { files: 'file_too_large' });
    if (!ALLOWED_TYPES.has(file.type.toLowerCase())) throw fail.invalid('common.invalid_request', { files: 'file_type_invalid' });
    if (file.name.length > 180 || /[\\/\x00-\x1f]/.test(file.name)) throw fail.invalid('common.invalid_request', { files: 'file_name_invalid' });
    if (!signatureMatches(file.type.toLowerCase(), file.bytes)) throw fail.invalid('common.invalid_request', { files: 'file_content_invalid' });
  }
}

function number(id: number): string { return `TKT-${new Date().getUTCFullYear()}-${String(id).padStart(6, '0')}`; }
function row<T>(value: T | null): T { if (!value) throw fail.notFound('common.not_found'); return value; }
function ticketSelect() {
  return `SELECT t.id,t.ticket_number as ticketNumber,t.user_id as userId,t.title,t.category,t.category_id as categoryId,COALESCE(NULLIF(t.category_name,''),tc.name,t.category) as categoryName,t.description,t.status,t.last_user_read_at as lastUserReadAt,t.last_admin_read_at as lastAdminReadAt,t.created_at as createdAt,t.updated_at as updatedAt,t.closed_at as closedAt,u.email as userEmail,u.nickname as userNickname,
    EXISTS(SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='admin' AND m.internal=0 AND m.created_at>COALESCE(t.last_user_read_at,0)) as userUnread,
    EXISTS(SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='user' AND m.created_at>COALESCE(t.last_admin_read_at,0)) as adminUnread
    FROM tickets t JOIN users u ON u.id=t.user_id LEFT JOIN ticket_categories tc ON tc.id=t.category_id`;
}

export async function listCategories(env: Pick<Bindings, 'DB'>, includeHidden = false) {
  const result = await env.DB.prepare(`SELECT id,slug,name,hidden,sort_order as sortOrder,created_at as createdAt,updated_at as updatedAt FROM ticket_categories ${includeHidden ? '' : 'WHERE hidden=0'} ORDER BY sort_order ASC,id ASC`).all();
  return { items: result.results };
}

export async function createCategory(env: Pick<Bindings, 'DB'>, name: string) {
  const clean = name.trim(); if (!clean || clean.length > 80) throw fail.invalid();
  const now = Date.now(); const slug = `category-${crypto.randomUUID().slice(0, 12)}`;
  const result = await env.DB.prepare('INSERT INTO ticket_categories(slug,name,sort_order,created_at,updated_at) VALUES(?,?,?,?,?) RETURNING id').bind(slug, clean, 0, now, now).first<{ id: number }>();
  return { id: row(result).id, slug, name: clean, hidden: false, sortOrder: 0, createdAt: now, updatedAt: now };
}

export async function updateCategory(env: Pick<Bindings, 'DB'>, id: number, input: { name?: string | undefined; hidden?: boolean | undefined; sortOrder?: number | undefined }) {
  const current = await env.DB.prepare('SELECT id,slug,name,hidden,sort_order as sortOrder FROM ticket_categories WHERE id=?').bind(id).first<{ id: number; slug: string; name: string; hidden: number; sortOrder: number }>();
  if (!current) throw fail.notFound('common.not_found');
  const name = input.name?.trim(); if (name !== undefined && (!name || name.length > 80)) throw fail.invalid();
  const sortOrder = input.sortOrder === undefined ? current.sortOrder : Math.max(0, Math.min(100000, Math.trunc(input.sortOrder)));
  await env.DB.prepare('UPDATE ticket_categories SET name=?,hidden=?,sort_order=?,updated_at=? WHERE id=?').bind(name ?? current.name, input.hidden === undefined ? current.hidden : (input.hidden ? 1 : 0), sortOrder, Date.now(), id).run();
  return { id, slug: current.slug, name: name ?? current.name, hidden: input.hidden === undefined ? Boolean(current.hidden) : input.hidden, sortOrder };
}

export async function hideCategory(env: Pick<Bindings, 'DB'>, id: number) {
  return updateCategory(env, id, { hidden: true });
}

export async function listMine(env: Pick<Bindings, 'DB'>, userId: number) {
  const result = await env.DB.prepare(`${ticketSelect()} WHERE t.user_id=? ORDER BY t.updated_at DESC LIMIT 100`).bind(userId).all();
  const unread = await env.DB.prepare("SELECT COUNT(*) as count FROM tickets t WHERE t.user_id=? AND EXISTS(SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='admin' AND m.internal=0 AND m.created_at>COALESCE(t.last_user_read_at,0))").bind(userId).first<{ count: number }>();
  return { items: result.results, unread: Number(unread?.count || 0) };
}

export async function listAdmin(env: Pick<Bindings, 'DB'>, filter: { status?: string; categoryId?: number; user?: string; page: number; perPage: number }) {
  const conditions = ['1=1']; const values: unknown[] = [];
  if (filter.status && TICKET_STATUSES.includes(filter.status as TicketStatus)) { conditions.push('t.status=?'); values.push(filter.status); }
  if (filter.categoryId !== undefined && Number.isSafeInteger(filter.categoryId) && filter.categoryId > 0) { conditions.push('t.category_id=?'); values.push(filter.categoryId); }
  if (filter.user) { conditions.push('(u.email LIKE ? OR u.nickname LIKE ? OR CAST(t.user_id AS TEXT)=?)'); values.push(`%${filter.user}%`, `%${filter.user}%`, filter.user); }
  const where = conditions.join(' AND ');
  const total = await env.DB.prepare(`SELECT COUNT(*) as count FROM tickets t JOIN users u ON u.id=t.user_id WHERE ${where}`).bind(...values).first<{ count: number }>();
  const result = await env.DB.prepare(`${ticketSelect()} WHERE ${where} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`).bind(...values, filter.perPage, (filter.page - 1) * filter.perPage).all();
  const unread = await env.DB.prepare(`SELECT COUNT(*) as count FROM tickets t JOIN users u ON u.id=t.user_id WHERE ${where} AND EXISTS(SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='user' AND m.created_at>COALESCE(t.last_admin_read_at,0))`).bind(...values).first<{ count: number }>();
  return { items: result.results, total: Number(total?.count || 0), unread: Number(unread?.count || 0) };
}

export async function get(env: Pick<Bindings, 'DB'>, actor: AuthedUser, id: number) {
  const ticket = await env.DB.prepare(`${ticketSelect()} WHERE t.id=?`).bind(id).first<Record<string, unknown>>();
  if (!ticket || (!isAdmin(actor) && Number(ticket.userId) !== actor.id)) throw fail.notFound('common.not_found');
  await env.DB.prepare(`UPDATE tickets SET ${isAdmin(actor) ? 'last_admin_read_at' : 'last_user_read_at'}=? WHERE id=?`).bind(Date.now(), id).run();
  const messages = await env.DB.prepare(`SELECT m.id,m.author_id as authorId,m.author_type as authorType,m.body,m.internal,m.created_at as createdAt,u.nickname as authorName FROM ticket_messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.ticket_id=? ${isAdmin(actor) ? '' : 'AND m.internal=0'} ORDER BY m.created_at ASC,m.id ASC`).bind(id).all();
  const attachments = await env.DB.prepare(`SELECT a.id,a.message_id as messageId,a.file_name as fileName,a.mime_type as mimeType,a.size_bytes as sizeBytes FROM ticket_attachments a LEFT JOIN ticket_messages m ON m.id=a.message_id WHERE a.ticket_id=? ${isAdmin(actor) ? '' : 'AND COALESCE(m.internal,0)=0'} ORDER BY a.created_at,a.id`).bind(id).all();
  const events = await env.DB.prepare('SELECT id,actor_id as actorId,type,from_status as fromStatus,to_status as toStatus,detail,created_at as createdAt FROM ticket_events WHERE ticket_id=? ORDER BY created_at ASC,id ASC').bind(id).all();
  return { ticket: { ...ticket, userUnread: false, adminUnread: false }, messages: messages.results, attachments: attachments.results, events: events.results };
}

async function saveFiles(env: Pick<Bindings, 'BUCKET' | 'DB'>, ticketId: number, messageId: number | null, files: TicketFile[]) {
  validateFiles(files);
  for (const file of files) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', file.bytes));
    const token = [...digest].map(v => v.toString(16).padStart(2, '0')).join('');
    const key = `tickets/${ticketId}/${token}-${file.name}`;
    await env.BUCKET.put(key, file.bytes, { httpMetadata: { contentType: file.type } });
    await env.DB.prepare('INSERT INTO ticket_attachments(ticket_id,message_id,object_key,file_name,mime_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)').bind(ticketId, messageId, key, file.name, file.type, file.bytes.byteLength, Date.now()).run();
  }
}

export async function create(env: Pick<Bindings, 'DB' | 'BUCKET'>, user: AuthedUser, input: { title: string; categoryId: number; description: string; files: TicketFile[] }) {
  const category = await env.DB.prepare('SELECT id,slug,name FROM ticket_categories WHERE id=? AND hidden=0').bind(input.categoryId).first<{ id: number; slug: string; name: string }>();
  if (!category) throw fail.invalid();
  validateFiles(input.files);
  const now = Date.now();
  const inserted = await env.DB.prepare('INSERT INTO tickets(ticket_number,user_id,title,category,category_id,category_name,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id').bind(`TEMP-${crypto.randomUUID()}`, user.id, input.title, category.slug, category.id, category.name, input.description, 'pending', now, now).first<{ id: number }>();
  const id = row(inserted).id;
  const ticketNumber = number(id);
  await env.DB.prepare('UPDATE tickets SET ticket_number=? WHERE id=?').bind(ticketNumber, id).run();
  const message = await env.DB.prepare('INSERT INTO ticket_messages(ticket_id,author_id,author_type,body,created_at) VALUES(?,?,?,?,?) RETURNING id').bind(id, user.id, 'user', input.description, now).first<{ id: number }>();
  await env.DB.prepare('INSERT INTO ticket_events(ticket_id,actor_id,type,to_status,detail,created_at) VALUES(?,?,?,?,?,?)').bind(id, user.id, 'created', 'pending', category.name, now).run();
  await saveFiles(env, id, message?.id ?? null, input.files);
  return { id, ticketNumber };
}

export async function addMessage(env: Pick<Bindings, 'DB' | 'BUCKET'>, actor: AuthedUser, id: number, body: string, internal: boolean, files: TicketFile[]) {
  const ticket = await env.DB.prepare('SELECT id,user_id as userId,status,title,ticket_number as ticketNumber FROM tickets WHERE id=?').bind(id).first<{ id: number; userId: number; status: TicketStatus; title: string; ticketNumber: string }>();
  if (!ticket || (!isAdmin(actor) && ticket.userId !== actor.id)) throw fail.notFound('common.not_found');
  if (!body.trim() && !files.length) throw fail.invalid();
  if (!isAdmin(actor) && internal) throw fail.forbidden();
  const now = Date.now();
  const message = await env.DB.prepare('INSERT INTO ticket_messages(ticket_id,author_id,author_type,body,internal,created_at) VALUES(?,?,?,?,?,?) RETURNING id').bind(id, actor.id, isAdmin(actor) ? 'admin' : 'user', body.trim(), internal ? 1 : 0, now).first<{ id: number }>();
  await env.DB.prepare('UPDATE tickets SET updated_at=?,status=CASE WHEN ?=1 THEN status WHEN ?=\'user\' THEN \'pending\' ELSE \'in_progress\' END WHERE id=?').bind(now, internal ? 1 : 0, isAdmin(actor) ? 'admin' : 'user', id).run();
  await env.DB.prepare('INSERT INTO ticket_events(ticket_id,actor_id,type,detail,created_at) VALUES(?,?,?,?,?)').bind(id, actor.id, internal ? 'internal_note' : 'message', body.slice(0, 200), now).run();
  const nextStatus = internal ? ticket.status : (isAdmin(actor) ? 'in_progress' : 'pending');
  if (nextStatus !== ticket.status) await env.DB.prepare('INSERT INTO ticket_events(ticket_id,actor_id,type,from_status,to_status,created_at) VALUES(?,?,?,?,?,?)').bind(id, actor.id, 'status_changed', ticket.status, nextStatus, now).run();
  await saveFiles(env, id, message?.id ?? null, files);
  return { ticket, messageId: message?.id ?? null };
}

export async function setStatus(env: Pick<Bindings, 'DB'>, actor: AuthedUser, id: number, status: string) {
  if (!TICKET_STATUSES.includes(status as TicketStatus)) throw fail.invalid();
  const ticket = await env.DB.prepare('SELECT id,status,title,ticket_number as ticketNumber,user_id as userId FROM tickets WHERE id=?').bind(id).first<{ id: number; status: TicketStatus; title: string; ticketNumber: string; userId: number }>();
  if (!ticket) throw fail.notFound('common.not_found');
  if (ticket.status === status) return { ticket, changed: false };
  const now = Date.now();
  await env.DB.prepare('UPDATE tickets SET status=?,updated_at=?,closed_at=? WHERE id=?').bind(status, now, status === 'closed' ? now : null, id).run();
  await env.DB.prepare('INSERT INTO ticket_events(ticket_id,actor_id,type,from_status,to_status,created_at) VALUES(?,?,?,?,?,?)').bind(id, actor.id, 'status_changed', ticket.status, status, now).run();
  return { ticket: { ...ticket, status }, changed: true };
}

export async function attachment(env: Pick<Bindings, 'DB' | 'BUCKET'>, actor: AuthedUser, ticketId: number, attachmentId: number) {
  const ticket = await env.DB.prepare('SELECT user_id as userId FROM tickets WHERE id=?').bind(ticketId).first<{ userId: number }>();
  if (!ticket || (!isAdmin(actor) && ticket.userId !== actor.id)) throw fail.notFound('common.not_found');
  const item = await env.DB.prepare(`SELECT a.object_key as objectKey,a.file_name as fileName,a.mime_type as mimeType FROM ticket_attachments a LEFT JOIN ticket_messages m ON m.id=a.message_id WHERE a.id=? AND a.ticket_id=? ${isAdmin(actor) ? '' : 'AND COALESCE(m.internal,0)=0'}`).bind(attachmentId, ticketId).first<{ objectKey: string; fileName: string; mimeType: string }>();
  if (!item) throw fail.notFound('common.not_found');
  const object = await env.BUCKET.get(item.objectKey); if (!object) throw fail.notFound('common.not_found');
  const headers = new Headers({ 'Content-Type': item.mimeType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  return new Response(object.body, { headers });
}

export async function recipients(env: Pick<Bindings, 'DB'>, excludeId?: number) {
  const rows = await env.DB.prepare("SELECT email,locale FROM users WHERE role IN ('admin','super_admin') AND email IS NOT NULL AND id != ?").bind(excludeId ?? 0).all<{ email: string; locale: string | null }>();
  return rows.results;
}

export async function owner(env: Pick<Bindings, 'DB'>, id: number) {
  return env.DB.prepare('SELECT t.id,u.email,u.locale,t.title,t.ticket_number as ticketNumber,t.status FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?').bind(id).first<{ id: number; email: string; locale: string | null; title: string; ticketNumber: string; status: TicketStatus }>();
}
