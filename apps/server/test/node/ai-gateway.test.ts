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

// ── 判别模型驱动（TypeSafe System One / Cloudflare Clef）─────────────────────

import { answersToVerdict, CLEF_MODELS, fetchAvailableModels, testAiConnection } from '../../src/services/ai-gateway.ts';

describe('answersToVerdict', () => {
  const answers = (unsafe: number, category?: string) => ({
    unsafe: { type: 'noul', noul: unsafe },
    ...(category ? { category: { type: 'choice', choice: category, probabilities: { [category]: 1 } } } : {}),
  });

  it('noul 概率 ≥ 阈值判 unsafe，choice 归类原因', () => {
    expect(answersToVerdict(answers(0.9, 'spam'), 0.5)).toEqual({ safe: false, category: 'spam' });
  });
  it('概率恰在阈值上判定违规', () => {
    expect(answersToVerdict(answers(0.5, 'hate'), 0.5)).toEqual({ safe: false, category: 'hate' });
  });
  it('概率低于阈值判 safe', () => {
    expect(answersToVerdict(answers(0.2, 'spam'), 0.5)).toEqual({ safe: true });
  });
  it('无 choice 结果时给占位 category', () => {
    expect(answersToVerdict(answers(0.9), 0.5)).toEqual({ safe: false, category: 'flagged' });
  });
  it('缺 unsafe 答案返回 null（fail-open）', () => {
    expect(answersToVerdict(null, 0.5)).toBeNull();
    expect(answersToVerdict({}, 0.5)).toBeNull();
    expect(answersToVerdict({ unsafe: { type: 'noul' } }, 0.5)).toBeNull();
  });
});

