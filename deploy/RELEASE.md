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

## 本次 V11 三期（指标宽表物表 + 目标建模表 + Oracle MERGE，契约 1.15）

**改动范围**：engine + admin 必发（`/sql/exec` 白名单多了两个动词，两侧镜像必须同版本，
否则 Oracle 幂等任务会稳定报 40001）；web 按 §5 走预打包产物。

- `engine`：exec 白名单新增 **`MERGE INTO`**（Oracle 幂等刷新，正文含 ` DELETE ` 一律拒，只放行
  UPDATE+INSERT 两分支）与 **`COMMENT ON`**。后者是一期遗留的真 bug：Oracle 无内联 COMMENT，
  「界面建表」把表/列注释拆成 `COMMENT ON` 与 CREATE 一批下发，白名单不认 → `Validate()` 阶段
  整批 400、一条不落库，所以 **v1.13 起「界面建表」在真 Oracle 上从未成功过一次**（此前只验过 DDL 文本）。
- `admin`：① 任务新增 `align`（`model` 缺省／`time` 时间宽表）与 `timeGrain`，落库列
  `databridge_metric_task.align_mode` / `time_grain`，**由 `init.js` 自动 ALTER 补可空列，无需手工迁移**
  （旧行读出来是 NULL → 按 `model` 处理，存量任务行为不变）；② 方言层新增 `GRAINS/grainRank/coarsestGrain`、
  `dateTrunc`、`upsertStatement`，`supports.upsertOnDuplicate` 改为通用 `supports.upsert`
  （Oracle 不再在保存期拒绝 upsert，改出 `MERGE INTO`）；③ `validateTargetModelShape`：目标建模表缺列/
  类型不兼容 → 保存期 40001（结构化清单走 `target-schema` 的 `missingColumns`/`mismatchColumns`/`matched`/
  `groups`/`targetModel`），**任务不自动建表也不自动 ALTER**；④ 指标可声明 `defineParams.timeGrain`
  （JSON 列内的键，无表结构变更）；⑤ `metricmodel.buildDdl` 的**度量列改为 `NULL`**（否则宽表空期次
  物化会整条失败）；⑥ 留痕列按目标表实际列「有则写、无则跳」。
- `web`：任务弹窗加「对齐模式」单选 + 「目标时间粒度」+ 目标表二选一（选建模表／自动建表·存量）、
  缺列红字与「去建模页补列」直达（`/metric/models?columnsFor=<id>` 自动开字段弹窗）、多模型分组展示、
  Oracle 的 upsert 不再置灰；指标广场卡片加「＋宽表」多选与「勾的指标建宽表」入口（跳任务页自动开弹窗）；
  任务列表加「对齐」列；任务/建模/广场三页使用指南同步。

**回归门禁（2026-10-10 本地真库全绿）**：**metric-wide 75**（新套件：粒度/维度/清洗规则/跨源八类闸门、
草稿目标模型、缺列与类型族两条 40001、`align/timeGrain` 落库回读、语句形状（截断+`GROUP BY` 重复表达式
+时间全集 UNION+LEFT JOIN+不出 CREATE）、真执行空期次落 NULL、upsert 幂等、留痕列有则跳、
`align=model` 不回退、**Oracle 真库 MERGE 两段**（模型模式两次 run 行数不涨 ⇒ UPDATE 分支命中；
时间宽表模式 `TO_CHAR`/`TO_DATE` 语句被真 Oracle 接受执行）、Oracle 生成表首次真库验通）/
metric-dialect **71**（原「oracle upsert 明确拒绝」用例已按契约改为断言产出 MERGE，并加 dateTrunc/粒度档位用例）/
metric-model 62 / metric-base 40 / metric-compile 60 / metric-task 34（逐字节证明同模型模式没退化）/
metric-sql 24 / dataflow-engine 21；engine `go test ./api/v1` 通过（新增 MERGE/COMMENT 允许与拒绝用例）。
metric-dimvalue 36/1：唯一失败是内网 LLM 网关上游 DNS 解析失败（`Name or service not known`），属外部依赖，非平台链路。

