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
| 指标类型 `metric.type`（1.12） | `ATOMIC`（原子）\| `DERIVED`（派生）\| `COMPOSITE`（复合）；由 defineType+defineParams 规则推导，不人工填 |
| 指标定义方式 `metric.defineType`（1.12） | `MEASURE`（字段+聚合）\| `FIELD`（手写聚合 SQL 片段）\| `METRIC`（引用其他指标） |
| 数据分层 `model.layer`（1.12） | `ODS` \| `DIM` \| `DWD` \| `DWS` \| `ADS` |
| 指标状态 `metric.status`（1.12） | `draft` \| `online` \| `offline` |
| 问数结果 `chat.status`（1.12） | `success` \| `corrected` \| `clarify` \| `failed` |

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

连通测试行为按存储驱动区分：`DB_DRIVER=mysql`（真实模式）时 mysql 类型走 mysql2 真实握手，oracle/postgresql 走真实 TCP 可达探测（账号校验二阶段接驱动后补全）；`DB_DRIVER=memory`（演示模式）时保留 mock 规则：`host` 以 `10.` 开头或名称含 `fail` 返回失败，否则成功。

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
  "execMode": "real",
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

- `execMode` 取自最新实例（见 1.3）；该任务还没有实例时为 `null`。

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
  "execMode": "real",
  "progress": 46,
  "totalRows": 100000,
  "readRows": 46000,
  "writeRows": 45200,
  "startedAt": "2026-09-19T01:00:00Z",
  "finishedAt": null,
  "message": null
}
```

- `execMode`：`real`（引擎真实读写源/目标库）| `simulate`（引擎按第 2 节 Mock 规格模拟推进）| `null`
  （本次改造之前落库的历史实例，没有该列）。判定规则见 4.1，字段随实例列表/详情/进度一并返回。
- `DB_DRIVER=mysql` 下 `simulate` 的实例会额外写一条 WARN 日志
  「本次为模拟执行（数据源类型或驱动不支持真实读写）」，供实例日志页与「模拟」Tag 使用。

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

### 1.4 引擎回调 `/engine`（仅供 Go 引擎调用；共享密钥鉴权见第 2 节开头，空配置期放行）

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
  ],
  "datasourceTypes": [
    { "type": "oracle", "count": 1 },
    { "type": "mysql", "count": 2 },
    { "type": "postgresql", "count": 0 }
  ],
  "taskModeDistribution": [
    { "mode": "full", "count": 2 },
    { "mode": "incremental", "count": 3 },
    { "mode": "cdc", "count": 1 },
    { "mode": "dataflow", "count": 1 }
  ],
  "runningPipelines": { "count": 1, "maxLagMs": 820 },
  "topDataApis": [
    { "id": "api-8001", "name": "订单查询服务", "path": "order-query", "invokeCount": 138, "errorCount": 2, "avgLatencyMs": 14 }
  ],
  "dataApiTotal": 4,
  "publishedDataApis": 4,
  "recentAlerts": [
    { "id": "rec-9501", "level": "WARN", "targetName": "订单库实时镜像", "message": "数据管道 订单库实时镜像 同步延迟 7564ms，已超过告警阈值", "createdAt": "2026-09-22T04:18:20.995Z", "read": false }
  ],
  "recentLogs": [
    { "id": "log-5001", "level": "INFO", "message": "捕获 58 条变更 (mock)", "instanceId": "inst-3101", "taskId": null, "createdAt": "2026-09-22T04:23:18.045Z", "taskName": "订单库实时镜像" }
  ],
  "todayRunning": 2,
  "weekSuccessRate": 75
}
```

- `recentTrend` 固定返回最近 7 天（含当天）按实例 `startedAt` 日期聚合的成败数量。

`dataApiCallStats`（数据服务监控大屏用）：`{ total, success, error, errorRate(0-100 一位小数), avgLatencyMs, todaySuccess, todayError, dayTrend: [{date, success, error}] }`（dayTrend 最近 7 天，按调用明细日志聚合）。
- 大盘新增字段（前端单接口取数，不再逐模块轮询列表页）：
  - `datasourceTypes`：按数据源 `type` 分组计数，`oracle|mysql|postgresql` 三类恒定输出（计数为 0 也给出）。
  - `taskModeDistribution`：`full|incremental` 取同步任务 `syncMode`，`cdc` 取数据管道总数，`dataflow` 取数据开发总数（四类恒定输出）。
  - `runningPipelines`：`status=running` 的管道数与其中最大 `lagMs`；无运行管道时 `maxLagMs` 为 `null`（区别于「延迟 0ms」）。
  - `topDataApis`：仅 `published`，按 `invokeCount` 降序前 5 条；`dataApiTotal` / `publishedDataApis` 为同一次查询算出的总量与已发布量（大盘 KPI 卡用，避免前端再打列表接口）。
  - `recentAlerts`：告警记录（契约 1.10）最新 8 条，`read` 缺省按 `false` 输出。
  - `recentLogs`：`run_log` 最新 15 条（`createdAt` 倒序）；`taskName` 为可选补充，由实例表反查，解析不到为 `null`。
  - `todayRunning`：当前 running 实例数（任务 / 数据开发 / 管道实例同表，故恒等于 `runningInstances`，保留独立字段供大盘卡片区使用）。
  - `weekSuccessRate`：`recentTrend` 7 天合计 `success/(success+failed)`，0-100 保留 1 位小数；7 天内无 success/failed 实例时为 `null`。
- **容错约定**：以上 6 组子聚合各自独立 try/catch，任一数据源查询失败只回退成 `[]` / `{ count: 0, maxLagMs: null }` / `null` 并记 warn 日志，不影响 overview 整体返回。

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
  "cdcPollColumn": "UPDATE_TIME",
  "pollIntervalSec": 5,
  "status": "running",
  "runningInstanceId": "inst-3101",
  "lastError": null,
  "createdAt": "2026-09-01T08:00:00Z",
  "updatedAt": "2026-09-01T08:00:00Z"
}
```

- `cdcPollColumn`（`string|null`，最长 128）：真实 cdc 的轮询增量列（时间列 / 自增列，见第 5 节），
  `null` 表示未配置；仅 `mode:"real"` 的快照会把它连同 `pollIntervalSec` 下发给引擎。
- `pollIntervalSec`（`number`，整数 1~3600，默认 `5`）：每多少秒拉一轮增量。
  两项在 simulate 模式下被引擎忽略（模拟链路不读库）。

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
  "cdcPollColumn": "UPDATE_TIME",
  "pollIntervalSec": 5,
  "execMode": "real",
  "startedAt": "2026-09-19T01:00:00Z"
}
```

- `execMode` 取该管道运行中实例的执行模式，管道已停止时退到最近一次实例（都没有则 `null`）。

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

#### 1.8.1 内存流水线执行引擎与扩展节点（pivot / script / json）

画布中出现 `pivot | script | json` 任一**新节点**时，`run` 改由 Node 侧内存流水线真实执行（`DB_DRIVER=mysql` 前提，与指标任务同口径）；**不含新节点的旧画布行为完全不变**（仍走引擎快照模拟）。流水线规则：

- 拓扑序执行，一期**单 input、单 output**（多源/多汇 40001）；`filter/transform/join/union/sql/validate` 在流水线中**透传并告警**（"该节点尚未真实执行"），不阻断。
- input 经引擎 `/sql/query` 读表（`SELECT * FROM t`，上限 `limitRows` 默认 50000，超限报错不截断）。
- output 经 `/sql/exec` 批量 INSERT（500 行/批）；`writeMode: overwrite`（先 TRUNCATE）| `insert`（仅追加，缺省）；`upsert` 流水线暂不支持（40001）；目标表必须已存在（列取首行键集，缺列由 INSERT 报错暴露）。

**新节点 config 契约**：

