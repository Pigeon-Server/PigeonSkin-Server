// restricted-email-domains 内置 —— 原 restricted-email-domains 插件的语义。
//
// allow/deny 两个名单存 settings（JSON 数组字符串）。
// 校验规则照搬原 EmailFilter::filter（checkEmailDomain 在 services/email-policy.ts，
// 由 services/auth.register 与 services/users.updateProfile 调用）。

import { Hono } from 'hono';
import { currentAdmin, readJson } from '../framework.ts';
import { type AppEnv } from '../lib.ts';
import { restrictedEmailListSchema } from '@pigeon-skin/shared/schemas';
import { writeSetting } from '../services/settings.ts';
import { readEmailDomainList } from '../services/email-policy.ts';

export const restrictedEmailRoutes = new Hono<AppEnv>();

/** 读名单（JSON 数组；坏数据按空表处理并容忍） */
const readList = readEmailDomainList;

restrictedEmailRoutes.get('/admin/restricted-email-domains', async (c) => {
  currentAdmin(c);
  return c.json({
    allow: await readList(c.env, 'restricted_email_allow'),
    deny: await readList(c.env, 'restricted_email_deny'),
  });
});

restrictedEmailRoutes.put('/admin/restricted-email-domains/:list', async (c) => {
  const admin = currentAdmin(c);
  const list = c.req.param('list');
  if (list !== 'allow' && list !== 'deny') {
    return c.json({ error: 'common.invalid_request' }, 422);
  }
  const body = await readJson(c, restrictedEmailListSchema);
  await writeSetting(c.env, list === 'allow' ? 'restricted_email_allow' : 'restricted_email_deny',
    JSON.stringify(body.domains), { isSuperAdmin: admin.role === 'super_admin' });
  return c.body(null, 204);
});
