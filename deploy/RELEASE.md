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

> **注意按改动范围选服务**：`web-dist.tar.gz` 只含前端静态产物；
> 后端改动（Node admin / Go engine）必须重建对应镜像才会生效。
> 例：V5 含 admin 后端改动（forward 转发、Oracle 连接池、调用日志筛选），
> 需 `ONLY=admin,web` 一起重建；engine 未变更可省略。

**A. 服务器能直连（常规）**

```bash
cd /path/to/dataLink && git pull
ONLY=admin,web PREBUILT_WEB=1 bash deploy/build-push-harbor.sh v<N>
# admin：Dockerfile 内 npmmirror 源装依赖直接构建（内网实测可达）；
# web：PREBUILT_WEB=1 自动解压 tar -> vue-vben-admin/prebuilt-dist/，走 Dockerfile.prebuilt 直接打 nginx 镜像（跳过 pnpm 安装），
# 推送 10.45.34.167:5000/datalink/{admin,web}:v<N>，并回写 deploy/k8s/kustomization.yaml 的 newTag；
# 仅动前端时改回 ONLY=web 即可
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
# 新机器（kubectl >= 1.14，支持 kustomize）：
cd deploy/k8s && kubectl apply -k

# 老机器（如 master-01，kubectl 不支持 -k —— 占位镜像名不会被替换，禁用 apply -f 直推）：
kubectl -n databridge set image deploy/databridge-admin admin=10.45.34.167:5000/datalink/admin:v<N>
kubectl -n databridge set image deploy/databridge-web  web=10.45.34.167:5000/datalink/web:v<N>
kubectl -n databridge set image deploy/databridge-engine engine=10.45.34.167:5000/datalink/engine:v<N>  # 仅本轮重建了 engine 时执行
```

```bash
# rollout status 老版本一次只能查一个资源：
kubectl -n databridge rollout status deploy/databridge-admin
kubectl -n databridge rollout status deploy/databridge-web
curl -s http://<任意节点IP>:32614/ | head -c 200   # 应返回 index.html（NodePort 固定 32614）
```

浏览器强刷（Ctrl+F5）确认新功能在线；镜像拉取失败时检查节点 containerd 对
`10.45.34.167:5000` 的免密/hosts.toml 配置（见 deploy/build-push-harbor.sh 头部注释）。

## 5. 只发 web 不动后端

`ONLY=web` 只重建 web 镜像；admin/engine 的 kustomization newTag 不被改写，
`kubectl apply -k` 对未变更镜像是 no-op，无需担心连带重启。

---

## 本次 V9（指标中心 Metric Center 整模块上线）

**改动范围**：指标中心 M0~M7 全量——域/模型/三类指标/校验器/编译器/清洗汇总物化任务/
LLM 系统配置/智能问数（ChatBI）/问数对外服务（X-CHAT-KEY）/首页概览/前端 7 页。
三端都有改动，**必须三镜像全重建**：

- `engine`：新增 `/sql/query`（仅 SELECT）、`/sql/exec`（建表/清空/插入白名单）、
  `X-Engine-Token` 守卫（M3）→ 必须重建。
- `admin`：新增 12 张 `databridge_metric_*` 表（init.js 自动建，真库无需手工迁移）、
  指标/域/模型/任务/问数/settings 全套接口、编译器、ChatBI、chatKey 对外服务、
  Oracle 方言编译（FETCH FIRST / TO_DATE）→ 必须重建。
- `web`：指标中心 7 个页面 + 文档中心问数 Key 卡片 + 弹窗 vben 化 + 每页使用指南 → 重建。

**回归门禁（全 12 套件，2026-10-09 全绿）**：
metric-base 40 / metric-model 39 / metric-compile 60 / metric-sql 19 / metric-task 29 /
metric-chat 19 / chat-api 19 / users 33 / dockey 31 / swagger 40 / forward 19 / parse-curl ALL PASS。
其中 users、swagger 是 **memory 模式**用例（需 `DB_DRIVER=memory ADMIN_INIT_PASSWORD=testpass123`
起一个 :3001 实例再跑，跑完切回 mysql 联调实例）；其余对真库 :3001 跑。