```json
{ "type": "pivot", "config": {
    "mode": "to_columns",
    "groupBy": ["ORG_ID"], "pivotColumn": "METRIC_NAME", "valueColumn": "METRIC_VALUE", "agg": "sum",
    "columns": ["A_NUM", "B_NUM"] } }
```
`mode=to_columns`（行转列：groupBy 保留，pivotColumn 的值生成新列，agg ∈ sum/count/avg/min/max/first，columns 缺省自动收集值域）；`mode=to_rows`（列转行：`unpivotColumns` 展开为 nameColumn/valueColumn 两列）。

```json
{ "type": "script", "config": {
    "code": "const out = []; for (const row of $input) { out.push({ ID: row.id, URL: row.url }) } return out",
    "timeoutMs": 30000, "env": { "TOKEN": "***" } } }
```
JS 脚本在 **worker_threads + node:vm 沙箱**执行（进程内隔离，超时 worker 强杀；上限 120s，默认 30s）；可用全局仅 `$input`（上游行数组）、`$env`（config.env 键值）、受限 `fetch`（http/https、单响应 2MB、禁云元址/链路本地——同 1.9.3 SSRF 红线）、`console`（输出并入运行日志）；**无 require/process/fs/child_process**。脚本 `return` 数组作为下游数据（爬虫场景：入参表给 URL 清单，脚本抓取返回结果行）。

```json
{ "type": "json", "config": { "mode": "parse", "column": "PAYLOAD", "keys": ["a", "b.c"], "onError": "null" } }
```
`mode=parse`（字符串列按 JSON 解析，`keys` 按点路径抽字段成列，缺省整列转对象）、`stringify`（对象列序列化字符串，`pretty` 可美化）、`format`（仅校验/规整字符串列，`pretty|compact`）；`onError ∈ null|skip|fail`（默认 null：坏数据置空不中断）。

**预览接口**：`POST /dataflows/preview`（body=画布 {nodes,edges}，不落库不写表）→ 执行到 output 前截断，返回 `{ stages: [{nodeId, name, type, rows}], sample: 前50行, warnings }`，供画布调试三新节点。运行记录：流水线模式创建实例走同一 run 结构，`remark` 记录各节点行数与告警。

### 1.9 数据服务（Data API）`/data-apis`

对标 FDL 数据服务：把表一键发布为 REST API，带鉴权/白名单/限流/调用统计。Mock 阶段返回程序生成的假数据行，**鉴权/限流逻辑真实生效**。

管理接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/data-apis` | 分页列表 |
| GET | `/data-apis/calls` | **调用明细日志（审计）**分页：参数 `apiId?`、`result?`(`success|error`)、`keyword?`（服务名/路径）、`apiName?`（服务名模糊）、`content?`（调用内容模糊：脱敏 query 或错误信息）、`startTime?`/`endTime?`（ISO 时间，闭区间，按 UTC 存储比对）；item：`{id, apiId, apiName, path, method, httpStatus, bizCode, ok, latencyMs, ip, query, errorMsg, createdAt}`（query 中 apiKey 脱敏；表滚动保留最近 5000 条；明细不随 API 删除而消失） |
| GET | `/data-apis/:id` | CRUD |
| POST / PUT / DELETE | `/data-apis/:id` | CRUD |
| POST | `/data-apis/:id/publish` | 发布（生成 apiKey，状态 published） |
| POST | `/data-apis/:id/unpublish` | 下线 |
| POST | `/data-apis/:id/invoke` | 前端"调试"按钮代理调用（透传 runtime 结果）。body `{page?, size?, queryParams?, apiKey?}`：`apiKey` 传字符串（含空串）以入参为准（可复现 40101/40102），完全不带则回落服务端已存 key |
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
- 数据来源按驱动模式：`DB_DRIVER=mysql`（真实模式）→ **按绑定数据源真实查询**（mysql 用 mysql2、oracle 用 oracledb thin 纯 JS 驱动，ROWNUM 分页兼容 11g+；表名/字段名走标识符白名单校验，queryParams 过滤值绑定传参防注入；查询失败返回 502 `{code:50003}` 并透传真实数据库错误如 ORA-00904）；`DB_DRIVER=memory`（演示模式）→ 按 tableName+fields 生成确定性伪随机行。两种模式均支持 `limit/page/size`，每次调用累加 invokeCount/延迟统计，限流用内存滑动窗口按 `rateLimitQps` 真实拦截。postgresql 真实查询二阶段接入。

#### 1.9.1 元数据浏览（配置期辅助）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/data-apis/meta/tables?datasourceId=xxx&keyword=` | 列出该数据源可查表（真实模式查 information_schema / ALL_TABLES，单次上限 5000 行；memory 模式返回内置演示表）。keyword 可选走 LIKE（Oracle 已显式 ESCAPE）；**前端约定**：切数据源时不带 keyword 拉全量，之后输入走本地内存过滤，不实时请求 |
| GET | `/data-apis/meta/columns?datasourceId=xxx&tableName=yyy` | 列出表字段 |

响应 `result`：

```json
// tables
[ { "name": "IR_CM_MEASURE", "comment": "计量单" } ]
// columns
[ { "name": "SID", "type": "NUMBER", "nullable": false, "comment": "主键" } ]
```

错误：40401 数据源不存在；50003 元数据查询失败（透传真实库错误）。Oracle 元数据按 `owner = 数据源 username 大写` 过滤；`tableName` 必须过标识符白名单，查询本身全绑定参数。

#### 1.9.2 自定义 SQL 模式

数据服务对象新增字段：

```json
{
  "sqlMode": "builder",
  "customSql": "SELECT sid, ms_bill_id, amount FROM ir_cm_measure WHERE status = :status AND created >= TO_DATE(:startTime,'YYYY-MM-DD HH24:MI:SS') AND org_id IN (:orgIds)",
  "queryParams": [
    { "name": "status", "type": "string", "required": true },
    { "name": "startTime", "type": "date", "required": false },
    { "name": "orgIds", "type": "list", "required": true }
  ]
}
```

- `sqlMode`：`builder`（默认，按 tableName+fields 拼 SELECT）| `custom`（执行 customSql）。
- 运行时（custom）：请求 query 参数按 `queryParams[].type` 处理后**一律绑定变量注入**，绝不拼进 SQL 字符串：
  - `string/number` → 标量绑定；`:name` 占位符 mysql 驱动转 `?`（按出现顺序），oracle 原生 `:name`。
  - `date` → 按字符串绑定，格式转换交给 SQL 内的 `TO_DATE/STR_TO_DATE`（由编写者显式声明，避免时区歧义）。
  - `list` → 值为逗号分隔字符串或重复参数；展开为 `IN (:orgIds__0,:orgIds__1,…)` 逐元素绑定，**元素上限 1000**（Oracle IN 限制），空列表报 40001。
- **安全红线（服务端强制校验 customSql）**：
  1. 规范化后必须以 `SELECT` 或 `WITH` 开头；禁止多语句（去尾分号后仍含 `;` 拒绝）。
  2. 关键字黑名单（词边界匹配）：`INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|EXECUTE|CALL|BEGIN|LOCK|RENAME`；`UNION` 允许（仍为只读）。
  3. 行数硬上限：外层再套 ROWNUM/LIMIT `MAX_SIZE(500)`；驱动调用超时 10s（oracle `connection.callTimeout`，mysql 计时销毁）。
  4. 凭据不出后端：元数据与查询都经服务端用存储的数据源连接执行；错误消息透传数据库原文但不含连接串/密码。
  5. builder 模式沿用表名/列名标识符白名单 + 值绑定；两种模式的过滤值都不参与 SQL 文本拼接。
- 保存时（POST/PUT）即校验 customSql 与 queryParams 一致性（custom 模式下 customSql 必填、占位符集合 ⊆ queryParams），违规 40001。

#### 1.9.3 API 转发模式（请求转调其他系统）

`sqlMode` 新增第三值 `forward`：`/ds/{path}` 在**鉴权/白名单/限流/统计照常执行**的前提下，把请求转调配置的目标系统 API，并**原样透传**下游状态码与响应体（不再包 {code:0,...} 信封）。

数据服务对象新增字段：

