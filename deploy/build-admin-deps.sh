#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 构建并推送 admin 的「依赖基座镜像」到 Harbor —— 整套流程里唯一需要外网/代理的构建步骤，
# 而且只在 package.json / yarn.lock 变化时才需要跑一次。
#
# 用法：
#   bash deploy/build-admin-deps.sh                      # 有外网的机器
#   内网机（master-01，走 squid）：
#     DOCKER_BUILD_OPTS="--build-arg HTTP_PROXY=http://<user>:<pass>@10.45.34.223:3128 \
#                        --build-arg HTTPS_PROXY=http://<user>:<pass>@10.45.34.223:3128" \
#       bash deploy/build-admin-deps.sh
#   强制重建（比如基础镜像 node:18-alpine 换了版本）：FORCE=1 bash deploy/build-admin-deps.sh
#
# tag = yarn.lock+package.json 内容哈希（deploy/admin-deps-tag.sh），所以：
#   依赖没变 → 脚本直接跳过；业务镜像 build-push-harbor.sh 会自动引用同一个 tag。
# ---------------------------------------------------------------------------
set -euo pipefail

REGISTRY="${REGISTRY:-10.45.34.167:5000}"
PROJECT="${PROJECT:-datalink}"
SCHEME="${SCHEME:-http}"                         # Harbor 走 https 时改为 https
HARBOR_USER="${HARBOR_USER:-}"
HARBOR_PASS="${HARBOR_PASS:-}"
FORCE="${FORCE:-0}"

cd "$(dirname "$0")/.."
# shellcheck source=./admin-deps-tag.sh
. deploy/admin-deps-tag.sh

TAG="$(admin_deps_tag .)"
REF="$REGISTRY/$PROJECT/admin-deps:$TAG"

tag_exists() {
  local url="$SCHEME://$REGISTRY/v2/$PROJECT/admin-deps/tags/list" out
  if [[ -n "$HARBOR_USER" ]]; then
    out=$(curl -fsSk --connect-timeout 5 -u "$HARBOR_USER:$HARBOR_PASS" "$url" 2>/dev/null || true)
  else
    out=$(curl -fsSk --connect-timeout 5 "$url" 2>/dev/null || true)
  fi
  # 不用数组展开：CentOS7 bash4.2 在 set -u 下 "${arr[@]}" 会报 unbound variable
  echo "$out" | tr -d '[]" \r' | tr ',' '\n' | grep -qx "$TAG"
}

if [[ "$FORCE" != "1" ]] && tag_exists; then
  echo "==> 基座已存在，跳过构建：$REF"
  echo "    （依赖变更或被 prune 需要重建时：FORCE=1 bash deploy/build-admin-deps.sh）"
  exit 0
fi

echo "==> 构建依赖基座 $REF（这一步要能访问 registry.npmmirror.com）"
docker build ${DOCKER_BUILD_OPTS:-} \
  -f node-express-boilerplate/Dockerfile.deps \
  -t "databridge/admin-deps:$TAG" \
  node-express-boilerplate

if [[ -n "$HARBOR_USER" ]]; then
  echo "$HARBOR_PASS" | docker login "$REGISTRY" -u "$HARBOR_USER" --password-stdin
fi

docker tag "databridge/admin-deps:$TAG" "$REF"
docker tag "databridge/admin-deps:$TAG" "$REGISTRY/$PROJECT/admin-deps:latest"
echo "==> 推送 $REF"
docker push "$REF"
docker push "$REGISTRY/$PROJECT/admin-deps:latest"

echo
echo "==> 完成。以后 admin 业务镜像构建零网络：bash deploy/build-push-harbor.sh v<N>"
