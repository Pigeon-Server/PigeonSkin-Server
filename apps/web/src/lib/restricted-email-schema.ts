// 与服务端 core/schemas.ts 的 restrictedEmailListSchema 保持同一规则：
// 前端提交前校验用。规则若调整必须两处同步（服务端是权威）。
import { z } from 'zod';

export const restrictedEmailListSchema = z.object({
  domains: z.array(z.string().trim().min(1).max(253).toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)).max(1000),
});
