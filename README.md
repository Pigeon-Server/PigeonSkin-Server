# Pigeon Skin Server

Pigeon Skin Server 是专为 Minecraft 玩家、服主与创作者打造的现代化开源皮肤站。它完整承接了经典 Blessing Skin Server 的核心业务与游戏加载逻辑，并借助 Cloudflare Workers、D1 与 R2 等边缘 Serverless 基础设施进行全栈重写。

无论你是想为几位联机好友搭建一个免受服务器运维困扰的换装小站，还是面向更多玩家建立开放的皮肤分享社区，Pigeon Skin Server 都希望为你提供更轻盈、顺畅且开箱即用的体验。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Pigeon-Server/PigeonSkin-Server)

点击按钮后，Cloudflare 会将仓库克隆到你自己的 GitHub 账号，读取 `apps/api/wrangler.jsonc` 引导你创建 D1、R2、Queues 等所需资源并完成首次部署。本项目为 monorepo，如果向导中预填的构建与部署命令不符合预期，请将根目录设为 `apps/api` 并按[部署上线](#部署上线)一节的命令调整。

首次部署完成后，还需依次完成：

1. 在 Worker 的构建设置或部署命令中对 D1 应用 `packages/db/migrations` 迁移（等同 `npm run db:migrate:prod`）；
2. 按下文[配置说明](#配置说明)设置 `APP_URL`，并写入 `SETUP_TOKEN`、`SESSION_SECRET`、`MFA_ENCRYPTION_KEY` 等机密；
3. 访问站点的 `/setup` 路径，输入 `SETUP_TOKEN` 完成管理员初始化。

## 核心特性

- **直观的材质呈现与衣柜管理**：支持高精度 3D 动态实时预览，无缝兼容双层皮肤（Alex 纤细手部 / Steve 经典手部）与高清披风。支持多角色灵活切换，兼顾公开材质分享与私密材质安全。
- **开箱即用的在线 3D 编辑**：深度裁剪并集成 Blockbench Web 引擎，无需离开浏览器即可快速修补像素、绘制新衣并一键保存到衣柜。
- **完善的游戏协议与外置登录**：原生提供 CustomSkinLoader (CSL) 适配接口，支持 Yggdrasil / Authlib-Injector 外置登录规范，轻松对接各类客户端与启动器。
- **免运维的 Serverless 架构**：全栈依托 Cloudflare Workers、D1 (SQL)、R2 (对象存储)、Queues 与 Durable Objects，全球边缘就近分发，告别传统 VPS 维护与停机顾虑。
- **多语言与国际化**：内置简体中文（`zh_CN`）、繁体中文（`zh_TW`）、英语（`en`）、西班牙语（`es_ES`）、俄语（`ru_RU`）与日语（`ja_JP`），适应多元社区环境。
- **现代安全与平滑迁移**：支持 Passkey（WebAuthn）通行密钥、两步验证（MFA）与主流 OAuth（GitHub、Microsoft / Xbox）快捷登录；提供完善的旧版 Blessing Skin 数据迁移核对工具，妥善保留玩家的历史角色与资产。

## 技术栈与代码组织

本项目采用 Monorepo 组织，各模块职责清晰独立：

| 模块路径 | 职责与技术选型 |
|---|---|
| `apps/web` | 现代化前端单页应用：Vue 3、Vite、Pinia、Vue I18n、Vuetify 组件库、Tailwind CSS、Material Design Icons |
| `apps/api` | 边缘 API 与路由网关：Hono、Cloudflare Workers、D1 关系型数据库、R2 对象存储、消息队列 |
| `packages/auth` | 认证与安全原语：WebCrypto 标准加密、令牌校验与旧站密码兼容支持 |
| `packages/db` | 数据持久层：Drizzle ORM schema 定义与 D1 迁移脚本 |
| `packages/minecraft` | Minecraft 领域逻辑：皮肤/披风 PNG 维度与透明通道校验、纹理渲染与协议组装 |
| `packages/shared` | 前后端共享类型、校验规则、多语言词典（`locales`）与公共目录 |
| `tools/migrate` | 旧版 Blessing Skin PHP 数据库与材质文件的分析、迁移与数据校验 CLI |
| `vendor/blockbench` | 固定版本的 Blockbench 子模块，遵循 GPL 规范独立沙箱构建与通信 |

前端静态产物由 Worker 的 assets 绑定同源托管，无需单独部署 Pages 服务。D1 保存结构化元数据，R2 保存纹理与上传文件，Queues 异步处理邮件通知与搜索引擎提交。

## 快速上手

### 1. 环境准备

开始前，请确保本地已安装：
- **Node.js** `>= 22.18`（建议使用受支持的 LTS 版本）
- **npm** `>= 10`（CI 使用 `package.json` 中声明的版本）
- **Git** 与 **tar**

### 2. 本地开发与体验

克隆仓库并初始化子模块（包含在线编辑器依赖）：

```sh
# 克隆仓库（需包含子模块）
git clone --recurse-submodules https://github.com/Pigeon-Server/PigeonSkin-Server.git
cd PigeonSkin-Server

# 若已有克隆，可通过此命令补全子模块
git submodule update --init --recursive

# 安装项目依赖
npm ci

# 初始化本地环境配置与数据库
npm run setup:local
npm run db:migrate:local

# 预构建前端产物
npm run build --workspace @pigeon-skin/web

# 启动本地开发服务
npm run dev
```

启动完成后：
- 前端页面：`http://localhost:5173`
- Worker API：`http://localhost:8787`（前端开发服务器会自动将 API 和游戏接口代理至 Worker）
- 初次初始化：访问 `http://localhost:5173/setup`，输入 `apps/api/.dev.vars` 中生成的 `SETUP_TOKEN` 即可创建首个管理员。
- 演示数据：如需快速预览界面效果，可运行 `npm run db:seed:local` 创建演示账号与角色（仅供本地测试，切勿导入生产数据库）。

本地环境下的 D1、R2、队列与 Durable Objects 均由 Wrangler 本地模拟，无需 Cloudflare 账号即可直接调试。

启动前请退出已运行的开发进程。若单独启动前端并连接其他 API 地址，可通过 `API_TARGET` 指定代理目标。

## 配置说明

本地 Worker 配置可参考 `apps/api/.dev.vars.example`。生产环境建议通过 `wrangler secret put <KEY>` 写入敏感凭据，请勿将真实机密写入公开配置文件。

| 环境变量 | 必选 | 说明与建议 |
|---|:---:|---|
| `APP_URL` | 是 | 站点的公开 HTTPS 地址（不含尾部斜杠，如 `https://skin.example.com`） |
| `SESSION_SECRET` | 是 | 会话签名与验证使用的随机密钥 |
| `MFA_ENCRYPTION_KEY` | 是 | 两步验证（MFA）加密密钥（32 字节随机值的 base64url 编码，需妥善留存） |
| `SETUP_TOKEN` | 初始 | 首次管理员安装凭证，初始化完成后建议在后台或密钥中清除 |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | 否 | Cloudflare Turnstile 人机验证凭据，用于保护注册与登录接口 |
| `RESEND_API_KEY` | 否 | 邮件服务凭证，用于发送验证邮件与找回密码 |
| `GITHUB_*` / `MICROSOFT_*` / `MOJANG_*` | 否 | 对应平台的第三方 OAuth 或正版验证应用凭据 |
| `LEGACY_SALT` | 否 | 旧站密码兼容盐值（仅用于自旧版 Blessing Skin 迁移过渡） |

除基础环境变量外，站点名称、备案号、注册策略、默认角色等业务设置均可在搭建完成后直接在**管理后台**进行可视化配置。

如需使用自动化发布脚本，可参考 `.env.example` 配置部署参数，并通过 `node --env-file=.env tools/cloudflare.mjs <preview|production> configure` 绑定资源。

## 部署上线

Pigeon Skin Server 原生适配 Cloudflare 基础设施。如果想跳过手动配置，可直接使用顶部的[一键部署](#一键部署)按钮。常见部署流程如下：

1. **创建 Cloudflare 资源**  
   在 Cloudflare 控制台创建对应的 D1 数据库、R2 存储桶（存放玩家上传的皮肤与材质）以及异步处理队列。

2. **准备部署参数**  
   参考 `.env.example` 设定目标环境的环境变量，包括 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 以及 D1/R2 的资源配置。

3. **执行迁移与发布**  
   ```sh
   # 运行发布前合规检查
   npm run check:public

   # 构建前端与编辑器静态产物
   npm run build --workspace @pigeon-skin/web

   # 应用生产环境数据库迁移
   npm run db:migrate:prod

   # 部署至 Cloudflare Workers
   npm run deploy:prod
   ```

4. 部署完成后，访问站点的 `/setup` 路径，输入先前配置的 `SETUP_TOKEN`，即可完成站点的首次初始化。

## 管理 CLI

`tools/cli` 提供运维命令：用户管理、材质批量导入导出、核心业务表备份、站点设置读写。所有数据操作通过 wrangler 执行（不自行持有 Cloudflare 凭据），生产环境需先 `wrangler login`。注意：CLI 直写数据库，不受应用层 admin API 权限模型约束，属运维级操作。

```sh
# 查看 help
npm run cli

# 创建用户（--generate-password 生成随机密码并打印一次）
npm run cli -- users create --email op@example.com --generate-password --role admin

# 批量导入皮肤/披风 PNG（校验、按 sha256 上传 R2、写 textures 元数据，不扣积分）
npm run cli -- textures import --dir ./skins --kind skin --uploader admin@example.com
# 批量导入推荐走站点管理端点（warm 连接并发，比 wrangler 通道快约两个数量级）：
#   管理界面「Pigeon API」签发密钥并勾选「批量导入纹理」权限后加 --api-key，
#   生产环境配套 --site-url；本地开发默认打 http://127.0.0.1:8787

# 导出材质（PNG + manifest.json，可直接作为 import --manifest 输入）
npm run cli -- textures export --out ./textures-backup

# 核心业务表备份（users/players/closet/textures 等 JSON，含密码哈希，注意保管）
npm run cli -- data export --out ./backup
npm run cli -- data import --from ./backup --yes   # 跳过式合并，已存在行不改动

# 旧 Blessing Skin（PHP 版）一条命令迁移：自动发现 .env（MySQL）或 *.sql dump
npm run cli -- legacy analyze --dir /path/to/old-blessing-skin
npm run cli -- legacy migrate --dir /path/to/old-blessing-skin                    # → 本地开发库
npm run cli -- legacy migrate --dir /path/to/old-blessing-skin --env production \
  --yes --site-url https://skin.example.com                                       # → 未初始化的生产站点
# dump 快照（如 phpMyAdmin 导出的 .sql）模式：无 .env 时需 --pwd-method 指定旧站密码算法

# 站点设置读写（键白名单见 apps/api/src/env.ts 的 SETTING_DEFAULTS）
npm run cli -- settings set --key site_name --value "我的皮肤站"
```

全局选项：`--env production` 操作生产库（此时写操作必须加 `--yes`）、`--json` 供脚本消费。详细用法见 `npm run cli` 输出。

## 管理级 API

站点暴露 machine-facing 的管理 API（`/api/v1/pigeon/admin/*`），供 CLI、监控与自动化集成。鉴权使用管理界面「Pigeon API」签发的 API key（`api-key` 请求头），按 scope 授权：

| scope | 能力 |
|---|---|
| `players.read` / `users.read` / `users.email` | 游戏协议查询（`/api/ps-api/*`） |
| `admin.texture.import` | 批量导入纹理（`POST /api/v1/pigeon/admin/import/textures`） |
| `admin.users.write` | 用户创建/查询/修改/删除/重置密码/吊销会话 |
| `admin.textures.write` | 纹理查询/改名/可见性/删除 |
| `admin.stats.read` | 站点统计与审计日志查询 |
| `admin.settings.write` | 站点设置读写与广播通知（secret 键只显示占位符，superAdminOnly 键不可见不可写） |

所有端点按 key 限流（默认 60 次/30 秒，`pigeon_api_window_seconds` / `pigeon_api_request_limit` 可调）。管理端点要求 key 签发者当前至少为 admin（实时检查：签发者被降级或封禁后其 key 即失效）。用户/纹理操作的审计 actor 记 key 签发者；设置与广播记为系统操作并在 detail 附 key 标识。CLI 的 `users`、`settings`、`textures import` 命令支持 `--api-key` 走这些端点，缺省回落 wrangler 直连通道。

## 游戏加载接口

Pigeon Skin Server 原生支持 Minecraft 社区常用接口标准，客户端与模组可直接读取：

```text
GET /{player}.json          # 标准 JSON 角色材质配置
GET /csl/{player}.json      # CustomSkinLoader (CSL) 专用适配格式
GET /textures/{hash}        # 原始皮肤与披风材质文件
GET /csl/textures/{hash}    # CSL 纹理路由
```

- **隐私保护策略**：私密材质不会在公开皮肤库中露出，但已经装备到角色的私密材质依然可以通过游戏接口正常匿名加载，确保游戏内的显示连贯不受影响。
- **外置登录认证**：站点支持标准 Yggdrasil / Authlib-Injector 规范，详细接入说明与客户端配置可在站内用户手册中查阅。

## 参与贡献与社区

开源因每一位开发者的参与而更有生命力。无论你是提出优化建议、报告缺陷、改善多语言翻译，还是提交功能代码，都非常欢迎加入共建。

提交前请确认本地检查均已通过：

```sh
npm run typecheck            # TypeScript 类型检查
npm test                 # 自动化测试套件
npm run lint                 # 代码规范检查
npm run check:public         # 公开文件与敏感信息检查
```

开发约定与提交规范请参阅 [贡献指南 (CONTRIBUTING.md)](CONTRIBUTING.md)。

## 致敬与鸣谢

Pigeon Skin Server 的诞生与成长离不开开源社区中众多先行者的启发与支持，在此致以由衷的感谢：

- **[Blessing Skin Server](https://github.com/bs-community/blessing-skin-server)**：感谢原作者与社区贡献者们多年的深耕，确立了经典的业务模型与中文 Minecraft 换肤社区生态。
- **[Blockbench](https://www.blockbench.net/)**：感谢 JannisX11 及 Blockbench 团队为社区提供如此强大的 3D 建模与材质绘制工具，让网页端在线创作成为可能。
- **[CustomSkinLoader](https://github.com/xfl03/MCCustomSkinLoader)**：感谢 xfl03 及模组维护团队，为无数 Minecraft 玩家自由展现个性形象铺平了道路。
- **开源生态与社区伙伴**：感谢 Cloudflare、Vue、Vite、Hono 等优秀开源项目，以及每一位提供反馈、参与测试与完善翻译的社区伙伴。

## 许可证与安全

- 本项目自有代码采用 [Apache-2.0 许可证](LICENSE) 发布。
- 继承的 Blessing Skin 业务逻辑与纹理渲染算法保留原作者的 [MIT 许可证](licenses/BlessingSkin-MIT.txt)。
- 内置 Blockbench 编辑器组件遵循其原生的 [GPL-3.0-or-later 许可证](https://github.com/JannisX11/blockbench/blob/master/LICENSE.md)。
- 更多第三方依赖与资源授权信息请参阅 [NOTICE](NOTICE) 及 [第三方说明文档 (docs/THIRD_PARTY.md)](docs/THIRD_PARTY.md)。
- 如发现安全相关缺陷，请勿公开提交 Issue，请依照 [安全政策 (SECURITY.md)](SECURITY.md) 中的指引通过私密渠道反馈，感谢你的守护。
