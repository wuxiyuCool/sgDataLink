# DataLink 指标中心（Metric Center）开发文档

> 版本：v1.2（2026-10-08，分支 `feat/metric-center`）
> v1.1 变更：并入「登录 & 首页概览」需求（§7.5/§8.1/§9）；补 demo 站账号；新增依赖与兼容性硬约束（§3）。
> v1.2 变更（评估修订）：engine 共享密钥提前为 M3 前置（§8.2，顺带解决 v9 回报鉴权 TODO）；指标对外服务明确复用 /ds 不自建（§7.2.4）；M2SQL 中文标识符反引号+两步解析（§7.4）；query_log 增 metric_ids 冗余列；跨表带维度复合查询一期拒绝（§6.3）；权限一期边界（§7.5）。
> 交付对象：实施本模块的 AI / 工程师。本文档是自包含的实施规格：架构、数据模型、编译规则、API 契约、前端、里程碑、本地调试联调全部在此。
> 唯一契约真源仍是 `docs/API.md`——本文件定稿后，第一步是把第 8 节内容并入 API.md（Node 侧新章节 1.12，engine 侧新章节 2.5）。

---

## 1. 背景与能力要求

在 DataBridge（三服务：Go 引擎 `databridge-engine` :8080、Node 管理端 `node-express-boilerplate` :3001、前端 `vue-vben-admin` :3100，元数据库 MySQL 10.45.34.222:3306/dataLink）之上新增**指标中心**模块。参考两个成熟项目并取各家之长：

- **SuperSonic**（github.com/tencentmusic/supersonic）：语义层对象模型 + 自然语言问数（S2SQL）+ LLM 问答工作流。
- **qData-metric**（gitee.com/qiantongtech/qData-metric）：指标治理（指标域/分层/口径/版本/预计算任务/API 服务化）。

界面与交互参考（本地调试时打开对照）：
- qData 数据分层页：https://demo.qdata.tech/dm/dataLayer （登录账号 `qData` / 密码 `qData123`，看主题域树 + 分层表分离的布局、首页概览的指标卡片排布）
- SuperSonic 演示站：http://129.204.36.122:9080/ （登录账号 `admin` / 密码 `123456`，看 ChatBI 问答、语义模型管理、指标下钻的交互）

**功能需求对照表（验收依据）**：

| # | 用户需求 | 方案落点 |
|---|---------|---------|
| 1 | 清洗汇总数据指标 | 指标任务（§7.2）：编译器生成 `INSERT INTO 目标表 SELECT 聚合...`，engine 真实执行，cron 调度复用现有 Node 调度器 |
| 2 | 基础指标加工 | 三类指标（§6）：原子 ATOMIC → 派生 DERIVED（继承+限定）→ 复合 COMPOSITE（公式再加工） |
| 3 | 界面关联修改指标、加公式再加工 | 指标管理页（§7.3）：公式编辑器带指标引用选择、依赖 DAG 血缘图、保存时循环/语法校验、影响分析提示 |
| 4 | 界面建模、同领域表分离 | 指标域树 + 数据分层（ODS/DIM/DWD/DWS/ADS）+ 模型向导 + 界面建表（DDL 经 engine 在目标库真实执行）（§7.1） |
| 5 | 大模型语义化问数、按指标值关联子指标与公式 | ChatBI 链路（§7.4）：词库召回→M2SQL 生成→校验纠错→语义编译→执行；响应内嵌 `metricTree`（子指标+公式展开树） |
| 6 | 登录 & 首页概览（指标数量、任务运行统计） | 登录直接复用 V6 用户体系（JWT + 登录日志 + 角色菜单显隐），**不新建鉴权**；指标中心首页 `GET /metric-dashboard` + `/metric/home` 页（§7.5） |

**两家开源版都没有完整的复合公式引擎（qData 无复合指标，SuperSonic 无 COMPOSITE 类型），§6.3 公式编译是本模块自研核心。**

## 2. 参考项目结论速览（已核实源码/文档）

### 2.1 从 SuperSonic 借鉴
- 元数据组织：Database(域)→Model(逻辑表，detail 存 JSON)→Dimension/Metric；模型挂 `databaseId` + `model_detail`。
- 指标定义：`type(ATOMIC/DERIVED) + define_type + type_params(JSON: expr+依赖列表)`，派生类型由规则推导而非人工标注；表达式是普通 SQL 片段（非模板语言）。
- 校验思路：FIELD 模式必须含聚合函数、MEASURE/METRIC 模式禁止聚合函数（用 SQL 解析器判定）；名称字符白名单前置把关。
- 问答工作流状态机：MAPPING(词库/向量召回)→PARSING(LLM 生成语义 SQL)→CORRECTING(规则+LLM 双重试)→TRANSLATING(编译物理 SQL)→执行；Prompt 里 schema 段带 `名 ALIAS AGG FORMAT COMMENT`，SideInfo 带当前日期/术语/示例。
- 同环比、维度下钻校验、审核后的问答对回灌为 few-shot。

### 2.2 从 qData-metric 借鉴
- 治理字段是一等公民：业务口径、负责人、上下架状态、保存即版本、版本带修改说明、试运行查看 SQL 与结果。
- 分层与命名规范：`dm_data_layer`（ODS/DIM/DWD/DWS/ADS）+ 主题域树（code+parent_id）+ 分层前缀命名（如 `ADS_交易_`）；模型带 create_type（手动录入/物化发布）+ 物化记录表。
- 派生指标=「继承+限定」：派生只能取原子已声明的度量/维度/逻辑，选分析维度+业务限定+时间粒度。
- 预计算任务：单次/计划调度、存储位置/更新策略/异常处理、统一任务列表 + 执行日志（SQL/耗时/数据量）。
- 工程惯例：每表 `del_flag/create_by/create_time/update_by/update_time/remark`，层级 code+parent_id，枚举走字典。

### 2.3 明确不学 / 不做的
- 不引入 Java/Spring、ES、独立向量库、Flink、Calcite——本模块用现有 Go+Node+MySQL 栈实现同等能力，向量召回做成可选增强（OpenAI embeddings 接口 + 内存余弦）。
- 不做查询期多方言下推全家桶：一期只支持 **MySQL 5.7+ 与 Oracle** 数据源（与 engine real 模式现状一致）。
- 不照抄 SuperSonic 的 MyBatis 动态 SQL 表达式；公式语法用 `${met_xxx}` 引用占位（§6.3）。

## 3. 总体架构

```
vue-vben-admin (:3100)
  └─ 菜单「指标中心」：域与建模 / 指标管理 / 指标任务 / 智能问数
        │ /api/v1 (信封 {code,message,result}，JWT 鉴权)
        ▼
node admin (:3001)  ← 新增 src/services/metric*、src/routes/v1/metric*.route
  ├─ 元数据 CRUD（MySQL 元库 dataLink，表前缀 databridge_metric_*，启动自动建表）
  ├─ 公式解析/校验/依赖维护（node-sql-parser）
  ├─ 语义编译器（指标+维度+时间 → 物理 SQL）★核心
  ├─ ChatBI 编排（词库召回 → LLM → 纠错）→ OpenAI 兼容 API（env 配置）
  └─ 指标任务调度（复用现有 node-cron 调度器）
        │ 下发无状态快照（含连接凭据），engine 只建连执行
        ▼
databridge-engine (:8080)  ← 新增 2 个接口（api/v1/engine.go 扩展）
  ├─ POST /api/v1/engine/sql/query   同步查询（试运行/问数取数）
  └─ POST /api/v1/engine/sql/exec    执行 DDL/DML（界面建表/清洗物化，异步回报可选）
        ▼
业务数据源（MySQL 10.45.34.222 测试库 / Oracle 10.45.34.90 等，复用 /datasources 已注册数据源）
```

设计约束（沿用项目既定原则）：
1. **引擎无状态**：Node 下发完整快照（endpoint 凭据+SQL），engine 不落库、不读元数据库。
2. **编译器在 Node 侧**：SQL 生成是控制面逻辑，便于与元数据/鉴权同进程；engine 只负责连接与执行。
3. **元库与业务库分离**：指标元数据全在 `dataLink` 库 `databridge_metric_*` 表；业务数据在 /datasources 注册的数据源。
4. `DB_DRIVER=mysql` 时一切数据读写走真实库，**严禁 mock**；memory 驱动仅供演示种子。
5. 表名字段名走既有标识符白名单校验；`queryParams` 绑定传参防注入（契约 1.9 已有约定，编译器继承）。
6. **架构不变式（用户拍板）**：本模块不改变三服务架构与既有部署形态；允许新增依赖包，但禁止为此改端口、加中间件（Redis/ES/向量库/消息队列）、拆服务或引入新运行时。既有功能（数据管道/同步任务/数据服务/文档中心/用户体系等）一律**只增不改**：新表、新路由、新页面挂在 `databridge_metric_*` 与 `/metric*` 命名空间下，不复用也不改动旧表结构；若某处确需触碰旧代码（如调度器注册、菜单、id_seq 表），改动必须是向后兼容的增量，旧回归套件（deploy/tests 全部既有脚本）必须保持全绿。
7. **允许新增的依赖（白名单，超出需先改本文档）**：
   - Node admin：`node-sql-parser`（公式/M2SQL 解析校验，唯一必需新依赖）；LLM 调用用原生 fetch/axios（已在依赖树），不引 langchain 类框架。
   - Go engine：无新依赖——`/sql/query`、`/sql/exec` 复用 `internal/infra/dbio` 现有 mysql/oracle 连接与池化。
   - 前端：无新依赖——图表用 vben 已带的 echarts，血缘/流程图用已有 LogicFlow，组件用 ant-design-vue。

## 4. 命名与通用约定

- 表前缀 `databridge_metric_`；路由前缀 `/metrics`、`/metric-domains`、`/metric-models`、`/metric-tasks`、`/metric-chat`（挂 `/api/v1` 下）。
- ID 前缀走 `src/db/init.js` 的 `databridge_id_seq` 注册表（新增如下条目）：

| 实体 | 前缀 | startId | 表 |
|------|------|---------|-----|
| 指标域 | `dom-` | 11000 | databridge_metric_domain |
| 模型 | `mdl-` | 12000 | databridge_metric_model |
| 指标 | `met-` | 13000 | databridge_metric_metric |
| 指标版本 | `mver-` | 13900 | databridge_metric_version |
| 指标任务 | `mtk-` | 14000 | databridge_metric_task |
| 任务执行记录 | `mtr-` | 14900 | databridge_metric_task_run |
| 业务术语 | `mterm-` | 16000 | databridge_metric_term |
| 问答示例 | `mex-` | 17000 | databridge_metric_example |
| 问答日志 | `mlg-` | 18000 | databridge_metric_query_log |

- 字段 camelCase（API 层）/ snake_case（库层）；时间 ISO 8601 UTC 字符串；每表带 `del_flag`、`created_at`、`updated_at`、`create_by`、`remark`（下文 DDL 省略注释）。
- 状态枚举统一：`draft` 草稿 / `online` 上线 / `offline` 下线。

## 5. 数据模型（DDL）

MySQL 5.7、**必须显式 utf8mb4**（库默认 utf8 是踩过的坑）。admin `src/db/init.js` 逐表 `CREATE TABLE IF NOT EXISTS` + 启动 ALTER 补可空列的既有自动迁移机制照旧。