describe('判别模型（systemone）驱动', () => {
  it('TypeSafe Jev：noul 高概率 → reject；请求体带固定 noul+choice 问题集', async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      captured = {
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          unsafe: { type: 'noul', noul: 0.93 },
          category: { type: 'choice', choice: 'harassment', probabilities: { harassment: 0.9 } },
        },
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200 });
    }));
    const result = await moderateComment(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'systemone',
      TYPESAFE_API_KEY: 'ts-key',
    }), 'you are terrible');
    expect(result).toEqual({ action: 'reject', reason: 'harassment' });
    expect(captured!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(captured!.headers.authorization).toBe('Bearer ts-key');
    expect(captured!.body.model).toBe('jev-latest');
    expect(captured!.body.state).toBe('you are terrible');
    const questions = captured!.body.questions as Record<string, { type: string }>;
    expect(questions.unsafe?.type).toBe('noul');
    expect(questions.category?.type).toBe('choice');
    expect(captured!.body.messages).toBeUndefined(); // 判别调用不含 chat messages
  });

  it('TypeSafe Jev：noul 低概率 → allow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { unsafe: { type: 'noul', noul: 0.05 } },
    }), { status: 200 })));
    const result = await moderateComment(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'systemone',
      TYPESAFE_API_KEY: 'ts-key',
    }), 'nice skin!');
    expect(result.action).toBe('allow');
  });

  it('HTTP 500 → fail-open allow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    const result = await moderateComment(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'systemone',
      TYPESAFE_API_KEY: 'ts-key',
    }), 'hello');
    expect(result.action).toBe('allow');
  });

  it('缺凭据 → fail-open allow（不发起请求）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await moderateComment(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'systemone',
    }), 'hello');
    expect(result.action).toBe('allow');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('仅 AI 绑定、无 TypeSafe Key：默认模型回落 Clef-flash 走绑定调用', async () => {
    const seen: Array<{ model: string; input: Record<string, unknown> }> = [];
    const testAi = { run: async (model: string, input: unknown) => {
      seen.push({ model, input: input as Record<string, unknown> });
      return { answers: { unsafe: { type: 'noul', noul: 0.9 } } };
    } };
    const result = await moderateComment(env({
      AI: testAi,
      AI_MODERATION_DRIVER: 'systemone',
    }), 'buy coins');
    expect(result).toEqual({ action: 'reject', reason: 'flagged' });
    expect(seen[0]!.model).toBe('@cf/cloudflare/clef-flash');
  });

  it('有 TypeSafe Key：默认模型 Jev 走 REST', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).model).toBe('jev-latest');
      return new Response(JSON.stringify({ answers: { unsafe: { type: 'noul', noul: 0.1 } } }), { status: 200 });
    }));
    const result = await moderateComment(env({
      AI: { run: async () => { throw new Error('should not use binding'); } },
      AI_MODERATION_DRIVER: 'systemone',
      TYPESAFE_API_KEY: 'ts-key',
    }), 'hello');
    expect(result.action).toBe('allow');
  });

  it('Clef 模型无绑定但有 REST 凭据：走 Cloudflare REST', async () => {
    let captured: { url: string; body: Record<string, unknown> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ answers: { unsafe: { type: 'noul', noul: 0.7 } } }), { status: 200 });
    }));
    const result = await moderateComment(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'systemone',
      CLOUDFLARE_ACCOUNT_ID: 'acct123',
      CLOUDFLARE_API_TOKEN: 'dev-cf-token',
    }), 'spam text');
    expect(result).toEqual({ action: 'reject', reason: 'flagged' });
    expect(captured!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/%40cf%2Fcloudflare%2Fclef-flash');
    expect(captured!.body.model).toBe('clef-flash');
    expect(captured!.body.state).toBe('spam text');
  });

  it('阈值按整数百分数生效：settings 写 80 → 判定阈值 0.8', async () => {
    const { SqliteD1 } = await import('../../src/node/d1/sqlite.ts');
    const { runMigrationsForNode } = await import('../../src/node/migrate.ts');
    const { invalidateSettingsCache } = await import('../../src/lib.ts');
    const db = new SqliteD1({ path: ':memory:' });
    await runMigrationsForNode(db);
    await db.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('ai_discriminative_threshold', '', '80', 0)").run();
    invalidateSettingsCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { unsafe: { type: 'noul', noul: 0.7 } },
    }), { status: 200 })));
    try {
      // 0.7 低于 0.8 阈值 → allow；若换算错误（阈值仍 0.5）会判 reject
      const result = await moderateComment(env({
        AI: undefined,
        AI_MODERATION_DRIVER: 'systemone',
        TYPESAFE_API_KEY: 'ts-key',
        DB: db,
      }), 'hello');
      expect(result.action).toBe('allow');
    } finally {
      invalidateSettingsCache();
      db.close();
    }
  });

  it('阈值缺省回落 0.5：settings 写越界值 5 → 用 0.5 判定', async () => {
    const { SqliteD1 } = await import('../../src/node/d1/sqlite.ts');
    const { runMigrationsForNode } = await import('../../src/node/migrate.ts');
    const { invalidateSettingsCache } = await import('../../src/lib.ts');
    const db = new SqliteD1({ path: ':memory:' });
    await runMigrationsForNode(db);
    await db.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('ai_discriminative_threshold', '', '5', 0)").run();
    invalidateSettingsCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { unsafe: { type: 'noul', noul: 0.6 } },
    }), { status: 200 })));
    try {
      // 0.6 ≥ 0.5（回落值）→ reject
      const result = await moderateComment(env({
        AI: undefined,
        AI_MODERATION_DRIVER: 'systemone',
        TYPESAFE_API_KEY: 'ts-key',
        DB: db,
      }), 'hello');
      expect(result).toEqual({ action: 'reject', reason: 'flagged' });
    } finally {
      invalidateSettingsCache();
      db.close();
    }
  });

  it('未配置模式时跟随 ai_driver（openai 驱动走 LLM 而非判别）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { unsafe: { type: 'noul', noul: 0.95 } },
    }), { status: 200 })));
    const result = await moderateComment(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'openai',
      OPENAI_API_KEY: 'sk-llm',
      TYPESAFE_API_KEY: 'ts-key',
      // moderateComment 读 settings 表；这里经 env 变量注入驱动，
      // 模式覆盖需经 settings，测试直接塞 readSettings 缓存不可行 ——
      // 改走 DB 空行集时 mode 为空，故该用例验证的是"显式模式走判别"由
      // 下一个 runAiJob 用例承担，这里只验证默认（跟随驱动 = openai）仍生效
      comments_ai_moderation: 'true',
    } as Record<string, unknown>), 'hello');
    // 默认跟随驱动走 openai（mock 的 openai 响应不是合法 chat 补全 → fail-open）
    expect(result.action).toBe('allow');
  });

  it('Clef 模型经 Workers AI 绑定调用，参数去 @cf/cloudflare/ 前缀', async () => {
    const seen: Array<{ model: string; input: Record<string, unknown> }> = [];
    const testAi = { run: async (model: string, input: unknown) => {
      seen.push({ model, input: input as Record<string, unknown> });
      return { answers: { unsafe: { type: 'noul', noul: 0.8 }, category: { type: 'choice', choice: 'spam' } } };
    } };
    const { SqliteD1 } = await import('../../src/node/d1/sqlite.ts');
    const { runMigrationsForNode } = await import('../../src/node/migrate.ts');
    const { invalidateSettingsCache } = await import('../../src/lib.ts');
    const db = new SqliteD1({ path: ':memory:' });
    await runMigrationsForNode(db);
    await db.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('ai_comments_moderation_model', '', '@cf/cloudflare/clef', 0)").run();
    invalidateSettingsCache();
    try {
      const result = await moderateComment(env({
        AI: testAi,
        DB: db,
        AI_MODERATION_DRIVER: 'systemone',
      }), 'buy coins');
      expect(result).toEqual({ action: 'reject', reason: 'spam' });
      expect(seen[0]!.model).toBe('@cf/cloudflare/clef');
      expect(seen[0]!.input.model).toBe('clef');
      expect(seen[0]!.input.state).toBe('buy coins');
    } finally {
      invalidateSettingsCache();
      db.close();
    }
  });

  it('判别模式下任务模型覆盖可指向 Clef（经绑定）', async () => {
    const seen: Array<string> = [];
    const testAi = { run: async (model: string) => {
      seen.push(model);
      return { answers: { unsafe: { type: 'noul', noul: 0.1 } } };
    } };
    const { SqliteD1 } = await import('../../src/node/d1/sqlite.ts');
    const { runMigrationsForNode } = await import('../../src/node/migrate.ts');
    const { invalidateSettingsCache } = await import('../../src/lib.ts');
    const db = new SqliteD1({ path: ':memory:' });
    await runMigrationsForNode(db);
    await db.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('ai_comments_moderation_model', '', '@cf/cloudflare/clef-flash', 0)").run();
    invalidateSettingsCache();
    try {
      const result = await moderateComment(env({
        AI: testAi,
        DB: db,
        AI_MODERATION_DRIVER: 'systemone',
      }), 'hello');
      expect(result.action).toBe('allow');
      expect(seen).toEqual(['@cf/cloudflare/clef-flash']);
    } finally {
      invalidateSettingsCache();
      db.close();
    }
  });

  it('runAiJob 显式判别模式走判别驱动（settings 覆盖 ai_comments_moderation_mode）', async () => {
    const { SqliteD1 } = await import('../../src/node/d1/sqlite.ts');
    const { runMigrationsForNode } = await import('../../src/node/migrate.ts');
    const { invalidateSettingsCache } = await import('../../src/lib.ts');
    const db = new SqliteD1({ path: ':memory:' });
    await runMigrationsForNode(db);
    await db.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('ai_comments_moderation_mode', '', 'discriminative', 0)").run();
    invalidateSettingsCache();
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state?: string };
      expect(body.state).toBe('hello');
      return new Response(JSON.stringify({ answers: { unsafe: { type: 'noul', noul: 0.9 } } }), { status: 200 });
    }));
    try {
      const text = await runAiJob(
        { DB: db, AI: undefined, OPENAI_API_KEY: 'sk-llm', TYPESAFE_API_KEY: 'ts-key' } as unknown as Bindings,
        AI_JOB_DEFINITIONS.comments_moderation,
        'hello',
      );
      // 判别驱动把 verdict 序列化成与生成式 parseVerdict 同形状的 JSON
      expect(text).not.toBeNull();
      expect(parseVerdict(text!)).toEqual({ safe: false, category: 'flagged' });
    } finally {
      invalidateSettingsCache();
      db.close();
    }
  });

  it('runAiJob 显式生成模式走 LLM 驱动（settings 覆盖 mode=generative 且驱动为 systemone）', async () => {
    const { SqliteD1 } = await import('../../src/node/d1/sqlite.ts');
    const { runMigrationsForNode } = await import('../../src/node/migrate.ts');
    const { invalidateSettingsCache } = await import('../../src/lib.ts');
    const db = new SqliteD1({ path: ':memory:' });
    await runMigrationsForNode(db);
    await db.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('ai_comments_moderation_mode', '', 'generative', 0)").run();
    invalidateSettingsCache();
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: unknown };
      expect(Array.isArray(body.messages)).toBe(true); // chat 补全形态
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"safe": false, "category": "spam"}' } }] }), { status: 200 });
    }));
    try {
      const text = await runAiJob(
        { DB: db, AI: undefined, AI_MODERATION_DRIVER: 'systemone', OPENAI_API_KEY: 'sk-llm', TYPESAFE_API_KEY: 'ts-key' } as unknown as Bindings,
        AI_JOB_DEFINITIONS.comments_moderation,
        'hello',
      );
      expect(parseVerdict(text!)).toEqual({ safe: false, category: 'spam' });
    } finally {
      invalidateSettingsCache();
      db.close();
    }
  });
});

