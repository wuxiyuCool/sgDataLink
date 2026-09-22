# DataBridge 接口契约（Mock 阶段）

> 三端（Vue 前端 / Node 管理后端 / Go 同步引擎）统一遵循本文档。Mock 阶段全部使用内存数据，不连接任何数据库。

## 0. 通用约定

### 统一响应结构（Node → 前端，兼容 vben v2 默认 defHttp 解析）

```json
{
  "code": 0,
  "message": "success",
  "result": { },
  "timestamp": 1700000000000
}
```

- `code`：`0` 成功；非 0 为业务错误码（400xx 参数错误 / 404xx 资源不存在 / 500xx 服务异常）。
- 失败时：`{ "code": 40001, "message": "参数校验失败: name 必填", "result": null }`，HTTP 状态码同步返回 4xx/5xx。

分页响应 `result`：

```json
{ "items": [], "total": 100, "page": 1, "size": 20, "pages": 5 }
```

### 查询参数

| 场景 | 格式 | 示例 |
|------|------|------|
| 分页 | `page` + `size` | `?page=1&size=20` |
| 关键字 | `keyword` | `?keyword=订单` |
| 精确筛选 | 字段名 | `?status=running&syncMode=full` |
| 排序 | `sort=field:asc|desc` | `?sort=createdAt:desc` |

### 枚举

| 枚举 | 取值 |
|------|------|
| 数据源类型 `type` | `oracle` \| `mysql` \| `postgresql` |
| 同步模式 `syncMode` | `full`（全量）\| `incremental`（增量）\| `cdc`（数据管道实时同步） |
| 任务状态 `lastStatus` | `idle` \| `running` \| `success` \| `failed` \| `stopped` |
| 实例状态 `status` | `running` \| `success` \| `failed` \| `stopped` |
| 实例触发方式 `trigger` | `manual` \| `cron` \| `retry` |
| 日志级别 `level` | `INFO` \| `WARN` \| `ERROR` |
| 冲突策略 `writeMode` | `insert` \| `upsert` \| `overwrite` |
| 管道状态 `pipeline.status` | `running` \| `stopped` |
| 数据服务状态 `dataApi.status` | `draft` \| `published` |
| 告警通道 `channel` | `dingtalk` \| `wecom` \| `email` |

字段命名统一 camelCase；时间统一 ISO 8601 字符串（UTC）。ID 为字符串（mock 用 ULID/自增前缀，如 `ds-1001`、`task-2001`、`inst-3001`）。

---

## 1. Node 管理后端（默认端口 3001，前缀 `/api/v1`）

### 1.1 数据源 `/datasources`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/datasources` | 分页列表，支持 keyword/type/status |
| GET | `/datasources/:id` | 详情 |
| POST | `/datasources` | 新增 |
| PUT | `/datasources/:id` | 编辑 |
| DELETE | `/datasources/:id` | 删除（被任务引用时返回 40002） |
| POST | `/datasources/test` | 连通测试（传入未保存的配置） |
| POST | `/datasources/:id/test` | 连通测试（已保存的数据源） |

数据源对象：

```json
{
  "id": "ds-1001",
  "name": "生产Oracle",
  "type": "oracle",
  "host": "10.0.0.11",
  "port": 1521,
  "database": "ORCLPDB1",
  "username": "app_user",
  "password": "***",
  "remark": "源库",
  "status": "enabled",
  "createdAt": "2026-09-01T08:00:00Z",
  "updatedAt": "2026-09-01T08:00:00Z"
}
```

- 响应中 `password` 永远脱敏为 `"***"`；创建/编辑请求体携带明文，服务端仅存内存。

`POST /datasources/test` 请求体 = 数据源对象（不含 id 也可）；响应 `result`：

```json
{ "success": true, "latencyMs": 42, "message": "mock 连接成功" }
```

mock 规则：`host` 以 `10.` 开头或名称含 `fail` 时返回失败，否则成功（便于前端演示两种结果）。

