// LLM 审核三驱动的单测：mock fetch 覆盖 allow / reject / fail-open。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseVerdict, moderateComment, isModerationConfigured } from '../../src/services/ai-gateway.ts';
import type { Bindings } from '../../src/env.ts';

const AI = { run: async () => ({ response: 'safe' }) };

/** getSettingBool 走 settings 表；默认值在 SETTING_DEFAULTS（comments_ai_moderation='true'），
 *  测试只需让 DB 查询返回空行集即可命中默认回退 */
const emptyDb = {
  prepare: () => ({
    bind: () => ({
      raw: async () => [],
      all: async () => ({ results: [] }),
      first: async () => null,
    }),
  }),
} as unknown as Bindings['DB'];

function env(overrides: Record<string, unknown> = {}): Bindings {
  return {
    AI,
    DB: emptyDb,
    ...overrides,
  } as unknown as Bindings;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseVerdict', () => {
  it('JSON 形态', () => {
    expect(parseVerdict('{"safe": true}')).toEqual({ safe: true });
    expect(parseVerdict('{"safe": false, "category": "spam"}')).toEqual({ safe: false, category: 'spam' });
    expect(parseVerdict('```json\n{"safe": true}\n```')).toEqual({ safe: true });
  });
  it('llama-guard 文本形态', () => {
    expect(parseVerdict('SAFE')).toEqual({ safe: true });
    expect(parseVerdict('UNSAFE\nS1')).toEqual({ safe: false, category: 'S1' });
  });
  it('无法解析返回 null', () => {
    expect(parseVerdict('hello world')).toBeNull();
  });
});

describe('isModerationConfigured', () => {
  it('无任何渠道时 false', async () => {
    expect(await isModerationConfigured(env({ AI: undefined }))).toBe(false);
  });
  it('openai 驱动看 API key', async () => {
    expect(await isModerationConfigured(env({ AI: undefined, AI_MODERATION_DRIVER: 'openai', OPENAI_API_KEY: 'sk' }))).toBe(true);
    expect(await isModerationConfigured(env({ AI: undefined, AI_MODERATION_DRIVER: 'openai' }))).toBe(false);
  });
});

