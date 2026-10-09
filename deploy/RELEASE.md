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

### 登录态：token 有效期 8 小时 + JWT 签名密钥（纯配置，不用重新构建镜像）

现象「用着用着突然退回登录页」的根因：`/auth` 只有 login、**没有 refresh 接口**，
token 的 `exp` 在登录瞬间按 `JWT_ACCESS_EXPIRATION_MINUTES` 钉死（不随操作滑动），
而该变量本地 `.env` 与清单/ConfigMap 都没配 → 走 `config.js` 默认 30 分钟，到点第一个
请求 401，前端 `checkStatus.ts` 直接清 token 跳登录页。前端 localStorage 缓存是 7 天
（`encryptionSetting.ts` 的 `DEFAULT_CACHE_TIME`），不是它限制的。

```bash
# 1) 放宽有效期到 8 小时（只做这一步即可解决「突然退出」）
kubectl -n databridge patch configmap databridge-config --type merge \
  -p '{"data":{"JWT_ACCESS_EXPIRATION_MINUTES":"480"}}'

# 2) 补 JWT 签名密钥 —— 必须先于第 3 步：secretKeyRef 指向的 key 不存在会让 Pod 卡在
#    CreateContainerConfigError（不配则一直用脚手架公开默认值 databridge-mock-secret，可伪造 admin token）
kubectl -n databridge patch secret databridge-db-secret --type merge \
  -p "{\"stringData\":{\"JWT_SECRET\":\"$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 24)\"}}"

# 3) 给 admin 追加 env（只追加、不碰 image；master-01 的 kubectl 不支持 -k，禁止 apply -f）
kubectl -n databridge patch deploy databridge-admin --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/env/-","value":{"name":"JWT_SECRET","valueFrom":{"secretKeyRef":{"name":"databridge-db-secret","key":"JWT_SECRET"}}}}]'

# 4) 验证：expiresInSec 约 28800（换密钥会让全部旧 token 立刻失效，本来也要重登）
curl -s -X POST http://10.45.34.165:32614/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"username":"<账号>","password":"<口令>"}' | head -c 240

# 回滚：把 ConfigMap 的值改回 "30" 再 rollout restart deploy/databridge-admin
```

已同步到清单：`configmap.yaml`（有效期 480）、`admin.yaml`（`JWT_SECRET` 走 secretKeyRef）、
`secret.example.yaml`（生成命令与说明）。存量环境仍按上面 patch 走，不要 apply 整份清单。
**注意：配置生效前登录的浏览器会话，其旧 token 的 exp 仍是旧值，到点照样掉，需重新登录一次。**


## 本次 V10+V11（方言层收敛 + 建模生命周期一期 + 指标广场/维度取值二期）

**改动范围**：三端都有，需三镜像全重建（web 也可只按 §5 走预打包产物）。

- `engine`：`/sql/exec` 白名单新增 `DROP TABLE`，但**必须请求体显式 `allowDrop=true`**，
  且只放单表（拒绝多表列表 / `CASCADE` / `PURGE` / 无表名）。这是为「建模删除平台自建表」
  服务的最小口子，Node 侧另有闸门（引用表、未建过表的模型根本不会下发 DROP）。
- `admin`：① 方言层 `src/utils/dialect.js` 成为 MySQL/Oracle 语法差异的唯一来源
  （编译/物化/建表/预览/问数五个生成点全部接入，Oracle 字符串出 `VARCHAR2(n CHAR)`）；
  ② 建模生命周期（契约 1.13）：`status` 三态 `draft|online|offline`、
  新列 `table_status/table_msg/table_at`、`POST /metric-models/:id/create-table`、
  `DELETE /metric-models/:id?dropTable=true`、`GET /metric-models/column-types`、
  `POST /metric-tasks/target-schema`。**无新表**，三个新列由 `init.js` 自动 ALTER
  补可空列，真库上线不用手工迁移（回滚到 v9 镜像也不影响，旧代码不读这几列）。
- `web`：建模页状态机（表状态列、启用/停用、生成表弹窗带方言 DDL 预览、删除弹窗按
  createType/tableStatus 区分并需手输表名）、字段编辑器类型族+长度/小数位、任务弹窗
  目标表结构自动生成；**V11 二期（契约 1.14）**：指标页改造成「指标广场」（按域分节卡片流 +
  广场/表格双视图 + 状态默认只回已上架）、「从表生成指标」三步批量向导（可就地登记引用表模型，
  逐条回显成败并只重投失败项）、字段弹窗维度列「取值」入口（探查/登记码值业务名/看失效值）、
  系统配置新增「候选值进问数 Prompt」开关与条数、菜单改名 指标管理→指标广场。
- **admin 二期新增（同上 v1.14）**：`GET /metrics/plaza`、`POST /metrics/batch`、
  `POST /metric-models/:id/profile-dimensions`、`GET/PUT/DELETE /metric-models/:id/dimension-values`；
  新表 `databridge_metric_dimvalue`（第 13 张，init.js 自动建，`mdv-` 序列 19000 自动补）；
  系统配置 8→10 项（`chat.dimValuePrompt` 默认 `0`、`chat.dimValueTopN` 默认 20，
  env `CHAT_DIM_VALUE_PROMPT`/`CHAT_DIM_VALUE_TOPN`）。**取值探查会向业务源库发只读 GROUP BY**，
  上线后先在高基数保护的默认值（200）下用，别拿大表列直接试。

**回归门禁（2026-10-09 本地真库全绿）**：metric-dialect **67**（离线，含 V11 二期双方言探查 SQL 形状与标识符注入拒绝）/ metric-base 40 /
metric-model **62**（一期生命周期 15 条 + 配置项 10 项与取值开关默认关）/
metric-compile 60 / metric-sql 24 / metric-task 34 / **metric-dimvalue 37**（二期新套件：真建码值表探查、高基数保护、
人工 label 不被探查覆盖、候选值进 prompt 开关两侧行为、华东→E1 值校正与 unmapped、广场分组/状态/别名搜索、
批量 2 成 2 败逐条原因、真 LLM 问数落地 SQL 出现 E1）；engine `go test ./api/v1` 通过。
metric-chat 依赖内网 LLM 网关：`llm.model` 必须是网关白名单内的模型（`deepseek-chat` 会被 400 拒），
当前网关只放行 `deepseek-ai/DeepSeek-V4-Flash`（10 问命中 6~8 波动，通过线 ≥7）与 `Qwen/Qwen3-8B`（实测更差 4/10）——
命中率是模型能力边界，不是平台链路问题；要提升得让网关加白更强的对话模型或用「转示例」沉 few-shot。
回归套件已改为对 `databridge_metric_setting` 先快照后还原，跑完不会把线上模型设置抹掉。

**上线后演示资产**：在生产 admin 上跑一次
`ADMIN_USER=mtlint01 ADMIN_PASS=<口令> BASE=http://10.45.34.165:32614/api/v1 node deploy/tests/seed-metric-demo.js`
即可获得「渠道日报(草稿) / 渠道日报(已建表) / 订单明细(引用表)」三种表状态各一条，
供界面走查（会真建 `dm_demo_ads` 一张表，属预期演示资产）。

**⚠️ 与本轮改动强绑定的配置项**：`ENGINE_SHARED_SECRET` 必须已在 admin/engine 两侧注入
（见上文 v9 必做节），否则 `create-table` 会被引擎以未鉴权拒绝。