### 1.2 同步任务 `/tasks`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/tasks` | 分页列表，支持 keyword/syncMode/lastStatus |
| GET | `/tasks/:id` | 详情（含 fieldMappings） |
| POST | `/tasks` | 创建全量/增量任务 |
| PUT | `/tasks/:id` | 编辑（running 中禁止编辑，返回 40003） |
| DELETE | `/tasks/:id` | 删除（running 中禁止删除，返回 40003） |
| POST | `/tasks/:id/start` | 下发启动指令 → 调用 Go 引擎，创建运行实例 |
| POST | `/tasks/:id/stop` | 下发停止指令 → 调用 Go 引擎 |
| GET | `/tasks/:id/progress` | 聚合视图：状态+进度+读写行数+当前 offset |
| GET | `/tasks/:id/instances` | 该任务的实例分页列表 |

任务对象：

```json
{
  "id": "task-2001",
  "name": "订单表全量同步",
  "syncMode": "full",
  "sourceId": "ds-1001",
  "sourceTable": "T_ORDER",
  "targetId": "ds-1002",
  "targetTable": "T_ORDER_MIRROR",
  "writeMode": "upsert",
  "batchSize": 1000,
  "incrementalColumn": null,
  "scheduleCron": "0 0 2 * * ?",
  "retryCount": 3,
  "retryIntervalSec": 60,
  "fieldMappings": [
    { "sourceField": "ID", "targetField": "ID", "sourceType": "NUMBER", "targetType": "BIGINT", "primaryKey": true, "transform": null },
    { "sourceField": "NAME", "targetField": "NAME", "sourceType": "VARCHAR2", "targetType": "VARCHAR", "primaryKey": false, "transform": { "type": "upper", "value": null } }
  ],
  "enabled": true,
  "lastStatus": "idle",
  "lastRunAt": null,
  "createdAt": "2026-09-01T08:00:00Z",
  "updatedAt": "2026-09-01T08:00:00Z"
}
```

- `incremental` 模式必须提供 `incrementalColumn`（如 `UPDATE_TIME`），否则 40001。
- 对标 FineDataLink 的调度能力（Mock 阶段仅存储与展示，不真正触发定时调度，第二阶段由 Node 调度器实现）：`scheduleCron`（Quartz 风格 6 位 cron，可为 null 表示手动触发）、`retryCount`（失败重试次数 0~10）、`retryIntervalSec`（重试间隔秒）。
- `fieldMappings[].transform`（对标 FDL 转换组件占位，Mock 阶段仅保存回显，不参与模拟执行）：`null` 或 `{ "type": "none|upper|lower|trim|constant|expression", "value": "常量值或表达式" }`。

`POST /tasks/:id/start` 响应 `result`（同步返回，Node 调引擎成功后落库）：

```json
{ "taskId": "task-2001", "instanceId": "inst-3001", "status": "running" }
```

`GET /tasks/:id/progress` 响应 `result`：

```json
{
  "taskId": "task-2001",
  "instanceId": "inst-3001",
  "status": "running",
  "progress": 46,
  "totalRows": 100000,
  "readRows": 46000,
  "writeRows": 45200,
  "currentOffset": "UPDATE_TIME=2026-09-18T12:00:00Z/ROWID=aaa",
  "rateRowsPerSec": 2300,
  "startedAt": "2026-09-19T01:00:00Z",
  "finishedAt": null,
  "message": null
}
```

### 1.3 任务运行实例 `/task-instances`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/task-instances` | 分页列表，支持 taskId/status |
| GET | `/task-instances/:id` | 实例详情 |
| GET | `/task-instances/:id/logs` | 实例日志分页，支持 level 筛选 |
| GET | `/task-instances/:id/offsets` | 实例 offset 点位分页 |

实例对象：

