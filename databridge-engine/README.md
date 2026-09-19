# databridge-engine

DataBridge 数据同步平台的 **Go 同步引擎**（Mock 第一阶段）。

- 骨架 = 官方 [nunu-layout-advanced](https://github.com/go-nunu/nunu-layout-advanced) 模板（Gin + wire + viper + zap），
  示例代码（user CRUD）、DB/redis/mongo 接线、jwt 鉴权、swagger 文档、job/task/cmd-migration 已整体删除。
- 业务代码 = 由手写的 Mock 引擎移植而来，接口契约见 [docs/API.md](../docs/API.md) 第 2 节，
  **全部内存模拟，不连接任何数据库**（无 GORM、无 Oracle/PG/MySQL 驱动）。
- 对外响应结构是 `{ code, message, data }`（注意与 Node 管理端给前端的 `{ code, message, result }` 不同）。

## 目录结构（官方 Nunu 布局）

```
databridge-engine/
├── cmd/
│   └── server/
│       ├── main.go                 # 入口：加载 yml -> 环境变量覆盖 -> wire 装配 -> app.Run
│       └── wire/
│           ├── wire.go             # 装配根（ProviderSet + 替换点），//go:build wireinject
│           └── wire_gen.go         # 由 wire 生成，勿手改
├── api/v1/
│   ├── v1.go / errors.go           # 模板自带的统一响应结构与通用错误
│   └── engine.go                   # 引擎 DTO + 业务码常量 + { code,message,data } 封装
├── config/{local,prod}.yml         # http.host/port + engine.* + log.*（无 data: 段）
├── internal/
│   ├── handler/                    # 参数校验 + 统一响应 + 领域错误映射
│   │   ├── handler.go              #   Handler 基类（OK/Fail/FailErr/bindFail）
│   │   ├── engine.go               #   start / stop / list / get
│   │   └── health.go               #   /health，含 Version（ldflags 注入）
│   ├── service/                    # 用例层，只依赖接口
│   │   ├── task_service.go         #   Start/Stop/List/Get/RunningCount/Shutdown
│   │   ├── mock_runner.go          #   模拟主循环（goroutine + context.WithCancel + tick 分片 + 回报）
│   │   ├── errors.go               #   领域错误（40901 / 40401 / 40001 / 50000 映射来源）
│   │   └── service.go              #   Service 基类（仅日志器）
│   ├── repository/
│   │   ├── task_repository.go      #   TaskRepository 接口（契约指定的 4 个方法）
│   │   ├── mem_repo.go             #   memRepo：map + sync.RWMutex，读写均值拷贝
│   │   └── repository.go           #   空 ProviderSet 说明（DB/redis/mongo Provider 已删除）
│   ├── infra/
│   │   ├── reader/                 #   Reader 接口 + mockReader（假数据行 + 模拟延迟）
│   │   ├── writer/                 #   Writer 接口 + mockWriter（提交延迟 + 0.98~1.0 写入比例）
│   │   └── reporter/               #   Reporter 接口 + httpReporter（net/http POST /report、/logs）
│   ├── router/{router.go,engine.go}#  RouterDeps + /health 与 /api/v1/engine/* 注册
│   ├── server/http.go              #  gin 装配：CORS + 访问日志 + panic recovery + NoRoute 404
│   └── middleware/                 #   cors.go / log.go（模板自带）+ recovery.go（契约风格）
├── pkg/                            # 模板基础设施：app / config / log(zap) / server(http)
├── Dockerfile  .dockerignore  .gitignore  Makefile
```

## 快速开始

```bash
cd databridge-engine
go mod tidy
go run ./cmd/server -conf config/local.yml     # 本地：127.0.0.1:8080
go run ./cmd/server -conf config/prod.yml      # 监听 0.0.0.0:8080（容器同款配置）

# 编译与检查
go build ./... && go vet ./...

# 重新生成 wire（改了 Provider 后执行）
make wire
```

### 配置：yml 主渠道 + 环境变量覆盖

`config/*.yml` 是主渠道；加载后仅对下列三个键做环境变量覆盖（见 `pkg/config/env.go`），
因此仓库根的 `docker-compose.yaml` 与 `deploy/k8s/engine.yaml` 无需改动：

| 环境变量 | 覆盖的 yml 键 | 默认值 |
|----------|---------------|--------|
| `SERVER_PORT` | `http.port` | `8080` |
| `NODE_REPORT_URL` | `engine.node_report_url` | local: `http://127.0.0.1:3001/api/v1/engine`；prod: `http://databridge-admin:3001/api/v1/engine` |
| `MOCK_TICK_MS` | `engine.mock_tick_ms` | `1000`（最小 50） |

仅 yml 可配：`engine.report_timeout_ms`（默认 3000）、`engine.max_history`（终态实例保留上限，默认 200）、
`http.host`（local `127.0.0.1` / prod `0.0.0.0`）、`log.*`（zap，prod 为 console+json，容器只看 stdout）。

## 接口清单

| 方法 | 路径 | 说明 | 失败响应 |
|------|------|------|----------|
| GET | `/health` | 健康检查，`data.status=ok`，带 `runningTasks` | — |
| POST | `/api/v1/engine/tasks/start` | 接收启动指令，拉起 goroutine 模拟同步 | 400/40001 参数错误；409/40901 `instanceId` 重复 |
| POST | `/api/v1/engine/tasks/stop` | 下发停止指令（`context.Cancel`） | 400/40001；404/40401 实例不存在 |
| GET | `/api/v1/engine/tasks` | 引擎内任务列表，支持 `?status=running` 过滤 | 400/40001 |
| GET | `/api/v1/engine/tasks/:instanceId` | 单实例模拟状态快照 | 404/40401 |

响应统一为 `{ "code": 0, "message": "success", "data": { } }`；错误时 `data` 为 `null`。

```bash
B=http://127.0.0.1:8080
curl -s $B/health

curl -s -X POST $B/api/v1/engine/tasks/start -H 'Content-Type: application/json' -d '{
  "taskId":"task-2001","instanceId":"inst-3001","syncMode":"full","batchSize":1000,
  "totalRows":100000,"failureRate":0,"incrementalColumn":null,
  "source":{"id":"ds-1001","type":"oracle","database":"ORCLPDB1"},
  "target":{"id":"ds-1002","type":"mysql","database":"dst"},
  "reportUrl":"http://127.0.0.1:3001/api/v1/engine"}'
# {"code":0,"message":"success","data":{"accepted":true,"instanceId":"inst-3001"}}

curl -s -X POST $B/api/v1/engine/tasks/stop -H 'Content-Type: application/json' \
  -d '{"instanceId":"inst-3001"}'
# {"code":0,"message":"success","data":{"stopped":true}}

# 数据管道（CDC）：syncMode=cdc + pipelineId + syncObjects，totalRows 忽略
curl -s -X POST $B/api/v1/engine/tasks/start -H 'Content-Type: application/json' -d '{
  "taskId":"pipe-7001","instanceId":"inst-3101","pipelineId":"pipe-7001","syncMode":"cdc",
  "batchSize":2000,"syncObjects":["APP_USER.T_ORDER","APP_USER.T_ORDER_ITEM"],"failureRate":0,
  "source":{"id":"ds-1001","type":"oracle","database":"ORCLPDB1"},
  "target":{"id":"ds-1002","type":"mysql","database":"dst"},
  "reportUrl":"http://127.0.0.1:3001/api/v1/engine"}'
```

## Mock 行为说明（对应契约「引擎模拟行为」1~7 条）

1. **一个任务一个 goroutine + `context.WithCancel`**：`start` 时创建句柄并登记到 `runs`，`stop` 调用 `cancel`，
   goroutine 感知后回报 `status=stopped` 并退出；`Stop` 会等待 goroutine 结束（上限 `2×tick + reportTimeout`），
   保证 Node 拿到响应时状态已落定。
2. **按 `batchSize` 分片推进**：每个 tick（默认 1s，`MOCK_TICK_MS` 可调）读取一批：`mockReader` 生成
   `min(batchSize, 剩余行数)` 行假数据（`ID/ORDER_NO/CUSTOMER/AMOUNT/STATUS/UPDATE_TIME/ROWID`）并 sleep 模拟耗时；
   `mockWriter` 模拟提交耗时并回报 **写入行数 = 读取行数 × 0.98~1.0 随机**；`progress = readRows / totalRows`（整数百分比）。
3. **每 tick 回报一次进度 + 一批日志**：`POST {reportUrl}/report`（结构见契约 1.4），`POST {reportUrl}/logs`
   （`{instanceId, logs:[{level,message}]}`）。INFO 批次日志形如 `batch 46/100 committed, 1000 rows`；
   失败时上报 ERROR，停止时上报 WARN。回报失败**只写 zap 日志，不中断任务**。
4. **`failureRate` 随机失败**：`start` 时按概率决定该实例是否失败以及失败在第几批（`planFailure`）；命中后在对应批次
   回报 `failed`，带 mock 错误消息（源库 oracle 时如 `ORA-01555: snapshot too old (mock)`，mysql/pg 各有对应报文）。
5. **正常完成**：回报 `success` + `progress=100` 后退出。**增量模式**额外回报推进后的 `currentOffset`
   （以「1 行 = 1 秒」的窗口把 `incrementalColumn` 位点从任务开始前推到当前时间）；全量模式回报分片点位
   `ROWID=0000001500`。
6. **cdc 模式（数据管道）**：请求体带 `pipelineId` + `syncObjects` 且 `syncMode=cdc` 时走 `runCdc` 循环，
   `totalRows` 忽略、`incrementalColumn` 不必填。goroutine 无限运行直至 `stop`：每 tick 捕获随机 **5~80** 条变更并
   累加 `changeRows`（`readRows/writeRows` 同步累加，写入按 0.98~1.0 比例），回报 `currentQps`（10~200 有界随机游走）、
   `lagMs`（300~3000 波动，约 2% 的 tick 尖峰到 6000+ 用于触发延迟告警演示）、`cdcPosition`（`SCN=` 随机基值，每 tick
   递增 500~20000）；`progress` 恒 0、`totalRows` 不回报。INFO 日志形如
   `捕获 30 条变更 (mock), lag=523ms, qps=152, applied=30, SCN=28855616294`。`failureRate>0` 时逐 tick 判定
   （概率 = `failureRate × 0.15`）是否中断，命中后回报 `failed` + ERROR 日志（oracle 如 `LOGMINER session terminated (mock)`，
   mysql/pg 各有对应报文）。停止/失败的终态回报与 full/incremental 走同一套 `finish` 逻辑（独立 context，保证能发出）。
7. **幂等**：同一 `instanceId` 再次下发 → HTTP `409` + `{"code":40901}`（同时查运行中句柄表与状态存储，
   故终态实例也保留幂等记录，直到被保留策略淘汰）；`stop` 对已终态实例幂等返回 `{"stopped":true}`，不存在则 404/40401。
   终态实例按 `engine.max_history`（默认 200）保留，超出后淘汰最早结束的实例。

实例快照（`GET /tasks` / `GET /tasks/:instanceId` 的 `data`）：

```json
{
  "instanceId": "inst-3001", "taskId": "task-2001", "syncMode": "full",
  "status": "running", "progress": 46, "totalRows": 100000,
  "readRows": 46000, "writeRows": 45200, "batchSize": 1000,
  "currentOffset": "ROWID=0000046000", "rateRowsPerSec": 1000,
  "failureRate": 0, "incrementalColumn": "",
  "pipelineId": "", "syncObjects": null, "changeRows": 0, "currentQps": 0, "lagMs": 0, "cdcPosition": "",
  "source": {"id":"ds-1001","type":"oracle","database":"ORCLPDB1"},
  "target": {"id":"ds-1002","type":"mysql","database":"dst"},
  "reportUrl": "http://127.0.0.1:3001/api/v1/engine",
  "startedAt": "2026-09-19T01:00:00Z", "finishedAt": null, "message": null
}
```

数据管道（cdc）实例的同一份快照里，`pipelineId/syncObjects/changeRows/currentQps/lagMs/cdcPosition` 会被填上实时值，
`progress` 恒为 0、`totalRows` 恒为 0：

```json
{
  "instanceId": "inst-3101", "taskId": "pipe-7001", "syncMode": "cdc",
  "status": "running", "progress": 0, "totalRows": 0,
  "readRows": 263, "writeRows": 262, "batchSize": 2000, "rateRowsPerSec": 108,
  "pipelineId": "pipe-7001", "syncObjects": ["APP_USER.T_ORDER", "APP_USER.T_ORDER_ITEM"],
  "changeRows": 263, "currentQps": 133, "lagMs": 1960, "cdcPosition": "SCN=28855668985"
}
```

## 第二阶段替换点

service 层**只依赖接口**、handler 层**只做校验与响应封装**，接真实数据源时这两层代码不动：

| 接口 | 文件 | Mock 实现 | 第二阶段实现 |
|------|------|-----------|--------------|
| `TaskRepository` | `internal/repository/task_repository.go` | `memRepo`（map + `sync.RWMutex`） | Redis / PG 存引擎侧运行态 |
| `reader.Reader` + `reader.Builder` | `internal/infra/reader/reader.go` | `mockReader`（假数据 + 延迟） | `oracle.Reader` / `postgres.Reader`（真实游标与 `ROWID` 位点） |
| `writer.Writer` + `writer.Builder` | `internal/infra/writer/writer.go` | `mockWriter`（延迟 + 0.98~1.0 比例） | `mysql.Writer` / `postgres.Writer`（批量 UPSERT） |
| `reporter.Reporter` + `reporter.Builder` | `internal/infra/reporter/reporter.go` | `httpReporter`（已是真实 HTTP 调用） | 保持不变，或换消息队列 |

替换方式集中在 **`cmd/server/wire/wire.go`**（等价于手写版的 `buildDeps()`）：把 `newReaderBuilder()` 里的
`reader.NewMockBuilder(...)` 换成 `reader.NewOracleBuilder(dsn)` 等，再 `make wire` 重新生成 `wire_gen.go`。
`reader.Builder.Build(ctx, Spec)` 收到的 `Spec` 已带源/目标库信息、表名、增量列、batchSize，以及
`Unbounded`（cdc 日志捕获：源端没有「读到底」的时刻，`TotalRows` 此时无意义；真实实现对应 LogMiner / 逻辑复制槽）。

`Reader.ReadBatch(ctx, batch []map[string]any) (int64, error)` 保持契约签名：调用方预分配长度为 `batchSize` 的切片，
实现填充 `batch[:n]` 并返回实际行数（真实实现里 `n < len(batch)` 表示源表读完）。

## Docker

```bash
docker build -t databridge/engine:mock .
docker run --rm -p 8080:8080 \
  -e NODE_REPORT_URL=http://databridge-admin:3001/api/v1/engine \
  -e MOCK_TICK_MS=1000 \
  databridge/engine:mock
```

多阶段构建（`golang:1.24-alpine` → `alpine:3.20`），`CGO_ENABLED=0` 静态二进制，非 root 运行，
`ENTRYPOINT` 固定带 `-conf config/prod.yml`（监听 `0.0.0.0:8080`），`HEALTHCHECK` 用
`wget -q -O /dev/null http://127.0.0.1:${SERVER_PORT}/health`。仓库根的 `docker-compose.yaml`
与 `deploy/k8s/engine.yaml` 直接引用 `databridge-engine/` 作为 build context，无需额外配置。

## 与契约的实现说明（需要注意的点）

- `GET /health` 的 `{ "status": "ok", "runningTasks": 3 }` 放在统一响应的 `data` 里（第 2 节开头声明引擎所有响应
  都是 `{code,message,data}`）；容器健康检查只看 HTTP 200。
- `start` 请求体的 `reportUrl` 允许缺省（回落 `NODE_REPORT_URL` / `engine.node_report_url`），`failureRate` 缺省视为 0；
  `incremental` 模式缺 `incrementalColumn` → 400/40001（契约第 1.2 节同规则）。
- `totalRows` 由 binding 的 `required` 改为**跨字段校验**：非 cdc 模式必须 `>= 1`（否则 400/40001），
  cdc 模式忽略该字段（下发也会被置 0），以便契约第 2 节第 6 条「totalRows 忽略」成立。
- 额外接受了几个契约未列出的可选字段：`taskName`、`sourceTable`、`targetTable`、`writeMode`，
  只用于日志与真实化占位；Node 不发这些字段也能正常工作。契约第 1.7 节的管道下发还会带
  `pipelineId` / `syncObjects`（引擎侧仅 cdc 模式使用；两者都不是硬性必填，普通任务可以不带）。
- 回报体（契约 1.4）里 `pipelineId/currentQps/lagMs/cdcPosition` 用 `omitempty`：非 cdc 回报**省略这四个键**，
  cdc 回报则一定带上；同理 cdc 回报省略 `totalRows`（契约写「totalRows 为 null」，引擎选择不发这个字段，
  以兼容 Node 侧 `totalRows: Joi.number()` 不接受 `null` 的校验）。
- `Reader.ReadBatch` 在 cdc 下按本 tick 的事件数（5~80）被调用，`cdcPosition` 替代 `currentOffset` 表达位点，
  `readRows/writeRows` 表示累计捕获与已应用的变更行数。
- `GET /api/v1/engine/tasks` 默认返回引擎内全部实例（含终态，便于排查），契约的「运行中任务列表」可用
  `?status=running` 精确获得。
- 未知路径统一返回 `404 / {"code":40401}`；panic 由 `internal/middleware/recovery.go` 兜住并返回
  `500 / {"code":50000}`（不用 `gin.Recovery`，否则响应结构会退化成纯文本）。
- CORS 沿用模板的 `internal/middleware/cors.go`：回显请求 `Origin` + `Allow-Credentials: true`，
  生产建议改白名单或由网关处理；引擎本身设计上只被 Node 管理端调用。
