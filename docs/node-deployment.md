# Node 自托管部署

除 Cloudflare Workers/Pages 之外，本仓库还提供 Node.js 自托管入口：同一个 Hono 应用、同一套业务代码与迁移 SQL，通过平台适配层（`apps/api/src/node/`）在 Node 上装配 D1/R2/DO/队列/限流的同形对象。本文描述该入口的 Docker 与裸机部署。

与 Cloudflare 部署的关系：两者共享 `apps/api/src/app.ts` 的 `createApp()` 与 `apps/api/src/tasks.ts` 的任务执行体，Worker 路径（`apps/api/src/index.ts`、wrangler 部署）不受 Node 部署影响，数据库迁移在 Worker 侧仍由 `wrangler d1 migrations apply` 应用。

---

## 快速开始（Docker）

```bash
git clone --recurse-submodules https://github.com/Pigeon-Server/PigeonSkin-Server.git
cd PigeonSkin-Server
docker compose up -d
curl http://127.0.0.1:8787/api/v1/health
```

`--recurse-submodules` 用于拉取 `vendor/blockbench`（GPL-3.0-or-later 的 Blockbench 上游源码），前端构建需要它；对已有克隆可补 `git submodule update --init`。

默认组合是 SQLite + 本地文件存储，不需要任何外部服务。所有状态（业务库、缓存库、DO 状态库、材质文件）都落在挂载卷 `./data` 中。首次启动会自动执行数据库迁移，之后访问 `http://127.0.0.1:8787` 即可。

生产部署至少补两件事：

1. 设置 `SESSION_SECRET`（长随机串），否则会话签名密钥来自默认空值；
2. 把 `APP_URL` 改为对外访问地址（邮件链接、OAuth 回调、Yggdrasil 首页链接都依赖它）。

`APP_URL` 有一个硬约束：`ENVIRONMENT` 非 `development` 时必须是合法的 https URL（仅协议与主机，不带路径、查询或凭据）。`http://localhost:8787` 这类默认值只在 `ENVIRONMENT=development` 下可用；生产环境忘改 `APP_URL` 时，健康检查正常但业务请求会返回 503 `common.internal_error`——这是站点地址校验（`resolveConfiguration`）的设计行为，不是故障。

---

## docker-compose 组合

`docker-compose.yml` 默认只有 `app` 一个服务。PostgreSQL / MySQL / Redis 三个服务块以注释形式内置，取消注释并在 `app.environment` 中加对应变量即可：

### SQLite（默认）

```yaml
services:
  app:
    image: pigeon-server
    ports: ["8787:8787"]
    volumes: ["./data:/app/data"]
```

不需要数据库服务。备份就是复制 `./data`。

### PostgreSQL

```yaml
services:
  app:
    environment:
      DB_DRIVER: postgres
      DATABASE_URL: postgresql://pigeon:pigeon@postgres:5432/pigeon
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: pigeon
      POSTGRES_PASSWORD: pigeon
      POSTGRES_DB: pigeon
    volumes: ["./data/postgres:/var/lib/postgresql/data"]
```

### MySQL

```yaml
services:
  app:
    environment:
      DB_DRIVER: mysql
      DATABASE_URL: mysql://pigeon:pigeon@mysql:3306/pigeon
  mysql:
    image: mysql:8.4
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci
    environment:
      MYSQL_USER: pigeon
      MYSQL_PASSWORD: pigeon
      MYSQL_DATABASE: pigeon
      MYSQL_ROOT_PASSWORD: change-me
    volumes: ["./data/mysql:/var/lib/mysql"]
```

### Redis（可选层）

```yaml
services:
  app:
    environment:
      REDIS_URL: redis://redis:6379
  redis:
    image: redis:7-alpine
    volumes: ["./data/redis:/data"]
```

Redis 只在显式配置 `REDIS_URL` 后启用，见下文「Redis 可选层」。

---

## 裸机部署

要求 Node.js ≥ 22.18（使用了内置的 `node:sqlite` 模块，无需原生编译）。

```bash
git clone --recurse-submodules https://github.com/Pigeon-Server/PigeonSkin-Server.git
cd PigeonSkin-Server
npm ci
npm run build                                        # 前端 → apps/web/dist
npm run build:node --workspace @pigeon-skin/api      # API bundle → apps/api/dist-node/entry.mjs
npm run start:node --workspace @pigeon-skin/api      # 监听 0.0.0.0:8787
```

环境变量与 Docker 相同（下表）。两个路径相关变量在裸机部署下需要留意：

