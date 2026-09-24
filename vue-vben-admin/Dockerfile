# ---------- 阶段一：构建前端静态资源 ----------
FROM node:18-alpine AS builder

WORKDIR /app

# 国内构建走 npmmirror（内网实测 0.2s，npmjs 本家 1.1s+ 且经代理易超时）；npm/pnpm/yarn 均认这个变量
ENV npm_config_registry=https://registry.npmmirror.com

# pnpm-lock.yaml 为 lockfileVersion 9.0（本地 pnpm 12 生成），需 pnpm >=9 才能命中锁文件
RUN npm install -g pnpm@9

# 依赖层单独缓存
# 低并发+多重试：经 squid 代理时 pnpm 默认 16 并发会耗尽连接导致 meta 请求 60s 超时
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile --prefer-offline \
    --network-concurrency 4 --fetch-retries 5 --fetch-retry-maxtimeout 30000

COPY . .

# 构建期可覆盖的接口前缀（prod 下由 nginx location /api/ 代理到管理后端）
ARG VITE_GLOB_DATABRIDGE_API_URL=/api/v1
ENV VITE_GLOB_DATABRIDGE_API_URL=${VITE_GLOB_DATABRIDGE_API_URL}
# imagemin/bin-wrapper 在 alpine 上需要额外系统库，容器构建时关闭图片压缩
ENV VITE_USE_IMAGEMIN=false
# 保留 vben 内置 mock（登录/用户信息接口由 mock 提供，见 mock/sys/user.ts）
ENV VITE_USE_MOCK=true

RUN pnpm run build

# ---------- 阶段二：nginx 托管静态资源 + 反向代理 ----------
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY build/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
