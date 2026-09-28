# Web 前端生产包发布流程（配合 git tag V\<N\> / 镜像 v\<N\>）

> 版本约定：git 标签 `V<N>` 与 Harbor 镜像 tag `v<N>` 保持同数字；
> 例：本次 `V5` → `10.45.34.167:5000/datalink/web:v5`。

## 1. 本地打包（Windows Git Bash，有外网）

```bash
cd D:/code/code/go/dataLink
bash deploy/build-web-dist.sh
# 产出 deploy/web-dist/web-dist.tar.gz（pnpm build 产物，VITE_USE_IMAGEMIN=false 与 Dockerfile 一致）
```

## 2. 提交产物并推送（GitHub + 内网 Gitea 双远端一次到位）

```bash
git add -f deploy/web-dist/web-dist.tar.gz
git commit -m "release: web dist v<N> 产物更新"
git tag V<N>
git push                      # origin 配置了双 pushurl（GitHub + Gitea），一次推两边
git push origin V<N>          # 标签单独推
```

## 3. 服务器构建镜像

**A. 服务器能直连（常规）**

```bash
cd /path/to/dataLink && git pull
ONLY=web PREBUILT_WEB=1 bash deploy/build-push-harbor.sh v<N>
# 自动解压 tar -> vue-vben-admin/prebuilt-dist/，走 Dockerfile.prebuilt 直接打 nginx 镜像（跳过 pnpm 安装），
# 推送 10.45.34.167:5000/datalink/web:v<N>，并回写 deploy/k8s/kustomization.yaml 的 newTag
```

**B. 内网机无外网（save/load 双机流水线）**

```bash
# 外网构建机：构建并导出 tar.gz（默认输出 /opt/dataLink/v<N>/）
MODE=save bash deploy/build-push-harbor.sh v<N>
# 拷贝 tar.gz 到内网机后：
MODE=load bash deploy/build-push-harbor.sh v<N> [tar包目录，默认 /opt/dataLink/v<N>]
```

## 4. K8s 生效与验证

```bash
cd deploy/k8s && kubectl apply -k
kubectl -n databridge rollout status deploy/databridge-web
curl -s http://<任意节点IP>:32614/ | head -c 200   # 应返回 index.html（NodePort 固定 32614）
```

浏览器强刷（Ctrl+F5）确认新功能在线；镜像拉取失败时检查节点 containerd 对
`10.45.34.167:5000` 的免密/hosts.toml 配置（见 deploy/build-push-harbor.sh 头部注释）。

## 5. 只发 web 不动后端

`ONLY=web` 只重建 web 镜像；admin/engine 的 kustomization newTag 不被改写，
`kubectl apply -k` 对未变更镜像是 no-op，无需担心连带重启。
