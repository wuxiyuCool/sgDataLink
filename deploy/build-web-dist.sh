#!/usr/bin/env bash
# 本地（Windows Git Bash / 任意开发机）一条命令：构建前端 -> 产物打成 tar 包入 git
# 用法：bash deploy/build-web-dist.sh
# 之后 git add -f deploy/web-dist/web-dist.tar.gz && git commit && git push
# 服务器端无需 scp：git pull 后 ONLY=web PREBUILT_WEB=1 bash deploy/build-push-harbor.sh 会自动解压
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(pwd)

echo "==> pnpm build（VITE_USE_IMAGEMIN=false，与 Dockerfile 参数一致）"
cd vue-vben-admin
VITE_USE_IMAGEMIN=false pnpm build

echo "==> 打包 dist -> deploy/web-dist/web-dist.tar.gz"
mkdir -p "$REPO/deploy/web-dist"
tar czf "$REPO/deploy/web-dist/web-dist.tar.gz" -C dist .
ls -la "$REPO/deploy/web-dist/web-dist.tar.gz"

echo
echo "==> 完成。提交分发："
echo "  cd $REPO && git add -f deploy/web-dist/web-dist.tar.gz && git commit -m 'release: web dist 产物更新' && git push"
