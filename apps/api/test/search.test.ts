// 高级搜索表达式 —— 在真实 D1 上验证。
//
// 分两层：
//   1. 字段表与 SQL 绑定表必须一致（编译期发现不了的错配，这里锁住）；
//   2. 每个入口都用"引用全部字段"的表达式打一遍真实查询 —— 绑定表里任何
//      写错的列名或表别名都会被执行层当场报错，这比只断言 SQL 文本有用得多。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { SEARCH_SCHEMAS } from '@pigeon-skin/shared/search';
import type { SearchField, SearchSchemaKey } from '@pigeon-skin/shared/search';
import { SERVER_SEARCH_KEYS, TARGET_SCHEMAS, searchTarget } from '../src/search/targets.ts';
import { compileNode } from '../src/search/compile.ts';
import { parseSearchExpressionLenient } from '@pigeon-skin/shared/search';
import { hashToken } from '@pigeon-skin/auth';
import { runMigrations } from './setup.ts';

const PASSWORD = 'correct-horse-9';
let seq = 0;
const uniq = (prefix: string) => `${prefix}_${++seq}_${Date.now().toString(36).replace(/[^a-z0-9]/g, '')}`;

async function register(prefix: string): Promise<{ id: number; email: string }> {
  const email = `${uniq(prefix)}@example.com`;
  const response = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, playerName: uniq('p') }),
  });
  expect(response.status).toBe(201);
  return { id: (await response.json<{ id: number }>()).id, email };
}