- `PIGEON_ROOT`：迁移目录探测根。启动时迁移执行器按顺序探测 `PIGEON_ROOT/packages/db/migrations{,-pg,-mysql}` → 相对 bundle 文件上三级 → 相对 cwd 两处。从仓库根目录启动（默认 cwd 即仓库根）可不用设置；从其它目录启动或打包部署时显式指向仓库根。Docker 镜像内已设为 `/app`。
- `ASSETS_DIR`：前端静态资源目录（SPA `index.html`、blockbench 编辑器、手册资源等）。默认相对 bundle 定位 `apps/web/dist`；目录不标准时显式设置。

systemd 单元示例：

```ini
[Unit]
Description=Pigeon Skin Server
After=network.target

[Service]
User=pigeon
WorkingDirectory=/srv/pigeon
EnvironmentFile=/srv/pigeon/.env
ExecStart=/usr/bin/node apps/api/dist-node/entry.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## 环境变量参考

以下变量在 `apps/api/src/node/runtime.ts` 装配，变量名与 Worker 部署的 wrangler vars/secrets 对齐。除标注外均可省略（省略即用默认行为）。

### 数据库

| 变量 | 默认 | 说明 |
|---|---|---|
| `DB_DRIVER` | `sqlite` | `sqlite` / `postgres` / `mysql` |
| `DATABASE_PATH` | `./data/pigeon.db` | 仅 sqlite：数据库文件路径，目录不存在会自动创建 |
| `DATABASE_URL` | — | postgres/mysql 必填。PG 形如 `postgresql://user:pass@host:5432/db`；MySQL 形如 `mysql://user:pass@host:3306/db` |
| `PIGEON_ROOT` | — | 迁移目录探测根（`packages/db/migrations*` 所在的仓库根） |
| `PIGEON_SQL_DEBUG` | — | 设为任意值时，PG 适配器把失败语句与参数打到 stderr（排障用） |

### 对象存储

| 变量 | 默认 | 说明 |
|---|---|---|
| `STORAGE_DRIVER` | `file` | `file`（本地文件系统）或 `s3`（任意 S3 兼容后端，SigV4） |
| `STORAGE_PATH` | `${DATA_DIR}/storage` | 仅 file：材质文件根目录 |
| `S3_ENDPOINT` | — | 仅 s3：如 `https://<account>.r2.cloudflarestorage.com`、MinIO `http://host:9000/bucket`。可含 bucket 路径 |
| `S3_BUCKET` | — | 仅 s3：endpoint 不含 bucket 时必填 |
| `S3_REGION` | `auto` | 仅 s3：R2 用 `auto`；OSS/MinIO 按其区域配置 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | 仅 s3：s3 驱动三项（endpoint + 两个 key）任缺其一启动即报错 |
| `ASSETS_DIR` | 相对 bundle 的 `apps/web/dist` | 前端静态资源目录，SPA 回退与 SEO 预渲染依赖它 |

### 缓存 / 限流 / 队列（Redis 可选层）

| 变量 | 默认 | 说明 |
|---|---|---|
| `REDIS_URL` | — | 如 `redis://127.0.0.1:6379`。配置后缓存、限流、队列三处切换到 Redis；未配置全部走本地实现 |
| `RATE_LIMIT_ENABLED` | 开启 | `false` 或 `0` 关闭限流 |
| `RATE_LIMIT_GLOBAL` | `120/60` | 全局限流规格：`<次数>/<秒数>`（未配 Redis 时为单实例内存窗口） |
| `RATE_LIMIT_AUTH` | `10/60` | 认证端点限流规格，同上 |
| `RATE_LIMIT_SKINLIB` | `60/60` | 皮肤库匿名访客限流规格（按 IP 计数，超限触发人机验证） |
| `RATE_LIMIT_SKINLIB_USER` | `300/60` | 皮肤库登录用户限流规格（按账号计数，超限只限速） |
| `SKINLIB_GUARD_ENABLED` | 开启 | 皮肤库反爬守卫总开关，`false`/`0` 关闭（后台「设置 → 安全」同键，DB 值优先） |

### HTTP 与运行

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `APP_URL` | `http://localhost:8787` | 对外访问地址，邮件链接、OAuth 回调、Yggdrasil 元数据依赖它 |
| `ENVIRONMENT` | `production` | 标识当前环境（health 端点会返回该值） |