**跑回归的环境要求**：`test-metric-wide` 的 Oracle 段默认用元库里登记的 `ds-1158`
（`TEST_ORACLE_DS=<id>` 覆盖，`TEST_ORACLE_DS=` 空串跳过；数据源不存在/禁用时自动 skip 并打印原因）。
所有 `test-metric-*` 都要按头注把 `TEST_DS_HOST/USER/PASS/DB` 一并导出（`TEST_DS_PASS=$MYSQL_PASSWORD`），
否则会踩「`!text.includes('')` 恒 false」这类断言自伤。Oracle 段只在**平台自建的 `MW…` 表**上写入，
业务表全程只读，结束按「模型删除 + dropTable」清理（回归跑完已核对目标库无 `MW` 前缀残留）。

**上线后演示资产**：生产 admin 上再跑一次 `seed-metric-demo.js`（同上命令）即新增
「访问明细(DWD) `dm_visit_src` + 指标 `dm_uv` + ADS 建模表 `dm_wide_month` + 任务 月度指标宽表」，
其中 2026-08 的 `dm_uv` 是 NULL，正好当「空期次落 NULL 不是 0」的讲解样本（会真建一张
`dm_wide_month`，属预期演示资产）。

**回滚说明**：`align_mode`/`time_grain` 是可空新列，旧代码不读，回滚 admin 镜像不影响存量任务；
但**回滚 engine 镜像会让 Oracle 的 MERGE 与 Oracle 生成表再次被白名单拒绝**（不伤 MySQL 链路），
如需回滚请连同 admin 一起退到上一版。

## 本次 V11 四期（建模分层树 + 分类，契约 1.16）

**改动范围**：只发 **admin + web**（engine 一行没动；三期那版 engine 镜像继续用）。
两侧 admin 镜像必须同版本：新表与补列是启动时自动迁移的，旧镜像不认识 `category_id` 也只是不读它。

- `admin`：① 新表 `databridge_metric_model_category`（`mcat-`，`name/layer/description/sort/del_flag`，
  `idx_metriccategory_layer`）由 `db/init.js` 启动自动建；② `databridge_metric_model` 加
  `category_id VARCHAR(64) NOT NULL DEFAULT ''` + `idx_metricmodel_category`——旧库走 `init.js` 自动补列时
  得到的是 **`VARCHAR(255) NULL`**（补列器恒定拼 NULL、字符串列兜底 255），与 schema 不同形但**不影响功能**：
  服务端 `normalizeTableStatus` 把 `null`/缺失统一读成 `''`。要把线上列型收敛成人话版，可重复执行
  `ALTER TABLE databridge_metric_model MODIFY category_id VARCHAR(64) NOT NULL DEFAULT ''`
  + `UPDATE databridge_metric_model SET category_id='' WHERE category_id IS NULL`（可选，非上线必需）；
  ③ 新路由组 `/metric-model-categories`（`GET /tree`、`POST /`、`PUT|DELETE /:id`、`POST /assign`，
  注意 `/tree`、`/assign` 排在 `/:id` 之前）；④ `GET /metric-models` 新增 `categoryId` 筛选（`none`=未分类，
  走函数谓词 + sqlStore 整表回退，内存/MySQL 同语义）；⑤ `createModel/updateModel` 收 `categoryId`
  并硬校验「分类存在未删 + 与模型同层」，换层不带新分类 → 40001；⑥ 删分类 = 软删 + 名下模型自动降级
  未分类（回 `movedModels`）。**分层树的「层」不落库**：5 个根由 `LAYERS` 常量虚拟生成，不参与任何写操作。
- `web`：数据建模页改成**左「分层树」右列表**——树是 `全部模型 → 5 个分层根 → 分类（+每层「未分类」节点）`，
  节点带模型计数、分类描述做副标题与 Tooltip；树顶部新建分类，节点上编辑/删除（删除的二次确认文案按
  `movedModels` 报「N 个建模将退回未分类，不会删除建模本身」）。列表加「分类」列与行多选 →「批量归类」
  （跨层的模型逐条点名、其余照常成功）。新弹窗 `CategoryModal.vue`（vben BasicModal）里**层级编辑态锁死**；
  `ModelModal.vue` 的分类下拉随所选层联动（换层自动清空并要求重选）。`guides.ts` 建模页说明卡补分层树段落。