```json
{
  "id": "inst-3001",
  "taskId": "task-2001",
  "taskName": "订单表全量同步",
  "syncMode": "full",
  "status": "running",
  "progress": 46,
  "totalRows": 100000,
  "readRows": 46000,
  "writeRows": 45200,
  "startedAt": "2026-09-19T01:00:00Z",
  "finishedAt": null,
  "message": null
}
```

日志对象：

```json
{
  "id": "log-5001",
  "instanceId": "inst-3001",
  "taskId": "task-2001",
  "level": "INFO",
  "message": "batch 46/100 committed, 1000 rows",
  "createdAt": "2026-09-19T01:05:00Z"
}
```

Offset 对象（增量点位 / 全量分片点位统一结构）：

```json
{
  "id": "ofs-6001",
  "taskId": "task-2001",
  "instanceId": "inst-3001",
  "shardKey": "default",
  "offsetValue": "UPDATE_TIME=2026-09-18T12:00:00Z",
  "updatedAt": "2026-09-19T01:05:00Z"
}
```

### 1.4 引擎回调 `/engine`（仅供 Go 引擎调用，Mock 阶段不鉴权）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/engine/report` | 上报状态/进度 |
| POST | `/engine/logs` | 批量上报日志 |

`POST /engine/report` 请求体：

```json
{
  "instanceId": "inst-3001",
  "taskId": "task-2001",
  "pipelineId": null,
  "status": "running",
  "progress": 46,
  "totalRows": 100000,
  "readRows": 46000,
  "writeRows": 45200,
  "currentOffset": "UPDATE_TIME=2026-09-18T12:00:00Z",
  "rateRowsPerSec": 2300,
  "currentQps": null,
  "lagMs": null,
  "cdcPosition": null,
  "message": null
}
```

- `pipelineId`/`currentQps`/`lagMs`/`cdcPosition` 仅 cdc 管道回报时携带（此时 progress 恒为 0、totalRows 为 null）。

响应 `result`: `{ "accepted": true }`

`POST /engine/logs` 请求体：

```json
{
  "instanceId": "inst-3001",
  "logs": [ { "level": "INFO", "message": "..." }, { "level": "ERROR", "message": "..." } ]
}
```

响应 `result`: `{ "accepted": 2 }`

### 1.5 运维统计 `/statistics`（对标 FDL 运维监控大盘）

`GET /statistics/overview` 响应 `result`：

```json
{
  "datasourceTotal": 3,
  "taskTotal": 5,
  "runningInstances": 1,
  "todayTotal": 8,
  "todaySuccess": 6,
  "todayFailed": 1,
  "todayStopped": 1,
  "recentTrend": [
    { "date": "2026-09-15", "success": 4, "failed": 0 },
    { "date": "2026-09-16", "success": 5, "failed": 1 }
  ]
}
```

`recentTrend` 固定返回最近 7 天（含当天）按实例 `startedAt` 日期聚合的成败数量。

### 1.6 实例触发方式补充

实例对象增加 `trigger` 字段（`manual|cron|retry`）。Node 端真实行为（Mock 阶段即实现）：

- **定时调度**：任务 `enabled=true` 且 `scheduleCron` 非空时，Node 内置调度器每分钟匹配一次（支持 6 位 Quartz 子集：`秒 分 时 日 月 周`，字段支持 `*`、`?`、具体数字；如 `0 0 2 * * ?` = 每天 02:00 UTC 触发），命中即自动 start（trigger=cron）；running 中的任务跳过并记 WARN 日志。
- **失败重试**：收到 `failed` 回报后，若该实例累计重试次数 < 任务 `retryCount`，则等待 `retryIntervalSec` 秒后自动重新下发（trigger=retry），日志记录 `第 N 次重试`。

### 1.7 数据管道（CDC）`/pipelines`

