#!/usr/bin/env bash
# 构建三个镜像并推送到 Harbor（10.45.34.167:5000/datalink）
# 版本号：默认自动递增 v1 -> v2 -> v3 ...；也可显式指定：
#   bash deploy/build-push-harbor.sh v5        （写 v5 或 5 都行）
#   VERSION=v5 bash deploy/build-push-harbor.sh
# 可覆盖：REGISTRY / PROJECT / ONLY=admin,engine,web / SKIP_BUILD=1（跳过构建，推已有本地镜像）
# 本地免密机器无需任何账号变量；需要认证的 Harbor 才设 HARBOR_USER/HARBOR_PASS
set -euo pipefail

REGISTRY="${REGISTRY:-10.45.34.167:5000}"
PROJECT="${PROJECT:-datalink}"
SCHEME="${SCHEME:-http}"                         # Harbor 走 https 时改为 https
HARBOR_USER="${HARBOR_USER:-}"
HARBOR_PASS="${HARBOR_PASS:-}"
ONLY="${ONLY:-admin,engine,web}"
SKIP_BUILD="${SKIP_BUILD:-0}"

cd "$(dirname "$0")/.."

src_image() { echo "databridge/$1:mock"; }       # 本地构建产出的镜像名（compose 同款）
ctx_dir() {
  case "$1" in
    admin) echo ./node-express-boilerplate ;;
    engine) echo ./databridge-engine ;;
    web) echo ./vue-vben-admin ;;
  esac
}

curl_tags() {
  local repo="$1" auth=()
  [[ -n "$HARBOR_USER" ]] && auth=(-u "$HARBOR_USER:$HARBOR_PASS")
  curl -fsSk --connect-timeout 5 "${auth[@]}" \
    "$SCHEME://$REGISTRY/v2/$PROJECT/$repo/tags/list" 2>/dev/null || true
}

# 版本确定：显式参数优先；否则取三个仓库现有 v<N> tag 最大值 +1，查不到再回退本地记录
VERSION="${1:-${VERSION:-}}"
if [[ -n "$VERSION" ]]; then
  [[ "$VERSION" =~ ^[0-9]+$ ]] && VERSION="v$VERSION"
  if [[ ! "$VERSION" =~ ^v[0-9]+$ ]]; then
    echo "!! 版本号不合法: '$VERSION'（应为 v5 或 5 这种整数版本）" >&2
    exit 1
  fi
  echo "==> 使用指定版本: $VERSION"
else
  max_v=$(
    for s in admin engine web; do
      curl_tags "$s" | tr -d '[]"' | tr ',' '\n' | grep -E '^v[0-9]+$' | tr -d 'v' || true
    done | sort -n | tail -1
  )
  if [[ -z "$max_v" ]]; then
    if [[ -f deploy/.harbor-version ]]; then
      max_v=$(cat deploy/.harbor-version)
    else
      max_v=0
      echo "!! 无法访问 $REGISTRY 的 tag 列表，从 v1 开始（如已有历史版本请手动核对）"
    fi
  fi
  VERSION="v$((max_v + 1))"
  echo "==> 自动递增版本: $VERSION"
fi

if [[ -n "$HARBOR_USER" ]]; then
  echo "$HARBOR_PASS" | docker login "$REGISTRY" -u "$HARBOR_USER" --password-stdin
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

echo "$VERSION" | tr -d 'v' > deploy/.harbor-version

# 同步 kustomization.yaml 的 newTag，保证 kubectl apply -k 与刚推的版本一致
sed -i -E "s|(newTag: )v[0-9]+|\\1$VERSION|" deploy/k8s/kustomization.yaml

echo
echo "==> 完成 $VERSION。更新集群二选一："
echo "  A) 在有清单的机器: kubectl apply -k deploy/k8s/"
for s in admin engine web; do
  echo "  kubectl -n databridge set image deploy/databridge-$s $s=$REGISTRY/$PROJECT/$s:$VERSION"
done
