#!/usr/bin/env bash
# DataBridge 镜像打包/推送脚本（Harbor: 10.45.34.167:5000/datalink），版本 v<N> 递增
#
# 三种模式（MODE 环境变量，默认 push）：
#   push —— 机器有 docker 且能拉基础镜像/外网源：直接构建并推送
#            bash deploy/build-push-harbor.sh            # 自动递增
#            bash deploy/build-push-harbor.sh v5         # 指定版本
#   save —— 外网构建机：构建并导出 tar.gz（产物默认 /opt/dataLink/v<N>/）
#            MODE=save bash deploy/build-push-harbor.sh v5
#   load —— 内网机（无外网）：读 tar.gz 并推送 Harbor（你原来的手工流程）
#            MODE=load bash deploy/build-push-harbor.sh v5 [tar包目录，默认 /opt/dataLink/v5]
#
# 可覆盖：REGISTRY / PROJECT / ONLY=admin,engine,web / SKIP_BUILD=1(push 模式跳过构建)
#         OUT_DIR(save 输出目录) / SRC_DIR(load 输入目录)
# 内网 Harbor 免密机器无需账号变量；需要认证才设 HARBOR_USER/HARBOR_PASS
set -euo pipefail

REGISTRY="${REGISTRY:-10.45.34.167:5000}"
PROJECT="${PROJECT:-datalink}"
SCHEME="${SCHEME:-http}"                         # Harbor 走 https 时改为 https
HARBOR_USER="${HARBOR_USER:-}"
HARBOR_PASS="${HARBOR_PASS:-}"
ONLY="${ONLY:-admin,engine,web}"
SKIP_BUILD="${SKIP_BUILD:-0}"
MODE="${MODE:-push}"

cd "$(dirname "$0")/.."

ctx_dir() {
  case "$1" in
    admin) echo ./node-express-boilerplate ;;
    engine) echo ./databridge-engine ;;
    web) echo ./vue-vben-admin ;;
    *) echo "!! 未知服务: $1" >&2; exit 1 ;;
  esac
}

build_image() {  # $1=服务名 $2=本地tag后缀；web 支持 PREBUILT_WEB=1 用本地传来的 dist 直接打 nginx 镜像
  if [[ "$1" == web && "${PREBUILT_WEB:-0}" == "1" ]]; then
    [[ -f vue-vben-admin/prebuilt-dist/index.html ]] || {
      echo "!! PREBUILT_WEB=1 但缺 vue-vben-admin/prebuilt-dist/index.html（先本地 pnpm build 再传 dist）" >&2; exit 1; }
    echo "==> 构建 web（预构建 dist 模式，跳过 pnpm install）"
    docker build -f vue-vben-admin/Dockerfile.prebuilt -t "databridge/web:$2" vue-vben-admin
  else
    echo "==> 构建 $1 ($(ctx_dir "$1"))"
    docker build -t "databridge/$1:$2" "$(ctx_dir "$1")"
  fi
}

curl_tags() {
  local repo="$1" url="$SCHEME://$REGISTRY/v2/$PROJECT/$1/tags/list"
  # 不用空数组展开：CentOS7 bash4.2 在 set -u 下 "${arr[@]}" 会报 unbound variable
  if [[ -n "$HARBOR_USER" ]]; then
    curl -fsSk --connect-timeout 5 -u "$HARBOR_USER:$HARBOR_PASS" "$url" 2>/dev/null || true
  else
    curl -fsSk --connect-timeout 5 "$url" 2>/dev/null || true
  fi
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
      echo "!! 无法访问 $REGISTRY 的 tag 列表，且无本地版本记录。" >&2
      echo "   请显式指定版本避免覆盖已有镜像，如: bash deploy/build-push-harbor.sh v4" >&2
      exit 1
    fi
  fi
  VERSION="v$((max_v + 1))"
  echo "==> 自动递增版本: $VERSION"
fi

OUT_DIR="${OUT_DIR:-/opt/dataLink/$VERSION}"
SRC_DIR="${2:-$OUT_DIR}"

harbor_login() {
  if [[ -n "$HARBOR_USER" ]]; then
    echo "$HARBOR_PASS" | docker login "$REGISTRY" -u "$HARBOR_USER" --password-stdin
  fi
}

push_to_harbor() {  # $1=服务名 $2=本地镜像名
  docker tag "$2" "$REGISTRY/$PROJECT/$1:$VERSION"
  docker tag "$2" "$REGISTRY/$PROJECT/$1:latest"
  echo "==> 推送 $REGISTRY/$PROJECT/$1:$VERSION"
  docker push "$REGISTRY/$PROJECT/$1:$VERSION"
  docker push "$REGISTRY/$PROJECT/$1:latest"
}

finish() {
  echo "$VERSION" | tr -d 'v' > deploy/.harbor-version
  # 同步 kustomization.yaml 的 newTag，保证 kubectl apply -k 与刚推的版本一致
  sed -i -E "s|(newTag: )v[0-9]+|\\1$VERSION|" deploy/k8s/kustomization.yaml
  echo
  echo "==> 完成 $VERSION。更新集群二选一："
  echo "  A) 在有清单的机器: kubectl apply -k deploy/k8s/"
  for s in admin engine web; do
    echo "  kubectl -n databridge set image deploy/databridge-$s $s=$REGISTRY/$PROJECT/$s:$VERSION"
  done
}

IFS=',' read -ra SERVICES <<<"$ONLY"

case "$MODE" in
  push)
    # 本机直接构建 + 推送
    harbor_login
    for s in "${SERVICES[@]}"; do
      if [[ "$SKIP_BUILD" != "1" ]]; then
        build_image "$s" mock
      fi
      push_to_harbor "$s" "databridge/$s:mock"
    done
    finish
    ;;

  save)
    # 外网构建机：build -> save tar.gz，产物拷进内网后用 load 模式
    for s in "${SERVICES[@]}"; do
      build_image "$s" "$VERSION"
      mkdir -p "$OUT_DIR"
      echo "==> 导出 $OUT_DIR/databridge-$s-$VERSION.tar.gz"
      docker save "databridge/$s:$VERSION" | gzip > "$OUT_DIR/databridge-$s-$VERSION.tar.gz"
    done
    echo
    echo "==> 产物在 $OUT_DIR/，拷到内网机器后执行："
    echo "    MODE=load bash deploy/build-push-harbor.sh $VERSION $OUT_DIR"
    ;;

  load)
    # 内网机：load tar.gz -> 推 Harbor（无需外网/基础镜像）
    harbor_login
    for s in "${SERVICES[@]}"; do
      f="$SRC_DIR/databridge-$s-$VERSION.tar.gz"
      [[ -f "$f" ]] || { echo "!! 缺文件 $f（可先用 ONLY=web 单推有的包）" >&2; exit 1; }
      echo "==> 导入 $f"
      docker load -i "$f"
      push_to_harbor "$s" "databridge/$s:$VERSION"
    done
    finish
    ;;

  *)
    echo "!! 未知 MODE: $MODE（可选 push / save / load）" >&2
    exit 1
    ;;
esac