对标 FDL 数据管道：整库/多表实时镜像，只做搬运。Mock 阶段由 Go 引擎 `cdc` 模式模拟日志捕获（不接真实 CDC）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/pipelines` | 分页列表（支持 keyword/status） |
| GET / POST / PUT / DELETE | `/pipelines/:id` | CRUD（running 禁止改删，40003） |
| POST | `/pipelines/:id/start` | 启动管道 → 引擎 cdc 模式 |
| POST | `/pipelines/:id/stop` | 停止管道 |
| GET | `/pipelines/:id/status` | 实时状态（前端 3s 轮询） |

管道对象：

```json
{
  "id": "pipe-7001",
  "name": "订单库实时镜像",
  "sourceId": "ds-1001",
  "targetId": "ds-1002",
  "syncObjects": ["APP_USER.T_ORDER", "APP_USER.T_ORDER_ITEM"],
  "ddlPolicy": "ignore",
  "status": "running",
  "runningInstanceId": "inst-3101",
  "lastError": null,
  "createdAt": "2026-09-01T08:00:00Z",
  "updatedAt": "2026-09-01T08:00:00Z"
}
```

`ddlPolicy`：`ignore|report`（DDL 变更策略占位）。`GET /pipelines/:id/status` 响应 `result`：

```json
{
  "pipelineId": "pipe-7001",
  "instanceId": "inst-3101",
  "status": "running",
  "changeRows": 12480,
  "currentQps": 46,
  "lagMs": 820,
  "cdcPosition": "SCN=28461937451",
  "startedAt": "2026-09-19T01:00:00Z"
}
```

### 1.8 数据开发（ETL 编排）`/dataflows`

对标 FDL 数据开发画布：节点=读库/转换/SQL/校验/输出，Mock 阶段保存画布 JSON，`run` 时由引擎按 full 模式模拟执行。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dataflows` | 分页列表 |
| GET / POST / PUT / DELETE | `/dataflows/:id` | CRUD（保存画布 JSON） |
| POST | `/dataflows/:id/run` | 模拟运行 → 创建实例，返回 `{ dataflowId, instanceId, status }` |
| POST | `/dataflows/:id/stop` | 停止 |
| GET | `/dataflows/:id/progress` | 运行进度（同任务 progress 结构，taskId 换 dataflowId） |

数据开发对象：

```json
{
  "id": "df-7501",
  "name": "订单宽表加工",
  "nodes": [
    { "id": "n1", "type": "input", "name": "读Oracle T_ORDER", "config": { "datasourceId": "ds-1001", "table": "T_ORDER" } },
    { "id": "n2", "type": "filter", "name": "过滤无效单", "config": { "condition": "STATUS != 'INVALID'" } },
    { "id": "n3", "type": "join", "name": "关联明细", "config": { "joinType": "left", "on": "ORDER_ID" } },
    { "id": "n4", "type": "validate", "name": "质量校验", "config": { "rules": ["ID not null"] } },
    { "id": "n5", "type": "output", "name": "写MySQL 宽表", "config": { "datasourceId": "ds-1002", "table": "T_ORDER_WIDE", "writeMode": "overwrite" } }
  ],
  "edges": [ { "source": "n1", "target": "n2" }, { "source": "n2", "target": "n3" }, { "source": "n3", "target": "n4" }, { "source": "n4", "target": "n5" } ],
  "scheduleCron": null,
  "retryCount": 3,
  "retryIntervalSec": 60,
  "enabled": true,
  "lastStatus": "idle",
  "createdAt": "2026-09-01T08:00:00Z",
  "updatedAt": "2026-09-01T08:00:00Z"
}
```

节点 `type` 枚举：`input | output | filter | transform | join | union | sql | json_parse | validate`（画布组件清单，Mock 阶段仅保存/回显，run 时取首尾 input/output 拼引擎快照）。

### 1.9 数据服务（Data API）`/data-apis`

对标 FDL 数据服务：把表一键发布为 REST API，带鉴权/白名单/限流/调用统计。Mock 阶段返回程序生成的假数据行，**鉴权/限流逻辑真实生效**。

