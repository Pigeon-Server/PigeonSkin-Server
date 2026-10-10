import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';
import { runMigrations, makeAdmin } from './setup.ts';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';
beforeAll(runMigrations);
async function user(name: string, admin = false) {
  const register = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${name}@example.com`,
      password: 'comments-ui-9',
      playerName: name,
    }),
  });
  expect(register.status).toBe(201);
  const { id } = await register.json<{ id: number }>();
  if (admin) await makeAdmin(id);
  const login = await SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: `${name}@example.com`, password: 'comments-ui-9' }),
  });
  return { id, cookie: login.headers.get('set-cookie')!.split(';')[0]! };
}
function request(path: string, cookie = '', method = 'GET', body?: unknown) {
  return SELF.fetch(`https://x/api/v1${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function upload(cookie: string, visibility: 'public' | 'private' = 'public') {
  const form = new FormData();
  form.set('file', new Blob([makePng({ width: 64, height: 64 })]), 'skin.png');
  form.set('name', 'Comment texture');
  const response = await SELF.fetch('https://x/api/v1/textures', {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  expect(response.status).toBe(201);
  const id = (await response.json<{ id: number }>()).id;
  if (visibility === 'private') {
    const patch = await SELF.fetch(`https://x/api/v1/textures/${id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(patch.status).toBe(200);
  }
  return id;
}
describe('private textures have no comment section', () => {
  it('hides comments on private textures even from the owner and admins', async () => {
    const owner = await user('private_owner');
    const admin = await user('private_admin', true);
    const texture = await upload(owner.cookie, 'private');

    expect((await request(`/textures/${texture}/comments`, owner.cookie)).status).toBe(404);
    expect((await request(`/textures/${texture}/comments`, admin.cookie)).status).toBe(404);
    expect(
      (await request(`/textures/${texture}/comments`, owner.cookie, 'POST', { content: 'self comment' })).status,
    ).toBe(404);
  });
});
describe('user comment workflow', () => {
  it('publishes a comment, exposes it to visitors and keeps deletion restricted to its author', async () => {
    const author = await user('comment_author');
    const other = await user('comment_other');
    const texture = await upload(author.cookie);
    expect(
      (await request(`/textures/${texture}/comments`, '', 'POST', { content: 'Visitor comment' }))
        .status,
    ).toBe(401);
    const published = await request(`/textures/${texture}/comments`, author.cookie, 'POST', {
      content: 'A real comment\nwith another line',
    });
    expect(published.status).toBe(201);
    const comment = await published.json<{ id: number }>();
    const visible = await (
      await request(`/textures/${texture}/comments`)
    ).json<{
      items: { id: number; userId: number; userName: string; content: string; createdAt: number }[];
      total: number;
    }>();
    expect(visible.total).toBe(1);
    expect(visible.items[0]).toMatchObject({
      id: comment.id,
      userId: author.id,
      content: 'A real comment\nwith another line',
    });
    expect(visible.items[0]!.userName).toBeTruthy();
    expect(visible.items[0]!.createdAt).toBeGreaterThan(0);
    expect((await request(`/comments/${comment.id}`, other.cookie, 'DELETE')).status).toBe(404);
    expect((await request(`/comments/${comment.id}`, author.cookie, 'DELETE')).status).toBe(204);
    expect(
      (await (await request(`/textures/${texture}/comments`)).json<{ total: number }>()).total,
    ).toBe(0);
  });
  it('keeps rejected comments visible only to their author', async () => {
    const author = await user('moderated_user');
    const texture = await upload(author.cookie);
    const ctx = createExecutionContext();
    const response = await createApp().fetch(
      new Request(`https://x/api/v1/textures/${texture}/comments`, {
        method: 'POST',
        headers: { cookie: author.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Rejected comment' }),
      }),
      {
        ...env,
        AI: {
          run: async (model: string, input: { messages: Array<{ role: string; content: string }> }) => {
            expect(model).toBe('@cf/meta/llama-guard-3-8b');
            // llama-guard 走网关的原生格式：单条 user 消息、裸内容（无 system、无界定符）
            expect(input.messages.length).toBe(1);
            expect(input.messages[0]!.role).toBe('user');
            expect(input.messages[0]!.content).toContain('Rejected comment');
            return { response: 'unsafe\nS1' };
          },
        },
      } as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect((await response.json<{ status: string }>()).status).toBe('pending');
    expect(
      (await (await request(`/textures/${texture}/comments`)).json<{ total: number }>()).total,
    ).toBe(0);
    const own = await (await request(`/textures/${texture}/comments`, author.cookie)).json<{ items: { content: string; status: string }[] }>();
    expect(own.items).toEqual([expect.objectContaining({ content: 'Rejected comment', status: 'rejected' })]);
  });
  it('shows pending review to the author and hides it from visitors and other accounts', async () => {
    const author = await user('review_author');
    const other = await user('review_other');
    const texture = await upload(author.cookie);
    const ctx = createExecutionContext();
    let release!: (value: { response: string }) => void;
    const verdict = new Promise<{ response: string }>(resolve => { release = resolve; });
    const response = await createApp().fetch(new Request(`https://x/api/v1/textures/${texture}/comments`, {
      method: 'POST', headers: { cookie: author.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Awaiting review' }),
    }), { ...env, AI: { run: async () => verdict } } as unknown as Bindings, ctx);
    expect(response.status).toBe(201);
    const ownResponse = await request(`/textures/${texture}/comments`, author.cookie);
    expect(ownResponse.headers.get('cache-control')).toContain('no-store');
    expect((await ownResponse.json<{ items: { status: string }[] }>()).items[0]?.status).toBe('pending');
    for (const cookie of ['', other.cookie]) expect((await (await request(`/textures/${texture}/comments`, cookie)).json<{ total: number }>()).total).toBe(0);
    release({ response: 'safe' });
    await waitOnExecutionContext(ctx);
    const published = await (await request(`/textures/${texture}/comments`)).json<{ items: { status: string }[] }>();
    expect(published.items[0]?.status).toBe('published');
  });
  it('does not restore a comment deleted while review is running', async () => {
    const author = await user('delete_review');
    const texture = await upload(author.cookie);
    const ctx = createExecutionContext();
    let release!: (value: { response: string }) => void;
    const verdict = new Promise<{ response: string }>(resolve => { release = resolve; });
    const response = await createApp().fetch(new Request(`https://x/api/v1/textures/${texture}/comments`, {
      method: 'POST', headers: { cookie: author.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Delete pending review' }),
    }), { ...env, AI: { run: async () => verdict } } as unknown as Bindings, ctx);
    const created = await response.json<{ id: number }>();
    expect((await request(`/comments/${created.id}`, author.cookie, 'DELETE')).status).toBe(204);
    release({ response: 'safe' });
    await waitOnExecutionContext(ctx);
    const row = await env.DB.prepare('SELECT status FROM comments WHERE id = ?').bind(created.id).first<{ status: string }>();
    expect(row?.status).toBe('deleted');
    expect((await (await request(`/textures/${texture}/comments`, author.cookie)).json<{ total: number }>()).total).toBe(0);
  });
  it('serves language-specific generator introductions and the site loading priority', async () => {
    const admin = await user('generator_admin', true);
    expect(
      (
        await request('/admin/settings', admin.cookie, 'PATCH', {
          settings: [
            { key: 'csl_first', value: 'mojang' },
            { key: 'config_generator_intro', value: '介绍', locale: 'zh_CN' },
            { key: 'config_generator_intro', value: 'Introduction', locale: 'en' },
          ],
        })
      ).status,
    ).toBe(200);
    const zh = await (
      await request('/settings/public?locale=zh_CN')
    ).json<Record<string, string>>();
    const en = await (await request('/settings/public?locale=en')).json<Record<string, string>>();
    expect(zh.config_generator_intro).toBe('介绍');
    expect(en.config_generator_intro).toBe('Introduction');
    expect(zh.csl_first).toBe('mojang');
    expect(en.csl_first).toBe('mojang');
    expect((await request('/config/extra-list')).status).toBe(401);
    const file = await request('/config/extra-list?locale=en', admin.cookie);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('attachment;');
    expect(file.headers.get('content-disposition')).toContain('.json');
    expect(await file.json()).toEqual({
      name: en.site_name,
      type: 'CustomSkinAPI',
      root: new URL('/csl/', env.APP_URL).href,
    });
  });
});