```json
{
  "sqlMode": "forward",
  "forwardUrl": "http://10.45.x.x:8080/external/bill/:billNr",
  "forwardMethod": "GET",
  "forwardHeaders": [ { "name": "Authorization", "value": "Bearer :token" } ],
  "forwardBodyTemplate": null,
  "forwardTimeoutMs": 10000,
  "forwardPassthroughQuery": true
}
```

- `forwardUrl`（必填）：仅允许 `http/https` 绝对地址；路径/查询中的 `:name` 占位符用请求参数值替换（自动 URL 编码）。
- `forwardMethod`：`GET`（默认）| `POST`。POST 时发送 `forwardBodyTemplate`（`:name` 替换后按 JSON 解析，解析失败按 text/plain 原样发送；模板内值替换发生在服务端，调用方无法注入 header/body 结构）。
- `forwardHeaders`：固定下游请求头（值支持 `:name` 占位符）；**调用方自带 header 一律不下传**（防 X-API-Key/Cookie 泄漏）；日志中 `Authorization`/`X-API-Key`/`Cookie` 值脱敏。
- `forwardPassthroughQuery`（默认 true）：把调用方 query 合并进下游 URL（`apiKey` 参数除外）；同名参数以转发配置解析出的 `:name` 替换值优先。
- `forwardTimeoutMs`：100~60000，默认 10000；超时/连接失败 → 502/50003（message 含目标 host，不含凭据）。
- **安全红线（服务端强制）**：
  1. 保存时校验 forwardUrl 协议与非空 host；拒绝指向链路本地/云元址（`169.254.0.0/16`、`fe80:*`）；内网地址允许（本特性就是为内网系统互调设计）。
  2. 不自动跟随 3xx 重定向（原样返回给调用方），防重定向 SSRF。
  3. 响应体透传上限 5MB，超限 502/50003。
  4. 调用明细日志（/data-apis/calls）对 forward 记录下游 httpStatus 与耗时；errorMsg 不含转发头值。
- 管理端「调试」（POST /data-apis/:id/invoke）：forward 结果同样以 `{httpStatus, body}` 透传（body 尽量 JSON 解析，失败给 `{contentType, text}`）。
- 转发不依赖数据库：`DB_DRIVER=memory` 与 `mysql` 均可用。

#### 1.9.4 Swagger 文档中心（OpenAPI 3.0 自动生成）

**查看需登录**：以下接口全部要求 JWT（401 未登录不可见），前端「文档中心」页位于登录态之后。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/data-apis/swagger.json` | JWT | 生成 OpenAPI 3.0 文档：每个 Data API 一条 path（`/ds/{path}`），`tags=[数据源名]`（供按数据源筛选），parameters 来自 queryParams+page/size，responses 含字段表与示例；`?status=published\|all`（all 仅 admin，默认 published）；`?keyword=` 按 path/名称模糊过滤 |
| GET | `/data-apis/:id/doc` | JWT | 取该服务的文档配置（apiDoc） |
| PUT | `/data-apis/:id/doc` | JWT+admin | 保存文档配置（summary/description/paramDocs/responseExample） |

**apiDoc 模板字段**（dataApi 对象新增 `apiDoc`，创建/更新定义时若为空由后端**自动生成模板**，用户可在界面上改）：

```json
{
  "summary": "计量单查询（GET /ds/bill）",
  "description": "构建模式：查询 IR_CM_MEASURE，过滤参数见 queryParams",
  "paramDocs": { "ms_bill_Nr": "计量申请单号，必填" },
  "responseExample": { "fields": ["MS_BILL_NR", "SID"], "rows": [["AQ201110J132", 30500], ["BQ201110J173", 30611]] }
}
```

- 模板生成规则：builder 按 fields 类型造 2 行示例（数字递增/字符串取样例列值/日期取当天）；custom 用声明字段生成；forward 的 responseExample 置 `{ note: '透传下游响应' }` 并在 description 注明目标地址。
- OpenAPI 的 `operationId` 用 `path` 连字符名；`x-databridge` 扩展字段携带 datasourceId/apiId/sqlMode，供前端筛选与跳转编辑。

#### 1.9.5 docKey：文档中心免登录访问 + 访问审计

开发/联调频繁取文档不必每次走登录：由管理员在用户管理中给用户开通「文档权限」（`docAccess`，仅 admin 可配置），开通即自动生成个人 docKey；用户可在文档中心页查看/复制/刷新自己的 key（刷新后旧 key 立即失效，不刷新则长期保留）。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/auth/doc-key` | JWT（本人） | `{docAccess, docKey?, updatedAt?}`；未开通时 docAccess=false 且无 key |
| POST | `/auth/doc-key/refresh` | JWT（本人，需已开通） | 重新生成 key 并返回新值（仅本次与后续 GET 回显） |
| GET | `/data-apis/swagger.json` | JWT **或** docKey | docKey 认证：请求头 `X-DOC-KEY: dok-xxxx` 或查询参数 `docKey=`；只返回 published 文档（`status=all` 仍仅限 admin JWT），参数其余同 1.9.4 |
| GET | `/data-apis/swagger-logs` | JWT+admin | 文档访问日志分页：`keyword`（用户名）/`result`/`authType`（jwt\|docKey）/`startTime`/`endTime` |

**访问审计（每次 swagger.json 请求都落库，`databridge_doc_access_log`，滚动 1 万条）**：
`{ id, userId, username, authType: jwt|docKey, ip, ok, httpStatus, bizCode, keyword, userAgent?, errorMsg?, createdAt }`；
docKey 只以掩码形式记录（前 6 位 + `***`），完整 key、JWT、口令一律不落日志。

**安全红线（服务端强制）**：
1. key 与用户绑定：用户被禁用 → key 实时失效（401/40105）；删除用户同样失效。
2. 校验不过（缺 key/错 key/未开通）→ 401/40102 统一文案，不区分「key 不存在」与「不匹配」，防枚举。
3. `status=all`、PUT 文档配置等管理动作不接受 docKey，只认 JWT（docKey 权限永远不大于登录用户本人权限）。
4. bizCode `40105`＝docKey 无效（HTTP 401）。
5. **自描述分组**：swagger.json 固定包含 `tags=[文档中心]` 的管理端接口条目（取本文档双通道说明、`/auth/login`、`/auth/doc-key` 查看/刷新、`/data-apis/{id}/doc` 读写、`/data-apis/swagger-logs`），不受 `keyword` 过滤影响；`components.securitySchemes` 提供 `BearerAuth`（JWT）与 `DocKeyAuth`（X-DOC-KEY）。

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

### 1.11 用户与鉴权（真实登录，替代脚手架 mock）

用户表 `databridge_user`（mysql 模式自动建表；空表启动自动播种 `admin`，初始密码见服务端启动日志，`mustChangePassword=true`）。密码 **bcryptjs(cost 10) 哈希存储**，任何接口/日志/错误消息不回显明文或哈希。