管理接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/data-apis` | 分页列表 |
| GET / POST / PUT / DELETE | `/data-apis/:id` | CRUD |
| POST | `/data-apis/:id/publish` | 发布（生成 apiKey，状态 published） |
| POST | `/data-apis/:id/unpublish` | 下线 |
| POST | `/data-apis/:id/invoke` | 前端"调试"按钮代理调用（透传 runtime 结果） |
| GET | `/data-apis/:id/stats` | 调用统计（invokeCount/errorCount/avgLatencyMs/recentTrend 最近7天） |

数据服务对象：

```json
{
  "id": "api-8001",
  "name": "订单查询服务",
  "path": "order-query",
  "method": "GET",
  "datasourceId": "ds-1002",
  "tableName": "T_ORDER_MIRROR",
  "fields": [ { "name": "ID", "type": "BIGINT" }, { "name": "AMOUNT", "type": "DECIMAL" } ],
  "queryParams": [ { "name": "minAmount", "type": "number", "required": false } ],
  "authEnabled": true,
  "apiKey": "dk-9f3a...",
  "rateLimitQps": 20,
  "ipWhitelist": [],
  "status": "published",
  "invokeCount": 138,
  "errorCount": 2,
  "avgLatencyMs": 14,
  "createdAt": "2026-09-01T08:00:00Z",
  "updatedAt": "2026-09-01T08:00:00Z"
}
```

运行时端点（对外数据服务总线，**不在** `/api/v1` 管理前缀内）：

```
GET  /ds/{path}?{queryParams}&page=1&size=20
Header: X-API-Key: dk-9f3a...   （authEnabled=true 时必需）
```

- 成功：`{ "code": 0, "message": "success", "result": { "fields": ["ID","AMOUNT"], "rows": [[1, 99.5]], "total": 57, "page": 1, "size": 20 } }`
- 错误：401 `{code:40101}` 未提供 API Key / 40102 无效 Key；403 `{code:40301}` IP 不在白名单；429 `{code:42901}` 超过限流 QPS；404 `{code:40404}` 未发布或路径不存在。
- Mock 行为：按 tableName+fields 生成确定性伪随机行（同一 page 结果稳定），支持 `limit/page/size`；每次调用累加 invokeCount/延迟统计；限流用内存滑动窗口按 `rateLimitQps` 真实拦截。

### 1.10 任务运维补充

**告警规则 `/alert-rules`**（CRUD）+ **告警记录 `/alert-records`**（GET 分页，支持 level/read 筛选；PATCH `/alert-records/:id/read` 标记已读）：

```json
{
  "id": "ar-9001",
  "name": "同步失败钉钉告警",
  "scope": "all",
  "conditions": ["task_failed", "pipeline_error", "lag_over_threshold"],
  "thresholdLagMs": 5000,
  "channels": [ { "type": "dingtalk", "webhook": "https://oapi.dingtalk.com/robot/send?access_token=MOCK" } ],
  "enabled": true,
  "createdAt": "2026-09-01T08:00:00Z"
}
```

Mock 触发链路：实例 failed / 管道 lastError / 管道 lagMs 超阈值时，若规则匹配则写入 alert-record（`{ id, ruleId, ruleName, level, targetType, targetId, targetName, message, channel, channelResult: "mock-sent", createdAt, read: false }`），不发真实 webhook（第二阶段接入）。

**数据血缘 `/lineage/graph`**：由数据源+任务+管道+数据开发+数据服务聚合生成表级血缘：

```json
{
  "nodes": [
    { "id": "ds-1001", "type": "datasource", "name": "生产Oracle" },
    { "id": "ds-1001:T_ORDER", "type": "table", "name": "T_ORDER" },
    { "id": "task-2001", "type": "task", "name": "订单表全量同步" },
    { "id": "ds-1002:T_ORDER_MIRROR", "type": "table", "name": "T_ORDER_MIRROR" }
  ],
  "edges": [
    { "source": "ds-1001", "target": "ds-1001:T_ORDER" },
    { "source": "ds-1001:T_ORDER", "target": "task-2001" },
    { "source": "task-2001", "target": "ds-1002:T_ORDER_MIRROR" }
  ]
}
```

`type`：`datasource|table|task|pipeline|dataflow|dataapi`（dataflow 按其 nodes 的 input/output 生成链，dataapi 连到其 tableName）。

### 1.11 健康检查

`GET /api/v1/health` → `{ "code": 0, "result": { "status": "ok", "service": "databridge-admin", "mock": false, "storage": "mysql|memory", "memoryMode": "mysql://host:port/dataLink" } }`

- `storage`/`mock` 反映**存储层开关**（env `DB_DRIVER=mysql|memory`）；Go 引擎侧始终是模拟器，不受该开关影响。

---

## 2. Go 同步引擎（默认端口 8080，前缀 `/api/v1/engine`）

引擎响应结构（Node 调用，不直接暴露给浏览器）：

```json
{ "code": 0, "message": "success", "data": { } }
```

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 `{ "status": "ok", "runningTasks": 3 }` |
| POST | `/api/v1/engine/tasks/start` | 接收启动指令，拉起 goroutine 模拟同步 |
| POST | `/api/v1/engine/tasks/stop` | 接收停止指令 |
| GET | `/api/v1/engine/tasks` | 当前引擎内运行中任务列表 |
| GET | `/api/v1/engine/tasks/:instanceId` | 单实例模拟状态快照 |

`POST /tasks/start` 请求体（Node 下发完整任务快照，引擎无状态依赖）：

```json
{
  "taskId": "task-2001",
  "instanceId": "inst-3001",
  "syncMode": "full",
  "batchSize": 1000,
  "totalRows": 100000,
  "failureRate": 0,
  "incrementalColumn": null,
  "source": { "id": "ds-1001", "type": "oracle", "database": "ORCLPDB1" },
  "target": { "id": "ds-1002", "type": "mysql", "database": "dst" },
  "reportUrl": "http://databridge-admin:3001/api/v1/engine"
}
```

- `failureRate`（0~1）：模拟任务中途失败概率，演示失败态；0 表示必定成功。
- `reportUrl`：引擎回报 Node 的地址（容器内用服务名，本地调试用 `http://127.0.0.1:3001/api/v1/engine`）。

