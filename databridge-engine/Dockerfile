# syntax=docker/dockerfile:1

# ---------- Build stage ----------
FROM golang:1.24-alpine AS builder

WORKDIR /src

RUN apk add --no-cache ca-certificates tzdata

ENV CGO_ENABLED=0 \
    GOOS=linux \
    GO111MODULE=on \
    GOPROXY=https://goproxy.cn,direct

# 依赖层与源码层分开，保证 go.mod/go.sum 未变时命中缓存
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# 入口在 cmd/server（Nunu advanced 布局）；Version 由 internal/handler.Version 接收
ARG VERSION=0.1.0-mock
RUN go build -trimpath -ldflags="-s -w -X databridge-engine/internal/handler.Version=${VERSION}" \
    -o /out/databridge-engine ./cmd/server

# ---------- Runtime stage ----------
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata wget \
    && adduser -D -u 10001 app

WORKDIR /app
COPY --from=builder /out/databridge-engine /app/databridge-engine
# 配置随镜像发布（容器内不挂卷）：ENTRYPOINT 用 config/prod.yml，监听 0.0.0.0:8080
COPY --from=builder /src/config/prod.yml /app/config/prod.yml

USER app

# 契约默认端口与环境变量（docs/API.md 第 4 节；覆盖 yml 同名键，见 pkg/config/env.go）
ENV SERVER_PORT=8080 \
    GIN_MODE=release \
    NODE_REPORT_URL=http://databridge-admin:3001/api/v1/engine \
    MOCK_TICK_MS=1000

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${SERVER_PORT}/health" || exit 1

ENTRYPOINT ["/app/databridge-engine", "-conf", "config/prod.yml"]