```sql
-- 5.1 指标域（主题域，树形，兼做「同领域表分离」的命名规范载体）
CREATE TABLE IF NOT EXISTS databridge_metric_domain (
  id            VARCHAR(32) PRIMARY KEY,          -- dom-11000
  name          VARCHAR(128) NOT NULL,
  code          VARCHAR(64)  NOT NULL UNIQUE,     -- 建表前缀用，如 trade（^[a-z][a-z0-9_]{1,30}$）
  parent_id     VARCHAR(32)  NOT NULL DEFAULT '0',
  table_prefix  VARCHAR(64)  NOT NULL DEFAULT '', -- 界面建表自动前缀，空则取 code
  owner         VARCHAR(64)  NOT NULL DEFAULT '',
  sort          INT          NOT NULL DEFAULT 0,
  del_flag      TINYINT      NOT NULL DEFAULT 0,
  remark        VARCHAR(512) NOT NULL DEFAULT '',
  create_by     VARCHAR(64)  NOT NULL DEFAULT '',
  created_at    DATETIME, updated_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.2 数据模型（逻辑表 ↔ 物理表）
CREATE TABLE IF NOT EXISTS databridge_metric_model (
  id            VARCHAR(32) PRIMARY KEY,          -- mdl-12000
  name          VARCHAR(128) NOT NULL,            -- 中文名，如 交易订单明细
  datasource_id VARCHAR(32)  NOT NULL,            -- 复用 /datasources
  domain_id     VARCHAR(32)  NOT NULL,
  layer         VARCHAR(8)   NOT NULL,            -- ODS|DIM|DWD|DWS|ADS
  table_name    VARCHAR(128) NOT NULL,            -- 物理表名
  create_type   VARCHAR(8)   NOT NULL,            -- reference 引用已有表 | ddl 界面建表
  table_ddl     TEXT,                             -- create_type=ddl 时留档
  time_column   VARCHAR(64)  NOT NULL DEFAULT '', -- 默认时间维度列
  status        VARCHAR(8)   NOT NULL DEFAULT 'online',
  version       INT          NOT NULL DEFAULT 1,
  del_flag TINYINT NOT NULL DEFAULT 0, remark VARCHAR(512) NOT NULL DEFAULT '',
  create_by VARCHAR(64) NOT NULL DEFAULT '', created_at DATETIME, updated_at DATETIME,
  UNIQUE KEY uk_ds_table (datasource_id, table_name, del_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.3 模型字段
CREATE TABLE IF NOT EXISTS databridge_metric_model_column (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  model_id    VARCHAR(32) NOT NULL,
  column_name VARCHAR(64) NOT NULL,
  biz_name    VARCHAR(128) NOT NULL DEFAULT '',   -- 中文业务名（LLM schema 用）
  data_type   VARCHAR(32) NOT NULL,
  role        VARCHAR(16) NOT NULL,               -- dimension | measure | time
  agg_default VARCHAR(16) NOT NULL DEFAULT '',    -- measure 默认可用聚合 sum/count/max/min/avg/count_distinct
  is_key      TINYINT NOT NULL DEFAULT 0,
  UNIT        VARCHAR(16) NOT NULL DEFAULT '',
  remark      VARCHAR(512) NOT NULL DEFAULT '',
  UNIQUE KEY uk_model_col (model_id, column_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.4 指标（三类共用一张表，对齐 SuperSonic s2_metric 思路）
CREATE TABLE IF NOT EXISTS databridge_metric_metric (
  id           VARCHAR(32) PRIMARY KEY,           -- met-13000
  code         VARCHAR(64) NOT NULL UNIQUE,       -- 指标编码，公式引用键，^[a-z][a-z0-9_]{2,63}$，如 order_amt
  name         VARCHAR(128) NOT NULL,             -- 中文名：订单总金额
  alias        TEXT,                              -- JSON 数组 ["成交额",...]
  type         VARCHAR(16) NOT NULL,              -- ATOMIC | DERIVED | COMPOSITE
  define_type  VARCHAR(16) NOT NULL,              -- FIELD(手写聚合SQL片段) | MEASURE(字段+聚合) | METRIC(引用其他指标公式)
  model_id     VARCHAR(32) NOT NULL DEFAULT '',   -- ATOMIC 必填；DERIVED 可空（继承自基底）
  domain_id    VARCHAR(32) NOT NULL DEFAULT '',
  expr         TEXT,                              -- 见 §6，按 define_type 语义不同
  define_params TEXT,                             -- JSON：聚合/限定/维度/引用清单（编译器输入）
  unit VARCHAR(32) NOT NULL DEFAULT '', data_format VARCHAR(16) NOT NULL DEFAULT 'DECIMAL', -- DECIMAL|PERCENT|THOUSANDTH
  caliber TEXT,                                   -- 业务口径（qData 治理字段）
  owner VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(8) NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 1,
  is_publish TINYINT NOT NULL DEFAULT 0,
  del_flag TINYINT NOT NULL DEFAULT 0, remark VARCHAR(512) NOT NULL DEFAULT '',
  create_by VARCHAR(64) NOT NULL DEFAULT '', created_at DATETIME, updated_at DATETIME,
  KEY idx_model (model_id), KEY idx_domain (domain_id), KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.5 指标依赖边（保存时由 expr 解析维护，血缘/循环检测/子指标展开的唯一依据）
CREATE TABLE IF NOT EXISTS databridge_metric_dep (
  parent_id VARCHAR(32) NOT NULL,   -- 引用方（派生/复合指标）
  child_id  VARCHAR(32) NOT NULL,   -- 被引用方（基底/子指标）
  ref_expr  VARCHAR(64) NOT NULL DEFAULT '',  -- 在公式中的引用位置（记录用，可空）
  PRIMARY KEY (parent_id, child_id),
  KEY idx_child (child_id)          -- 反向：改了子指标，谁受影响
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.6 指标版本（保存即快照）
CREATE TABLE IF NOT EXISTS databridge_metric_version (
  id VARCHAR(32) PRIMARY KEY,       -- mver-13900
  metric_id VARCHAR(32) NOT NULL, version INT NOT NULL,
  snapshot TEXT NOT NULL,           -- 指标行完整 JSON
  change_note VARCHAR(512) NOT NULL DEFAULT '',
  create_by VARCHAR(64) NOT NULL DEFAULT '', created_at DATETIME,
  KEY idx_metric (metric_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.7 清洗汇总任务（指标预计算/物化）
CREATE TABLE IF NOT EXISTS databridge_metric_task (
  id VARCHAR(32) PRIMARY KEY,       -- mtk-14000
  name VARCHAR(128) NOT NULL,
  domain_id VARCHAR(32) NOT NULL,
  source_model_id VARCHAR(32) NOT NULL,
  metric_ids TEXT NOT NULL,         -- JSON 数组：本任务要汇总的 ATOMIC/DERIVED/COMPOSITE 均可
  dimension_column_ids TEXT,        -- JSON 数组：GROUP BY 的模型字段
  clean_rules TEXT,                 -- JSON 数组，见 §7.2.2
  time_preset TEXT,                 -- JSON：{mode:BETWEEN|RECENT, unit:DAY|WEEK|MONTH, period:N}
  target_datasource_id VARCHAR(32) NOT NULL,
  target_model_id VARCHAR(32) NOT NULL DEFAULT '', -- 已存在的 ADS 模型；为空则运行时自动界面建表
  target_table VARCHAR(128) NOT NULL DEFAULT '',
  write_mode VARCHAR(16) NOT NULL DEFAULT 'overwrite',  -- overwrite|append|upsert
  upsert_keys TEXT,                 -- JSON 数组：upsert 主键列
  schedule_cron VARCHAR(64) NOT NULL DEFAULT '',   -- 空=手动；Quartz 6 位，复用现有调度器格式
  status VARCHAR(8) NOT NULL DEFAULT 'online',
  last_run_at DATETIME, last_status VARCHAR(16) NOT NULL DEFAULT 'idle',
  del_flag TINYINT NOT NULL DEFAULT 0, remark VARCHAR(512) NOT NULL DEFAULT '',
  create_by VARCHAR(64) NOT NULL DEFAULT '', created_at DATETIME, updated_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.8 任务执行记录
CREATE TABLE IF NOT EXISTS databridge_metric_task_run (
  id VARCHAR(32) PRIMARY KEY,       -- mtr-14900
  task_id VARCHAR(32) NOT NULL, trigger VARCHAR(8) NOT NULL,   -- manual|cron
  status VARCHAR(8) NOT NULL,       -- running|success|failed
  sql_text TEXT,                    -- 实际执行的清洗 SQL（多语句用 \n--  分隔）
  read_rows BIGINT NOT NULL DEFAULT 0, write_rows BIGINT NOT NULL DEFAULT 0,
  elapsed_ms BIGINT NOT NULL DEFAULT 0, message TEXT,
  created_at DATETIME, KEY idx_task (task_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.9 业务术语（LLM 侧知识，借 s2_term）
CREATE TABLE IF NOT EXISTS databridge_metric_term (
  id VARCHAR(32) PRIMARY KEY,       -- mterm-16000
  name VARCHAR(128) NOT NULL, alias TEXT, description TEXT NOT NULL,
  related_metric_ids TEXT, related_model_ids TEXT,
  del_flag TINYINT NOT NULL DEFAULT 0, created_at DATETIME, updated_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.10 示例问答（few-shot）
CREATE TABLE IF NOT EXISTS databridge_metric_example (
  id VARCHAR(32) PRIMARY KEY,       -- mex-17000
  question VARCHAR(512) NOT NULL, m2sql TEXT NOT NULL, note VARCHAR(512) NOT NULL DEFAULT '',
  enabled TINYINT NOT NULL DEFAULT 1, created_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.11 问数日志（审计+few-shot 素材；滚动上限 5 万条，仿 doc_access_log 做法）
CREATE TABLE IF NOT EXISTS databridge_metric_query_log (
  id VARCHAR(32) PRIMARY KEY,       -- mlg-18000
  user_name VARCHAR(64) NOT NULL DEFAULT '', question VARCHAR(1024) NOT NULL,
  matched TEXT,                     -- JSON：召回的元素
  m2sql TEXT, physical_sql TEXT, status VARCHAR(8) NOT NULL,  -- success|corrected|failed|clarify
  metric_ids VARCHAR(1024) NOT NULL DEFAULT '',  -- 命中指标 id 逗号分隔冗余列（hotMetrics 频次统计用，勿解析 matched JSON）
  error TEXT, elapsed_ms BIGINT NOT NULL DEFAULT 0, result_preview TEXT,
  reviewed TINYINT NOT NULL DEFAULT 0,   -- 人工审核通过=1 → 可一键转 example
  created_at DATETIME, KEY idx_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5.12 指标中心系统配置（LLM 参数等；表内值优先，缺省回落 §10.2 的 env）
CREATE TABLE IF NOT EXISTS databridge_metric_setting (
  setting_key   VARCHAR(64) PRIMARY KEY,          -- llm.baseUrl / llm.apiKey / llm.model / llm.timeoutMs / llm.embed.enabled
  setting_value TEXT NOT NULL,
  secret        TINYINT NOT NULL DEFAULT 0,       -- 1=API 不回显明文（只回掩码，仿 docKey 掩码做法）
  updated_by    VARCHAR(64) NOT NULL DEFAULT '',
  updated_at    DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## 6. 指标定义与公式引擎（核心）

### 6.1 类型体系（define_type 决定语义，type 由规则推导，不人工填）

| type | define_type | expr 语义 | define_params | 推导规则 |
|------|-------------|-----------|---------------|----------|
| ATOMIC 原子 | `MEASURE` | 单聚合函数，如 `SUM(t.order_amt)` | `{modelId, measureColumn, agg, timeColumn?, filterSql?}` | define_type=MEASURE 且 expr 不含其他指标引用 |
| ATOMIC 原子 | `FIELD` | 手写聚合 SQL 片段 | `{modelId, filterSql?}` | define_type=FIELD |
| DERIVED 派生 | `METRIC` 基底为单指标 | 空（继承基底 expr） | `{baseMetricId, dimensions:[columnId], filterSql?, timePreset?}` | 引用闭包只含 1 个指标 |
| COMPOSITE 复合 | `METRIC` | 标量四则运算公式，引用用 `${met_code}` | `{refs:[code...]}`（保存时从 expr 解析生成） | 引用 ≥2 个指标或含运算 |

校验硬规则（保存时，借 SuperSonic `MetricCheckUtils` 思路，用 `node-sql-parser` 解析）：
1. MEASURE/METRIC 的 expr **禁止**出现聚合函数（聚合来自被引用指标自身）；FIELD **必须**含聚合函数。
2. code 全库唯一、`^[a-z][a-z0-9_]{2,63}$`、创建后不可改（公式引用锚点）。
3. 引用的 `${code}` 必须存在且 `status=online`（草稿可放宽为 warning）。
4. **循环检测**：对 `databridge_metric_dep` 做 DFS，发现环 → 400xx 报出环路径。
5. 复合公式仅允许：数字、`+ - * / ( )`、`CASE WHEN ... END`、白名单标量函数（`COALESCE ROUND ABS FLOOR CEIL NULLIF IF`）、`${code}` 引用；出现表名、列名、聚合、子查询一律拒绝（复合层只做已聚合值之间的运算）。
6. DERIVED 的 `dimensions` 只能是基底指标所在模型（或其关联模型，一期同模型）已声明的 dimension 字段——即 qData 的「继承+限定」。

### 6.2 原子指标编译产物（内部 IR）

编译器先把每个指标编译成统一 IR（内部中间结构），复合/清洗/问数都消费 IR：

```json
{
  "select": [{"agg":"SUM","column":"t.order_amt","as":"order_amt"}],
  "from": {"datasourceId":"ds-1001","table":"dwd_order_detail","alias":"t"},
  "where": ["t.status='PAID'", "<timeFilter>"],
  "groupBy": ["t.region"],
  "timeColumn": "t.pay_date"
}
```

### 6.3 复合公式展开算法（自研核心）

输入：`metricId, dateRange, dimensions[]`；输出：物理 SQL。

```
compile(metric, dims, time):
  if ATOMIC: 生成 IR（select=聚合，from=模型物理表，where=filterSql+时间）
  if DERIVED: base=compile(基底指标, dims∩可用维度)
              → IR 上追加 where(filterSql) / 时间预设换算 / groupBy(dims)
  if COMPOSITE:
     1. 解析 expr 得引用列表 → 递归 compile 每个子指标（memo 去重，同参数复用）
     2. 合并策略：
        a) 所有子指标同 datasource + 同物理表 + 同 filter + 同时间
           → 合并为单次扫描：SELECT expr(替换 ${code}→对应聚合表达式) FROM 表 WHERE ... GROUP BY dims
        b) 否则 → 标量子查询拼接：每个 ${code} 替换为 (SELECT agg FROM ... )，
           整式变为 SELECT (子1)/(子2) FROM DUAL（Oracle）/ 无 FROM 查询（MySQL 需包 SELECT）
     3. 维度对齐：只有 relateDimensions 交集内的 dims 可用于分组，越界 → 400xx 提示
     4. 一期硬边界：带 GROUP BY 维度的复合查询要求所有子指标同表（合并扫描可行）；
        子指标跨表/跨源的复合仅允许标量（无维度）查询，带维度直接 400xx 拒绝，
        禁止生成"多路 group by 子查询相乘"的错误 SQL
  递归深度上限 8；visited 集合防环（双保险，依赖已做静态循环检测）