响应：`{ "code": 0, "message": "success", "data": { "accepted": true, "instanceId": "inst-3001" } }`；
同一 `instanceId` 重复下发返回 409 / `code: 40901`（幂等）。

`POST /tasks/stop` 请求体：`{ "instanceId": "inst-3001" }` → `data: { "stopped": true }`；不存在返回 404 / `code: 40401`。

### 引擎模拟行为（Mock 规格）

1. 每个任务一个 goroutine + `context.WithCancel`；停止指令通过 cancel 终止，回报 `stopped`。
2. 按 `batchSize` 分片推进：每 tick（默认 1s，可配置 `MOCK_TICK_MS`）增加一批"已读/已写"行数（写入行数 = 读取行数 × 0.98~1.0 随机），进度 = readRows/totalRows。
3. 每 tick 向 `reportUrl/report` POST 一次进度；日志按批向 `/logs` 批量上报（含 INFO 批次日志；失败时上报 ERROR）。
4. `failureRate > 0` 时随机决定该任务是否失败，失败点也随机；失败后状态回报 `failed` 并带 `message`（mock 错误如 `ORA-01555: snapshot too old (mock)`）。
5. 正常完成后回报 `success`、progress=100，goroutine 退出；增量模式额外回报最终 `currentOffset`（模拟推进 `incrementalColumn` 位点）。
6. **cdc 模式（数据管道）**：请求体带 `pipelineId`、`syncObjects`（表名数组），`totalRows` 忽略。goroutine 无限运行直至 stop：每 tick 模拟捕获一批变更事件（changeRows 累加，每 tick 增量 = 随机 5~80），回报 `currentQps`（10~200 随机游走）、`lagMs`（300~3000 波动，约 2% 概率尖峰到 6000+ 用于触发延迟告警演示）、`cdcPosition`（`SCN=` 起始值按 tick 递增）；`failureRate>0` 时可能中途回报 `failed` + mock 日志（如 `LOGMINER session terminated (mock)`）。停止回报 `stopped`。
7. 内存实现必须走接口（见下），第二阶段替换 Oracle/PG 真实实现时不改 handler/service。