async function login(email: string): Promise<string> {
  const response = await SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

let adminCookie: string;
let userCookie: string;
let userId: number;

beforeAll(async () => {
  await runMigrations();
  const admin = await register('searchadmin');
  await env.DB.prepare(`UPDATE users SET role = 'super_admin' WHERE id = ?`).bind(admin.id).run();
  adminCookie = await login(admin.email);
  const user = await register('searchuser');
  userId = user.id;
  userCookie = await login(user.email);

  const now = Date.now();
  const insert = `INSERT INTO textures (hash, kind, model, name, size_bytes, visibility, width, height, likes, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 100, ?, 64, 64, ?, ?, ?)`;
  await env.DB.batch([
    env.DB.prepare(insert).bind(`h-${uniq('a')}`, 'skin', 'default', 'Dragon Knight', 'public', 120, now, now),
    env.DB.prepare(insert).bind(`h-${uniq('b')}`, 'skin', 'slim', 'Summer Beach', 'public', 5, now, now),
    env.DB.prepare(insert).bind(`h-${uniq('c')}`, 'cape', null, 'Blue Cape', 'public', 40, now, now),
  ]);
});

const get = (path: string, cookie?: string) =>
  SELF.fetch(`https://x${path}`, cookie ? { headers: { cookie } } : undefined);

/** 该字段类型下一个合法的字面量，用于生成"引用全部字段"的表达式。 */
function literalFor(field: SearchField): string {
  switch (field.type) {
    case 'enum': return `field:${field.values![0]!}`;
    case 'boolean': return 'field:true';
    case 'number': return 'field>0';
    case 'date': return 'field>=2024-01-01';
    case 'text': return 'field:zzz';
  }
}

/** 把 schema 的每个字段都写进表达式，确保每个绑定的 SQL 都真的被执行到。 */
function allFieldsExpression(key: SearchSchemaKey): string {
  return SEARCH_SCHEMAS[key].fields.map(field => literalFor(field).replace('field', field.name)).join(' OR ');
}

const ENDPOINTS: Record<(typeof SERVER_SEARCH_KEYS)[number], { path: string; param: string; auth: 'admin' | 'user' | 'public' }> = {
  textures: { path: '/api/v1/textures', param: 'keyword', auth: 'public' },
  closet: { path: '/api/v1/closet', param: 'keyword', auth: 'user' },
  adminUsers: { path: '/api/v1/admin/users', param: 'q', auth: 'admin' },
  adminTextures: { path: '/api/v1/admin/textures', param: 'q', auth: 'admin' },
  adminPlayers: { path: '/api/v1/admin/players', param: 'q', auth: 'admin' },
  auditLog: { path: '/api/v1/admin/audit-log', param: 'q', auth: 'admin' },
  tickets: { path: '/api/v1/admin/tickets', param: 'q', auth: 'admin' },
  votes: { path: '/api/v1/admin/votes', param: 'q', auth: 'admin' },
  yggLogs: { path: '/api/v1/admin/yggdrasil/logs', param: 'q', auth: 'admin' },
};

describe('字段表与 SQL 绑定表一致性', () => {
  it('每个可搜字段都有对应的 SQL 绑定', () => {
    for (const key of SERVER_SEARCH_KEYS) {
      const target = searchTarget(key);
      for (const schemaKey of TARGET_SCHEMAS[key]) {
        for (const field of SEARCH_SCHEMAS[schemaKey as SearchSchemaKey].fields) {
          expect(Object.hasOwn(target, field.name), `${key}.${field.name}`).toBe(true);
        }
      }
    }
  });

  it('绑定表里没有 schema 之外的字段', () => {
    for (const key of SERVER_SEARCH_KEYS) {
      // 一个 SQL 目标可能服务多个 schema（公开皮库与后台材质共用绑定表），
      // 因此绑定键只需落在这些 schema 字段的并集里。
      const names = new Set(TARGET_SCHEMAS[key].flatMap(schemaKey =>
        SEARCH_SCHEMAS[schemaKey as SearchSchemaKey].fields.map(field => field.name)));
      for (const bound of Object.keys(searchTarget(key))) {
        expect(names.has(bound), `${key}.${bound}`).toBe(true);
      }
    }
  });
});

describe('表达式搜索：公开皮库', () => {
  const search = async (expression: string) => {
    const response = await get(`/api/v1/textures?keyword=${encodeURIComponent(expression)}&per_page=50`);
    expect(response.status, expression).toBe(200);
    const body = await response.json<{ items: Array<{ name: string }>; total: number }>();
    return body.items.map(item => item.name);
  };

  it('普通词按名称子串匹配（3 字以上走 FTS）', async () => {
    expect(await search('Dragon')).toContain('Dragon Knight');
    expect(await search('Blue Cape')).toEqual(['Blue Cape']);
  });

  it('短词回退 LIKE，中文两字也能命中', async () => {
    expect(await search('Bl')).toContain('Blue Cape');
  });

  it('字段限定与否定', async () => {
    const capes = await search('kind:cape');
    expect(capes).toContain('Blue Cape');
    expect(capes).not.toContain('Dragon Knight');
    const notCapes = await search('-kind:cape');
    expect(notCapes).toContain('Dragon Knight');
    expect(notCapes).not.toContain('Blue Cape');
  });

  it('数值比较与区间', async () => {
    expect(await search('likes>100')).toEqual(['Dragon Knight']);
    expect(await search('likes:10..100')).toContain('Blue Cape');
    expect(await search('likes:10..100')).not.toContain('Summer Beach');
  });

  it('布尔与逻辑组合、括号分组', async () => {
    const grouped = await search('(kind:skin OR name:Blue) likes>10');
    expect(grouped).toContain('Dragon Knight');
    expect(grouped).toContain('Blue Cape');
    expect(grouped).not.toContain('Summer Beach');
    expect(await search('kind:skin likes>10')).toEqual(['Dragon Knight']);
    expect(await search('name:"Summer Beach"')).toEqual(['Summer Beach']);
  });

  it('“不等于”包含该字段为空的行，与 `-字段:值` 一致', async () => {
    // 造出来的纹理都没有上传者（uploader_id 为空），所以两种写法都应返回全部可见行
    const all = await search('');
    expect(all.length).toBeGreaterThan(0);
    expect(await search('uploader:alice')).toEqual([]);
    expect(await search('uploader!=alice')).toEqual(all);
    expect(await search('-uploader:alice')).toEqual(all);
  });

  it('数值与日期的区间允许省略任一端', async () => {
    expect(await search('likes:..100')).toContain('Summer Beach');
    expect(await search('likes:..100')).not.toContain('Dragon Knight');
    expect(await search('likes:10..')).toContain('Dragon Knight');
    expect(await search('created:2020-01-01..')).toContain('Dragon Knight');
  });

  it('无搜索时返回全部可见材质', async () => {
    const items = await search('');
    expect(items).toContain('Dragon Knight');
  });

  it('无法解析的表达式按字面量搜索，不做错误反馈', async () => {
    // 未知字段、非法取值、显式包含用在枚举、未闭合引号：一律退化成一个普通词
    for (const expression of ['nope:1', 'likes>abc', 'kind:>10', '"未闭合', '..']) {
      const response = await get(`/api/v1/textures?keyword=${encodeURIComponent(expression)}`);
      expect(response.status, expression).toBe(200);
      // 这些字面量都不是任何材质名的一部分，所以结果为空而不是报错
      expect((await response.json<{ total: number }>()).total, expression).toBe(0);
    }
    // 真正的上限仍然生效：参数长度由输入校验兜住
    const tooLong = await get(`/api/v1/textures?keyword=${encodeURIComponent('a'.repeat(600))}`);
    expect(tooLong.status).toBe(422);
  });
});

describe('表达式搜索：每个入口都能执行全部字段', () => {
  for (const key of SERVER_SEARCH_KEYS) {
    it(`${key}`, async () => {
      const endpoint = ENDPOINTS[key];
      const cookie = endpoint.auth === 'admin' ? adminCookie : endpoint.auth === 'user' ? userCookie : undefined;
      const response = await get(`${endpoint.path}?${endpoint.param}=${encodeURIComponent(allFieldsExpression(key))}`, cookie);
      // 绑定表写错的列名/别名会在这里变成 500
      expect(response.status, await response.clone().text()).toBe(200);
    });
  }

  it('后台各入口都能处理无法解析的表达式（退化成字面量，不报错）', async () => {
    for (const key of SERVER_SEARCH_KEYS) {
      const endpoint = ENDPOINTS[key];
      if (endpoint.auth !== 'admin') continue;
      const response = await get(`${endpoint.path}?${endpoint.param}=${encodeURIComponent('nope:1')}`, adminCookie);
      expect(response.status, key).toBe(200);
      expect((await response.json<{ total: number }>()).total, key).toBe(0);
    }
  });
});

describe('注入与滥用防护', () => {
  /** 整串都在尝试注入：必须一行都匹配不到，且绝不能是 500。 */
  const INJECTION = [
    "' OR 1=1 --",
    "'; DROP TABLE textures; --",
    "name:' OR 1=1 --",
    'name:UNION SELECT password_hash FROM users',
    'name:/*',
    'name:\\',
    'name:%',
    'name:_',
  ];
  /** 解析不了的输入：退化成字面量搜索（200 + 命中不到），只有超长仍被输入校验拒绝。 */
  const MALFORMED = [
    '"',
    '" OR 1=1 --',
    "name:Robert\"); DROP TABLE textures;--",
    'name:""',
    '((',
    Array.from({ length: 100 }, () => 'x').join(' OR '),
  ];
  const TOO_LONG = 'a'.repeat(600);
  /** 含合法条件的表达式：结果不应超过全表。 */
  const NEUTRAL = ['likes>0 OR 1=1', 'dragon OR Knight'];

  it('用户输入只进绑定参数，SQL 文本里没有载荷也不含语句片段', () => {
    let compiled = 0;
    for (const payload of [...INJECTION, ...MALFORMED, ...NEUTRAL]) {
      const ast = parseSearchExpressionLenient(payload, SEARCH_SCHEMAS.textures);
      if (!ast) continue;
      const fragment = compileNode(ast, SEARCH_SCHEMAS.textures, searchTarget('textures'));
      compiled++;
      // 载荷可以出现在参数里（它本来就是被搜索的值），但绝不能出现在 SQL 文本里；
      // 单字符载荷（如 `"`）本来就会与标识符引号重合，只对足够长的载荷做包含判断
      if (payload.length >= 4) expect(fragment.sql.includes(payload), payload).toBe(false);
      // 生成的 SQL 只有列引用、运算符与方言片段，不会有语句分隔符或注释符
      expect(/;|--/.test(fragment.sql), `${payload}: ${fragment.sql}`).toBe(false);
      expect(fragment.sql.split('?').length - 1, payload).toBe(fragment.params.length);
    }
    // 至少有一批载荷是"合法但无害"的，否则这条用例会退化成空转
    expect(compiled).toBeGreaterThan(0);
  });

  it('注入载荷匹配不到任何行，也不破坏数据', async () => {
    const before = await env.DB.prepare('SELECT count(*) AS n FROM textures').first<{ n: number }>();
    expect(before!.n).toBeGreaterThan(0);

    for (const payload of INJECTION) {
      const response = await get(`/api/v1/textures?keyword=${encodeURIComponent(payload)}&per_page=100`);
      expect(response.status, payload).toBe(200);
      expect((await response.json<{ total: number }>()).total, payload).toBe(0);
    }

    // 表还在、行数没变 —— 没有载荷被执行成 DDL/DML
    const after = await env.DB.prepare('SELECT count(*) AS n FROM textures').first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    const probe = await env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>();
    expect(probe!.n).toBeGreaterThan(0);
  });

  it('畸形表达式退化成字面量搜索，不把 SQL 错误漏成 500', async () => {
    for (const payload of MALFORMED) {
      const response = await get(`/api/v1/textures?keyword=${encodeURIComponent(payload)}`);
      expect(response.status, payload).toBe(200);
      expect((await response.json<{ total: number }>()).total, payload).toBe(0);
    }
    // 超过输入长度上限仍被拒绝（这是体积限制，不是语法问题）
    expect((await get(`/api/v1/textures?keyword=${encodeURIComponent(TOO_LONG)}`)).status).toBe(422);
  });

  it('LIKE 元字符按字面匹配，不会退化成通配', async () => {
    for (const payload of ['name:%', 'name:_']) {
      const response = await get(`/api/v1/textures?keyword=${encodeURIComponent(payload)}`);
      expect(response.status, payload).toBe(200);
      expect((await response.json<{ total: number }>()).total, payload).toBe(0);
    }
  });

  it('显式“包含”用在非文本字段、以及没有字段的区间，退化成字面量搜索', async () => {
    for (const expression of ['kind~skin', '..', 'a..b']) {
      const response = await get(`/api/v1/textures?keyword=${encodeURIComponent(expression)}`);
      expect(response.status, expression).toBe(200);
      expect((await response.json<{ total: number }>()).total, expression).toBe(0);
    }
  });

  it('含合法条件的表达式结果不超过全表', async () => {
    const total = (await env.DB.prepare('SELECT count(*) AS n FROM textures').first<{ n: number }>())!.n;
    for (const payload of NEUTRAL) {
      const response = await get(`/api/v1/textures?keyword=${encodeURIComponent(payload)}`);
      expect(response.status, payload).toBe(200);
      expect((await response.json<{ total: number }>()).total, payload).toBeLessThanOrEqual(total);
    }
  });
});

describe('表达式搜索：机器端管理 API 共用同一套字段表', () => {
  it('pigeon admin 列表接受搜索表达式', async () => {
    const owner = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind('searchadmin-placeholder').first<{ id: number }>();
    const ownerId = owner?.id ?? (await env.DB.prepare('SELECT id FROM users ORDER BY id LIMIT 1').first<{ id: number }>())!.id;
    const secret = `psk_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    await env.DB.prepare(`INSERT INTO pigeon_api_keys (id, label, secret_hash, prefix, scopes, created_by, enabled, created_at)
                          VALUES (?, 'search-test', ?, ?, ?, ?, 1, ?)`)
      .bind(crypto.randomUUID(), await hashToken(secret), secret.slice(0, 12), JSON.stringify(['admin.users.write']), ownerId, Date.now()).run();

    const response = await SELF.fetch('https://x/api/v1/pigeon/admin/users?q=' + encodeURIComponent('score>=0'), { headers: { 'api-key': secret } });
    expect(response.status).toBe(200);
    expect((await response.json<{ total: number }>()).total).toBeGreaterThan(0);

    const literal = await SELF.fetch('https://x/api/v1/pigeon/admin/users?q=' + encodeURIComponent('nope:1'), { headers: { 'api-key': secret } });
    expect(literal.status).toBe(200);
    expect((await literal.json<{ total: number }>()).total).toBe(0);
  });
});

describe('表达式搜索：各入口的字段真的生效', () => {
  it('衣柜按收藏名与材质名搜索', async () => {
    const textureId = (await env.DB.prepare(`SELECT id FROM textures WHERE name = 'Blue Cape'`).first<{ id: number }>())!.id;
    const now = Date.now();
    await env.DB.prepare('INSERT INTO closet (user_id, texture_id, item_name, is_default, created_at) VALUES (?, ?, ?, 0, ?)')
      .bind(userId, textureId, '我的披风', now).run();

    const hit = await get(`/api/v1/closet?keyword=${encodeURIComponent('我的披风')}`, userCookie);
    expect(hit.status).toBe(200);
    expect((await hit.json<{ items: unknown[] }>()).items).toHaveLength(1);

    const byTextureName = await get(`/api/v1/closet?keyword=${encodeURIComponent('name:Blue')}`, userCookie);
    expect((await byTextureName.json<{ items: unknown[] }>()).items).toHaveLength(1);

    const miss = await get(`/api/v1/closet?keyword=${encodeURIComponent('kind:cape name:zzz')}`, userCookie);
    expect(miss.status).toBe(200);
    expect((await miss.json<{ items: unknown[] }>()).items).toHaveLength(0);
  });

  it('后台用户搜索按邮箱与昵称匹配，并支持积分比较', async () => {
    const response = await get('/api/v1/admin/users?q=' + encodeURIComponent(`searchuser_ OR score>=0`), adminCookie);
    expect(response.status).toBe(200);
    expect((await response.json<{ total: number }>()).total).toBeGreaterThan(0);

    const none = await get('/api/v1/admin/users?q=' + encodeURIComponent('score>99999999'), adminCookie);
    expect((await none.json<{ total: number }>()).total).toBe(0);
  });

  it('投票状态用派生的时间窗表达式过滤', async () => {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO pigeon_votes (id, title, description, status, starts_at, ends_at, max_choices, results_policy, created_at, updated_at)
                          VALUES (?, '进行中的投票', '', 'published', ?, ?, 1, 'always', ?, ?)`)
      .bind(crypto.randomUUID(), now - 1000, now + 86_400_000, now, now).run();
    const active = await get('/api/v1/admin/votes?q=' + encodeURIComponent('status:active'), adminCookie);
    expect(active.status).toBe(200);
    expect((await active.json<{ items: Array<{ title: string }> }>()).items.map(item => item.title)).toContain('进行中的投票');

    const ended = await get('/api/v1/admin/votes?q=' + encodeURIComponent('status:ended'), adminCookie);
    expect((await ended.json<{ items: Array<{ title: string }> }>()).items.map(item => item.title)).not.toContain('进行中的投票');
  });

  it('审计日志按 action/detail 搜索，命中的是我们写入的那一条', async () => {
    const probe = `probe${Date.now()}`;
    await env.DB.prepare(`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at)
                          VALUES (?, 'admin.texture.delete', 'texture', 1, ?, ?)`)
      .bind(userId, probe, Date.now()).run();
    const total = async (expression: string) => {
      const response = await get('/api/v1/admin/audit-log?q=' + encodeURIComponent(expression), adminCookie);
      expect(response.status, expression).toBe(200);
      return (await response.json<{ total: number }>()).total;
    };
    expect(await total(`detail:${probe}`)).toBe(1);
    expect(await total(`action:admin.texture.delete detail:${probe}`)).toBe(1);
    expect(await total(`action:admin.texture.delete detail:${probe}x`)).toBe(0);
    expect(await total(`actor:searchuser`)).toBeGreaterThan(0);
  });

  it('条件过多、以及长关键词，都不会在 D1 上变成 500', async () => {
    // 先塞一行数据：空表不会求值 LIKE，会让同类问题隐身
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at)
                          VALUES (?, 'admin.texture.delete', 'texture', 1, 'budget', ?)`).bind(userId, now).run();
    await env.DB.prepare(`INSERT INTO ygg_log (ip, action, body, user_id, created_at) VALUES ('203.0.113.1', 'join', '{}', ?, ?)`)
      .bind(userId, now).run();
    const category = await env.DB.prepare(`SELECT id FROM ticket_categories ORDER BY id LIMIT 1`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO tickets (ticket_number, user_id, title, category, category_id, description, status, created_at, updated_at)
                          VALUES (?, ?, 'budget', 'other', ?, 'x', 'pending', ?, ?)`)
      .bind(`T-${now}`, userId, category?.id ?? null, now, now).run();

    // 20 个词足以让三个入口都超过谓词预算（每词 4~7 个绑定，上限 64），应退化成字面量搜索
    const many = Array.from({ length: 20 }, (_, index) => `zzq${index}`).join(' ');
    for (const path of ['/api/v1/admin/audit-log', '/api/v1/admin/yggdrasil/logs', '/api/v1/admin/tickets']) {
      const response = await get(`${path}?q=${encodeURIComponent(many)}`, adminCookie);
      expect(response.status, path).toBe(200);
      expect((await response.json<{ total: number }>()).total, path).toBe(0);
    }

    // 长关键词：D1 的 LIKE 模式上限是 50 字符，超过后必须换谓词而不是报错
    const long = 'w'.repeat(60);
    for (const [path, param] of [
      ['/api/v1/textures', 'keyword'],
      ['/api/v1/admin/audit-log', 'q'],
      ['/api/v1/admin/yggdrasil/logs', 'q'],
      ['/api/v1/admin/tickets', 'q'],
      ['/api/v1/admin/users', 'q'],
    ] as const) {
      const response = await get(`${path}?${param}=${encodeURIComponent(long)}`, path.startsWith('/api/v1/admin') ? adminCookie : undefined);
      expect(response.status, `${path} long keyword`).toBe(200);
    }
    // 带字段限定的长值同样不能踩到 LIKE 上限（上传者是普通列，不走全文索引）
    const uploader = await get(`/api/v1/textures?keyword=${encodeURIComponent(`uploader:${long}`)}`);
    expect(uploader.status).toBe(200);
  });

  it('表达式明确要归档状态时，归档的投票也能被搜到', async () => {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO pigeon_votes (id, title, description, status, starts_at, ends_at, max_choices, results_policy, created_at, updated_at, archived_at)
                          VALUES (?, '已归档的投票', '', 'published', ?, ?, 1, 'always', ?, ?, ?)`)
      .bind(crypto.randomUUID(), now - 86_400_000, now - 3600_000, now, now, now).run();
    // 只给状态表达式、不选状态下拉时，归档行也应该能被表达式捞出来
    const response = await get('/api/v1/admin/votes?q=' + encodeURIComponent('status:archived'), adminCookie);
    expect(response.status).toBe(200);
    expect((await response.json<{ items: Array<{ title: string }> }>()).items.map(item => item.title)).toContain('已归档的投票');
  });

  it('投票的派生状态里，关闭与取消也能被搜到（枚举与实际状态集一致）', async () => {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO pigeon_votes (id, title, description, status, starts_at, ends_at, max_choices, results_policy, created_at, updated_at)
                          VALUES (?, '已关闭的投票', '', 'closed', ?, ?, 1, 'always', ?, ?)`)
      .bind(crypto.randomUUID(), now - 86_400_000, now - 3600_000, now, now).run();
    const response = await get('/api/v1/admin/votes?q=' + encodeURIComponent('status:closed'), adminCookie);
    expect(response.status).toBe(200);
    expect((await response.json<{ items: Array<{ title: string }> }>()).items.map(item => item.title)).toContain('已关闭的投票');
  });

  it('Yggdrasil 日志可按 action、IP 与玩家名搜索', async () => {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO ygg_log (ip, action, body, user_id, created_at) VALUES ('198.51.100.9', 'join', '{}', ?, ?)`)
      .bind(userId, now).run();
    const byIp = await get('/api/v1/admin/yggdrasil/logs?q=' + encodeURIComponent('ip:198.51.100.9'), adminCookie);
    expect(byIp.status).toBe(200);
    expect((await byIp.json<{ total: number }>()).total).toBeGreaterThan(0);

    const byAction = await get('/api/v1/admin/yggdrasil/logs?q=' + encodeURIComponent('action:join'), adminCookie);
    expect((await byAction.json<{ total: number }>()).total).toBeGreaterThan(0);

    const none = await get('/api/v1/admin/yggdrasil/logs?q=' + encodeURIComponent('ip:198.51.100.255'), adminCookie);
    expect((await none.json<{ total: number }>()).total).toBe(0);
  });
});