```

示例：`件单价 = ${order_amt} / ${order_cnt}`，同表合并产物：
```sql
SELECT t.region, SUM(t.order_amt)/COUNT(t.id) AS unit_price
FROM dwd_order_detail t
WHERE t.status='PAID' AND t.pay_date BETWEEN '2026-09-01' AND '2026-09-30'
GROUP BY t.region
```

MySQL **5.7 无 CTE**：编译器禁用 WITH，统一用子查询/合并扫描（上例 a 类覆盖绝大多数场景；b 类跨表复合用标量子查询，行数 limit 1 语义）。同环比（RATIO_ROLL/RATIO_OVER）一期不做，IR 结构已预留 `timePreset` 扩展位。

### 6.4 子指标展开树（需求 3/5 的共同底座）

`GET /metrics/:id/tree`：按 `databridge_metric_dep` 递归下钻（带环保护、深度上限 8），返回：

```json
{ "id":"met-13001","code":"unit_price","name":"件单价","type":"COMPOSITE","expr":"${order_amt} / ${order_cnt}",
  "children":[
    {"id":"met-13000","code":"order_amt","name":"订单总金额","type":"ATOMIC","expr":"SUM(t.order_amt)","model":"交易订单明细","children":[]},
    {"id":"met-13002","code":"order_cnt","name":"订单数","type":"ATOMIC","expr":"COUNT(t.id)","children":[]}
  ] }
```

问数响应把该树挂在 `metricTree` 字段 → 前端渲染「指标值 → 公式 → 子指标值」逐层展开（子指标值随同一次编译多取一遍：展开树时每个叶子同参数各查一次并回填 `value`）。

## 7. 功能模块设计

### 7.1 域与建模（需求 4）

**指标域**：树形 CRUD + `GET /metric-domains/tree`；删除校验（下有模型/指标禁删）。

**模型管理**两种创建方式：
1. **引用已有表**：选数据源 → 复用现有表名选择器（`TableSelect`，切源拉全量+本地过滤的产品定案不变）→ 拉列元数据（现有 `GET /datasources/:id/columns` 能力）→ 字段角色自动识别（借 qData：非数值/含 id→dimension，日期→time，其余数值→measure，可手工调整；借 SuperSonic：可勾选「用 LLM 辅助识别」，调 §7.4 同一 LLM 通道给 prompt「把列分类为 dimension/measure/time 并给中文业务名」，失败静默回退规则识别）→ 保存。
2. **界面建表**（DDL）：域内选分层 → 表单定义列（名/类型/长度/PK/注释）→ 生成 `CREATE TABLE`（表名=`{domain.table_prefix}_{layer小写}_{用户输入}`，utf8mb4、显式主键）→ 预览 SQL → 确认后 **engine `/sql/exec` 在目标数据源真实执行** → 自动登记为 model（create_type=ddl）。同领域数据即通过「域前缀 + 分层」在物理表上分离。
   - 建表红线：表名/列名走标识符白名单（`^[A-Za-z_][A-Za-z0-9_]{0,63}$`）；`DROP/ALTER` 一期不提供界面入口。

### 7.2 清洗汇总任务（需求 1）

**7.2.1 流程**：选源模型 → 勾选要汇总的指标与分组维度 → 时间预设 → 目标（选/建 ADS 模型） → 写入策略 → 试运行（LIMIT 预览走 `/sql/query`）→ 保存 → 调度（cron 复用现有任务调度器格式与重试逻辑）。
**DAG 定位**：一期指标任务为单节点（源模型→目标表）；多任务编排不重复造轮子——需要 DAG 时把指标任务作为节点挂到现有「数据开发」（LogicFlow 画布）/同步任务调度体系，属后续扩展点，本期限定不改其结构。

**7.2.2 clean_rules（JSON 数组，按序应用）**：
```json
[
  {"type":"filter","sql":"t.amount >= 0"},
  {"type":"dedup","by":["order_id"],"keep":"latest","on":"pay_time"},
  {"type":"fill","column":"region","value":"未知"},
  {"type":"rename","from":"old_col","to":"new_col"}
]
```
编译器把规则翻进 IR（filter 追加 where；dedup→`ROW_NUMBER() 窗口`不可用（5.7），改 `GROUP BY pk + MAX(...)` 或自连接 `NOT EXISTS` 方案，Oracle 走 `ROW_NUMBER`；fill→`COALESCE(col,'未知')`；rename 只影响目标列名映射）。

**7.2.3 执行**（engine `/sql/exec`，statements 依序）：
- overwrite：`TRUNCATE TABLE tgt;` + `INSERT INTO tgt(...) SELECT ...`
- append：直接 INSERT
- upsert：`INSERT INTO tgt(...) SELECT ... ON DUPLICATE KEY UPDATE ...`（MySQL）；Oracle 一期只允许 overwrite/append，生成语句时校验拦截。
- 目标表不存在（自动建表模式）：先 `CREATE TABLE IF NOT EXISTS`（列=维度列+指标 code 列+`_etl_time`）。
- 执行结果（行数/耗时/SQL）落 `databridge_metric_task_run`，失败走现有告警规则通道。

**7.2.4 指标对外服务 = 复用 /ds DataAPI，不自建**：物化出的 ADS 表直接在现有「数据服务」页发布为 API（SQL 模式即查 ADS 表；forward 模式不适用），复用其 apiKey/白名单/限流/调用日志/swagger 文档中心/docKey 全套能力；`/metric` 模块不提供独立对外查询端点。问数结果如需分享，同样引导走 /ds 发布。

### 7.3 指标管理界面（需求 2/3）

- 列表：域树侧栏 + 搜索（名称/code/别名）+ 类型/状态筛选 + 批量上下线。
- 编辑抽屉（三 tab 切换类型）：
  - 原子：选模型→选度量字段→选聚合→时间列/粒度→过滤条件（表达式框）。
  - 派生：选基底指标（只列出自己有权看的 online 指标）→继承信息只读展示→勾分析维度→业务限定→时间预设。
  - 复合：**公式编辑器**——textarea + 「插入指标」弹窗（域内指标搜索选择，插入 `${code}`）+ 实时语法/循环/白名单校验（失焦调 `POST /metrics/validate`）+ 右侧依赖预览。
- 详情页：口径、版本历史（可回滚=以旧快照建新草稿）、**血缘图**（LogicFlow 已有依赖：上=引用我的指标，下=我引用的子指标，公式标注在边）、试跑面板（选时间+维度→`POST /metrics/preview` 返回 SQL+结果表格/单值）。
- **关联修改**（需求 3 核心交互）：修改任一指标保存成功后，弹窗列出「受影响的父指标」（`databridge_metric_dep.idx_child` 反查），一键跳转批量重新校验。

### 7.4 ChatBI 智能问数（需求 5）

链路（对齐 SuperSonic 状态机，简化实现，全部在 admin 进程内）：

```
POST /metric-chat/ask { question, sessionId?, dateRange? }
  1 MAPPING   词库召回：内存索引（指标 code/name/alias、字段 biz_name、域名、术语、维度值）
              精确+编辑距离(阈值 0.3) 匹配 → schema 候选集；候选>15 元素时截断按分数
              （可选增强：env LLM_EMBED_ENABLED=1 时启动拉 /embeddings 建向量缓存，余弦召回；默认关）
  2 PARSING   组 Prompt 调 LLM 生成 M2SQL（指标 SQL 方言）
  3 CORRECTING 规则校验（表名=已注册域名/模型名、列名=召回集、聚合函数禁出现在 M2SQL）
              失败→带错误信息让 LLM 重试 1 次→仍失败→返回 clarify（候选指标列表让用户点选）
  4 TRANSLATING 编译器把 M2SQL（业务名指标/维度/时间 WHERE）→ 物理 SQL（§6）
  5 执行       engine /sql/query（limit 默认 1000）
  6 回答       { value/rows, metricTree(含子指标 value 回填), m2sql, physicalSql, explain }
```

**M2SQL 方言**（借 S2SQL，LLM 只写语义层，不接触物理表）：
```sql
SELECT `地区`, `订单总金额`, `件单价` FROM `交易域`
WHERE `数据日期` BETWEEN '2026-09-01' AND '2026-09-30'
GROUP BY `地区` ORDER BY `订单总金额` DESC
```
表名=域名或模型名；列名=指标 name/alias、字段 biz_name。**中文标识符必须反引号包裹**（Prompt 规则同步声明；node-sql-parser 对裸中文标识符解析不可靠）。解析流程两步走：① 先把召回集内的业务名/别名做最长匹配替换为 `` `${met-id}` `` / `` `${col-id}` `` 规范 token；② 再交 node-sql-parser 结构化解析。替换不上且非保留字的名称 → 判失败进纠错/clarify，绝不带着未知名去编译。

**Prompt 模板**（存 `metric/prompt.js`，可调不改代码）：
```
角色：指标问数助手。把用户问题转成 M2SQL，只输出 SQL 与一行说明。
### 可用指标: name(ALIAS [别名], 聚合方式, 单位, 口径摘要) 清单（召回集）
### 可用维度: name(ALIAS, 所属模型) 清单
### 可用域/表: 域名(含模型清单)
### 业务术语: mterm 命中项 name=description
### 当前日期: {{today}}（相对时间一律基于此换算）
### 示例: {{enabled examples ≤5}}
### 规则: 禁止聚合函数/物理列名/子查询；时间条件必须显式给出，缺省时用最近7天；无法确定时输出 CLARIFY:候选项
```

**知识维护**：`/metric-terms`、`/metric-examples` CRUD；问数日志页支持「审核通过→转示例」；LLM 配置走 env（§10），不落库不入库明文 key。
**多轮**：一期前端带 `sessionId`，admin 内存 map 存最近 5 轮（问题+命中元素），Prompt 注入 PriorKnowledge；重启即失，不落库。

### 7.5 登录与指标中心首页概览（需求 6）

**登录**：完全复用 V6 用户体系——前端登录页 + JWT + 路由守卫 + 角色菜单显隐 + 登录日志，指标中心只新增菜单组，不新建任何鉴权逻辑；`/metric*` 全部路由走与 `/users` 相同的 auth 中间件（docKey 与 `/ds` apiKey 机制不受影响）。

**首页概览 `GET /metric-dashboard`**（实时 COUNT 聚合，不建新表；实现照抄现有 `statistics.service` 的分组计数模式）：

```json
{ "domains": {"total": 4},
  "models":  {"total": 12, "byLayer": {"ODS":3,"DIM":2,"DWD":4,"DWS":2,"ADS":1}},
  "metrics": {"total": 35, "byType": {"ATOMIC":20,"DERIVED":9,"COMPOSITE":6},
              "byStatus": {"online":28,"draft":4,"offline":3}},
  "tasks":   {"total": 6, "enabled": 5, "last24h": {"success":11,"failed":2,"running":1}, "successRate": 0.846},
  "chat":    {"last7dQueries": 143, "last7dFailed": 9},
  "hotMetrics": [ {"id":"met-13000","name":"订单总金额","queryCount":31} ] }