**会话**：`POST /auth/login` 成功返回 JWT access token（`Authorization: Bearer <token>`，有效期 `JWT_ACCESS_EXPIRATION_MINUTES`，代码默认 30 分钟，`.env`/`.env.example`/k8s ConfigMap 取 **480**）。**一期没有 refresh 接口**，`exp` 在签发瞬间钉死、不随操作滑动，到点首个请求返回 401 由前端清 token 跳登录页（`deploy/RELEASE.md`「登录态」一节给存量环境的 patch 命令）。业务码：40103 用户名或密码错误（**不区分二者，防账号枚举**）、40104 账号已禁用。登录接口挂 `authLimiter`（15 分钟窗口失败 20 次限流）。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/auth/login` | 匿名 | `{username,password}` → `{token, user}`；user 含 `mustChangePassword` |
| GET | `/auth/me` | JWT | 当前用户信息 |
| POST | `/auth/change-password` | JWT | `{oldPassword,newPassword}`；旧密码不符 40001；成功后清 mustChangePassword |
| GET | `/users` | JWT+admin | 分页；`keyword`（用户名/昵称）`role` `status` |
| POST | `/users` | JWT+admin | `{username,nickname,password,role}`；username 3~32 位 `[a-z0-9_.-]` 全库唯一；新建用户 `mustChangePassword=true` |
| PUT | `/users/:id` | JWT+admin | `{nickname,role,status,docAccess}`；**不得禁用/降级自己**；系统必须保留至少一个可用 admin；`docAccess` 开通即自动生成 docKey、关闭即清空（契约 1.9.5） |
| DELETE | `/users/:id` | JWT+admin | **不得删除自己**；最后一个 admin 不可删 |
| POST | `/users/:id/reset-password` | JWT+admin | `{password}` 管理员重置他人密码，置 `mustChangePassword=true` |

- **密码强度（服务端强制）**：8~64 位，至少含 1 字母和 1 数字；不满足 40001。
- **越权红线**：`/users` 全部接口与用户数据访问仅限 admin 角色（passport-jwt + roleRights），普通用户访问一律 403；改密/查自己走 `/auth/*`，不接受任何 userId 参数（无 IDOR 面）。
- **本期边界（诚实声明）**：JWT 强制覆盖 `/users`、`/auth/me`、`/auth/change-password`；其余 DataBridge 业务接口本期仍不鉴权（`/ds/{path}` 继续走 apiKey 机制；engine 回报通道共享密钥已由契约 1.12 排期，随指标中心 M3 落地，空配置 WARN 兼容，见第 2 节「引擎共享密钥」），前端路由守卫按角色显隐菜单。
- **登录日志（审计）**：每次 `POST /auth/login`（成功与失败）写一条 `databridge_login_log`：`{id, userId?, username, ip, ok, errorMsg?, createdAt}`（username 原样记录便于排查撞库尝试；errorMsg 不含密码）。查询：`GET /auth/login-logs`（JWT+admin，分页，参数 `keyword`（用户名模糊）/`result=success|error`/`startTime`/`endTime`），表滚动保留最近 1 万条。
- 前端：登录页对接真实 `/auth/login`；「系统管理→用户管理」页（admin 可见）提供增删改/禁用/重置密码；头像菜单提供个人修改密码；`mustChangePassword=true` 时登录后强制弹出改密。
- **出参安全**：用户对象带 `docAccess`（布尔）供界面显隐，**docKey 明文只出现在本人 `GET/POST /auth/doc-key*` 响应**，列表/详情/me 一律不回传。

---

### 1.12 指标中心 `/metric*`（v1.12 新增；本节为接口契约，实施规格/公式编译/完整 DDL 见 `docs/METRIC-DEV.md`）

**鉴权与错误码**：全部 `/metric*` 路由需 JWT；`GET/PUT /metric-settings`、`POST /metric-logs/:id/to-example` 仅 admin。新错误码：`40902` 域下有模型/指标禁删、`40903` 指标被引用禁删、`40904` 界面建表物理表名冲突、`40905` 公式循环依赖、`50201` 数据源 SQL 执行失败（HTTP 502，message 透传真实库错误）。

**指标对象**（`type` 由 `defineType+defineParams` 在保存时推导）：

```json
{ "id": "met-13000", "code": "order_amt", "name": "订单总金额", "alias": ["成交额"],
  "type": "ATOMIC", "defineType": "MEASURE", "modelId": "mdl-12000", "domainId": "dom-11000",
  "expr": "SUM(t.order_amt)",
  "defineParams": { "measureColumn": "order_amt", "agg": "sum", "timeColumn": "pay_date", "filterSql": "t.status='PAID'" },
  "unit": "元", "dataFormat": "THOUSANDTH", "caliber": "成交后实收金额，不含取消",
  "owner": "data-team", "status": "online", "version": 3 }
```

- `code` 全库唯一、`^[a-z][a-z0-9_]{2,63}$`、创建后不可改——是复合公式 `${code}` 引用的锚点。
- `dataFormat` ∈ `DECIMAL`（默认）| `PERCENT` | `THOUSANDTH`，仅用于展示格式；留空按 DECIMAL 存储。
- COMPOSITE 的 `expr` 仅允许 `${code}` 引用 + 数字 + `+ - * / ( )` + CASE WHEN + 白名单标量函数（COALESCE/ROUND/ABS/FLOOR/CEIL/NULLIF/IF/NVL/IFNULL/DECODE/TRUNC/GREATEST/LEAST/MOD/SUBSTR/SUBSTRING/LENGTH/CONCAT/TO_NUMBER，跨 MySQL/Oracle 通用；公式字符集不含引号故字符串常量不适用），禁聚合/表名/列名/子查询；DERIVED 用「继承基底指标 + 维度限定 + 业务过滤 + 时间预设」（`defineParams: {baseMetricId, dimensions[], filterSql?, timePreset?}`）。校验与编译规则见 METRIC-DEV §6。
- **跨库方言：三层处理 + 单一方言层**（`node-express-boilerplate/src/utils/dialect.js`，V10 起）。所有 mysql/oracle 的 SQL 文本差异只从这里出，编译器（`metricCompiler`）、物化任务（`metrictask`）、模型 DDL 预览（`metricmodel`）、数据预览（`metricExec`）、问数落地（`metricChat`）**五个生成点统一接入**，不再各写 `ds.type === 'oracle'` 分支（此前每漏一处就产出一条必失败的语句）：① 语法探针（node-sql-parser）对 mysql/oracle 函数**宽容互认**（实测两方言都能解析 NVL/TO_CHAR/TO_DATE/DECODE/TRUNC/REGEXP_LIKE/`||`），故探针不按方言分支；② 编译期按目标方言**归一改写**：`NVL(`/`IFNULL(` → `COALESCE(`（两库通用），Oracle 目标 additionally `DATE_FORMAT(x,'%Y-%m')` → `TO_CHAR(x,'YYYY-MM')`（掩码表 `%Y %m %d %H %i %s %y %M %D`，含未覆盖 `%码` 时不改写只告警）；③ 无法等价改写的专有写法（Oracle DECODE/NVL2/TO_CHAR/TO_DATE/TO_NUMBER/NUMTODSINTERVAL/REGEXP_LIKE/TRUNC/SYSDATE/ROWNUM，MySQL DATE_FORMAT/STR_TO_DATE/GROUP_CONCAT/SUBSTRING_INDEX/FIND_IN_SET/IF）在 `POST /metrics/validate` 与保存响应里回 **warnings**（不阻断保存）。

  方言产物对照（回归见 `deploy/tests/test-metric-dialect.js`，离线不连库）：

  | 生成点 | MySQL | Oracle |
  |---|---|---|
  | 标识符/别名 | 反引号 `` `gk1` `` | 大写无引号 `GK1`（非引号标识符必须字母开头） |
  | 日期字面量 | `'2026-04-12'` | `TO_DATE('2026-04-12','YYYY-MM-DD')`（裸串比较会 ORA-01861） |
  | 行数限制 | `LIMIT n` | `SELECT * FROM (…) dbr_page WHERE ROWNUM <= n`（与引擎侧 dbio 一致；`FETCH FIRST` 需 12c+，11g 直接语法错，故不用） |
  | 当前时间 | `NOW()` | `SYSDATE` |
  | ETL 留痕列 | `_etl_time` DATETIME | `ETL_TIME` TIMESTAMP（下划线开头会 ORA-00911，故跨库列名不同，属已知差异） |
  | 列类型 | 原样（NUMERIC→DECIMAL） | `VARCHAR→VARCHAR2(n CHAR)`、`CHAR→CHAR(n CHAR)`、`INT→NUMBER(10)`、`BIGINT→NUMBER(19)`、`DECIMAL(p,s)→NUMBER(p,s)`、`TEXT→CLOB`、`DATETIME→TIMESTAMP`；>4000 宽直接 40001 拒。**字符串必须带 `CHAR` 语义**：MySQL 的 `VARCHAR(n)` 按字符计数、Oracle 默认按字节计数，AL32UTF8 下中文一字符 3~4 字节，写成 `VARCHAR2(n)` 会在物化 INSERT 时报 ORA-12899（实测 `PRODUCE_LINE` 声明 2、实际 4 字节即中招） |
  | 建表 | `CREATE TABLE IF NOT EXISTS … ENGINE=InnoDB … utf8mb4` | `CREATE TABLE T (…)`；无 IF NOT EXISTS → 执行前用 `SELECT COUNT(*) FROM user_tables WHERE table_name='T'` 探测，已存在则跳过建表（等价幂等） |
  | 清空 | `` TRUNCATE TABLE `t` `` | `TRUNCATE TABLE T` |
  | 列注释 | 内联 `COMMENT '…'` | 拆成 `COMMENT ON TABLE/COLUMN` 语句 |
  | upsert | `ON DUPLICATE KEY UPDATE` | **一期拒绝**（需 MERGE INTO，未实现），保存期即 40001 提示改用 overwrite/append |
  | 空串语义 | `''` 是空串 | `''` 等价 NULL → `cleanRules` 的 fill 值为空串时保存期 40001，要求填实际占位（如 `-`） |
  | 未接入类型 | — | `postgresql` 等按方言层不支持 → 40001（不再静默按 MySQL 生成） |


**模型生命周期与建表（v1.13 / V11 一期）**：物理表结构只有建模一个出口，任务不再建表（任务侧改造在二期）。

- 状态机：`status ∈ draft | online | offline`。`createType=ddl` 新建默认 **draft**（草稿：可反复改字段，不能建表、不能被指标/任务引用）；`createType=reference` 仍默认 `online`（引用已有物理表，平台不建也不删，无危险动作）。启用 = `PUT {status:'online'}`，启用时校验「至少一列 + 表名合法」。
- 建表留痕字段（新增列，`init.js` 自动补可空列，无需人工迁移）：`tableStatus ∈ none | created | exists | failed`、`tableMsg`（失败时存原始 ORA-/1146 报错，界面可看）、`tableAt`。`reference` 恒为 `exists`；`ddl` 初始 `none`，点「生成表」后 `created`/`failed`。
- `POST /metric-models/:id/create-table`：仅 `createType=ddl` 且 `status=online` 可调，否则 40001。DDL 由方言层 `buildDdl` 生成（MySQL `CREATE TABLE IF NOT EXISTS ... utf8mb4`；Oracle 无 IF NOT EXISTS → 先探 `user_tables`，已存在即视为幂等成功并回 `existed:true`），经 engine `/sql/exec` 真执行；`DB_DRIVER≠mysql` 时 40001（内存模式不发起真实执行）。响应 `{tableStatus, tableMsg, tableAt, ddl, executed}`，`executed=false` 表示库里已建好、本次只补状态。
- `DELETE /metric-models/:id?dropTable=true`（缺省 false）：默认只软删模型、**不动物理表**。只有「平台建的表」（`createType=ddl` 且 `tableStatus=created`）允许 `dropTable=true`；`reference` 传 true → **40001 拒绝**（引用表不归平台所有，平台永远不 DROP——这条是硬闸门，不依赖前端隐藏按钮）。删除前照旧挡引用（下有指标/任务 → 40903/40902 语义）。DROP 失败不阻断软删，但把报错回给前端（`dropped:false, dropMsg`），避免"表还在、模型没了"变成无人知晓的孤儿表。
- 引擎侧配套：`/sql/exec` 语句白名单新增 `DROP TABLE`——仅单语句、单表、禁止 `CASCADE`/`PURGE`/多表逗号尾巴（见 `databridge-engine/api/v1/sql.go` 与 `sql_test.go`）；仍受 `X-Engine-Token` 与标识符白名单约束。

**指标广场与维度取值（v1.14 / V11 二期）**：指标的管理入口从表格改成「按域浏览的广场」，并把「维度候选值 + 码值业务名」补进问数链路（治的是「用户问华东、库里存 01，LLM 只能猜」这类命中问题）。

_A. 广场聚合（只读，不改 `/metrics` 既有分页契约）_

- `GET /metrics/plaza?domainId=&type=&status=&keyword=&limit=500` → `{domains:[{id,name,code,path,total,items:[卡片]}], total, truncated}`。
- 卡片字段：`{id,code,name,alias,type,status,unit,dataFormat,caliber,owner,modelId,modelName,domainId,referencedBy,hot7d,updatedAt}`。`referencedBy` ＝被多少指标当子依赖引用（dep 表 count），`hot7d` ＝近 7 天 query_log 命中次数（零额外查询，来自已有埋点）。
- 分组口径：**按根域分节**；传 `domainId` 时该域**含全部子孙域**聚合成一节（树形域的实际用法）。节内排序 `hot7d desc → updatedAt desc`。
- `status` 缺省只回 `online`（广场=上架目录）；显式传 `draft`/`offline`/`all` 才出现草稿与下架卡片，界面须标注「草稿不可被引用」。
- 不分页：卡片流按域分节，分页会打断分组；`limit` 上限 500，超出回 `truncated:true`（界面提示改用搜索或选域）。

_B. 从表批量生成指标_

- `POST /metrics/batch`，body `{items:[{code,name,alias?,domainId,modelId,measureColumn,agg,timeColumn?,filterSql?,unit?,dataFormat?,caliber?,status}]}`，单次 ≤50 条。
- **逐条走既有 `createMetric` 校验器**（语法探针/聚合规则/循环/跨源/草稿模型闸门一个都不绕），返回 `{results:[{index,code,ok,id?,message?}], created, failed}`；HTTP 恒 200——部分失败不是接口失败，前端按条显示红行。无事务、不回滚已成功条。
- 默认命名口径（界面预填、允许逐条改）：`code = 域编码_列名`、`name = 列业务名 || 列名`、`agg` 取列的 `aggDefault`（无则 sum/c count 按类型推）。界面**不许静默改名**，撞码就报错给人看。
- 不做「就地建模型」的复合接口：先 `POST /metric-models`（`createType=reference`）登记，再批量建指标——职责单一，一期的草稿模型闸门与 40904 撞表判定自动复用。

_C. 维度取值档案 + 码值字典（一张表两种来源，别做成两个概念）_

- 新表 `databridge_metric_dimvalue`（`init.js` 自动建）：`id(mdv-，startId 19000)`、`model_id`、`column_name`、`value VARCHAR(191)`、`label VARCHAR(191) NOT NULL DEFAULT ''`、`hits BIGINT`、`source`（`auto` 探查 / `manual` 人工补录）、`stale`（本次探查没再见到该值）、`profiled_at`；唯一键 `(model_id, column_name, value)`。
- `POST /metric-models/:id/profile-dimensions`，body `{columns?:string[], topN?=50, distinctGuard?=200, timeColumn?/timePreset?}`：经 engine `/sql/query` **真查**目标库，SQL 一律由方言层新方法 `dimProfileSql` 生成（MySQL `GROUP BY col ORDER BY COUNT(*) DESC LIMIT n`；Oracle 用 `SELECT * FROM (…) WHERE ROWNUM<=n` 嵌套，与既有限行口径一致）。
  - 先算基数：`COUNT(DISTINCT col) > distinctGuard` → 该列**不取值**，只回 `highCardinality:true`（防把用户ID/时间戳灌进 prompt，也防大表 GROUP BY 压库）。
  - 只覆盖 `source=auto` 的行，**已登记的 `label` 按 (model,column,value) 保留**；库里已消失的旧值置 `stale:true` 不删（历史数据仍可被引用）。
  - 响应 `{columns:[{columnName,highCardinality,distinctCount,values:[{value,label,hits,source,stale}]}], profiledAt}`；`DB_DRIVER≠mysql` → 40001（内存模式不发起真实执行，与 create-table 同口径）。
- `GET /metric-models/:id/dimension-values?columnName=&keyword=`：只读档案（界面/下拉），不打库。
- `PUT /metric-models/:id/dimension-values`，body `{columnName, values:[{value,label}]}`：登记「库里是 01、业务叫华东」。档案里没有的 value 允许新增并记 `source=manual`——这是"探查没覆盖但业务知道"的补录通道。
- `DELETE /metric-models/:id/dimension-values?columnName=`：清该列档案。

_D. 候选值进 prompt 与解析后值校正_

- 系统配置新增两项：`chat.dimValuePrompt`（`0|1`，**默认 0 关**）、`chat.dimValueTopN`（默认 20）。默认关的理由：候选值是真实业务数据，进 prompt＝数据出境边界，须按模型/环境显式打开（沿用 apiKey 掩码那套「默认可信最小」口径）。
- 开关打开时：`metricKnowledge.buildIndex` 给维度列附 `values`，`buildSchemaSection` 的维度行从 `- 地区(别名:region, 类型:维度)` 变成 `- 地区(别名:region, 类型:维度, 取值:01=华东、02=华南…（共4）)`；条数受 `chat.dimValueTopN` 截断并标注「另有 M 种未列出」。
- **值校正发生在解析之后、编译之前**：`parseM2Sql(tokenSql, refs, dimValues)` 新增第 3 参（缺省 `undefined`＝行为完全不变，老调用零风险）。规则：过滤 literal 若不是该列档案里的真实 `value`，但能按 `label` 精确/大小写不敏感/去空白匹配到，就换成真实 `value`；`IN` 列表逐元素处理；时间列、数值比较（`>=` 等）不校正。
- 响应与审计：`{corrections:[{column,from,to}]}`，问数答案卡下方界面显示「已按字典把 华东→01」；未命中档案的值原样保留并记入 query_log，作为「待补录码值」的治理线索。
- 红线：占位 token 内**绝不嵌原始值**（沿用 `@COL(n)@` 注册表写法，历史上嵌列名导致过二次替换污染）；探查/校正涉及的标识符全过白名单；两条新 SQL 属方言差异，只能加进 `src/utils/dialect.js`（红线 9）。

**三期预告（未实现，勿按此设计写码）**：任务改为「选目标模型表 + 同数据源内多指标按共同维度拼宽表」，缺列只报错不自动 ALTER，保持"表结构唯一权威在建模"；本期的 `dimvalue.label` 正是那时「同维度判定/值映射（region ↔ area_code、华东 ↔ 01）」的原料。


**路由**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/metric-dashboard` | 首页概览：域/模型/指标计数（按类型/状态/分层分组）、任务近 24h 运行统计与成功率、近 7d 问数量与失败数、hotMetrics Top10 |
| GET/POST | `/metric-domains`；GET `/metric-domains/tree`；PUT/DELETE `/metric-domains/:id` | 指标域树（`dom-`；删除撞 40902；code `^[a-z][a-z0-9_]{1,30}$` 兼建表前缀） |
| GET/POST | `/metric-models`（筛选 domainId/layer/datasourceId/**status**/keyword）；GET/PUT/DELETE `/metric-models/:id` | 模型（`mdl-`；createType=`reference`\|`ddl`；列表行含 `status`/`tableStatus`/`tableMsg`/`tableAt`，`status` 可按 draft\|online\|offline 筛；详情含 columns[{columnName,bizName,dataType,role:dimension\|time\|measure,aggDefault}]）。**dataType 服务端归一**：一律收成 MySQL 风格规范串（`varchar`→`VARCHAR(64)`、`VARCHAR2(58)`→`VARCHAR(58)`、`NUMBER`→`DECIMAL(18,4)`、`NUMBER(10)`→`DECIMAL(10,0)`、`timestamp(6)`→`TIMESTAMP`、`CLOB`→`TEXT`），目录外的冷门写法兜底成 `VARCHAR(64)` 而非报错（免得引用表被源库类型卡死）；长度/精度超出目标库上限（oracle VARCHAR2 4000、NUMBER 精度 38）按 40001 拒绝 |
| GET | `/metric-models/column-types` | 字段类型族目录（方言层产物，界面下拉唯一来源）：`{mysql:[...], oracle:[...]}`，每项 `{family,label(中文),rendered(该方言真实类型名),hasLength,hasScale,defaultLength,defaultPrecision,defaultScale,maxLength}` |
| POST | `/metric-models/preview-ddl` | 列定义 → CREATE TABLE SQL 回显（不执行；表名=域前缀+分层+名称，撞库 40904）。可传 `datasourceId` 决定 DDL 方言，响应回 `dialect`；不传按 mysql。`name` 与 `tableName` **至少给一个**（给了 tableName 以它为准，否则按 name 拼表名；两者同传不报错） |
| POST | `/metric-models` | `createType=reference` 必须给 `tableName`（已有物理表）；`createType=ddl` 可留空，服务端按「域前缀_分层_名称」自动命名（与 preview-ddl 同口径） |
| POST | `/metric-models/:id/create-table` | 生成表（v1.13）：仅 `createType=ddl` + `status=online`，方言层出 DDL 经 engine 执行；幂等（Oracle 先探 `user_tables`）。返回 `{tableStatus, tableMsg, tableAt, ddl, executed}`；失败也落 `tableStatus=failed` + 原始报错供界面展示与重试 |
| DELETE | `/metric-models/:id?dropTable=true` | 删除模型（默认只软删）。`dropTable=true` 仅当 `createType=ddl` 且 `tableStatus=created`；`reference` → 40001（引用表平台永不 DROP）。返回 `{id, deleted:true, dropped, dropMsg?}` |
| GET | `/metrics/plaza` | 指标广场聚合（v1.14）：按根域分节，`domainId` 时含子孙域；只回 online（除非 status=draft/offline/all）；卡片含 `referencedBy`（被引用数）与 `hot7d`（近 7 天问数命中）。见上方 A 节 |
| POST | `/metrics/batch` | 从表批量生成原子指标（v1.14）：`{items:[...]}` ≤50 条，逐条走单条校验器，返回 `{results:[{index,code,ok,id?/message?}],created,failed}`，HTTP 恒 200。见上方 B 节 |
| POST | `/metric-models/:id/profile-dimensions` | 维度取值探查（v1.14）：真查目标库（engine `/sql/query` + 方言层 `dimProfileSql`），先基数保护后取 topN，保留人工 label、消失值置 stale；`DB_DRIVER≠mysql` → 40001 |
| GET/PUT/DELETE | `/metric-models/:id/dimension-values` | 取值档案读/码值业务名登记/清列（v1.14）。GET 只读库内档案不打源库 |
| GET | `/metric-models/:id/preview` | 前 20 行真实数据（engine `/sql/query`，失败 50201） |
| PUT | `/metric-models/:id` | 只收 `name/layer/tableName/timeColumn/status/remark/columns`——**域与数据源创建后不可迁移，多传 `domainId`/`datasourceId` 直接 40001**（前端编辑态因此不下发这两个字段）；ddl 模型改 `columns` 时服务端按目标方言归一并**同步重算留档 `tableDdl`**（`PUT /:id/columns` 同口径） |
| GET/POST | `/metrics`；GET/PUT/DELETE `/metrics/:id` | 指标分页（domainId/type/status/keyword 搜 name/code/alias）；保存即写版本；删除撞 40903 |
| POST | `/metrics/validate` | 草稿校验（语法/聚合规则/循环 40905/维度合法性），返回 `{errors, warnings}`，无副作用 |
| GET | `/metrics/:id/tree` | 子指标展开树（type/expr/model/children，深度 ≤8） |
| GET | `/metrics/:id/lineage` | 双向血缘 `{parents, children}`（LogicFlow 数据，边带引用表达式） |
| POST | `/metrics/:id/preview` | 试跑 `{dateRange, dimensions[], limit}` → `{sql, columns, rows, elapsedMs}`（编译产物真实执行，黄金对照入口） |
| GET/POST | `/metrics/:id/versions`；`/metrics/:id/rollback` | 版本列表（`mver-`）/ 指定版本回滚为新草稿 |
| CRUD | `/metric-tasks`（`mtk-`）；POST `/metric-tasks/:id/run`；GET `/metric-tasks/:id/runs`；POST `/metric-tasks/preview`；POST `/metric-tasks/target-schema` | 清洗汇总任务：sourceModelId/metricIds/dimensionColumnIds/cleanRules/timePreset/target(writeMode ∈ overwrite\|append\|upsert，upsert 仅 MySQL)/scheduleCron（格式同 1.2，调度走 Node 现有 scheduler）；执行记录 `mtr-` 含 sqlText/readRows/writeRows/elapsedMs；preview 返回将要执行的语句数组（不落库）。**target-schema 返回目标表结构回显**（同 preview 的入参与校验，不落库不执行）：`{dialect, table, autoCreate, writeMode, primaryKeys[], columns[{name,type,source:维度\|指标\|留痕,comment}], createSql, insertSql}`——类型由 `buildPlan` + 方言层给权威值，界面「选了哪些字段 → 会建成什么样」直接用它，前端不自行推断。cleanRules 一期支持 filter/fill/rename，**dedup 明确 40001 拒绝**（5.7 无窗口函数，去重放上游同步任务）；全部指标必须同挂源模型（跨模型复合不可物化）；保存即组一次计划生成，配置错误挡在保存期 |
| CRUD | `/metric-terms`（`mterm-`）、`/metric-examples`（`mex-`） | LLM 术语与示例问答 few-shot（example={question, m2sql, enabled}） |
| POST | `/metric-chat/ask` | `{question, sessionId?, dateRange?}` → `{status: success\|corrected\|clarify\|failed, answer, value?\|columns?/rows?, m2sql, physicalSql, metricTree（子指标逐层展开并回填 value）, candidates?（clarify 时的候选指标）}`；每次问答落 `mlg-` 日志 |
| GET/POST | `/metric-chat/sessions/:id/history` | 多轮上下文查询/清空（内存态，重启即失） |
| GET | `/metric-logs`（筛选 keyword/result/user/时间段）；POST `/metric-logs/:id/to-example` | 问数审计（滚动 5 万条）；审核转示例（admin） |
| GET/PUT | `/metric-settings` | 系统配置（metric_setting 表，优先于 env）：`llm.baseUrl/llm.model/llm.apiKey/llm.timeoutMs/llm.embed.enabled/llm.embedModel/llm.embed.baseUrl/llm.embed.apiKey`——embedding 可与对话模型不同供应商，`llm.embed.baseUrl/apiKey` 未配置时回落主 `llm.baseUrl/apiKey`（env：LLM_EMBED_BASE_URL/LLM_EMBED_API_KEY）；**v1.14 起共 10 项**，新增 `chat.dimValuePrompt`（`0|1`，默认 `0`；维度候选值/码值是否进问数 prompt——真实业务数据出境，必须显式开）与 `chat.dimValueTopN`（默认 20，prompt 内每列条数上限）（env：`CHAT_DIM_VALUE_PROMPT`/`CHAT_DIM_VALUE_TOPN`）；**apiKey 掩码回显**（`sk-xx***`，仿 docKey 做法），PUT 传空串=保持不变。PUT 请求体为**嵌套形态** `{settings:{llm:{...},chat:{dimValuePrompt:"",dimValueTopN:""}}}`（全局 mongo-sanitize 会把点分键拆嵌套，契约顺势定义嵌套；服务端扁平化为点分 key 后按白名单校验） |

