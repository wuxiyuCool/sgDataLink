# ---------- 阶段一：构建前端静态资源 ----------
FROM node:18-alpine AS builder

WORKDIR /app

# pnpm-lock.yaml 为 lockfileVersion 5.4（pnpm 7），镜像构建时安装依赖
RUN npm install -g pnpm@7.33.7

# 依赖层单独缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile --prefer-offline

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