```

- `hotMetrics`：近 7 天按 `databridge_metric_query_log.metric_ids` 冗余列拆分计数 Top10（不解析 matched JSON）。
- 卡片点击跳转对应列表页并带筛选参数（如「失败任务」→ `/metric/task?lastStatus=failed`）。
- 前端路由 `/metric/home` 作为「指标中心」菜单默认子页；布局参考 qData demo 首页（上排数量卡 + 下排任务趋势/热门指标）。
- **权限一期边界（防过度设计）**：不做指标敏感度分级、不做行级/列级数据权限；可见性=登录用户全量可见（菜单显隐沿用角色机制），数据可查范围由所选数据源账号自身权限天然决定；`sensitive_level` 一期仅作为展示字段不拦截。

## 8. API 契约（实施第一步并入 docs/API.md，编号 Node 1.12 / engine 2.5）

信封 `{code,message,result}`，错误码段：400xx 参数、404xx 不存在、**409xx 冲突（域下有资产/循环依赖/表已存在）**、500xx 服务异常、**50201 数据源执行失败（透传库错误）**、401 未登录沿用 JWT 全局中间件（本节所有路由均挂 auth，问数路由同样）。

### 8.1 Node 管理端

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/metric-dashboard` | 首页概览（§7.5，实时 COUNT 聚合，无新表） |
| GET/POST | `/metric-domains` | 列表(平铺)/创建；GET `/metric-domains/tree` 树 |
| PUT/DELETE | `/metric-domains/:id` | 更新/软删（有资产→40902） |
| GET/POST | `/metric-models` | 分页（domainId/layer/datasourceId 筛选）/创建（reference 或 ddl） |
| GET/PUT/DELETE | `/metric-models/:id` | 详情(含 columns)/更新/软删 |
| POST | `/metric-models/preview-ddl` | 列定义→CREATE TABLE SQL 回显（不落库） |
| GET | `/metric-models/:id/preview` | 前 20 行真实数据（engine /sql/query） |
| GET/POST | `/metrics` | 分页（domainId/type/status/keyword 搜 name/code/alias）/创建 |
| GET/PUT/DELETE | `/metrics/:id` | 详情/更新（保存即新版本）/软删（被引用→40903） |
| POST | `/metrics/validate` | 草稿校验：语法/聚合规则/循环/维度合法性，返回 errors+warnings（无副作用） |
| GET | `/metrics/:id/tree` | 子指标展开树（§6.4） |
| GET | `/metrics/:id/lineage` | 双向血缘 {parents, children}（LogicFlow 数据） |
| POST | `/metrics/:id/preview` | 试跑 {dateRange, dimensions[], limit} → {sql, columns, rows, elapsedMs} |
| GET | `/metrics/:id/versions` | 版本列表；POST `/metrics/:id/rollback` {version} → 生成新草稿 |
| GET/POST/PUT/DELETE | `/metric-tasks...` | 标准 CRUD + `/runs` 列表 + POST `/metric-tasks/:id/run`（手动触发） |
| GET/POST/PUT/DELETE | `/metric-terms...`、`/metric-examples...` | 知识 CRUD |
| POST | `/metric-chat/ask` | {question, sessionId?, dateRange?} → §7.4 响应 |
| GET/POST | `/metric-chat/sessions/:id/history` | 多轮上下文查询/清空 |
| GET | `/metric-logs` | 问数日志分页筛选；POST `/metric-logs/:id/to-example` 审核转示例 |
| GET/PUT | `/metric-settings` | 系统配置：GET 回显（`llm.apiKey` 只回掩码 `sk-xx***`），PUT 批量保存（值传空串=保持不变）；仅 admin 角色（复用现有角色校验中间件）；用户权限管理不新做页面，沿用 `/users` 用户管理页 |

### 8.2 engine 新增（api/v1/engine.go，沿用 `{code,message,data}` 与 EndpointDTO）

```
POST /api/v1/engine/sql/query
  请求 { "endpoint": EndpointDTO(含 host/port/username/password/database/table 可空),
         "sql": "SELECT ...", "limit": 1000, "timeoutSec": 30 }
  响应 data { "columns":[...], "rows":[[...]], "rowCount":n, "elapsedMs":n }
  校验：仅允许单条语句且匹配 ^\s*SELECT（含 SHOW/DESCRIBE 白名单另议，一期只 SELECT）；
        执行失败 HTTP 502 + code 50002（透传库错误），admin 侧转 50201 给前端

POST /api/v1/engine/sql/exec
  请求 { "instanceId":"mtr-xxx", "endpoint":EndpointDTO,
         "statements":["CREATE TABLE ...","TRUNCATE ...","INSERT ... SELECT ..."],
         "reportUrl": 可选（异步：立即 accepted，完成后按现有 ProgressReport 回报） }
  同步模式（无 reportUrl）响应 data { "results":[{"affectedRows":n,"elapsedMs":n}] }
  校验：每语句首关键字 ∈ {CREATE TABLE, TRUNCATE TABLE, INSERT INTO, ALTER TABLE ADD COLUMN}
        —— 拒绝 DROP/DELETE/GRANT/多语句拼接；标识符白名单复用 pkg 现有校验
  仅支持 type ∈ {mysql, oracle}（与现状一致）
```

engine 侧凭据处理照旧契约第 5 节：明文仅进程间传输、不进日志与回报。

**engine 鉴权（新增，安全前置项）**：现状 engine :8080 所有接口零鉴权，`/sql/*` 相当于把内网库任意执行权裸奔，因此本模块要求：
- env `ENGINE_SHARED_SECRET`（admin/engine 双侧同名配置，K8s 走 `databridge-db-secret` 同款 Secret 注入）。
- admin→engine 全部请求（含既有 `/engine/tasks/start` 与新 `/sql/*`）带请求头 `X-Engine-Token: <secret>`；engine 中间件校验，不匹配 → 40101。
- engine→admin 回报（`/report`、`/logs`）带同一请求头，admin 校验（顺带解决 v9 遗留的回报通道鉴权 TODO）。
- **平滑上线**：secret 为空时只打 WARN 放行（兼容旧部署），配置后即强制——发版顺序：先双侧配好 secret 再切强制，由 RELEASE.md 记录。
- 该机制对既有接口是向后兼容增强（不带 token 的旧模拟回归脚本在空配置态仍通过），M3 的硬性前置。

## 9. 前端（vue-vben-admin）

新增菜单组「指标中心」，路由 `/metric/*`，页面（antd 组件直接上，遵循 vben 精简分支无 BasicTable 的现状）：

登录复用现有页面不动；**数据源管理页复用现有 `/datasources` 页（新增/编辑/测试连接/表名选择器都是现成的，指标中心直接引用，不重做）**。

| 页面 | 路由 | 要点 |
|------|------|------|
| 指标中心首页 | /metric/home | 概览卡片区（§7.5），作为菜单默认子页 |
| 指标域管理 | /metric/domain | 左树右表；域内资产统计（模型数/指标数） |
| 数据建模 | /metric/model | 左「分层树」右列表（v1.16：5 个分层根虚拟不可编辑，根下挂可建可删的「分类」节点带描述，节点显示模型计数、每层有「未分类」节点；列表行多选可批量归类）+两个向导（引用表 / 界面建表含 DDL 预览）；字段角色编辑表 |
| 指标管理 | /metric/metric | 列表+编辑抽屉（三类型 tab，公式编辑器+校验）+详情（血缘 LogicFlow、版本、试跑） |
| 指标任务 | /metric/task | 列表+任务编辑（规则可增删行）+运行历史抽屉（SQL/行数/耗时，失败可查 message） |
| 智能问数 | /metric/chat | 对话气泡 + 结果卡（大数值/表格/echarts）+ **metricTree 折叠展开面板**（每层：名称=公式，子指标值逐层回填）+ SQL 查看抽屉 |
| 问数审计 | /metric/log | **M6a 阶段先作为对话页「历史」tab**（列表+审核转示例），M6b 视需要再独立成页 |
| 系统配置 | /metric/setting | LLM 参数（baseUrl/model/key 掩码/超时/向量开关，存 metric_setting 表，见 §5.12）；「用户权限」区块直接内嵌跳转现有用户管理页 |

## 10. 本地调试与联调指南

### 10.1 启动
```bash
# 根目录脚本（Windows Git Bash / cmd 均可）
start-dev.cmd            # engine :8080 / admin :3001 / web :3100
# 单独重启 admin 需环境变量：
cd node-express-boilerplate
DB_DRIVER=mysql PORT=3001 yarn dev
```
- 元库：10.45.34.222:3306/dataLink（凭据在 admin `.env`，勿入库）。**新表全部走 init.js 自动建**，重启 admin 即生效，无需手工迁移。
- 业务数据源：先用 222 上同库建 demo 表（`dwd_order_demo`/`dws_order_daily`），经界面「数据源」注册后走建模流程。

### 10.2 LLM 配置（admin `.env`，新增，代码经 config 读取，禁止硬编码 key）
**接入协议统一为 OpenAI 兼容（用户拍板）**：代码只实现一套 chat/completions（+可选 embeddings）客户端，供应商通过 baseUrl+model+key 三元组切换——DeepSeek（`https://api.deepseek.com/v1`，ds）、通义千问、智谱 GLM、硅基流动 SiliconFlow 等主流 API 均兼容；本地备选 Ollama（`http://127.0.0.1:11434/v1`，任意 key）。内网访问外网 API 走 squid `10.45.34.223:3128`（记得域名加白 + `HTTPS_PROXY`，注意 223 的 IPv6 坑：`-4`/`dns_v4_first`）。
```
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=***
LLM_MODEL=deepseek-chat                          # 通义: qwen-plus / GLM: glm-4-flash / 硅基: 对应模型名
LLM_TIMEOUT_MS=30000
HTTPS_PROXY=http://weknora:weknora@10.45.34.223:3128   # 仅内网机器需要；本地开发有直连外网则留空
LLM_EMBED_ENABLED=0                              # 向量召回开关（模型名 LLM_EMBED_MODEL）
LLM_EMBED_BASE_URL=                              # embedding 独立端点（如硅基流动 https://api.siliconflow.cn/v1），留空回落 LLM_BASE_URL
LLM_EMBED_API_KEY=                               # embedding 独立密钥，留空回落 LLM_API_KEY（系统配置页同名字段 llm.embed.baseUrl/apiKey）
```
无外网 key 时可指向本地 Ollama（`http://127.0.0.1:11434/v1`，任意 key）。**运行时优先级：`databridge_metric_setting` 表（系统配置页可改，§5.12）> env**；`llm.apiKey` 只在表内做掩码回显、更新走 PUT。**LLM 不可达时问数路由返回 500xx 明确提示，指标 CRUD/编译/任务不受影响**（LLM 只在 §7.4 步骤 2/3 出现，编译链路纯规则可独立跑）。

### 10.3 调试顺序（每步都有可观测出口）
1. M0 后：重启 admin → `SHOW TABLES LIKE 'databridge_metric%'` 应 12 张。
2. 建模：界面建表向导 → 预览 DDL → 执行 → 222 库 `SHOW CREATE TABLE` 核对 utf8mb4。
3. 编译：`POST /metrics/:id/preview` 直接 curl（带 JWT），核对生成 SQL 与手工在 222 执行结果一致——**这是公式引擎的黄金对照**。
4. engine 联调：curl :8080 `/api/v1/engine/sql/query` 单语句 SELECT 冒烟；确认拒绝 DROP。
5. 问数：先用「示例问题」下拉里内置的 3 条 mex 冒烟，失败看 `databridge_metric_query_log`（m2sql/error 字段全留痕）。
6. 回归：`deploy/tests/test-metric-*.js`（§11 各阶段配套），memory 模式与 mysql 模式各跑一遍。

### 10.4 已知环境坑（务必遵守，历史踩过）
- MySQL 5.7：默认字符集 utf8→DDL 必须显式 utf8mb4；**无 CTE/窗口函数**（Oracle 有 ROWNUM/ROW_NUMBER 可用，编译器分方言）。
- 列名保留字（如 `unit`）：建表时反引号，编译器统一加。
- Node `require` 路径大小写与磁盘一致（Linux 容器区分）。
- STRICT+IGNORE_SPACE sql_mode：INSERT 必须显式列清单。
- 演示种子只进 memory 驱动；mysql 模式空库起步。

## 11. 实施里程碑（严格按序，每个里程碑先改 API.md 再写码）