- **对外服务边界**：指标结果对外交付复用 1.9 `/data-apis`（ADS 表/SQL 发布为 API）与 `/ds` runtime（apiKey/白名单/限流/调用日志/swagger/docKey 全套）；本节不提供独立对外查询端点。
- **落库**：`databridge_metric_*` 共 13 张（domain/model/model_column/**dimvalue**/metric/metric_dep/metric_version/task/task_run/term/example/query_log/setting），mysql 模式启动自动建表（DDL 见 METRIC-DEV §5，utf8mb4 显式）；memory 模式走内存实现。
- **engine 交互**：所有 SQL 执行经第 2 节「通用 SQL 执行接口」，携带 `X-Engine-Token`（见引擎共享密钥）。

**问数对外服务（v1.12 增补，仿 1.9.5 docKey 模式）**：把智能问数发布为外部可调用 API，权限位绑定用户、密钥走 API 头、审计仅 admin。

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/chat/ask` | **X-Chat-Key 头**（或 `chatKey` 查询参数，二选一；不要求 JWT） | 请求体同 `/metric-chat/ask`（`{question, sessionId?, dateRange?}`），响应 result 同构（status/answer/value/columns/rows/m2sql/physicalSql/metricTree/candidates/warnings）。错误：key 缺失/无效/权限未开通统一 `401/40102`（防枚举，复用 docKey 语义；`chatKey` 查询参数仅当未带 X-CHAT-KEY 头时生效）；账号被禁用 `401/40105`。每次调用（成败）落 `metric_query_log`，`userName` 为绑定用户并带 `(apikey)` 后缀，`matched.source='chatKey'` |
| GET | `/auth/chat-key` | JWT（本人） | 返回 `{chatAccess, chatKey, updatedAt}`：开通时 chatKey 明文**只回本人**，未开通 chatKey=null |
| POST | `/auth/chat-key/refresh` | JWT（本人） | 本人刷新 key（旧 key 立即失效；未开通 40001） |

- **权限模型**：用户新增 `chatAccess`（布尔，**仅 admin 在用户管理中开通**）+ `chatKey`（`chk-`+32hex，绑定用户）。开通即自动生成（已有则保留），**关闭权限立即清空**——key 生命周期绑定权限位；账号禁用实时失效。`GET/PUT /metric-settings` 之外，`GET /metric-logs`（问数审计）由「登录即可」收紧为**仅 admin（manageMetrics）**，前端问数页「历史」tab 按 admin 显隐。
- **文档中心集成**：swagger.json 固定含「智能问数」分组（`POST /api/v1/chat/ask` 自描述：请求/响应 schema、`ChatKeyAuth` securityScheme、**curl 调用模板**）；文档中心页对已开通用户在 docKey 区下方展示 chatKey（掩码/明文切换/复制/刷新）与问数 curl 模板。
- **用户对象增字段**：`chatAccess: boolean`（列表可见）；`chatKey` 明文不出 `/users*` 接口（toSafeUser 剔除，仅 `/auth/chat-key*` 回本人）。落库列 `databridge_user.chat_access/chat_key/chat_key_updated_at`（启动自动 ALTER 补列）。
- **实施状态（2026-10-08）**：M0~M5 后端全部落地（含 `/metric-chat/ask` 主链路、术语/示例/日志/会话、`/metric-settings` 配置页）。真实联调验收：`deploy/tests/test-metric-chat.js` 真库+真 DeepSeek 全绿（10 问命中 ≥7 为通过线，metricTree 子指标随主指标并入同一次查询后整树回填 value）。

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
| POST | `/api/v1/engine/sql/query` | 执行单条 SELECT 返回结果集（同步；v1.12 指标中心，见「通用 SQL 执行接口」） |
| POST | `/api/v1/engine/sql/exec` | 依序执行 DDL/DML（界面建表/清洗物化；v1.12，见「通用 SQL 执行接口」） |

### 引擎共享密钥（契约 v1.12 新增，M3 已落地）

env `ENGINE_SHARED_SECRET`（admin/engine 双侧同值；K8s 经 Secret `databridge-db-secret` 注入）。

- 配置后：Node→engine **全部请求**（含 tasks/start、sql/* 等）与 engine→Node 回报（1.4 `/engine/report`、`/engine/logs`）必须携带请求头 `X-Engine-Token: <secret>`，不匹配返回 HTTP 401 + `code: 40101`。
- 未配置（空串）：双侧维持放行并启动时打一条 WARN（平滑过渡期态）；**生产与本地生产测试态禁止空配置长期使用**（METRIC-DEV §12 红线）。
- 上线顺序：先发带空配置兼容的双侧版本 → ConfigMap/Secret 配好同值 → 重启后自动强制；该切换写入 RELEASE.md。对既有回归脚本向后兼容（空配置态不带 token 仍通过）。

### 通用 SQL 执行接口（v1.12 指标中心专用，仅 admin 调用）

```
POST /api/v1/engine/sql/query
  req  { "endpoint": { "id":"ds-1001","type":"mysql","host":"...","port":3306,
                      "username":"...","password":"...","database":"..." },   // 第 5 节同款真实快照
         "sql": "SELECT ...", "limit": 1000, "timeoutSec": 30 }
  resp data { "columns": ["c1","c2"], "rows": [[...]], "rowCount": 20, "elapsedMs": 150 }
  校验：仅允许单条语句且必须以 SELECT 开头（不区分大小写），否则 40001；
        执行失败 HTTP 502 + code 50002（message 透传真实库错误）

