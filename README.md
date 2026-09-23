# DataBridge —— 轻量数据同步平台（Mock 阶段）

对标帆软 FineDataLink / Apache DataLink 的轻量数据同步平台骨架。第一阶段**全内存 Mock，不连接任何数据库**（PG / Oracle / Mongo 均不接入），用于验证产品形态与前后端契约；第二阶段替换底层实现接入 PostgreSQL（平台元数据）与 Oracle（源/目标库）。

- 接口契约：[docs/API.md](docs/API.md)（三端统一遵循，改接口先改文档）
- 三套服务：Go 同步引擎（Gin）+ Node 管理后端（Express）+ Vue 前端（vben-admin / ant-design-vue）

## 1. 目录方案

| 目录 | 来源 | 说明 |
|------|------|------|
| `databridge-engine/` | **官方 nunu-layout-advanced 模板 + Mock 移植** | Go Gin 同步引擎（wire/viper/zap 分层，示例与 DB 接线已删），Mock 任务模拟执行 |
| `nunu/` | 已有脚手架 | Nunu **CLI 生成器仓库**（即上述官方模板的来源），本身不是可运行 Web 骨架 |
| `node-express-boilerplate/` | 已有脚手架扩展 | 管理后端；新增 `src/repositories/`（内存 Repository 层）、`src/services/`、`src/controllers/`、`src/routes/v1/`、`src/validations/` 各 databridge 文件；`src/index.js` 支持 `MEM_MOCK=true` 跳过 Mongo 连接 |
| `vue-vben-admin/` | 已有脚手架扩展 | 前端；新增 `src/api/databridge/`、`src/views/databridge/`（5 个页面）、`src/router/routes/modules/databridge.ts` |
| `docs/API.md` | 新建 | 前后端接口契约 |
| `docker-compose.yaml` | 新建 | Mock 版一键拉起 3 服务（无数据库） |
| `deploy/k8s/` | 新建 | Deployment + Service + Ingress 模板 |

技术栈说明：vben-admin v2.8 的组件库是 **ant-design-vue 3.x**，为保证工程一致性，新页面使用 antd 原生组件而非 Element Plus。

## 2. 快速启动

### 方式零：一键脚本（Windows，推荐日常开发）

```bat
start-dev.cmd            :: 三窗口拉起 引擎8080 / 后端3001 / 前端3100（后端模式读 .env 的 DB_DRIVER）
start-dev.cmd memory     :: 强制内存 mock 模式启动后端（不碰数据库）
start-dev.cmd mysql      :: 强制 MySQL 持久化模式
stop-dev.cmd             :: 按端口停掉三个服务
```

### 存储层开关（MySQL 持久化 ↔ 内存 Mock）

Node 管理后端支持双驱动（仓储门面按 `DB_DRIVER` 选择实现，service 层无感）：

- `DB_DRIVER=mysql`：10 张 `databridge_*` 表真实落库（内网 `10.45.34.222/dataLink`，连接信息在 `node-express-boilerplate/.env` 的 `MYSQL_*`，首次启动自动建表+种子入库）
- `DB_DRIVER=memory`（默认）：纯内存 + 种子数据，行为与 Mock 阶段一致
- 后端也可用脚本直接指定：`yarn dev:mysql` / `yarn dev:memory`
- 当前模式查看：`GET /api/v1/health` 的 `storage` 字段（前端大盘服务状态 Tag 同步展示"MySQL 持久化 / 内存 mock"）
- 注意：Go 同步引擎在本阶段始终为模拟器（假数据+进度模拟），不受该开关影响

### 方式一：Docker Compose（推荐，一键）

```bash
docker compose up -d --build
```

| 入口 | 地址 |
|------|------|
| 前端 | http://localhost:8000 |
| Node 管理后端 | http://localhost:3001/api/v1 （健康检查 `/health`） |
| Go 引擎 | http://localhost:8080/health |

登录（vben 内置 mock 账号）：`admin` / `123456`。

### 方式一·生产：MySQL 持久化打包（推荐上线姿势）