| 阶段 | 内容 | 验收 |
|------|------|------|
| M0 契约+底座 | API.md 增 1.12/2.5；init.js 建表+ID 注册；validation 骨架 | 重启自动建表；`test-metric-base.js`（表结构/信封/401）通过 |
| M1 域与建模 | domain/model/column CRUD、引用表向导后端、preview-ddl、`/metric-dashboard`、`/metric-settings` | `test-metric-model.js`（含 409 冲突、软删保护）+ dashboard/settings 用例 |
| M2 指标与公式 | 三类指标、校验器、依赖表、tree/lineage/versions | `test-metric-compile.js` 黄金用例：同表合并/跨表子查询/循环拒绝/派生继承（memory+mysql 双跑） |
| M3 engine SQL 接口 | **前置：共享密钥中间件双侧落地（§8.2 鉴权，顺带关闭 v9 回报鉴权 TODO）**；/sql/query、/sql/exec、白名单、同步+回报 | Go 单测 + 222/90 真库冒烟；`test-metric-sql.js`（拒绝 DROP/多语句/错 token 40101） |
| M4 清洗任务 | task/run、编译器→物化 SQL、cron 接入、告警接入 | 建 ADS 表→跑任务→查行数幂等 |
| M5 ChatBI | 词库召回、Prompt、M2SQL 解析/纠错、ask 链路、日志/审核/示例 | `deploy/tests/test-metric-chat.js`：内置 10 问（相对时间/口径过滤/分组/复合公式/多指标/友好 clarify）≥7 题正确 + metricTree 子指标回填 + 会话/日志/转示例用例 |
| M6a 前端·核心 | 首页概览、指标域、数据建模、指标管理、智能问数（**问数审计以对话页「历史」tab 呈现，不做独立页**） | 浏览器实操走通 6 大需求主路径（本条由人工验证，不可用单测代替声明） |
| M6b 前端·扩展 | 指标任务管理、系统配置、独立问数审计页（若 M6a 的 tab 已够用可只做前两项） | 任务/配置/审计操作闭环 |
| M7 收尾 | RELEASE.md 补发版说明（admin+engine 双重建，`ONLY=admin,engine,web`）、回归全量 | 全绿 |

**实施进度（2026-10-08）**：M0~M7 ✅ 全量完成（`feat/metric-center`；全 12 套件回归全绿：metric base40/model39/compile51/sql19/task29/chat19 + chat-api19 + users33/dockey31/swagger40/forward19/parse-curl）。问数对外服务 ✅。M7 收尾：RELEASE.md 补 v9 三镜像重建说明、合并 main、打 tag V9。

**前端 UI 精修（2026-10-08）**：指标中心三个原生弹窗改版——域表单（600 宽居中/图标标题/提示条/两列栅格）、数据预览（980 宽/执行 SQL 代码块/行数说明/斑马纹）、运行记录（1000 宽/触发与状态中文 Tag/SQL 明细美化）；统一圆角与斑马纹样式收进 `src/design/index.less`（antd Modal 内容在 scoped 样式外，必须全局选择器）。web dist 已重打包 `deploy/web-dist/web-dist.tar.gz`。

**vben 组件化 + 演示增强（2026-10-08）**：① 三个弹窗全部迁到 vben `BasicModal + useModal`（用户规则：UI 一律优先 vben 封装组件，见记忆 feedback-vben-ui-components；BasicModal 的 class/wrapClassName 到不了弹窗 DOM——`useAttrs` 过滤 class，圆角等用内容根标记类 + `:has()` 全局命中）。② 每页新增「使用指南」折叠卡（共享 `views/metric/components/GuideCard.vue` + 文案集中 `views/metric/guides.ts`）。③ 演示数据扩充：`seed-metric-demo.js` 增加派生指标 dm_paid_east（基底 dm_paid+region 过滤）、两个物化任务（dm_region_sum overwrite / dm_region_daily upsert+BETWEEN+cron+fill），并各执行一次留运行记录（日汇总含 成功→失败→成功 三条）。④ 新增 `docs/METRIC-DEMO.md` 逐页走查清单。⑤ 域树逐层新增：节点悬停「+」直接建子域（右键菜单保留）；seed 固化常驻层级 dmtrade→dm_pay→dm_pay_channel；修复回归套件清理缺陷（sql/task 用 `code=RUN` 精确码逃过 `RUN_%` 清理，各域清理统一改 `RUN%` 前缀清扫 + model 套件加空域全库兜底清扫）。

**验收修复批3（2026-10-08）· Oracle 方言编译**：用户用制造域真实 Oracle 表（HR_PROD_MATERIAL）建指标试跑，暴露编译器两处 MySQL 假设：① `buildSelect` 无条件拼 `LIMIT n` → Oracle 报 ORA-00933（SQL 未正确结束）；② `timeFilter` 生成 `日期列 BETWEEN 'YYYY-MM-DD' AND ...` 裸字符串比较 → Oracle 报 ORA-01861（字面量与格式不匹配）。修复：编译器按数据源 type 出方言——Oracle 行数用 `FETCH FIRST n ROWS ONLY`（置于 ORDER BY 之后）、日期包 `TO_DATE('...','YYYY-MM-DD')`；MySQL 路径完全不变。`timeFilter` 加可选第三参 `oracle=false`（向后兼容，无外部调用者），标量/合并/原子三处调用点透传数据源方言。`test-metric-compile` 新增 7 条进程内 `compileMetric` Oracle 断言（不连真库，建 oracle 数据源+手工列模型+指标，断言 FETCH FIRST/TO_DATE 且 mysql 对照仍 LIMIT+字符串），套件 44→51 全绿；sql/task/chat 复跑无回归。注：用户该指标另有一处 `exted_col7` 笔误（真实列 EXTEND_COL7），属数据录入非平台缺陷，界面改过滤条件即可。

**V9 后压测与示例库（2026-10-09）**：① **跨库语法识别核查**——实测 node-sql-parser 探针对 mysql/oracle 方言函数**宽容互认**（两方言都能解析 NVL/TO_CHAR/TO_DATE/DECODE/TRUNC/REGEXP_LIKE/`||`），故探针无需按方言分支；但由此暴露真 bug：示例指标 `ex_nvl_safe` 校验通过、**MySQL 执行期报 `FUNCTION datalink.NVL does not exist`**。修复＝编译期把 `NVL(`/`IFNULL(` 归一为两库通用的 `COALESCE(`（`normalizeDialectFns`，metricCompiler 两处 expr 读取点），并对无法等价改写的方言专有函数（Oracle DECODE/NVL2/TO_CHAR/TO_DATE/TO_NUMBER/TRUNC/REGEXP_LIKE/SYSDATE/ROWNUM、MySQL DATE_FORMAT/STR_TO_DATE/GROUP_CONCAT/SUBSTRING_INDEX）在 validate/保存响应回 **warnings**（不阻断保存）。复合公式标量白名单从 7 个扩到 19 个。② **bench-metric.js 新增场景 C/D**：C＝11 类公式打 `POST /metrics/validate` 干跑并按预期 valid 断言（257 TPS @conc50，**正确性 100%**）；D＝三指标 preview 真库执行（MySQL 原子 122 TPS / p50 157ms，MySQL 复合 63 TPS，**Oracle gk1 34 TPS / p50 564ms**，零错误）。③ **示例指标库 `ex_*` 15 条**固化进 `seed-metric-demo.js`：7 原子（sum/count/avg/max 四种聚合 + FIELD 手写表达式 + 两个 filterSql 案例）、2 派生（继承基底+过滤 / +timePreset）、6 复合（四则 / 比率 / NULLIF 防除零 / CASE 分档 / NVL 跨方言 / GREATEST），dataFormat 覆盖 THOUSANDTH/DECIMAL/PERCENT，**每条 caliber 字段即一句配置说明书**；15/15 preview 真跑通过，`docs/METRIC-DEMO.md` 有对照表、指标页指南卡给出 `ex_` 检索入口。④ 修正 gk1 列名笔误（exted_col7→EXTEND_COL7），Oracle 真实返回 238545。回归：compile 51→60 全绿，base40/model39/sql19/task29/chat19/chat-api19 无回归。

**V10 方言层收敛（2026-10-09）**：用户报「测试老是出现不同数据库语法问题」+ 生产 Oracle 物化任务失败（`连接 10.45.66.32:1521/zzgldb 失败: dial tcp` 15s 超时，与 `dbio.ConnectTimeout=15s` 吻合 → 那一条是**集群到 66 网段的网络问题，不是 SQL 问题**；但同一条任务的 SQL 明细里暴露了第二类问题）。盘点发现方言判断散在 4 个文件里各写 `ds.type === 'oracle'`，且**有 5 个 SQL 生成点**，其中两处完全漏改：

| 生成点 | 收敛前状态 |
|---|---|
| `metricCompiler` 试跑/预览 | 已按方言出 TO_DATE/行数限制（V9 批3 修的） |
| `metrictask.buildStatements` 物化 | 建表/TRUNCATE **只有 MySQL 写法**（反引号+ENGINE+utf8mb4+DATETIME），时间窗**恒用裸字符串** |
| `metricmodel.buildDdl` 界面建表 | **完全 MySQL-only**，Oracle 源上预览即错 |
| `metricExec.previewModel` | 有 ROWNUM 分支，但手写 |
| `metricChat.assembleSelect` 问数落地 | **完全 MySQL-only**（反引号别名 + 裸日期 + LIMIT）→ Oracle 源上问数必炸 |

落地：新建 `src/utils/dialect.js` 作为 mysql/oracle 文本差异的唯一来源（标识符/表名、日期字面量、行数限制、now 表达式、ETL 留痕列名、MySQL 风格类型→Oracle 类型 + VARCHAR2 4000 上限拦截、CREATE TABLE、数据字典幂等探测、TRUNCATE、upsert 支持位、列注释拆 COMMENT ON、`FROM DUAL`、函数归一与跨库告警表、`supports.emptyStringIsNull`），五个生成点全部改为向它取片段，`ds.type === 'oracle'` 布尔分支清空。

行为变更（都属修 bug，需要知道）：① Oracle 行数限制由 `FETCH FIRST n ROWS ONLY` 改 **ROWNUM 嵌套**（12c+ 才支持 FETCH FIRST，与引擎侧 `dbio` 的 oracle 分页口径对齐，11g/12c 通用）；② Oracle 目标 ETL 留痕列 `_etl_time` → **`ETL_TIME`**（Oracle 非引号标识符必须字母开头，下划线开头会 ORA-00911，**跨库列名从此不同，属已知差异**）；③ Oracle 目标 `IF NOT EXISTS` 缺失 → 执行前 `SELECT COUNT(*) FROM user_tables` 探测，存在即跳过建表（幂等等价）；④ Oracle upsert 从执行期拒提前到**保存期 40001**；⑤ Oracle 目标 `cleanRules` 的 fill 空串在**保存期 40001**（Oracle 空串等价 NULL，填 `''` 会静默变成没填）；⑥ Oracle 目标自动把 `DATE_FORMAT(x,'%Y-%m')` 翻译成 `TO_CHAR(x,'YYYY-MM')`，掩码含未覆盖 `%码` 时不改写只告警；⑦ `postgresql` 等未接入方言从「静默按 MySQL 生成」改为显式 40001。告警规则表补 `TO_NUMBER/NUMTODSINTERVAL/IF/FIND_IN_SET`。

回归：新增**离线**套件 `deploy/tests/test-metric-dialect.js`（`datasource.repository` 用 require.cache 桩替换，不连库、不起服务，任何机器可跑）**47 条断言全绿**，覆盖双方言 DDL/时间窗/行数/类型映射/幂等探测/upsert/空串 fill/函数归一与告警/模型 DDL 预览/未接入方言拒绝；`test-metric-compile` 的 Oracle 断言同步改 ROWNUM 口径。前端 `TaskModal` 选到 Oracle 源时禁用 upsert 并显示方言提示条，`guides.ts` 三页指南卡补方言说明；`docs/API.md` 1.12 增「方言产物对照表」。⚠️ 依赖真实库的 HTTP 套件（compile/task/model/sql/chat）本轮**未跑**：联调管理员 `mtlint01` 口令已被改（40103），在共享元库上建/改账号需要先授权。