describe('判别模型后台辅助', () => {
  it('systemone 驱动 + TypeSafe Key：模型列表走 GET /v1/models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'jev-latest' }, { id: 'jev-preview' }],
    }), { status: 200 })));
    const models = await fetchAvailableModels(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'systemone',
      TYPESAFE_API_KEY: 'ts-key',
    }));
    expect(models).toEqual(['jev-latest', 'jev-preview']);
  });

  it('systemone 驱动 + Clef 绑定：返回固定候选', async () => {
    const models = await fetchAvailableModels(env({
      AI: { run: async () => ({}) },
      AI_MODERATION_DRIVER: 'systemone',
    }));
    expect(models).toEqual(CLEF_MODELS);
  });

  it('systemone 驱动连通测试：noul ping 成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { unsafe: { type: 'noul', noul: 0.42 } },
    }), { status: 200 })));
    const result = await testAiConnection(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'systemone',
      TYPESAFE_API_KEY: 'ts-key',
    }));
    expect(result).toMatchObject({ ok: true, model: 'jev-latest' });
  });

  it('systemone 驱动连通测试：HTTP 失败返回 call-failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 401 })));
    const result = await testAiConnection(env({
      AI: undefined,
      AI_MODERATION_DRIVER: 'systemone',
      TYPESAFE_API_KEY: 'ts-key',
    }));
    expect(result).toMatchObject({ ok: false, reason: 'call-failed' });
  });

  it('生成式任务（texture_translate）在判别驱动下结构性无模型：不发起任何请求', async () => {
    const fetchMock = vi.fn();
    const aiMock = { run: vi.fn() };
    vi.stubGlobal('fetch', fetchMock);
    const { runAiJob: run } = await import('../../src/services/ai-gateway.ts');
    const text = await run(env({
      AI: aiMock,
      AI_MODERATION_DRIVER: 'systemone',
      TYPESAFE_API_KEY: 'ts-key',
    }), AI_JOB_DEFINITIONS.texture_translate, 'translate me');
    expect(text).toBeNull(); // 判别模型不能翻译 → 无模型 → fail-open
    expect(fetchMock).not.toHaveBeenCalled(); // 不白耗判别 API 配额
    expect(aiMock.run).not.toHaveBeenCalled();
  });
});