**发版命令（v9 从 `main` HEAD 构建，不用 `V9` 标签）**：

> 标签说明：`V9` 指向指标中心合并提交 `06f1612`；其后 `a0d47df` 又修了
> **跨库方言（NVL/IFNULL→COALESCE、方言专有函数告警、标量白名单 7→19）** 并加了
> 15 条示例指标库。这些**不在 V9 标签内**，故本轮镜像按 main HEAD 构建。
> 不要 force 移动已推送的 V9 标签（会重写 GitHub/Gitea 共享状态）。

```bash
cd D:/code/code/go/dataLink
bash deploy/build-web-dist.sh                       # 产出 web-dist.tar.gz（已随 a0d47df 提交，可跳过）
git add -f deploy/web-dist/web-dist.tar.gz
git commit -m "release: web dist v9 产物更新"
git push                                            # origin 双 pushurl：GitHub + Gitea 一次到位
# master-01（或构建机）：
cd /path/to/dataLink && git fetch origin && git checkout main && git pull
ONLY=admin,engine,web PREBUILT_WEB=1 bash deploy/build-push-harbor.sh v9
# 三镜像推 Harbor 10.45.34.167:5000/datalink/{admin,engine,web}:v9，回写 kustomization newTag
```

**K8s 生效（master-01 kubectl 不支持 -k，用 set image）**：

```bash
kubectl -n databridge set image deploy/databridge-admin  admin=10.45.34.167:5000/datalink/admin:v9
kubectl -n databridge set image deploy/databridge-engine engine=10.45.34.167:5000/datalink/engine:v9
kubectl -n databridge set image deploy/databridge-web    web=10.45.34.167:5000/datalink/web:v9
kubectl -n databridge rollout status deploy/databridge-admin
kubectl -n databridge rollout status deploy/databridge-engine
kubectl -n databridge rollout status deploy/databridge-web
```

**上线后**：浏览器 Ctrl+F5 → 指标中心 7 页可进、首页统计有真数、问数能答、
任务能物化；生产 admin 需配 `ENGINE_SHARED_SECRET`（engine 与 admin 同值），
本地过渡态空密钥禁止上线。回滚：`kubectl set image` 回上一 tag（如 v8）。

### ⚠️ v9 必做：配置引擎共享密钥（此前 k8s 清单未注入）

`ENGINE_SHARED_SECRET` 两侧**只从环境变量读**（engine 不读 `config/*.yml`），
v9 起已写进 `deploy/k8s/admin.yaml` + `engine.yaml` 的 env，值取自同一个 Secret。
首次部署（或该 Secret 里还没有这个 key）执行：

```bash
# 生成一个随机密钥并写入既有 Secret（已存在 MYSQL_PASSWORD 的 Secret 上追加）
KEY="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
kubectl -n databridge patch secret databridge-db-secret \
  --type merge -p "{\"stringData\":{\"ENGINE_SHARED_SECRET\":\"$KEY\"}}"

# 让两侧重新读取 env（admin 与 engine 都要重启，值必须一致）
kubectl -n databridge rollout restart deploy/databridge-admin
kubectl -n databridge rollout restart deploy/databridge-engine

# 验证：engine 启动日志不应再出现「ENGINE_SHARED_SECRET 未配置：无鉴权过渡态」WARN
kubectl -n databridge logs deploy/databridge-engine | grep -i "ENGINE_SHARED_SECRET\|WARN"
```

漏配的后果：engine 空密钥=放行（功能可用但接口无鉴权）；两侧值不一致=admin 调
engine 全部 401/code 40101，指标试跑/物化任务/问数都会失败。