POST /api/v1/engine/sql/exec
  req  { "instanceId": "mtr-14900", "endpoint": { ... },
         "statements": ["CREATE TABLE IF NOT EXISTS ...", "TRUNCATE TABLE ...", "INSERT INTO t (c1,c2) SELECT ..."],
         "allowDrop": false,   // v1.13：破坏性动词开闸位，仅「建模删除平台自建表」链路传 true
         "reportUrl": "可选；携带则异步：立即 accepted，完成后按 1.4 ProgressReport 回报" }
  resp（同步）data { "results": [ { "affectedRows": 1200, "elapsedMs": 340 } ] }
  校验：每条语句首关键字 ∈ {CREATE TABLE, TRUNCATE TABLE, INSERT INTO, ALTER TABLE ADD COLUMN, DROP TABLE(v1.13 起，仅 `DROP TABLE [IF EXISTS] <单表>`)}；
        DROP 还必须带 `allowDrop=true`，否则 40001（引擎无状态、判不出调用方意图，故把开关做成显式请求字段）；
        DELETE/UPDATE/GRANT/DROP USER、多表逗号、CASCADE/PURGE 尾巴、分号多语句拼接一律 40001；
        DROP 只服务「建模删除平台自己创建的表」，引用型表在 Node 侧就被挡（见 1.13 模型生命周期）；
        标识符白名单与口令处理同第 5 节（凭据不进日志与回报）；type ∈ {mysql, oracle} 仅