### Go 引擎分层接口（第二阶段替换点）

```go
// internal/repository — 状态存储
type TaskRepository interface {
    Save(ctx context.Context, t *model.MockTask) error
    Get(ctx context.Context, instanceID string) (*model.MockTask, bool)
    List(ctx context.Context) []*model.MockTask
    Remove(ctx context.Context, instanceID string) error
}
// internal/infra/reader / writer — 数据读写（第二阶段换 Oracle 实现）
type Reader interface {
    TotalRows(ctx context.Context) (int64, error)
    ReadBatch(ctx context.Context, batch []map[string]any) (int64, error) // mock: 生成假数据
}
type Writer interface {
    WriteBatch(ctx context.Context, batch []map[string]any) (int64, error)
}
// internal/infra/reporter — 回报 Node
type Reporter interface {
    Report(ctx context.Context, r *dto.ProgressReport) error
    ReportLogs(ctx context.Context, instanceID string, logs []dto.LogItem) error
}
```

Mock 实现：`memRepo`（map+RWMutex）、`mockReader`/`mockWriter`（假数据+延迟）、`httpReporter`（真实 HTTP，指向 Node mock）。

---

## 3. 前端调用约定

- vben-admin v2.8（UI 组件为 ant-design-vue），API 模块放 `src/api/databridge/*.ts`，视图放 `src/views/databridge/*`。
- dev 代理：`/api` → `http://127.0.0.1:3001`（vite proxy 或 `VITE_GLOB_API_URL`）。
- 轮询：任务监控/进度页面用 3s `setInterval` 轮询 `GET /tasks/:id/progress` 与日志接口（Mock 阶段不做 WebSocket）。

## 4. 服务地址与环境变量

| 服务 | 端口 | 关键环境变量 |
|------|------|------|
| databridge-admin (Node) | 3001 | `NODE_ENV`、`PORT`、`ENGINE_BASE_URL`（引擎地址）、`MOCK=true`（跳过 MongoDB 连接）、**`DB_DRIVER`**（`memory` \| `mysql`，默认 `memory`）、`MYSQL_HOST`/`MYSQL_PORT`/`MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DATABASE`/`MYSQL_CONNECTION_LIMIT`（`DB_DRIVER=mysql` 时生效） |
| databridge-engine (Go) | 8080 | `SERVER_PORT`、`NODE_REPORT_URL`、`MOCK_TICK_MS` |
| databridge-web (Vue) | 80(容器)/5173(dev) | `VITE_GLOB_API_URL` |

`DB_DRIVER=mysql` 时管理后端把 11 类实体落到同一 MySQL 库的 `databridge_*` 表
（datasource / sync_task / task_instance / run_log / offset / pipeline / dataflow / data_api /
data_api_call_day / alert_rule / alert_record + `databridge_id_seq` 取号表），
启动时逐表 `CREATE TABLE IF NOT EXISTS`（MySQL 5.7+，逐表显式 `utf8mb4 / utf8mb4_unicode_ci`），
并只在 `databridge_datasource` 为空表时注入上表所列的种子数据；
接口路径、出入参结构与错误码与 `DB_DRIVER=memory` 完全一致（契约不变），
差异只有：时间统一按 `YYYY-MM-DDTHH:mm:ss.sssZ` 回显、`POST /datasources/{id,}/test` 对
`type=mysql` 的数据源改为真实建连测试。滑动窗口限流计数、调度器 `lastTriggerAt`、
失败重试排程定时器仍是内存态。表清单与启动步骤见 `node-express-boilerplate/README.md` 第 3.1 节。