> ⚠️ 默认（不建 `.env`）= `DB_DRIVER=memory` 演示模式，**界面全是 mock 数据**。要生产版本必须显式提供根目录 `.env`（该文件被 gitignore，口令永不入库）：

```bash
git clone git@github.com:wuxiyuCool/sgDataLink.git && cd dataLink
cp .env.example .env        # 编辑：DB_DRIVER=mysql、MYSQL_HOST/USER/PASSWORD/DATABASE 填真实值
docker compose up -d --build
curl http://localhost:3001/api/v1/health   # 确认返回 "storage":"mysql" 即生产模式生效
```

生效后的行为差异（契约 4.1/5 节）：空库起步**不注入任何演示种子**；10+ 张 `databridge_*` 表自动建表；数据源连通测试、Data API 查询、同步任务/管道/数据开发全部走真实 MySQL/Oracle 读写（引擎 `mode:"real"`，列表带「真实」Tag；不支持的类型自动降级「模拟」Tag）。

K8s 生产：`deploy/k8s/configmap.yaml` 配好 `MYSQL_HOST` 等，`kubectl create secret generic databridge-db-secret -n databridge --from-literal=MYSQL_PASSWORD=xxx`，再 `kubectl apply -k deploy/k8s/`。

裸机生产：`cp node-express-boilerplate/.env.example node-express-boilerplate/.env`（设 `DB_DRIVER=mysql` + `MYSQL_*`），`yarn install && yarn start`。

### 方式二：本地开发（依赖只列清单，请自行安装）

前置：Go ≥ 1.24（引擎 go.mod 为 1.24.10；本机 1.21 + `GOTOOLCHAIN=auto` 会自动拉取）、Node ≥ 18、pnpm/yarn、Git Bash。

```bash
# 1) Go 引擎 :8080（官方 Nunu advanced 布局，入口在 cmd/server）
cd databridge-engine
go mod tidy && go run ./cmd/server -conf config/local.yml
# 配置以 yml 为主渠道，三个环境变量可覆盖：SERVER_PORT NODE_REPORT_URL MOCK_TICK_MS
# 容器同款配置：go run ./cmd/server -conf config/prod.yml（监听 0.0.0.0:8080）

# 2) Node 管理后端 :3001
cd node-express-boilerplate
yarn install
cp .env.example .env    # 确认 MEM_MOCK=true、ENGINE_BASE_URL=http://127.0.0.1:8080
yarn dev

# 3) Vue 前端 :5173
cd vue-vben-admin
yarn install            # 或 pnpm install
yarn dev                # vite 代理 /api/v1 -> http://127.0.0.1:3001
```

### 存储层开关（MySQL 持久化 ↔ 内存 Mock）

Node 管理后端支持双驱动（仓储门面按 `DB_DRIVER` 选择实现，service 层无感）：

- `DB_DRIVER=mysql`：10+ 张 `databridge_*` 表真实落库（内网 `10.45.34.222/dataLink`）；**空库起步、不注入任何演示数据**（契约 4.1，`SEED_DEMO=true` 可强制注入）；历史演示行用 `yarn db:cleanup` 清除
- `DB_DRIVER=memory`（默认）：纯内存 + 种子数据，行为与 Mock 阶段一致
- 后端也可用脚本直接指定：`yarn dev:mysql` / `yarn dev:memory`
- 当前模式查看：`GET /api/v1/health` 的 `storage` 字段（前端大盘服务状态 Tag 同步展示"MySQL 持久化 / 内存 mock"）

### 执行层开关（真实同步 ↔ 模拟，引擎 mode）

`DB_DRIVER=mysql` 且源/目标类型 ∈ {mysql, oracle} 时，任务/管道/数据开发自动走**真实数据库读写**（Go 引擎 `mode:"real"`，go-ora 纯 Go 驱动免装 Oracle 客户端）：全量分批拷贝、增量位点推进、管道按轮询列定时拉取；实例带 `execMode:"real"`。不满足条件（如 postgresql、管道未配轮询列、memory 模式）自动降级 `simulate` 并在实例日志中 WARN 标注，前端列表有「真实/模拟」Tag。详见 `databridge-engine/README.md` 与契约第 5 节。