**V10 字段类型录入结构化（2026-10-09）**：用户拿建模弹窗截图报障——「界面建表」的字段类型是一个自由文本框，只能写 `varchar`（无长度，MySQL 建表直接语法错）、`NUMBER(24,6)`、`TIMESTAMP(6)` 这类手打串，既没法设长度/小数位，DDL 预览也永远按 MySQL 出（前端调 preview-ddl 时没传数据源，而且 preview-ddl 的 Joi 白名单里根本没有 `datasourceId`，传了会被 40001 拒——所以这个洞一直藏着）。落地：① 方言层加**类型族目录**（VARCHAR/CHAR/TEXT/INT/BIGINT/DECIMAL/DATE/DATETIME/TIMESTAMP + 各家原生写法别名映射），`composeColumnType` 把任意输入归一成 MySQL 风格规范串（`varchar`→`VARCHAR(64)`、`VARCHAR2(58)`→`VARCHAR(58)`、`NUMBER(10)`→`DECIMAL(10,0)` 按整数处理不擅自补小数、目录外兜底 `VARCHAR(64)` 不抛错），超上限（oracle 字符串 4000 / NUMBER 精度 38）给 40001；`oracleType` 改成「先归一再映射」，顺带修掉 `VARCHAR2` 里的 `2` 被当成长度的解析 bug。② 新 `GET /metric-models/column-types` 把目录（含 rendered 真实类型名与 maxLength）交给前端，界面不再硬编码类型清单。③ `assertColumns` 全链路按目标数据源方言归一 dataType（createModel/updateModel/replaceColumns/preview-ddl 四个入口都带方言），并且不再原地改入参对象。④ 前端 `ColumnsEditor` 类型列换成「类型族下拉 + 长度 + 小数位」三列（非字符串/定点数族自动禁用输入），`ModelModal` 把 datasourceId 传给 preview-ddl、按数据源类型切目录、预览旁标注所用方言。⑤ 附带的安全收益：dataType 从此是「白名单族 + 数字」拼出来的，自由文本进不了 DDL。回归：离线方言套件 47→**60 条全绿**（新增类型归一/目录/上限/DDL 无长度类型名断言），真库 base40/model39/compile60/task29/sql19 无回归；Vite 三个改动模块编译 200。浏览器实操验证未做（vben 登录态注入在本环境仍不可行，按惯例交人工）。



**编辑模型必失败的历史 bug（2026-10-09，同批修）**：用户实操「编辑模型 → 保存」报 `参数校验失败: "domainId" is not allowed, "datasourceId" is not allowed`。根因与方言无关——`ModelModal.handleSubmit` 创建/编辑共用一个 payload，始终带上 `domainId`/`datasourceId`，而 `PUT /metric-models/:id` 的 Joi 白名单不收这两个字段（域与数据源创建后不可迁移是既定语义），所以**从 V9 上线起编辑任何模型都会 40001**。修法：编辑分支不再下发这两个字段（界面里它们本就是禁用态）；同时补上「ddl 模型改字段后留档 `tableDdl` 不重算」的缺口（`updateModel` 与 `PUT /:id/columns` 都按目标方言归一并重建 DDL，否则详情弹窗里看到的还是建模型时的旧语句）。契约与断言同步：API.md 明确 PUT 只收 7 个字段，`test-metric-model` 新增 7 条（类型目录双方言、dataType 归一、PUT 越界字段 40001、改字段后 DDL 同步、preview-ddl 带 datasourceId 出 Oracle 方言、超宽列 40001），套件 39→**46 全绿**。**教训：创建/编辑共用提交体时，必须逐个字段核对更新接口的白名单，别只看创建能过。**



**目标表结构自动生成 + Oracle 字符串 CHAR 语义（2026-10-09）**：用户要「生成表时下拉选择字段，根据所选字段自动生成」。落地：① 新接口 `POST /metric-tasks/target-schema`（复用 preview 的入参与校验，不落库不执行），返回 `{dialect, table, autoCreate, writeMode, primaryKeys[], columns[{name,type,source:维度|指标|留痕,comment}], createSql, insertSql}`——类型口径全部来自 `buildPlan` + 方言层，前端不自己推；② 任务弹窗新增「目标表结构」区块（antd Table + Tag 方言/自动建表/主键 + CREATE 语句块），`watch(JSON.stringify(buildPayload()))` 防抖 500ms 自动刷新，必填不齐时清空不发请求、后端拒绝时以 Alert 就地提示（不弹 toast 刷屏）；分组维度下拉的 label 改成「勾选即目标表字段，也是聚合粒度」。③ 顺带修两个契约与界面不一致：`preview-ddl` 的 `oxor('name','tableName')` 是**互斥**，编辑态同时有名称和表名必然 40001 → 改 `or`（至少一个，给了 tableName 以它为准）；`createModel` 的 `tableName` 原本 required，但界面写着「可留空自动命名」→ 改为 reference 必填、ddl 可留空并按「域前缀_分层_名称」自动命名。④ **真 bug（用户跑任务时被 Oracle 拒绝才暴露）**：`钢捆信息统计` 建连与语法都过了，报 `ORA-12899: value too large for column "GMC"."TEST"."PRODUCE_LINE" (actual: 4, maximum: 2)`——MySQL 的 `VARCHAR(n)` 按字符计数、Oracle 的 `VARCHAR2(n)` 默认按**字节**计数，AL32UTF8 下中文一字符 3~4 字节，所以照抄宽度必炸。修法：方言层 Oracle 字符串一律出 `VARCHAR2(n CHAR)` / `CHAR(n CHAR)`（9i 起支持），并在 API.md 方言对照表里写清原因。回归：离线方言套件 60（含 `VARCHAR2(2 CHAR)` 断言）、`test-metric-model` 46、`test-metric-task` 29→**34**（新增结构列/类型来源/主键/CREATE 与 preview 一致/非法表名拦截）；另把 `dashboard tasks` 的 `successRate === 1` 放宽成 `> 0`——共享元库里任何任务失败都会让它不等于 1，原断言依赖环境（本轮就是被用户那条 Oracle 失败任务打到的，属于断言过死而非代码回归）。


**V11 一期 · 建模即建表的生命周期（后端，2026-10-09）**：需求是「建模页负责建表，任务不再建表；删除时能 drop，但只有平台自己建的表可以」。落地口径：① `status` 扩成三态 `draft|online|offline`，**`createType=ddl` 新建即 draft**（可反复改字段），`reference` 仍默认 online（源库已有表，无危险动作）；草稿/停用模型在**四处**入口被挡：`createTableModel`、指标保存校验（`metric.service` 汇总 `draftModels` 一次性列出「哪个模型要先启用」）、任务 `buildPlan` 源模型、以及 `PUT {status:'online'}` 自身要求至少一列。② 留痕三列 `tableStatus(none|created|exists|failed)/tableMsg/tableAt` 加进 `databridge_metric_model`，靠 `init.js` 的「可空列自动 ALTER」上线，无需人工迁移；`reference` 恒 `exists`。③ `POST /:id/create-table` 走方言层 `buildDdl` → `splitDdlStatements` → engine `/sql/exec` 真执行，**失败不抛错**而是落 `failed` + 原始报错（弹窗与状态不能两轨），Oracle 先 `user_tables` 探测实现幂等，`DB_DRIVER≠mysql` 直接 40001（内存模式不发起真实执行）。④ `DELETE /:id?dropTable=true`：默认只软删；`reference` 传 true → 40001，ddl 但 `tableStatus≠created` → 40001（平台从没建过它，凭什么删）；DROP 失败**不阻断软删**但把 `dropMsg` 回给前端，避免出现"表还在、模型没了"的孤儿表。⑤ engine 白名单加 `DROP TABLE`，但**必须请求体显式 `allowDrop=true`**，且正则锁死「单表、无分号、无 CASCADE/PURGE、不带多表列表」。

**血泪教训（本轮真实事故）**：给 engine 加 DROP 后，`test-metric-sql.js` 里原本"被白名单拒绝"的负向用例 `DROP TABLE databridge_datasource` **真的执行了**，把共享元库的数据源表连数据一起删掉（结构靠 `init.js` 自动重建，数据靠 `.env` 口令逐条回填）。根因不是白名单，是**回归脚本拿真平台表当"越权样本"**。从此规矩：负向守卫用例只能用不存在的表名（`__guard_missing__`、`DROP USER`、多表、PURGE、缺 allowDrop），正向 DROP 只允许操作本套件自己建的临时表（`${EXEC_TABLE}_drop`），且删除类语句在 Node 侧、engine 侧各设一道闸门（`allowDrop` 就是 engine 侧那道，防的是"上游代码回归 + 脚本用例"叠加）。


**V11 一期 · 建模页状态机前端（2026-10-09）**：把后端那套状态机原样搬到界面，按钮的可用性就是后端的闸门（但闸门永远在后端，前端只是不给误点的机会）。① `data.ts` 加 `MODEL_STATUS_*`/`TABLE_STATUS_*` 标签与色板，模型页「状态」列从二元（启用/停用）改成三态，新增「表状态」列（未建表/已建表/引用表/建表失败），失败时 Tooltip 直接展示后端存的 `tableMsg` 原始报错——排障不用去翻日志。② 操作列加「启用/停用」（`PUT {status}`，停用有 Popconfirm 说明影响面）和「生成表」：`createType≠ddl` 或 `status≠online` 时按钮禁用，Tooltip 说明原因（引用表「平台不建也不删」、草稿「请先启用」、已建表「再次点击幂等同步」）。③ 新弹窗 `CreateTableModel.vue`：打开即拉详情 + `preview-ddl` 展示**将要执行的方言 DDL**（与执行入口同一个 `buildDdl`，所见即所跑），执行失败时不关窗、把 `tableMsg` 就地贴出来供重试。④ 新弹窗 `ModelDeleteModal.vue` 取代原来的 Popconfirm：**只有 `ddl + created` 才出现「同时删除物理表」勾选**，勾上还要逐字输入表名才解锁确认（引用表看到的是「平台永不 DROP」的说明条，不是隐藏按钮——让用户知道为什么没有）。删除返回 `dropped:false + dropMsg`（模型已软删、表没删掉）时**不关窗**，就地说明「去目标库手工清理」，避免孤儿表无人知晓。⑤ `ModelModal`：新建态不再下发 `status`（ddl 由后端落 draft，界面用禁用态文案「新建为草稿（启用后可生成表）」说明），编辑态状态改成三态下拉；ddl 分支顶部加三步走说明卡，字段区 Divider 文案从「物理表由任务首次执行时创建」改成「启用后点生成表才真建」——旧文案是二期的世界观，会误导用户。⑥ `GET /metric-models` 的 `status` 筛选界面接上（后端早就支持）。回归：`test-metric-model` 46→**61 全绿**（新增草稿默认值、草稿不可建表/不可被指标引用、启用、真建表→预览读得到 3 列→幂等、引用表与未建表 dropTable 40001、被拒后模型未被误删、软删默认不动表、建表后带 dropTable 删除并验证表真的没了）；全套 base40/compile60/dialect60/sql24/task34 无回归，engine `go test ./api/v1` 通过。验证口径：`vue-tsc` 在本仓对 `<script setup>` 模板绑定全线报 "Cannot find name"（改动前后一致，属工具噪声，不作依据），改用 Vite dev 编译产物核对——新代码的模板标识符全部解析成 setup 常量、无 `_ctx.` 兜底即说明绑定正确；浏览器实操仍交人工。


**V11 二期 · 指标广场 + 维度取值/码值（2026-10-09，契约 1.14）**：三件事一次做完——管理入口改成按域浏览的广场、从表批量生成原子指标、把「用户说华东、库里存 E1」这类取值问题接进问数链路。

