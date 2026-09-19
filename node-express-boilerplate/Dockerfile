# ---------------------------------------------------------------------------
# DataBridge 管理后端 —— mock 版镜像（内存存储，不依赖任何数据库）
# 构建：docker build -t databridge-admin:mock .
# 运行：docker run -p 3001:3001 databridge-admin:mock
# 镜像内允许 yarn install；本地开发请自行安装依赖后 yarn dev（见 README）。
# ---------------------------------------------------------------------------
FROM node:18-alpine

# 契约要求：Node >= 18（engineClient 使用全局 fetch）
ENV NODE_ENV=production \
    MEM_MOCK=true \
    PORT=3001

WORKDIR /usr/src/node-app

# 先只拷依赖清单，利用层缓存。
# --ignore-scripts：跳过 prepare(husky) 等脚本；本项目运行时依赖全是纯 JS，无 native 编译。
COPY package.json yarn.lock ./

RUN yarn install --production --non-interactive --frozen-lockfile --ignore-scripts \
  && yarn cache clean

# 再拷源码（.dockerignore 已排除 node_modules / tests / .env）
COPY . .

RUN chown -R node:node /usr/src/node-app
USER node

EXPOSE 3001

# 探针走契约里的健康检查接口
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/v1/health || exit 1

CMD ["node", "src/index.js"]