## 3. 功能清单（Mock 行为，对标 FineDataLink 四大模块）

### 数据集成
- **数据源管理**：CRUD + 连通测试。mock 规则：`host` 以 `10.` 开头或名称含 `fail` → 测试失败；`password` 响应恒为 `***`。
- **同步任务**：全量/增量任务 CRUD（字段映射+transform 占位、`scheduleCron`、失败重试策略）；启动/停止经 Node 转发 Go 引擎。**调度器真实生效**：enabled 任务按 cron（6 位子集：`*`/`?`/数字）自动触发；failed 后按 `retryCount`/`retryIntervalSec` 自动重试（实例带 `trigger: manual|cron|retry`）。
- **数据管道（CDC）**：对标 FDL 实时管道——多表镜像管道 CRUD/启停；Go 引擎 `cdc` 模式无限模拟日志捕获（changeRows/qps/延迟 lagMs/SCN 位点每 tick 回报），前端 3s 轮询实时展示，延迟尖峰可触发告警演示。
- **数据开发（ETL 画布）**：LogicFlow 画布（`@logicflow/core`，含 JSON 编辑降级模式）拖拽编排 input/filter/join/transform/sql/json_parse/validate/output 节点，保存 nodes/edges JSON；`run` 时取首尾 input/output 拼快照交引擎按 full 模拟执行。

### 数据服务（Data API）
表一键发布为 REST API：管理端 CRUD + publish/unpublish（生成 apiKey）+ 调试（invoke 代理 + curl 命令生成）+ 调用统计（7 日趋势）。运行时 `GET /ds/{path}` 的 **X-API-Key 鉴权、IP 白名单、滑动窗口 QPS 限流为真实逻辑**。
- **配置期元数据驱动**：选数据源后实时拉取真实表名（`/data-apis/meta/tables`）与字段（`/meta/columns`，MySQL information_schema / Oracle ALL_TABLES+ALL_TAB_COLUMNS），勾选字段即输出列。
- **两种 SQL 模式**：builder（选表勾字段自动拼 SELECT）/ custom（自定义 SQL，`:name` 绑定变量；`list` 类型自动展开 Oracle `IN` 逐元素绑定、上限 1000；时间用 `TO_DATE(:t,...)` 显式声明）。
- **安全**（契约 1.9.2 红线，服务端强制）：仅允许单条 SELECT/WITH（注释与字符串字面量经掩码解析，不误杀不放过）；DML/DDL 关键字词边界黑名单；一切用户输入只走绑定参数，表/列名过标识符白名单；行数上限 500、查询超时 10s；错误透传数据库原文但不含连接凭据。

### 运维监控
- **任务监控大盘**：`/statistics/overview` 统计卡 + 7 日成败趋势图 + 运行实例 3s 轮询进度（Progress/读写行数/QPS）。
- **运行日志**：级别过滤 + ERROR 高亮 + 轮询开关。
- **告警管理**：规则 CRUD（task_failed/pipeline_error/lag_over_threshold × 钉钉/企微/邮件通道占位）+ 告警记录列表/标记已读；触发链路真实生效（引擎 failed/lag 回报即写记录，webhook 为 mock-sent）。
- **数据血缘**：`/lineage/graph` 由数据源/任务/管道/数据开发/数据服务聚合表级血缘，ECharts 力导向图展示。
- **offset 点位**：任务实例位点查询（增量 `UPDATE_TIME=`、全量 `ROWID=`、CDC `SCN=`）。

### 引擎模拟执行
每任务一个 goroutine + `context.WithCancel`：按 `batchSize` 每秒（`MOCK_TICK_MS`）推进读/写行数，进度与日志实时回报 Node（`/api/v1/engine/report`、`/logs`）；支持 `failureRate` 随机失败（`ORA-01555` / `LOGMINER session terminated` 等 mock 错误）、停止回报 `stopped`、增量回报推进后的 `currentOffset`。

