# 多阶段构建：build 阶段完整构建前端 + API bundle，运行阶段只带运行必需品。
#
# Blockbench 子模块说明：apps/web 的 prebuild（scripts/build-blockbench.mjs）
# 从 vendor/blockbench（git submodule，GPL-3.0-or-later）构建皮肤编辑器，
# 并用 git 读取 gitlink 记录与子模块 HEAD 做固定版本校验，因此 build 阶段
# 需要 git 二进制与仓库的 .git。克隆时需要：
#   git clone --recurse-submodules https://github.com/Pigeon-Server/PigeonSkin-Server.git
# 或对已有克隆补一次：git submodule update --init
# 缺少 vendor/blockbench 时 docker build 会在 build 阶段报错并给出提示。

# ── 构建阶段 ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

# build-blockbench.mjs 依赖 git（子模块版本校验与源码归档）
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

# 网络抖动重试（ENV 会被子脚本里的嵌套 npm 调用继承，含 blockbench 缓存目录的 npm ci）
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_TIMEOUT=120000

WORKDIR /src

# 精确复制依赖清单，最大化利用层缓存
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/minecraft/package.json packages/minecraft/
COPY packages/shared/package.json packages/shared/
COPY tools/migrate/package.json tools/migrate/
COPY tools/cli/package.json tools/cli/
# --ignore-scripts：esbuild 的 postinstall 版本校验在容器 overlayfs 上有
# ETXTBSY 竞态（下载二进制后立即 exec）。平台二进制包（@esbuild/linux-arm64）
# 本身由可选依赖正常安装，esbuild 的 JS shim 运行时解析它，构建不受影响；
# 其余被跳过的 postinstall（wrangler/workerd 等）在镜像内不会执行。
RUN npm ci --ignore-scripts

# 源码：业务包 + 前端 + 构建脚本。vendor/ 是 blockbench 子模块（见文件头注释）；
# .git 仅供 build-blockbench 的子模块版本校验，不进运行镜像
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY tools/ tools/
COPY apps/ apps/
COPY vendor/ vendor/
COPY .git/ .git/

# 前端（vue-tsc + vite，含 blockbench 与第三方许可清单）与 API bundle
RUN npm run build && npm run build:node --workspace @pigeon-skin/api

# ── 运行阶段 ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

# 运行时依赖：bundle 已内联全部业务依赖（hono/jose/zod/postgres/mysql2/
# linkedom/aws4fetch 等），唯一 external 的运行时 npm 包是 ioredis（懒加载，
# 配置 REDIS_URL 才 import）。单独安装它，不复制 monorepo 的 node_modules。
RUN npm init -y >/dev/null \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund ioredis@^6 \
 && npm cache clean --force

# bundle 产物、前端静态资源、迁移 SQL（migrate.ts 按 PIGEON_ROOT/packages/db/migrations* 探测）
COPY --from=build /src/apps/api/dist-node/ dist-node/
COPY --from=build /src/apps/web/dist/ web/dist/
COPY --from=build /src/packages/db/migrations/ packages/db/migrations/
COPY --from=build /src/packages/db/migrations-pg/ packages/db/migrations-pg/
COPY --from=build /src/packages/db/migrations-mysql/ packages/db/migrations-mysql/

# 非 root 运行；数据目录挂载点归 node(uid/gid 1000)
RUN chown -R node:node /app
USER node

# 默认值：sqlite 零依赖即可运行；生产部署务必显式设置 SESSION_SECRET 与
# APP_URL（https；默认 http 地址仅在 ENVIRONMENT=development 下可用）
ENV NODE_ENV=production \
    PIGEON_ROOT=/app \
    DB_DRIVER=sqlite \
    DATABASE_PATH=/app/data/pigeon.db \
    DATA_DIR=/app/data \
    STORAGE_DRIVER=file \
    STORAGE_PATH=/app/data/storage \
    ASSETS_DIR=/app/web/dist \
    APP_URL=http://localhost:8787 \
    PORT=8787 \
    HOST=0.0.0.0

VOLUME /app/data
EXPOSE 8787

# node:22-slim 无 curl：用内置 fetch 探活（health 端点会真实执行 SELECT 1）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/v1/health').then(r => r.json()).then(j => process.exit(j.ok ? 0 : 1)).catch(() => process.exit(1))"]

# 启动时自动跑数据库迁移（apps/api/src/node/runtime.ts），再监听 HTTP
CMD ["node", "dist-node/entry.mjs"]