1. **广场聚合 `GET /metrics/plaza`**（新 `metricplaza.service.js`，只读、不动 `/metrics` 分页契约）：按**根域分节**，传 `domainId` 时把该域**连同全部子孙域**聚成一节；卡片带 `referencedBy`（dep 表 `child_id` 计数）与 `hot7d`（复用 dashboard 的近 7d query_log `metric_ids` 口径，零额外打库）。缺省只回 `online`（广场=上架目录），要看草稿得显式传 `status=draft|offline|all`。不分页（卡片流按节展示，分页会打断分组），`limit` 上限 500、超出回 `truncated:true`。**坑：根域的 `parentId` 库里存的是字符串 `'0'` 不是空串**——`if (!node.parentId)` 判根会让所有指标掉出分组（首轮 plaza 全空的真因），统一走 `parentOf()` 把 `''/0/'0'` 都当根。
2. **批量生成 `POST /metrics/batch`**：界面按「列→指标」扁平形态提交，服务端 `toMetricPayload` 折算成 `defineType=MEASURE + defineParams`，然后**逐条调用单条 `createMetric`**——语法探针/聚合规则/循环/跨源/草稿模型闸门一个都不复制第二份。顺序执行（同批内后一条可引用前一条、重复 code 会被第二条拦下），无事务、部分成功回 HTTP 200 + `results[{index,ok,message}]`；前端的「重新提交失败项」按 `results.index` 回查**上一次提交的条目**（不能拿界面当前行去猜 index，会错位）。就地登记模型走已有 `POST /metric-models`（reference），不做复合接口。
3. **取值档案 `databridge_metric_dimvalue`（第 13 张指标表，id 前缀 `mdv-`/19000）**：一张表两种来源（`source=auto|manual`），`value` 是库里真实值、`label` 是人工登记的业务名。探查 `POST /metric-models/:id/profile-dimensions` 每列两步：先 `COUNT(DISTINCT)` 基数预检（超 `distinctGuard` 默认 200 就**只标记不取值**，防大表 GROUP BY 压库、防用户ID灌进 prompt），再 `GROUP BY + COUNT + topN`；SQL 全走方言层新方法 `dimCountSql`/`dimProfileSql`（MySQL `LIMIT`，Oracle 内层聚合排序 + 外层 `ROWNUM` 嵌套，标识符/表名过白名单且 Oracle 大写）。回写用 `ON DUPLICATE KEY UPDATE` 且**分支里刻意不出现 label**——人工登记的优先级高于探查；库里消失的旧值置 `stale` 不删（历史数据仍要能被解释），`manual` 行不参与 stale 判定。`DB_DRIVER≠mysql` 一律 40001（与 create-table 同口径）。
4. **进 prompt 与值校正（这是本期最容易做错的地方）**：
   - 系统配置加 `chat.dimValuePrompt`（默认 `0`）与 `chat.dimValueTopN`（默认 20），共 10 项。默认关的理由：候选值就是真实业务数据，进 prompt 等于数据出境；关掉时索引连档案都不读。
   - **只喂 prompt 不够**：用户说「华东」不会提到列名 `region_code`，按标签包含匹配的召回根本不会把这一列放进 schema，取值永远进不了 prompt。做法是给带 `label` 的取值加 `kind:'value'` 词条，召回命中值名后**回挂所属列**。
   - **value 词条绝不能参与 `toTokens`**：否则 `WHERE region_code = '华东'` 里的 `'华东'` 会被当成列名替换成列 token，过滤条件当场报废（toTokens 的 else-if 链不认 `value`，正好安全；改这里时别顺手加分支）。
   - 值校正在 `parseM2Sql(tokenSql, refs, dimValues)` 第 3 参上做，**缺省 undefined 即行为完全不变**；只改字符串字面量、只改 `=`/`!=`/`IN`（数值比较与时间列不碰），匹配顺序＝真实值精确 → 真实值忽略大小写 → label 忽略大小写；未命中原样保留并记进 `unmapped`，答案卡与 query_log 都能看到「这个值没登记」。
   - **同名值散在多个模型会带错列**：demo 库与业务库都有 `华东`，prompt 里两条维度并列，LLM 就选了 demo 的 `region` 列（表现为 SQL 里根本没有该过滤）。收敛做法：命中指标时把维度清单限制在**主指标所属模型**内（主指标取最长命中，避免「码值订单额」被「订单额」的子串召回顶掉），编译期本来就只允许单模型，收敛不丢能力只去噪。systemPrompt 加第 5 条规则：维度行带「取值:」时，用户话里的值名（含业务名）必须翻译成等号左边的原始值，**不许因为不认识值名就丢掉过滤条件**。
5. **前端**：`views/metric/metric/index.vue` 从表格页改成广场（Radio 切「广场/表格」两视图、按域分节的卡片流、点卡片才拉详情开弹窗——卡片是精简视图，编辑/公式树必须完整 `defineParams`）；新 `BatchMetricModal.vue`（三步向导：选 online 模型或就地登记表 → 勾选度量列逐条改名/聚合/过滤 → 逐条成败回显并可只重投失败项）；新 `DimensionValuesModal.vue`（字段弹窗每个维度列一个「取值」入口：探查/登记业务名/清空/看 stale）；系统配置页加开关与条数并写明出境风险；`guides.ts` 四页文案同步（广场、从表生成、取值登记、prompt 开关）。菜单 `指标管理 → 指标广场`。
6. **回归（`test-metric-dimvalue.js` 新套件 37 条）**：真建 `${RUN}_code` 码值表 + 引用模型，断言「只探维度列/度量与时间列不探」「高基数只标记」「重探查不冲掉人工 label」「manual 值不被标 stale」「开关关闭时 prompt 不含取值、打开后含 `E1=华东`」「只提值名也能召回所属列」「华东→E1 的校正与 corrections」「IN 逐元素」「档案无此值时原样保留并进 unmapped」「空档案兜底不改写」「广场分组/别名搜索/状态默认与 all/limit 越界 400」「批量 2 成 2 败且逐条原因含『占用』『草稿』」「真 LLM 问数落地 SQL 出现 E1」。方言离线套件 60→**67**（新增双方言探查 SQL 形状 + 标识符注入被拒），model 61→**62**（配置项 10 个 + 开关默认 0）。
7. **⚠️ 本轮踩到的新坑（已修，务必别再犯）**：`test-metric-model` 的 cleanup 一直 `DELETE FROM databridge_metric_setting WHERE setting_key='llm.model'`，而这张表**与生产 admin 共用**——跑一次回归就把用户配好的网关模型抹掉，回落成 env 的 `deepseek-chat`，被网关白名单 400 拒，表现为「问数突然全量不可用」。现在 cleanup 改为**先 SELECT 快照、清完用 REPLACE INTO 还原**。同类风险还有 `llm.embed.baseUrl/apiKey`（快照已一并覆盖）。
8. **few-shot 选取口径修正**：`ask` 里原来 `find({filters:{enabled:true}}).slice(0,5)` 走 store 默认 `createdAt:asc`——管理员刚「转示例」的样本永远排在几百条历史之后，等于白转。改成 `sort:'createdAt:desc'`（最近沉淀的 5 条优先）。演示资产里也固化了一条码值问法（`昨天的已支付订单额是多少 → ... AND \`status\` = 'PAID'`），小模型照着仿写比靠规则条文稳。
9. **问数命中率的真实边界（别误判成回归）**：内网网关白名单目前只有 `DeepSeek-V4-Flash / Qwen3-8B / DeepSeek-OCR` 可用，`test-metric-chat` 的 10 问命中在 **6~8/10 之间波动**（Qwen3-8B 实测 4/10，更差），套件通过线是 ≥7，所以会偶发 1 条不过——这是所选对话模型的能力上限与网关稳定性，不是平台链路坏了（值校正/召回/编译这些环节全部有确定性断言兜着）。要真正提命中率得让网关加白更强的对话模型，或用「转示例」把高频问法沉成 few-shot。
10. **仍待实测**：Oracle 源库上的取值探查只有离线 SQL 形状断言（等 ds-1001/1012/1077 补回来再跑真库）；`chat.dimValueTopN` 对超大枚举列的 prompt 体积影响需要现场观察。

**V11 三期 · 指标宽表物表 + 目标建模表 + Oracle MERGE（2026-10-10，契约 1.15）**：原计划的「行列转换」挪给数据开发 dataflow 的 `pivot` 节点（那边本来就有节点图与算子位），本模块改成做**真正缺的能力**：把多个模型的指标按时间粒度对齐，自动汇总进一张建模表。

1. **两种对齐模式（`align`）**：`model`（缺省，二期行为逐字节保持，存量任务不迁移）与 `time`（时间宽表，允许跨**同数据源**的多模型，但 `dimensionColumnIds` 必须为空）。当初讨论过「按同维度对齐」（多表按地区/门店 JOIN），**刻意不做**：跨表的同维度需要先有"维度一致性映射"，猜错列名会得到一张看起来对、算起来错的表，属于静默错算，比报错更糟。宽表只认一个对齐键＝截断后的时间 `stat_period`（rename 规则只对时间列生效，`fill` 与非时间列 rename 在 `time` 模式下直接 40001）。
2. **时间全集 LEFT JOIN，而不是以某张表为基准**：`FROM (SELECT stat_period FROM (子查询1) u1 UNION SELECT stat_period FROM (子查询2) u2) u LEFT JOIN (子查询1) …`。基准表当期没数时整行会丢，这是"少了一天数据"这类疑难对账的源头。两个细节是真跑出来的：**各子查询指标个数不同，UNION 两侧列数必须一致**，所以 UNION 里只 SELECT 对齐键一列；**外层必须写 `u.stat_period`**，裸写 `stat_period` 在 MySQL 报 1052 ambiguous（基表和每个 JOIN 子查询都有这一列）。MySQL 5.7 无 `FULL OUTER JOIN`，两库统一这个形状。
3. **粒度只能向粗对齐**：`GRAINS=['day','week','month','quarter','year']` + `grainRank`/`coarsestGrain` 收在方言层（红线 9）。指标在自己的 `defineParams.timeGrain` 声明源粒度（缺省 `day`，老指标不动），任务的 `timeGrain` 必须 ≥ 全部指标里最粗的那一档，否则保存期 40001 并把越界指标点名（形如 `mw_x_amt(month)`）。理由要能在报文里讲清：日→月是再聚合（正确），月→日是无中生有（同一个值摊到当月每一天）。截断只在方言层：`dl.dateTrunc(expr, grain)`（MySQL `DATE_FORMAT/YEARWEEK(x,3)/CONCAT(YEAR,'-Q',QUARTER)`，Oracle `TO_CHAR` 五种格式模型，周用 Iso 周 `'IYYY-IW'`）。时间窗过滤仍走各模型自己的时间列，截断只发生在分组键上。**`GROUP BY` 一律重复表达式**，绝不写 `GROUP BY 1`（Oracle 不支持按序号分组，MySQL 支持——这正是"本地好使、Oracle 报错"的经典形状）。
4. **目标表权威彻底交给建模页**：新任务必须选 `targetModelId`（草稿/`tableStatus=failed` 都 40001），表名与数据源都从模型取；`targetTable` 在 Joi 层由必填改为可空，两者都不给才报错（存量自动建表任务不受影响）。保存期 `validateTargetModelShape` 做结构比对：按「大小写不敏感的列名」找缺失，按类型族（str/num/date）找不兼容，**只报错、绝不自动 ALTER/自动建表**（一放开，表结构权威就又漏回任务侧）。结构化清单只能走 `target-schema` 回显——`ApiError` 信封只有一个 message，塞不进数组；所以报文里写人类可读的列名清单，界面红字与「去建模页补列」用结构化字段（`/metric/models?columnsFor=<id>` 直接开字段弹窗，用户不用自己找那张模型）。
5. **留痕列「有则写、无则跳」**（`resolveEtlColumn`）：目标模型没有 `_etl_time`/`ETL_TIME` 时，INSERT 列表和 `ON DUPLICATE KEY UPDATE` / `MERGE … UPDATE SET` 尾巴里都不出现它。方言层的 `upsertTail`/`upsertStatement` 因此多了 `etlColumn` 形参（传空串=不写）。`metricChat` 的问数落库 SQL 不受影响（它只走 `buildPlan` 的 model 分支）。
6. **空值语义 + 建模页度量列可空**：宽表指标列 `DEFAULT 0 NOT NULL` → `NULL`（0 会被下游读成"真的是零"）。这条要成立必须连带改 `metricmodel.buildDdl`：**度量列（`role='measure'` 且非主键）建表时出 `NULL`**，其余仍 `NOT NULL`——否则「界面建表」出来的 ADS 表全列非空，物化在第一个空期次就整条失败（MySQL 1048 / ORA-01400）。已建好的表不回改（改 nullability 得去库里改）。
7. **Oracle 幂等 upsert = `MERGE INTO`**（`supports.upsertOnDuplicate` 改成通用的 `supports.upsert`，闸门由 `dl.upsertStatement` 承担）：`MERGE INTO 目标 s USING (本次 SELECT) d ON (全部主键) WHEN MATCHED THEN UPDATE SET … WHEN NOT MATCHED THEN INSERT …`，UPDATE 分支不含主键（Oracle 禁止更新 ON 列）。**踩到的真坑：`SYSDATE` 必须写成 `SYSDATE AS ETL_TIME`**——MERGE 的 INSERT 分支按 `d.ETL_TIME` 引用源列，无别名表达式在派生表里没有列名，直接 ORA-00904（MySQL 的 `INSERT … SELECT` 不需要别名，所以这个 bug 只在 Oracle 侧暴露）。
8. **engine 白名单两个新动词**（`databridge-engine/api/v1/sql.go`）：`MERGE INTO`（正文含 ` DELETE ` 一律拒，只放行 UPDATE+INSERT 两分支）与 `COMMENT ON`。后者是**顺手揪出的一期真 bug**：Oracle 没有内联 COMMENT，「生成表」把表/列注释拆成 `COMMENT ON` 随 CREATE 一批下发，而白名单不认 → `/sql/exec` 在 `Validate()` 阶段整批 400（一条不过、全部不执行），所以 **v1.13 的「界面建表」在真 Oracle 上一次都没成功过**，此前只验过 DDL 文本没验过执行。`go test ./api/v1` 补了 MERGE/COMMENT 的允许与拒绝用例。
9. **前端**：`TaskModal.vue` 加「对齐模式」Radio（切 time 自动清空分组维度、把清洗规则收成 filter+rename(时间列)）、「目标粒度」下拉、目标表改成「选建模表 / 自动建表(存量)」二选一、缺列与类型不兼容时红字 Alert +「去建模页补列」直达、多模型时展示每个分组（模型/表/时间列/指标）；Oracle 的 upsert 不再置灰，文案改成「MERGE INTO」；广场卡片加「＋宽表」多选 + 顶部「勾的指标建宽表（N）」→ 跳任务页自动开弹窗并预填指标（`?metrics=&align=time`，进页面即 `router.replace` 清掉 query，避免刷新重复弹窗）；任务列表加「对齐」列；`guides.ts` 任务/建模/广场三页文案同步。
10. **回归（`test-metric-wide.js` 新套件 75 条）**：MySQL 侧覆盖八类闸门（带维度/缺粒度/非法档位/向细/向粗允许/fill/rename/跨数据源）、草稿目标模型、缺列 `missingColumns` 与类型族 `mismatchColumns` 的保存期 40001、`align/timeGrain/targetTable` 落库回读、语句形状（`DATE_FORMAT(...,'%Y-%m')` 截断 + `GROUP BY` 重复表达式 + 无 `GROUP BY 1`、UNION 时间全集 + 两路 LEFT JOIN、时间窗按各自时间列下推、目标建模表存在则不出 CREATE）、**真执行**（2026-09=300/2/8、2026-10 有销售无访问 → `uv` 落 NULL 而非 0、留痕列写入、upsert 幂等行数不涨且现值更新）、留痕列无则跳、week/quarter 截断、`align=model` 行为不回退。Oracle 侧真库跑通两段：**模型模式 MERGE**（源=只读主数据表，目标=平台自建表，两次 run 的 writeRows 相同 ⇒ ON 命中走 UPDATE 分支且没产生重复行）与**时间宽表 MERGE**（平台自建带 DATE 列的源表，断言 `TO_CHAR(t.stat_date, 'YYYY-MM')`/`TO_DATE` 时间窗/时间全集 LEFT JOIN 并真执行成功）；顺带把「Oracle 生成表」第一次在真库验通（`CREATE + COMMENT ON` 一批下发）。引用型模型删除断言 `dropped:false`（业务表永不被平台 DROP）。全套 base40/compile60/dialect71/model62/task34/sql24/dataflow21/wide75 全绿，dimvalue 36/1（唯一失败是 LLM 网关上游 DNS 解析失败，属外部依赖），engine `go test ./api/v1` 通过。**踩到两次"套件自己骗自己"**：① `USER_TABLES` 登记成引用模型拿不到列——平台列结构走 `ALL_TABLES`，而它不含视图；② 没导出 `TEST_DS_PASS` 时 `!text.includes('')` 恒 false，把「口令不回显」这条断言变成假失败（跑回归务必按头注把 `TEST_DS_*` 都带上）。
11. **界面验证口径**：`vue-tsc` 对本仓 `<script setup>` 模板绑定全线报 "Cannot find name"（40 条，改动前后一致，全是既有噪声，且无一条落在 metric 文件上），所以判定用「Vite dev 逐个拉取产出的 SFC 编译产物」＋ eslint；真机走查（切 align 后维度列消失、缺列红字与直达按钮、广场勾选跳任务自动开弹窗）仍需人工在浏览器里过一遍。