### 种子数据（`MEM_MOCK=true` 启动自动注入）
3 数据源、2 同步任务（running 全量 / success 增量）、1 管道（pipe- running 含演示位点）、1 数据开发画布（5 节点）、1 已发布 Data API（invokeCount 138）、1 告警规则 + 2 条告警记录、若干实例/日志/offset。演示失败态：任务 `failureRate` 设 0.5 再启动，观察自动重试链路与告警记录产生。

## 4. K8s 部署（模板）

```bash
# 先构建推送三个镜像并替换 yaml 中 image 地址
docker build -t <registry>/databridge-admin:mock  node-express-boilerplate
docker build -t <registry>/databridge-engine:mock databridge-engine
docker build -t <registry>/databridge-web:mock    vue-vben-admin

kubectl apply -k deploy/k8s/
```

注意：Mock 阶段数据在进程内存，**admin/engine 均保持 1 副本**；Service 名必须是 `databridge-admin`、`databridge-engine`（前端 nginx 与引擎回报地址按名硬解析）。

## 5. 架构分层与第二阶段替换点

```
Vue(vben) ──HTTP──> Node: route → controller → service → [Repository 接口] ──> 内存 Map（现在）/ PostgreSQL+Sequelize（第二阶段）
Node ──启停指令──> Go(cmd/server → internal/handler → internal/service):
                        [TaskRepository / Reader / Writer / Reporter 接口]
                       internal/repository + internal/infra/{reader,writer,reporter}
                       内存+mock 假数据（现在）        Oracle 驱动真实读写（第二阶段）
Go ──进度/日志回报──> Node /api/v1/engine/*
```

- Go：官方 Nunu advanced 布局，`internal/repository`、`internal/infra/{reader,writer,reporter}` 全部面向接口，
  装配集中在 `cmd/server/wire/wire.go`（wire 生成 `wire_gen.go`）；换 Oracle 只新增实现 + 改这一处装配，
  `internal/handler`、`internal/service` 不动。DTO 与业务码在 `api/v1/engine.go`，配置在 `config/*.yml`
  （`SERVER_PORT` / `NODE_REPORT_URL` / `MOCK_TICK_MS` 覆盖，见 `pkg/config/env.go`）。
- Node：`src/repositories/*.repository.js` 统一 `find/page/getById/create/update/delete` 形态，第二阶段逐个替换为 PG 实现；auth 中间件已在新路由预留 TODO。
- 真实调度（cron 触发、失败重试、任务依赖）、CDC 实时管道、数据血缘、权限分级 → 第二阶段规划，接口字段已占位。

## 6. 当前验证边界（诚实声明）

| 项 | 状态 |
|----|------|
| Go 引擎 | `go mod tidy / build / vet / gofmt` 通过，wire 重新生成通过；本地运行时冒烟（起服务 + 假回报端 + curl）已通过：start/每 tick `/report`+`/logs` 到达/stop/重复 409(40901)/不存在 404(40401)/未知路径 404/参数 400(40001)/success 与 failureRate 随机失败/增量位点推进/`SERVER_PORT`+`MOCK_TICK_MS`+`NODE_REPORT_URL` 环境变量覆盖；Linux 静态二进制交叉编译 + `ldflags -X internal/handler.Version` 已验证。**未** 实际 `docker build`（本机无 Docker），SIGTERM 优雅停机仅能在 Linux 容器内验证 |
| Node 后端 | 语法与接线静态校验 + 仓储/服务层桩测试；四模块新增：cronMatcher/rateWindow/mockRows/重试计数有纯逻辑 stub 测试、路由挂载与前端调用路径逐一比对；**未** `yarn install` 实跑 express、Joi 运行时未验证 |
| Vue 前端 | 全部 ts 与 .vue script 块语法校验、导入核对；**未** install/build/vue-tsc，UI 渲染未实测（LogicFlow 画布有 JSON 编辑降级兜底） |
| compose / k8s | 文件已按三份 Dockerfile 约定编写；**未** 实际 `docker compose up` / `kubectl apply` |

首轮联调建议顺序：`go run` 引擎 → `yarn dev` Node → curl `POST /api/v1/tasks/task-2002/start` 看回报 → 再起前端。