**回归门禁（2026-10-10 本地真库全绿）**：metric-model **62 → 100**（新增 38 条分类段落：非法 layer、
同层重名与跨层同名、tree 五根恒定/排序/`modelCount`/`uncategorized`、`categoryId` 与 `none` 筛选、
`assign` 正常归类 + 跨层逐条点名（HTTP 恒 200、`assigned/failed` 计数）、模型详情与列表 `categoryId`
归一为 `""` 而非 `undefined`、`updateModel` 跨层 40001、`PUT /:id` 带 `layer` 40001、删除后 `movedModels`
与模型真的回到未分类）；复跑非回归：metric-base **40** / metric-compile **60** / metric-dialect **71** /
metric-task **34** / metric-sql **24** / metric-dimvalue **38** / metric-wide **75** / dataflow-engine **21**，
engine `go test ./api/v1` 通过（本轮未改引擎代码）。另用 `DB_DRIVER=memory` 单跑过分类服务，两驱动语义一致。
跑法照旧必须导出 `TEST_DS_*`（`TEST_DS_PASS=$MYSQL_PASSWORD`）。

**上线后演示资产**：生产 admin 再跑一次 `seed-metric-demo.js` 会补 4 个分类——
DWD「交易域」（订单明细+访问明细）、ADS「应用出数」（渠道日报已建表+月度宽表）、
DIM「维度登记」与 DWS「汇总层预留」**故意留空**（演示"分类先建、模型后归类"），
并把「渠道日报(草稿)」留在 ADS 的**未分类**桶里当样本。

**回滚说明**：`category_id` 是可空/带默认的新列，旧代码不读；新表旧代码不查。回滚 admin 镜像后
分类数据静静躺着不影响任何链路，界面上的树会退化成纯列表。**唯一要留意的是删过的分类**：
降级动作已经把模型置成未分类，这不可逆（要恢复归类得重新手工归类）。

---

## 本次 V11 发布操作单（三期宽表 + 四期分层树 + 筛选修复，镜像 tag `v11` / 标签 `V11`）

**改动范围＝三镜像全重建**（不要只发 web）：

- `engine`：`/sql/exec` 白名单新增 `MERGE INTO` 与 `COMMENT ON`。**不回滚它就不算发完**——
  admin 侧 Oracle 幂等任务与 Oracle「生成表」都依赖这两个动词，engine 停在 v10 会让它们稳定 40001。
- `admin`：新表 `databridge_metric_model_category` + 模型列 `category_id` + 任务列 `align_mode`/`time_grain`
  （全部由 `db/init.js` 启动时自动建表/补可空列，**不需要手工迁移**）；新路由组 `/metric-model-categories`；
  方言层 `dateTrunc`/`GRAINS`/`upsertStatement`；`listUsers` 筛选修复。
- `web`：任务弹窗双栏、广场勾指标建宽表、建模页分层树（左树右表 + 分类管理 + 批量归类）、
  文档中心搜索区统一、三处「组件没 import」的隐形按钮修复。

**回归门禁（2026-10-10 本地真库全绿，16 个套件）**：
metric-model **100** / metric-wide **75**（新）/ metric-dialect **71** / metric-compile **60** /
metric-base **40** / metric-task **34** / metric-sql **24** / metric-dimvalue **38** /
metric-chat **19**（10 问命中 8）/ dataflow-engine **21** / chat-api **19** / dockey **31** /
forward **19** / parse-curl ALL PASS / users **38**（新 5 条筛选断言）/ swagger **40**；
engine `go test ./api/v1` 通过。
跑法注意：① metric 系列必须导出 `TEST_DS_*`（`TEST_DS_PASS=$MYSQL_PASSWORD`），否则「口令不回显」那条会假失败；
② `users`/`swagger` 是 **memory 模式**套件，另起 `DB_DRIVER=memory ADMIN_INIT_PASSWORD=testpass123 PORT=3002 node -r dotenv/config src/index.js`
再用 `BASE=http://127.0.0.1:3002/api/v1 node ../deploy/tests/<suite>.js` 跑（本轮已把这两个套件的 BASE 改成可覆盖），跑完关掉临时实例，别动用户的 :3001。