### 业务配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_SECRET` | — | 会话签名密钥，生产必须设置长随机串 |
| `MFA_ENCRYPTION_KEY` | — | 两步验证敏感字段的加密密钥 |
| `SETUP_TOKEN` | — | 初始化站点时的管理员创建口令（`POST /api/v1/setup`），创建完成后可移除 |
| `LEGACY_SALT` | — | 旧版（PHP 站）密码哈希的 salt，迁移旧用户后保留以支持旧哈希校验 |
| `DERIVATIVES_ENABLED` | `true` | 是否生成衍生图（头像等） |
| `OFFICIAL_CATALOG_ENABLED` | — | 官方材质目录更新开关 |
| `DATA_DIR` | `./data` | 本地状态根：sqlite 缓存库 `cache.db`、DO 状态库 `do-state.db`、file 存储默认落在这里 |
| `DEPLOY_HOOK_URL` / `UPDATE_MANIFEST_URL` | — | Cloudflare 部署钩子与更新清单（Node 部署一般不用） |

### OAuth 提供方

| 变量 | 说明 |
|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth |
| `LITTLESKIN_CLIENT_ID` / `LITTLESKIN_CLIENT_SECRET` / `LITTLESKIN_API_ROOT` | LittleSkin OAuth，API root 指其 Yggdrasil API 根 |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Microsoft OAuth |
| `MOJANG_CLIENT_ID` / `MOJANG_CLIENT_SECRET` | Mojang（Yggdrasil）OAuth |

### Turnstile（验证码）

| 变量 | 默认 | 说明 |
|---|---|---|
| `TURNSTILE_ENABLED` | `false` | 是否启用验证码（站点设置里也可开启，需要两把 key 齐全） |
| `TURNSTILE_SECRET` / `TURNSTILE_SITE_KEY` | — | Cloudflare Turnstile 密钥对 |

### LLM 审核（评论区内容审核）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_MODERATION_DRIVER` | — | `openai` 或 `anthropic`。未配置且无 Workers AI 绑定时审核不启用（新评论直接放行） |
| `OPENAI_API_KEY` | — | `openai` 驱动必填 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 可指向 Ollama、vLLM、OpenRouter 等任何 OpenAI 兼容端点 |
| `OPENAI_MODERATION_MODEL` | `gpt-4o-mini` | 审核模型 |
| `ANTHROPIC_API_KEY` | — | `anthropic` 驱动必填 |
| `ANTHROPIC_MODERATION_MODEL` | `claude-haiku-4-5` | 审核模型 |

Workers AI 驱动（`@cf/meta/llama-guard-3-8b`）只在 Cloudflare 部署可用，见「已知差异」。

### 邮件

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAIL_DRIVER` | `resend` | `resend`（HTTP API）或 `smtp`（直连 SMTP） |
| `MAIL_FROM` | — | 发件人地址（如 `Pigeon Skin <no-reply@example.com>`），未配置视为邮件未启用 |
| `RESEND_API_KEY` | — | resend 驱动必填 |
| `SMTP_HOST` / `SMTP_PORT` | — | smtp 驱动的服务器地址与端口 |
| `SMTP_ENCRYPTION` | `starttls` | `starttls` / `ssl` / `none` |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | — | SMTP 认证（可选，视服务器而定） |

---

## 数据库选型

**SQLite 是默认且完全可用的选型**：零外部依赖，整个数据库就是 `DATA_DIR` 下的一个文件，中小规模皮肤站足够。缓存库（`cache.db`）与 DO 状态库（`do-state.db`）也是同目录的独立 SQLite 文件。

**PG / MySQL**：启动时自动跑迁移——依次执行 `packages/db/migrations-pg/` 或 `migrations-mysql/` 下的 SQL 脚本，并在数据库里的 `d1_migrations` 表记账（迁移文件名为主键），重启时已应用的自动跳过，与 D1 的行为一致。sqlite 方言对应 `packages/db/migrations/`。

**从 Cloudflare（D1）迁移数据**：没有自动迁移工具。可行路径是 `wrangler d1 export` 导出 SQL dump，再手动转换为目标方言（引号、`AUTOINCREMENT`、`DATETIME`、触发器等方言差异逐项处理）后导入 PG/MySQL；导入后本服务的 `d1_migrations` 表需要按已应用的迁移文件名补齐记账，否则下次启动会重放迁移。材料是普通 SQL，过程繁琐但机械；如实评估工作量后再决定是否值得切换方言。

---

## 对象存储

- **file（默认）**：材质按 R2 对象的 key 布局存放在 `STORAGE_PATH` 下，目录即 bucket。适合单机。
- **s3**：任何 S3 兼容后端——Cloudflare R2 的 S3 API、MinIO、阿里云 OSS（S3 兼容端点）、AWS S3 等。R2 示例：

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
S3_BUCKET=pigeon-textures
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

切换驱动不搬运历史数据：换 `STORAGE_DRIVER` 前先自行把旧 `storage/` 目录内容同步到新后端（对象 key 不变即可无缝衔接）。

---

## Redis 可选层

`REDIS_URL` 未配置时，缓存用 `DATA_DIR/cache.db`（SQLite），限流是进程内存窗口，队列落在业务库 `node_jobs` 表轮询消费——单实例部署完全可用，不需要 Redis。

配置 `REDIS_URL` 后三处同时切换：

- **缓存**：会话查找、站点设置等热点读走 Redis；
- **限流**：`RL_GLOBAL` / `RL_AUTH` 计数移到 Redis，多实例共享窗口；
- **队列**：搜索提交、邮件通知改由 Redis List/ZSET 承载，轮询消费。

多实例部署（同一数据库后端 + 负载均衡）**必须**配置 Redis：内存限流在实例间互不可见，SQLite 轮询队列会被多实例重复消费竞争。

定时任务的现状：Workers 部署里 cron 由平台触发一次；Node 部署的 `setInterval` **每个实例都会各自运行**（启动时执行一次、此后每小时）。任务设计为幂等（清理、官方资源同步、sitemap 兜底），多实例同时执行不产生错误数据，但会重复做功——如果在意，只在一个实例上保留定时配置即可（当前没有独立开关，这是如实现状）。

---

## LLM 审核

评论区内容审核支持三个驱动，按 `AI_MODERATION_DRIVER` 选择：

1. `openai`：任意 OpenAI 兼容端点。`OPENAI_BASE_URL` 指向 Ollama（`http://host:11434/v1`）、vLLM、OpenRouter 等即可；
2. `anthropic`：Anthropic Messages API；
3. Workers AI（`@cf/meta/llama-guard-3-8b`）：仅 Cloudflare 部署可用，Node 部署没有 `env.AI` 绑定。

