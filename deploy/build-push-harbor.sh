#!/usr/bin/env bash
# 一键构建三个镜像并推送到 Harbor，版本号自动递增（v1.0.0 -> v1.0.1 ...）
# 用法（在仓库根目录执行）：
#   HARBOR_USER=admin HARBOR_PASS=xxx bash deploy/build-push-harbor.sh
# 可覆盖：REGISTRY / PROJECT / ONLY=admin,engine,web / SKIP_BUILD=1（只推已构建镜像）
set -euo pipefail

REGISTRY="${REGISTRY:-10.45.34.165:5000}"
PROJECT="${PROJECT:-databridge}"                 # Harbor 项目名，不存在需先在 UI 创建
SCHEME="${SCHEME:-http}"                         # Harbor 走 https 时改为 https
HARBOR_USER="${HARBOR_USER:-}"
HARBOR_PASS="${HARBOR_PASS:-}"
ONLY="${ONLY:-admin,engine,web}"
SKIP_BUILD="${SKIP_BUILD:-0}"

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

# 本地镜像名 -> Harbor 镜像名 的映射（compose/Dockerfile 在各自子目录）
src_image() { echo "databridge/$1:mock"; }
ctx_dir() {
  case "$1" in
    admin) echo ./node-express-boilerplate ;;
    engine) echo ./databridge-engine ;;
    web) echo ./vue-vben-admin ;;
  esac
}

curl_tags() {
  local repo="$1" url auth=()
  url="$SCHEME://$REGISTRY/v2/$PROJECT/$repo/tags/list"
  [[ -n "$HARBOR_USER" ]] && auth=(-u "$HARBOR_USER:$HARBOR_PASS")
  curl -fsSk --connect-timeout 5 "${auth[@]}" "$url" 2>/dev/null || true
}

# 取三个仓库现有 tag 的最大值，patch +1；无历史则从 v1.0.0 开始
max_tag=$(
  for s in admin engine web; do
    curl_tags "$s" | tr -d '[]"' | tr ',' '\n' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true
  done | sort -V | tail -1
)
if [[ -z "$max_tag" ]]; then
  VERSION="v1.0.0"
else
  IFS=. read -r maj min pat <<<"${max_tag#v}"
  VERSION="v$maj.$min.$((pat + 1))"
fi
echo "==> 本次版本: $REGISTRY/$PROJECT/*:$VERSION"

# 登录（push 必需；仅 API 查询用不到）
if [[ -n "$HARBOR_USER" ]]; then
  echo "$HARBOR_PASS" | docker login "$REGISTRY" -u "$HARBOR_USER" --password-stdin
else
  docker login "$REGISTRY"   # 交互式，或提前手动 login 后重跑
fi

IFS=',' read -ra SERVICES <<<"$ONLY"
for s in "${SERVICES[@]}"; do
  if [[ "$SKIP_BUILD" != "1" ]]; then
    echo "==> 构建 $s ($(ctx_dir "$s"))"
    docker build -t "$(src_image "$s")" "$(ctx_dir "$s")"
  fi
  docker tag "$(src_image "$s")" "$REGISTRY/$PROJECT/$s:$VERSION"
  docker tag "$(src_image "$s")" "$REGISTRY/$PROJECT/$s:latest"
  echo "==> 推送 $REGISTRY/$PROJECT/$s:$VERSION"
  docker push "$REGISTRY/$PROJECT/$s:$VERSION"
  docker push "$REGISTRY/$PROJECT/$s:latest"
done

# 同步 kustomization.yaml 里的 newTag，保证 kubectl apply -k 拉的是刚推的版本
# （images 块里只有 newTag 一处 vX.Y.Z，直接整文件替换）
sed -i -E "s|(newTag: )v[0-9.]+|\\1$VERSION|" deploy/k8s/kustomization.yaml

echo
echo "==> 完成。后续步骤："
echo "  1) 把 deploy/k8s/ 同步到 master 节点后: kubectl apply -k deploy/k8s/"
echo "  2) 或直接在有 kubectl 的机器执行:"
for s in "${SERVICES[@]}"; do
  echo "     kubectl -n databridge set image deploy/databridge-$s $s=$REGISTRY/$PROJECT/$s:$VERSION"
done
echo "  3) 校验: kubectl -n databridge rollout status deploy/databridge-admin"
