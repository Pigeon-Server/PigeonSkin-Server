# 皮肤库反爬与防护配置

皮肤库（材质列表与详情）是站点的主要被抓取目标。本仓库内置了「边缘限流 + 渐进式人机验证」的应用层守卫，Cloudflare 部署时再叠加平台自带能力，两层组合使用。

---

## 一、应用层守卫（两种部署通用）

### 1.1 行为

守卫只作用于三个端点（按路由模式挂载，与路由同一套匹配语义，`0x47F`、`+1151`、百分号编码等写法无法绕过）：

| 端点 | 是否设防 |
|---|---|
| `GET /api/v1/textures`（列表 / 搜索 / 筛选） | 是 |
| `GET /api/v1/textures/:id`（详情） | 是 |
| `GET /api/v1/textures/:id/description`（描述） | 是 |
| `GET /api/v1/textures/:id/content`（材质 PNG） | **否** —— 外链引用与游戏加载依赖它，弹挑战会破坏这些用途 |
| `GET /api/v1/textures/:id/comments`（评论列表） | **否** —— 社交内容，不属材质本体 |

`HEAD` 与 `GET` 同样计数（否则可以据此零成本探测材质是否存在）。非法 id（如 `/api/v1/textures/abc`）同样先计数再交路由处理（404），超限时 429 优先于 404。

> **SSR 页面是等价的抓取面。** `/skinlib?page=N` 与 `/skinlib/<id>` 会服务端渲染材质列表与详情（`apps/api/src/services/seo.ts`），普通 HTTP 客户端无需 JS 就能枚举整库，且不受本守卫约束——这些页面必须保持免挑战（搜索引擎与正常访问都依赖它们）。要收口这一面，请在平台层处理，见 §2.3。

计数分两档，登录态是更强的信任信号：

| 身份 | 计数维度 | 默认阈值 | 超限处置 |
|---|---|---|---|
| 匿名访客 | IP | 60 请求 / 分钟 | 已配置验证码驱动 → 弹出人机验证；未配置 → 普通 429 软限流 |
| 登录用户 | 账号 | 300 请求 / 分钟 | 仅 429 限速，不弹验证（身份已知，挑战没有额外信息量） |

验证通过后签发 60 分钟的 HMAC 通行证 Cookie（`skinlib_pass`），之后的浏览不再打扰；通行证不解除限流本身，持证者仍有自己的分钟预算，超出只返回普通 429，不会陷入解不完的挑战循环。

正常浏览（每页 24 个材质、翻页间隔数秒）远低于上述阈值；按 ID 枚举或高频翻页的爬虫会很快触发。

### 1.2 开关与阈值

- 后台「设置 → 安全」中的 **皮肤库反爬守卫** 控制整个功能的开启（默认开启）。
- 限流阈值是部署级配置，不在后台改：
  - Cloudflare：`apps/api/wrangler.jsonc` 的 `ratelimits` 中 `RL_SKINLIB`（匿名）与 `RL_SKINLIB_USER`（登录用户）。
  - Node 自托管：环境变量 `RATE_LIMIT_SKINLIB` / `RATE_LIMIT_SKINLIB_USER`，格式 `<次数>/<秒数>`。

守卫在所有异常路径上 fail-open：限流 binding 缺失、验证码服务不可用、`RATE_LIMIT_ENABLED` 关闭时都直接放行——反爬是纵深防御的一层，不该把正常访问打挂。

### 1.3 验证码驱动选择

挑战复用站点已配置的人机验证驱动（六选一：Turnstile / reCAPTCHA v2 / v3 / 腾讯 / 阿里 / 自绘图案）。

- **Cloudflare 部署推荐 Turnstile**：Cloudflare 自家、免费、托管模式对多数访问者无感通过。在控制台创建 Turnstile widget 后，把 Site Key / Secret Key 填入后台「设置 → 安全」并选择 `Turnstile` 驱动即可。
- **Node 自托管**没有任何外部依赖的底线选项是「自绘图案」（`image`），需要 `SESSION_SECRET`，无需第三方账号。

未配置任何驱动时守卫仍然生效，只是超限后只做软限流、不弹挑战。

---

## 二、Cloudflare 平台层（控制台配置）