三者都不配置时审核不启用，新评论直接放行。审核开关本身在站点设置（`comments_ai_moderation`）里控制。

---

## 邮件

两个驱动，按 `MAIL_DRIVER` 分发：

- `resend`：Resend HTTP API，配 `RESEND_API_KEY` + `MAIL_FROM`；
- `smtp`：直连任意 SMTP 服务器（Node 上用 `node:net`/`node:tls` socket，不等价于 Worker 的 `cloudflare:sockets` 限制），配 `SMTP_HOST`/`SMTP_PORT` 等。

`MAIL_FROM` 未配置视为邮件未启用，验证邮件、密码重置等功能会静默跳过发送。

---

## 已知差异与限制

与 Cloudflare Workers 部署相比，Node 入口的平台差异如下（业务代码同一份，差异都在平台 shim 层）：

- **Workers AI 不可用**：Node 没有 `env.AI`，AI 审核请配置 LLM 驱动（openai/anthropic）。
- **Workers Logs → 标准输出**：日志走 `console.*` 到 stdout/stderr，由容器/进程管理器收集。
- **限流**：未配 Redis 时是单实例内存窗口，重启清零；配置 Redis 后多实例共享。
- **Durable Objects**：Node 用 SQLite 存储 + 内存实现模拟 DO 语义，是 Workers DO 的子集（alarm、storage 可用；单实例串行语义在同一进程内成立）。业务只用到这一子集，多实例同时挂载同一 `DATA_DIR` 的 `do-state.db` 不受支持。
- **`caches.default`**：Node 侧是本机缓存（SQLite/Redis），不是 Workers 的边缘缓存；纹理响应头的缓存语义不变。
- **队列**：Cloudflare Queues → 本地库轮询或 Redis 轮询，投递语义为至少一次，与 Workers Queues 一致。

---

## 备份

需要备份的状态全部有明确位置：

- **SQLite**：停机窗口内直接复制 `DATA_DIR` 三个 `.db` 文件（`pigeon.db`、`cache.db`、`do-state.db`）；不停机用 `sqlite3 pigeon.db ".backup '/backup/pigeon.db'"` 做一致性快照。加上 `storage/` 目录（file 驱动时）。
- **PostgreSQL / MySQL**：常规 `pg_dump` / `mysqldump`，无特殊要求；`d1_migrations` 表随库一起备份，用于识别迁移进度。
- **storage/ 目录**：材质文件（file 驱动时在 `DATA_DIR/storage`；s3 驱动时归对象存储自身的生命周期管理）。
- 容器部署时以上内容都在挂载卷 `./data` 内，宿主机常规备份即可覆盖。
