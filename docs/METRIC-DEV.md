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
| 数据建模 | /metric/model | 列表+两个向导（引用表 / 界面建表含 DDL 预览）；字段角色编辑表 |
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
| M5 ChatBI | 词库召回、Prompt、M2SQL 解析/纠错、ask 链路、日志/审核/示例 | 内置 10 问测评集（`deploy/tests/metric-eval.json`）≥7 题正确 |
| M6a 前端·核心 | 首页概览、指标域、数据建模、指标管理、智能问数（**问数审计以对话页「历史」tab 呈现，不做独立页**） | 浏览器实操走通 6 大需求主路径（本条由人工验证，不可用单测代替声明） |
| M6b 前端·扩展 | 指标任务管理、系统配置、独立问数审计页（若 M6a 的 tab 已够用可只做前两项） | 任务/配置/审计操作闭环 |
| M7 收尾 | RELEASE.md 补发版说明（admin+engine 双重建，`ONLY=admin,engine,web`）、回归全量 | 全绿 |

## 12. 红线汇总（AI 实施时必须遵守）

1. `docs/API.md` 是唯一契约真源：先写契约再实现，三端同步改。
2. `DB_DRIVER=mysql` 严禁 mock/假数据；memory 演示分支单独隔离。
3. 引擎无状态，Node 下发含凭据快照；凭据不进日志、不进回报、不落明文运行记录。
4. 所有拼进 SQL 的标识符过白名单正则；用户输入值走绑定参数；engine `/sql/exec` 语句类型白名单硬校验。
5. 表达式仅 `online` 指标可被新公式引用；循环依赖在保存期拦截，编译期 visited 双保险。
6. 每次改动跑 `deploy/tests` 回归并更新文档（用户长期要求）；回归脚本收进仓库，不放临时目录。
7. 复合指标跨数据源计算一期禁止（编译期校验 refs 的 datasource 一致性）。
8. engine `/sql/*` 及回报通道必须启用 `ENGINE_SHARED_SECRET`（生产/本地生产测试态禁止空配置上线；见 §8.2 鉴权）。
