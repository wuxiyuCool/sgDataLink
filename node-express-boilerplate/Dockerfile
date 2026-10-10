# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# DataBridge 管理后端（Node admin）
#
# 依赖不再在本镜像里 yarn install，而是从「依赖基座镜像」整份 COPY node_modules：
#   基座 = node-express-boilerplate/Dockerfile.deps，tag 取 yarn.lock 内容哈希，
#   构建/推送 = bash deploy/build-admin-deps.sh（只在依赖变更时需要外网/代理）。
# 这样业务镜像构建完全离线、秒级，且代理账号不会留在镜像 history 里。
#
# 本地/有外网机器想一步到位也可以直接构建基座：
#   docker build -f Dockerfile.deps -t databridge/admin-deps:<tag> .
# ---------------------------------------------------------------------------
ARG DEPS_IMAGE=10.45.34.167:5000/datalink/admin-deps:latest

FROM ${DEPS_IMAGE} AS deps

FROM node:18-alpine

# 契约要求：Node >= 18（engineClient 使用全局 fetch）
ENV NODE_ENV=production \
    MEM_MOCK=true \
    PORT=3001

WORKDIR /usr/src/node-app

# 依赖层：来自基座镜像，无网络
COPY --from=deps /usr/src/node-app/node_modules ./node_modules
COPY package.json ./

# 再拷源码（.dockerignore 已排除 node_modules / tests / .env）
COPY . .

RUN chown -R node:node /usr/src/node-app
USER node

EXPOSE 3001

# 探针走契约里的健康检查接口
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/v1/health || exit 1

CMD ["node", "src/index.js"]