**V11 四期 · 建模分层树 + 分类（2026-10-10，契约 1.16）**：需求是「建模页加一棵分层树快速定位建模；每个分层是根节点，根节点下可以加带描述的分类，把同一类型的建模归到分类里汇总」。

1. **分层根节点刻意不落库**（`LAYERS` 常量虚拟化生成 5 个根，不可增删改名）。这不是偷懒，是护栏：`layer` 是承重字段——参与物理表命名 `域前缀_分层_名称`（`composeTableName`）、DDL 表注释、首页看板按层分组、批量建指标的默认层。一旦"层"变成用户可编辑的树节点，改名会让命名规则与既有资产漂移，`test-metric-model` 里「中文名生成哈希表名（前缀_分层_哈希）」那条断言也会被直接打脸。所以树的可编辑部分只有分类。
2. **分类是「全局按层」实体，与指标域正交**：一个分类属于且只属于一个 `layer`，不隶属 `domain`。当初可选的另外两条路——域内按层（形成 域→层→分类 三层嵌套，模型行要同时保证 `domain_id`+`category_id` 一致）与自由文本标签（没有描述、没有重名保护、没有管理入口）——都更贵或更弱。正交两轴的代价是界面上要讲清"树不按域走"，收益是没有一致性债，也不与 v1.14 指标广场「按根域分节」抢导航职责。
3. **模型单归属**（`databridge_metric_model.category_id`，空串＝该层未分类）。多归属要引入中间表，节点计数会重影、删改联动复杂，而"汇总定位"这个诉求单值就够。
4. **落库形态与旧库补列的形态差要写进契约**：新表 `databridge_metric_model_category`（id 前缀 `mcat-`，`seq` 自增主键 + `uk_metriccategory_id` + `idx_metriccategory_layer`，列 `name/layer/description/sort/del_flag/create_by/created_at/updated_at/extra`，utf8mb4 显式），模型侧加 `category_id VARCHAR(64) NOT NULL DEFAULT ''` + `idx_metricmodel_category`（真源是 `node-express-boilerplate/src/db/schema.sql`，本文件 §5 是最初草图，不回填）。`init.js` 的自动补列一律拼 `NULL`、字符串列兜底 `VARCHAR(255)`，所以线上补出来的 `category_id` 是 `VARCHAR(255) NULL`，与 schema 的 `VARCHAR(64) NOT NULL DEFAULT ''` 不同形（和 `table_status` 是同一个坑）。语义靠**读时归一**兜住（`normalizeTableStatus` 顺手把 `categoryId` 的 `null`/缺失并成 `''`，`queryModels` 与 `getModel` 两条路径都走它），生产要收敛列型得人工 `ALTER`（API.md 里给了可重复执行的语句）。
5. **树接口口径**（`GET /metric-model-categories/tree`）：5 个分层根**恒定出现**（空层也回 `children:[]`、`modelCount:0`，前端不必兜底空层）；`uncategorized` 让「未分类」成为每层下一个真实可点节点（`?layer=X&categoryId=none`）；`total` 是**分类节点数**而不是模型数；计数口径＝全量未删除模型，**不随右侧筛选变化**（否则"点了节点计数还在跳"，用户会以为树在骗人）。不开平铺 `GET /metric-model-categories`——列表数据只从 `children` 取，少一个真源。
6. **`none` 这种"值不是 id"的筛选用函数谓词**：`queryModels` 把 `categoryId==='none'` 翻成 `(value) => !value`，`memoryStore.matchOne` 原生支持函数谓词，`sqlStore.buildWhere` 遇到函数值自动整表回退到内存过滤器——两驱动同语义，且不用改公共内核，也不用在 SQL 里拼 `OR IS NULL`。管理后台百级数据量下开销可忽略。
7. **两个"不静默"的闸门**：① 删分类＝软删 + 名下模型批量置空（`movedModels` 回给界面写确认文案），不走 40902 式禁删——40902 是「指标域是资产容器」的专属语义，分类只是定位用的归组节点；② 分类的 `layer` 创建后**只要请求体带这个键就 40001**（即使值相同也不放行），口径由代码路径保证而非值比较，报错文案给可执行动作「新建分类再批量归类」。模型侧同理：编辑时改了 `layer` 又没带新 `categoryId` → 40001，宁可让调用方显式二选一，也不静默把跨层成员留在原分类里。
8. **批量归类逐条点名**（`POST /metric-model-categories/assign`，`modelIds` ≤500）：跨层的那几条不整批失败，落进 `results[{id,ok,message}]` + `assigned/failed`，HTTP 恒 200，形状沿用 v1.14 `POST /metrics/batch`。理由是真实操作："勾 20 个模型归到一个分类"里混进 2 个别的层的模型，全批回滚会让人重来一遍并怀疑功能；明确点名反而一次就能改对。单个创建/编辑仍走 40001 硬拒——那没有"部分成功"可言。
9. **红线（新增）**：分类的一切操作（增删改、归类、降级）**只写元数据列，不产一句 DDL、不碰物理表**，也不进 40902/40903 那类资产闸门；否则"归个类"就会变成库侧动作，与红线 12（任务不得改目标表结构）同源失守。

## 12. 红线汇总（AI 实施时必须遵守）
1. `docs/API.md` 是唯一契约真源：先写契约再实现，三端同步改。
2. `DB_DRIVER=mysql` 严禁 mock/假数据；memory 演示分支单独隔离。
3. 引擎无状态，Node 下发含凭据快照；凭据不进日志、不进回报、不落明文运行记录。
4. 所有拼进 SQL 的标识符过白名单正则；用户输入值走绑定参数；engine `/sql/exec` 语句类型白名单硬校验。
5. 表达式仅 `online` 指标可被新公式引用；循环依赖在保存期拦截，编译期 visited 双保险。
6. 每次改动跑 `deploy/tests` 回归并更新文档（用户长期要求）；回归脚本收进仓库，不放临时目录。
7. 复合指标跨数据源计算一期禁止（编译期校验 refs 的 datasource 一致性）。
8. engine `/sql/*` 及回报通道必须启用 `ENGINE_SHARED_SECRET`（生产/本地生产测试态禁止空配置上线；见 §8.2 鉴权）。
9. **SQL 文本的方言差异只能来自 `src/utils/dialect.js`**：任何生成 SQL 的代码（编译/物化/建表预览/数据预览/问数落地）禁止再写 `ds.type === 'oracle'` 之类的本地分支，需要新差异就往方言层加字段/方法，并同步 `deploy/tests/test-metric-dialect.js`（离线，不连库）与 `docs/API.md` 的方言对照表。
10. **回归脚本绝不拿平台真实表当样本**：`deploy/tests` 连的是共享元库，守卫/负向用例里出现 `DROP`/`TRUNCATE` 只能指向本套件自建、带 `RUN` 前缀的临时表；平台表（`databridge_*`）与用户登记的源表禁止出现在任何删除类语句里，即便预期"会被拒绝"（白名单一旦放宽，预期就变成事故——V11 已因此丢过 `databridge_datasource`）。删除类能力必须 Node + engine 双闸门（engine `allowDrop=true` 显式开关）。
11. **回归脚本不许留下被改过的共享配置**：`databridge_metric_setting`（llm.model / llm.embed.* / chat.*）与生产 admin 是同一张表，用例期间改写它就必须**先快照、cleanup 末尾还原**（`test-metric-model` 已按此实现）。历史教训：cleanup 里那句 `DELETE ... WHERE setting_key='llm.model'` 把用户配好的网关模型抹掉，回落 env 默认 `deepseek-chat` 被白名单 400 拒，等于跑个测试把线上问数打挂。同理，`databridge_user` 里非本套件创建的账号一律不得删改。
12. **汇总任务不得改动目标表结构**：表名、列、类型、nullability 的权威只在「数据建模」。任务侧只做两件事——比对（`validateTargetModelShape` 报 `missingColumns`/`mismatchColumns`）与跳过（目标表没有留痕列就不写它），**永远不生成 `ALTER TABLE`、不为新任务自动建表**。理由：一旦任务能补列，"改了模型为什么表没变/表里为什么多了列"就再也查不动了。
13. **对齐与空值不能"猜着算"**：跨模型只按时间对齐（`align=time`），非时间维度必须同模型（`align=model`）；目标粒度只能 ≥ 参与指标里最粗的那一档（向细＝把粗期次值摊到每个细期次，静默错算）；宽表的指标列当期没数落 `NULL` 而非 `0`（`0` 会被下游读成"真的是零"）。这三条都属于"错了也能跑通、只有对账时才发现"的类别，必须在保存期用 40001 挡住，不留 warn 口子。
14. **分层树的「层」不可被用户编辑，分类操作零 DDL**：5 个分层根由 `LAYERS` 常量虚拟化生成（不落库、不改名、不增删），因为 `layer` 参与物理表命名/DDL 注释/看板分组；分类只是定位用的归组节点，它的增删改与批量归类**只写 `category_id` 这类元数据列，绝不生成 DDL、绝不碰物理表**，也不套用 40902/40903 资产闸门（删分类走"名下模型自动降级未分类"并回 `movedModels`）。
