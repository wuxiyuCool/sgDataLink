# shellcheck shell=bash
# admin 依赖基座镜像的 tag 计算 —— 被 build-admin-deps.sh 与 build-push-harbor.sh 共用，
# 保证两边算出来的 tag 一定一致（不一致就会出现"业务镜像找不到基座"）。
#
# 口径：package.json + yarn.lock 两个文件的内容哈希。只动源码不动依赖 → tag 不变 → 复用基座；
# 加/删/升级依赖 → tag 变 → 必须重新构建并推一次基座（这一步要外网/代理）。

admin_deps_tag() {
  local root="${1:-.}"
  local sum
  if command -v md5sum >/dev/null 2>&1; then
    sum=$(cat "$root/node-express-boilerplate/package.json" "$root/node-express-boilerplate/yarn.lock" | md5sum | cut -c1-10)
  elif command -v md5 >/dev/null 2>&1; then
    sum=$(cat "$root/node-express-boilerplate/package.json" "$root/node-express-boilerplate/yarn.lock" | md5 -q | cut -c1-10)
  else
    sum=$(cat "$root/node-express-boilerplate/package.json" "$root/node-express-boilerplate/yarn.lock" | openssl dgst -md5 | awk '{print $NF}' | cut -c1-10)
  fi
  echo "d$sum"
}