### 2.1 开启 Bot Fight Mode（免费版可用）

控制台 → 对应域名 → **Security → Settings → Bot traffic → Bot fight mode** 打开。它会对自动化流量发起计算型 JS 质询，对正常人类访问无感。

注意：免费版无法对 Bot Fight Mode 加豁免规则，开启后请留意是否有合法爬虫/监控被挡；如站点依赖特定搜索引擎抓取，可在 `robots.txt` 与后台之间权衡后决定是否开启。

### 2.2 WAF 速率限制规则（可选）

如果需要更长的统计窗口（应用层 binding 的窗口上限是 60 秒），可在 **Security → WAF → Rate limiting rules** 配置更宽的规则。**API 与 SSR 页面都要覆盖**，否则只挡住一半入口：

- 匹配（API，只能配 `Block`/限速，不要配质询）：
  `http.request.uri.path eq "/api/v1/textures"` 或
  `http.request.uri.path matches "^/api/v1/textures/[^/]+$"`（覆盖详情与描述；description 也在此前缀下）
- 匹配（SSR 页面，见 §2.3 的说明）：
  `http.request.uri.path eq "/skinlib"` 或
  `http.request.uri.path matches "^/skinlib/[0-9]+$"`
- 统计维度：IP
- 动作：`Block`，配合较长周期（如 10 分钟 N 次）；页面路径也可以改用 Managed Challenge（对导航请求安全）

阈值建议明显高于正常浏览（正常用户一分钟翻不了几页），先观察再收紧。

### 2.3 ⚠️ 质询类动作只能用于页面导航，不要配到 API 路径上

WAF 的 **Managed Challenge / JS Challenge 动作只对页面导航有效**。如果把它配到 `/api/v1/textures` 这类 JSON API 上，浏览器 `fetch` 拿到的是挑战 HTML 页面，前端无法解析也无法通过，正常用户会直接看到报错——这是「配了反而更糟」的典型。

正确分工：

| 抓取面 | 平台层 | 应用层 |
|---|---|---|
| API（`/api/v1/textures*`） | 限速 / Bot Fight Mode | 守卫（含 Turnstile 挑战） |
| SSR 页面（`/skinlib`、`/skinlib/<id>`） | 限速 / Managed Challenge / Bot Fight Mode | 不设防（保 SEO 与正常访问） |

---

## 三、自托管（Node）补充

- 验证码驱动选 `image` 或任意第三方驱动，配置方式见后台设置或环境变量（`CAPTCHA_DRIVER` 等）。
- 未配置 Redis 时，限流是单进程内存窗口：单实例部署完全可用；**多实例部署必须配置 `REDIS_URL`**，否则各实例计数互不可见，反爬强度按实例数打折。
- 站点前面还有一层反向代理时，确认它透传 `X-Forwarded-For`，否则所有请求按同一个 IP 计数。

---

## 四、验证清单

部署后按下面的步骤确认配置生效：

```bash
# 1. 匿名快速请求列表端点 61 次（阈值 60/分钟），第 61 次应返回 429
for i in $(seq 1 61); do
  curl -s -o /dev/null -w "%{http_code}\n" https://your-site/api/v1/textures
done
# 预期：前 60 次 200，之后 429 + {"error":"skinlib.challenge_required"}（已配置验证码时）

# 2. 换个 id 写法不能绕过（与路由同源的匹配语义）
curl -s -o /dev/null -w "%{http_code}\n" https://your-site/api/v1/textures/0x1
# 预期：同样落在守卫内（429 或按预算放行），不会被跳过

# 3. 图片内容端点不受影响
curl -s -o /dev/null -w "%{http_code}\n" https://your-site/api/v1/textures/1/content
# 预期：200（或内容不存在时的 404），不会是 429
```

浏览器端验证：打开皮肤库页面连续快速翻页触发挑战 → 弹窗完成人机验证 → 翻页自动恢复；随后一分钟内继续翻页不再弹窗（通行证生效）。

前端已接入挑战重试的位置：皮肤库列表与详情、材质描述、创作者主页列表、角色管理、材质编辑器。**装饰性内容刻意保持静默降级**：首页精选与头像取 hash 失败时不弹验证（避免页面加载时突然弹窗），拿不到就回退默认展示。