```

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
| databridge-admin (Node) | 3001 | `NODE_ENV`、`PORT`、`ENGINE_BASE_URL`（引擎地址）、`MOCK=true`（跳过 MongoDB 连接）、**`DB_DRIVER`**（`memory` \| `mysql`，默认 `memory`）、`SEED_DEMO`（`true`\|`false`，演示种子开关，缺省 memory=true / mysql=false）、`MYSQL_HOST`/`MYSQL_PORT`/`MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DATABASE`/`MYSQL_CONNECTION_LIMIT`（`DB_DRIVER=mysql` 时生效）、`ORACLE_POOL_MIN`/`ORACLE_POOL_MAX`（Data API/元数据真实查询的 oracle 连接池，按数据源一份，默认 2/10；吞吐≈池上限÷单查询耗时）、`ADMIN_INIT_PASSWORD`（契约 1.11 首次播种 admin 的初始密码，留空随机生成并打日志）、`JWT_SECRET`/`JWT_ACCESS_EXPIRATION_MINUTES`（登录令牌签名与有效期）、`ENGINE_SHARED_SECRET`（v1.12 可选；配置后所有引擎调用带 X-Engine-Token）、`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`/`LLM_TIMEOUT_MS`/`LLM_EMBED_ENABLED`/`LLM_EMBED_MODEL`/`LLM_EMBED_BASE_URL`/`LLM_EMBED_API_KEY`（v1.12 指标问数，OpenAI 兼容协议；embedding 端点/密钥未配置时回落主 LLM 值；可被 metric_setting 表覆盖） |
| databridge-engine (Go) | 8080 | `SERVER_PORT`、`NODE_REPORT_URL`、`MOCK_TICK_MS`、`ENGINE_SHARED_SECRET`（v1.12 可选，需与 admin 同值） |
| databridge-web (Vue) | 80(容器)/5173(dev) | `VITE_GLOB_API_URL` |

`DB_DRIVER=mysql` 时管理后端把 11 类实体落到同一 MySQL 库的 `databridge_*` 表
（datasource / sync_task / task_instance / run_log / offset / pipeline / dataflow / data_api /
data_api_call_day / alert_rule / alert_record + `databridge_id_seq` 取号表；契约 1.12 起另有指标中心 `databridge_metric_*` 12 张表，清单见 1.12，同走自动建表/补列机制），
启动时逐表 `CREATE TABLE IF NOT EXISTS`（MySQL 5.7+，逐表显式 `utf8mb4 / utf8mb4_unicode_ci`），
**默认不注入演示种子**（空库起步，见 4.1；`SEED_DEMO=true` 才注入，且仍受「已有数据即跳过」的幂等保护）；
接口路径、出入参结构与错误码与 `DB_DRIVER=memory` 完全一致（契约不变），
差异只有：时间统一按 `YYYY-MM-DDTHH:mm:ss.sssZ` 回显、`POST /datasources/{id,}/test` 对
`type=mysql` 的数据源改为真实建连测试。滑动窗口限流计数、调度器 `lastTriggerAt`、
失败重试排程定时器仍是内存态。表清单与启动步骤见 `node-express-boilerplate/README.md` 第 3.1 节。

### 4.1 演示种子与去 mock 语义（2026-09-22 起生效）

- 演示种子（假数据源/任务/管道/画布/DataAPI/告警等）**仅 `DB_DRIVER=memory` 注入**；`DB_DRIVER=mysql` 启动为空库起步，接口返回的全部是用户真实配置与真实执行数据。`SEED_DEMO=true` 可显式覆盖（特殊调试用）。
- 历史库中已注入的演示行用 `yarn db:cleanup`（`src/db/cleanup-demo.js`）按固定演示 ID 清单一次性清除，不碰用户数据。
- 执行模式判定（Node 下发引擎快照时决定并写入 `mode` 字段）：`DB_DRIVER=mysql` 且源/目标类型均 ∈ {mysql, oracle} → `mode:"real"` 真实读写；否则 `mode:"simulate"` 模拟执行。模拟执行的实例会写一条 WARN 日志「本次为模拟执行」，前端任务/管道列表显示「模拟」Tag。
- 数据开发画布：**保存允许草稿态**（input/output 节点可暂缺 config.datasourceId/table），`run` 时才强制端点配置完整（40001）。

## 5. 引擎真实同步模式（start 快照 `mode:"real"`）

真实模式下 Node 快照的 `source/target` 携带完整连接信息（含明文 password，仅内网进程间传输、引擎不落日志），并附 `table`、`fieldMappings`、`incrementalColumn`（增量）、`cdcPollColumn`/`pollIntervalSec`（管道轮询）：

- **驱动**：mysql → `go-sql-driver/mysql`；oracle → `go-ora`（纯 Go，免 Instant Client）。
- **full**：`COUNT(*)` 定总量 → 按主键/ROWNUM 分批读（批大小 `batchSize`）→ 事务批量写目标表。`writeMode`：`insert` 批插；`overwrite` 先清空目标表；`upsert` mysql `ON DUPLICATE KEY UPDATE`、oracle `MERGE INTO`（依赖 primaryKey 映射）。
- **incremental**：`WHERE incrCol > :offset ORDER BY incrCol` 循环拉批写入，位点=批内最大值，完成回报最终 `currentOffset`；起始位点取 Node 下发的 `offsetStart`（上次持久化值，可空）。
- **cdc（管道）**：非日志挖掘——按 `cdcPollColumn` 每 `pollIntervalSec` 秒一轮增量拉取，无限运行直至 stop；changeRows=累计写入行数、qps=近一轮均值、lagMs=本轮处理耗时、位点持久化在实例内并随 report 回报 `cdcPosition`。
- 真实模式进度/行数/日志全部来自真实执行；SQL 错误回报 `failed` + 数据库原始错误（截 500 字）。凭据仅在引擎进程内使用，不回报、不落日志。
- `simulate` 模式行为与旧契约第 2 节完全一致（memory 驱动或端点类型不支持时使用）。