**发版命令**：

```bash
# 本地（Windows Git Bash）：产物已随本次提交入库，重打只在改了前端时才需要
cd D:/code/code/go/dataLink
bash deploy/build-web-dist.sh                      # 产出 deploy/web-dist/web-dist.tar.gz
git add -f deploy/web-dist/web-dist.tar.gz
git commit -m "release: web dist v11 生产包（时间宽表 + 建模分层树 + 筛选修复）"
git tag V11
git push                                           # origin 配了双 pushurl：GitHub + 内网 Gitea 一次到位
git push origin V11                                # 标签单独推

# master-01（有 docker + kubectl，能出网或走 squid 223:3128）
cd /path/to/dataLink && git fetch origin && git checkout main && git pull
ONLY=admin,engine,web PREBUILT_WEB=1 bash deploy/build-push-harbor.sh v11
# → 三镜像推 Harbor 10.45.34.167:5000/datalink/{admin,engine,web}:v11，并回写 kustomization newTag

# K8s 生效（该集群 kubectl 不支持 -k，用 set image）
kubectl -n databridge set image deploy/databridge-admin  admin=10.45.34.167:5000/datalink/admin:v11
kubectl -n databridge set image deploy/databridge-engine engine=10.45.34.167:5000/datalink/engine:v11
kubectl -n databridge set image deploy/databridge-web    web=10.45.34.167:5000/datalink/web:v11
kubectl -n databridge rollout status deploy/databridge-admin
kubectl -n databridge rollout status deploy/databridge-engine
kubectl -n databridge rollout status deploy/databridge-web
```

**上线后验证（按顺序，任一步不过就别往下走）**：

1. `kubectl -n databridge logs deploy/databridge-admin | tail` 看启动日志有没有「自动补列」成功、无 FATAL；
   新表 `databridge_metric_model_category` 与三列（`category_id`/`align_mode`/`time_grain`）由 init 建/补齐。
2. 浏览器 Ctrl+F5（web 是静态产物，缓存不刷新会看到旧界面）→ 指标中心：
   数据建模左侧出现分层树（5 个分层根 + 分类 + 未分类）；任务管理「对齐」列能区分同模型/时间宽表；
   指标广场卡片右上可勾选并跳任务页自动开弹窗。
3. **每页的「查询」按钮都要真发请求**（本轮修的就是点了没反应）：F12 Network 里能看到带
   `layer=`/`categoryId=`/`lastStatus=`/`role=` 的请求。
4. 生产 admin 再跑一次 `seed-metric-demo.js` 铺演示资产（宽表任务 + 4 个分类），见 docs/METRIC-DEMO.md。
5. `ENGINE_SHARED_SECRET` 是否真落到 Pod（engine 日志不应再有「无鉴权过渡态」WARN）——
   `kubectl set image` **不会**带出清单里新增的 env，必须按本文「⚠️ v9 必做」那节 `kubectl patch deploy` 追加，
   且**先补 Secret 的 key 再 patch**，否则 Pod 卡 CreateContainerConfigError。

**可选的列型收敛**（不影响功能，想让人工核对的 DDL 与 schema 一致再做）：

```sql
ALTER TABLE databridge_metric_model MODIFY category_id VARCHAR(64) NOT NULL DEFAULT '';
UPDATE databridge_metric_model SET category_id = '' WHERE category_id IS NULL;
```

**回滚**：三镜像一起 `kubectl set image ... :v10`（admin 与 engine 不要分开退——v11 的 Oracle 链路
依赖 engine 的 MERGE/COMMENT 白名单，退回 v10 admin + 留 v11 engine 没问题，反之会让 Oracle 任务 40001）。
新表/新列都是"旧代码不读"的加法，回滚不需要清库；唯一不可逆的是**删分类带来的归类信息丢失**
（模型会静静躺在「未分类」里，需要人工重新归类）。