describe('moderateComment', () => {
  it('开关关闭直接放行', async () => {
    const result = await moderateComment(env({ comments_ai_moderation: 'false' }), 'hello');
    expect(result.action).toBe('allow');
  });

  it('openai 驱动：模型判 UNSAFE → reject', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"safe": false, "category": "harassment"}' } }],
    }), { status: 200 })));
    const result = await moderateComment(env({
      AI: undefined, AI_MODERATION_DRIVER: 'openai', OPENAI_API_KEY: 'sk-test',
    }), 'you are bad');
    expect(result).toEqual({ action: 'reject', reason: 'harassment' });
  });

  it('openai 驱动：HTTP 500 → fail-open allow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));
    const result = await moderateComment(env({
      AI: undefined, AI_MODERATION_DRIVER: 'openai', OPENAI_API_KEY: 'sk-test',
    }), 'hello');
    expect(result.action).toBe('allow');
  });

  it('openai 驱动：返回垃圾文本（解析失败）→ fail-open allow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'I cannot answer that' } }],
    }), { status: 200 })));
    const result = await moderateComment(env({
      AI: undefined, AI_MODERATION_DRIVER: 'openai', OPENAI_API_KEY: 'sk-test',
    }), 'hello');
    expect(result.action).toBe('allow');
  });

  it('anthropic 驱动：模型判 safe → allow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ text: '{"safe": true}' }],
    }), { status: 200 })));
    const result = await moderateComment(env({
      AI: undefined, AI_MODERATION_DRIVER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test',
    }), 'nice skin!');
    expect(result.action).toBe('allow');
  });

  it('anthropic 驱动：模型判 unsafe 带 category → reject', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ text: '{"safe": false, "category": "advertising"}' }],
    }), { status: 200 })));
    const result = await moderateComment(env({
      AI: undefined, AI_MODERATION_DRIVER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test',
    }), 'buy cheap coins at example.com');
    expect(result).toEqual({ action: 'reject', reason: 'advertising' });
  });

  it('openai 请求超时 → fail-open allow', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))); // 永不返回
    vi.useFakeTimers();
    try {
      const pending = moderateComment(env({
        AI: undefined, AI_MODERATION_DRIVER: 'openai', OPENAI_API_KEY: 'sk-test',
      }), 'hello');
      await vi.advanceTimersByTimeAsync(25_000);
      const result = await pending;
      expect(result.action).toBe('allow');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 注入防护与网关管道 ────────────────────────────────────────────────────────

import { AI_JOB_DEFINITIONS, buildSystemPrompt, wrapUserContent, runAiJob, parseJsonOutput } from '../../src/services/ai-gateway.ts';

describe('prompt injection guard', () => {
  it('wrapUserContent 用界定符包裹并截断超长内容', () => {
    expect(wrapUserContent('hello', 100)).toBe('<user_content>\nhello\n</user_content>');
    const long = 'x'.repeat(300);
    const wrapped = wrapUserContent(long, 100);
    expect(wrapped).toContain('…(truncated)');
    expect(wrapped.length).toBeLessThan(300);
  });

  it('默认提示词始终附加 GUARD 声明', async () => {
    const prompt = await buildSystemPrompt(AI_JOB_DEFINITIONS.comments_moderation, { DB: emptyDb } as Pick<Bindings, 'DB'>);
    expect(prompt).toContain('Security rules (highest priority)');
    expect(prompt).toContain(AI_JOB_DEFINITIONS.comments_moderation.defaultPrompt);
  });

  it('管理员覆盖提示词后 GUARD 声明仍然附加', async () => {
    const { SqliteD1 } = await import('../../src/node/d1/sqlite.ts');
    const { runMigrationsForNode } = await import('../../src/node/migrate.ts');
    const { invalidateSettingsCache } = await import('../../src/lib.ts');
    const db = new SqliteD1({ path: ':memory:' });
    await runMigrationsForNode(db);
    await db.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('ai_comments_moderation_prompt', '', 'Custom admin prompt.', 0)").run();
    invalidateSettingsCache();
    try {
      const prompt = await buildSystemPrompt(AI_JOB_DEFINITIONS.comments_moderation, { DB: db } as unknown as Pick<Bindings, 'DB'>);
      expect(prompt).toContain('Custom admin prompt.');
      expect(prompt).toContain('Security rules (highest priority)');
    } finally {
      invalidateSettingsCache();
      db.close();
    }
  });
});

describe('runAiJob pipeline', () => {
  it('workers 驱动：native 模型收裸单消息（llama-guard 原生格式），文本输出经 parseVerdict 可解析', async () => {
    const seen: Array<unknown> = [];
    const testAi = { run: async (_model: string, input: unknown) => { seen.push(input); return { response: 'UNSAFE\nS1' }; } };
    const result = await runAiJob(env({ AI: testAi }), AI_JOB_DEFINITIONS.comments_moderation, 'buy coins');
    expect(result).toBe('UNSAFE\nS1');
    expect(seen[0]).toMatchObject({ messages: [{ role: 'user', content: 'buy coins' }] });
    // 单消息：无 system 提示词，无 <user_content> 包裹
    expect((seen[0] as { messages: unknown[] }).messages.length).toBe(1);
  });

  it('chat 驱动（openai）：system 提示词 + <user_content> 包裹 + JSON-only', async () => {
    let captured: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"safe": true}' } }] }), { status: 200 });
    }));
    const result = await runAiJob(env({ AI: undefined, AI_MODERATION_DRIVER: 'openai', OPENAI_API_KEY: 'sk' }), AI_JOB_DEFINITIONS.comments_moderation, 'hello');
    expect(result).not.toBeNull();
    const body = JSON.parse(captured!) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toContain('Security rules (highest priority)');
    expect(body.messages.at(-1)!.content).toContain('<user_content>');
  });

  it('无驱动配置返回 null（fail-open）', async () => {
    expect(await runAiJob(env({ AI: undefined }), AI_JOB_DEFINITIONS.comments_moderation, 'x')).toBeNull();
  });
});

describe('parseJsonOutput', () => {
  it('剥 fence 解析 JSON，垃圾输入返回 null', () => {
    expect(parseJsonOutput<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonOutput<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonOutput('not json')).toBeNull();
    expect(parseJsonOutput('"just a string"')).toBeNull();
  });
});
