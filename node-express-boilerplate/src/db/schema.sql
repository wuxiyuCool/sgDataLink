-- =============================================================================
-- DataBridge 管理后端（node-express-boilerplate）MySQL 表结构
--
-- 目标库：MySQL 5.7.24，库默认字符集 utf8 —— 因此每张表都必须逐表显式声明
--         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci（否则中文按 utf8 存，
--         且排序规则与仓储层的大小写不敏感比对不一致）。
-- 会话 sql_mode 含 STRICT_TRANS_TABLES + IGNORE_SPACE：
--   1) 类型不匹配（空串写 INT、ISO 'Z' 串写 DATETIME）会直接报错，不做静默转换，
--      所以仓储层写入前统一做类型归一（见 src/repositories/mysql/sqlStore.js）；
--   2) 函数名与左括号之间不能有空格；
--   3) 时间列用 DATETIME(3)（不用 TIMESTAMP，避免会话时区转换），
--      禁止零日期：所有时间列一律 NULL 允许、NOT NULL 无默认值。
--
-- 命名约定：
--   - 表统一 databridge_ 前缀，列 snake_case，与 API 契约的 camelCase 由仓储层映射；
--   - 每张业务表都有 `seq` BIGINT AUTO_INCREMENT + UNIQUE，用于还原内存仓储
--     「按插入顺序遍历（Map 迭代序）」的语义，默认 ORDER BY seq ASC；
--   - 复杂嵌套（fieldMappings / nodes / edges / channels / conditions /
--     ipWhitelist / queryParams / fields / syncObjects）用 JSON 列；
--   - `extra` 承载契约里未建列的扩展键，读出时并入对象，
--     保证与内存实现「记录里有什么就返回什么」的语义一致。
--
-- 本文件由 src/db/init.js 逐条 CREATE TABLE IF NOT EXISTS 执行，重复启动安全。
-- =============================================================================

-- 数据源（契约 1.1）----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `databridge_datasource` (
  `id`         VARCHAR(64)  NOT NULL COMMENT '字符串主键，沿用内存仓储的 ds-1001 式自增 ID',
  `name`       VARCHAR(128) NOT NULL,
  `type`       VARCHAR(32)  NULL COMMENT 'oracle | mysql | postgresql',
  `host`       VARCHAR(128) NULL,
  `port`       INT          NULL,
  `database`   VARCHAR(128) NULL,
  `username`   VARCHAR(64)  NULL,
  `password`   VARCHAR(255) NULL COMMENT '明文保存（响应侧由 service 脱敏为 ***）',
  `remark`     VARCHAR(512) NULL,
  `status`     VARCHAR(16)  NULL COMMENT 'enabled | disabled',
  `created_at` DATETIME(3)  NULL,
  `updated_at` DATETIME(3)  NULL,
  `extra` JSON         NULL COMMENT '未建列的扩展键，读出时并回对象',
  `seq`        BIGINT       NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_datasource_seq` (`seq`),
  KEY `idx_datasource_status` (`status`),
  KEY `idx_datasource_type` (`type`),
  KEY `idx_datasource_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 同步任务（契约 1.2）--------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `databridge_sync_task` (
  `id`                 VARCHAR(64)  NOT NULL,
  `name`               VARCHAR(128) NOT NULL,
  `sync_mode`          VARCHAR(16)  NULL COMMENT 'full | incremental',
  `source_id`          VARCHAR(64)  NULL,
  `source_table`       VARCHAR(128) NULL,
  `target_id`          VARCHAR(64)  NULL,
  `target_table`       VARCHAR(128) NULL,
  `write_mode`         VARCHAR(16)  NULL COMMENT 'insert | upsert | overwrite',
  `batch_size`         INT          NULL,
  `incremental_column` VARCHAR(128) NULL,
  `field_mappings`     JSON         NULL COMMENT '字段映射数组（含 transform 占位）',
  `schedule_cron`      VARCHAR(64)  NULL COMMENT '6 位 Quartz 子集，NULL 表示仅手动触发',
  `retry_count`        INT          NULL,
  `retry_interval_sec` INT          NULL,
  `total_rows`         BIGINT       NULL COMMENT 'mock 引擎按此推进进度',
  `failure_rate`       DOUBLE       NULL,
  `enabled`            TINYINT(1)   NULL,
  `last_status`        VARCHAR(16)  NULL COMMENT 'idle | running | success | failed | stopped',
  `last_run_at`        DATETIME(3)  NULL,
  `remark`             VARCHAR(512) NULL,
  `created_at`         DATETIME(3)  NULL,
  `updated_at`         DATETIME(3)  NULL,
  `extra`         JSON         NULL,
  `seq`                BIGINT       NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_task_seq` (`seq`),
  KEY `idx_task_last_status` (`last_status`),
  KEY `idx_task_source_id` (`source_id`),
  KEY `idx_task_target_id` (`target_id`),
  KEY `idx_task_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 任务运行实例（契约 1.3 / 1.4，同时承载 dataflow 与 cdc 管道实例）--------------------
CREATE TABLE IF NOT EXISTS `databridge_task_instance` (
  `id`                VARCHAR(64)  NOT NULL,
  `task_id`           VARCHAR(64)  NULL COMMENT '同步任务或数据开发流程 id（画布复用本列）',
  `pipeline_id`       VARCHAR(64)  NULL COMMENT 'cdc 管道实例才有值',
  `task_name`         VARCHAR(128) NULL,
  `sync_mode`         VARCHAR(16)  NULL COMMENT 'full | incremental | cdc',
  `status`            VARCHAR(16)  NULL COMMENT 'running | success | failed | stopped',
  `trigger_type`      VARCHAR(16)  NULL COMMENT 'manual | cron | retry（trigger 是 MySQL 保留字，列名换掉）',
  `retry_attempt`     INT          NULL COMMENT '第几次重试链：0 表示首次运行',
  `progress`          INT          NULL,
  `total_rows`        BIGINT       NULL COMMENT 'cdc 模式没有总行数，为 NULL',
  `read_rows`         BIGINT       NULL,
  `write_rows`        BIGINT       NULL,
  `rate_rows_per_sec` INT          NULL,
  `exec_mode`         VARCHAR(16)  NULL COMMENT 'real = 引擎真实读写（mysql 驱动 + 两端 mysql/oracle）| simulate = 模拟推进（契约 1.3/4.1）',
  `started_at`        DATETIME(3)  NULL,
  `finished_at`       DATETIME(3)  NULL,
  `message`           TEXT         NULL,
  `extra`        JSON         NULL,
  `seq`               BIGINT       NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_instance_seq` (`seq`),
  KEY `idx_instance_task_id` (`task_id`),
  KEY `idx_instance_pipeline_id` (`pipeline_id`),
  KEY `idx_instance_status` (`status`),
  KEY `idx_instance_started_at` (`started_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 运行日志（契约 1.3，引擎 POST /engine/logs 批量写入）------------------------------
CREATE TABLE IF NOT EXISTS `databridge_run_log` (
  `id`          VARCHAR(64) NOT NULL,
  `instance_id` VARCHAR(64) NULL,
  `task_id`     VARCHAR(64) NULL,
  `level`       VARCHAR(8)  NULL COMMENT 'INFO | WARN | ERROR',
  `message`     TEXT        NULL,
  `created_at`  DATETIME(3) NULL,
  `extra`  JSON        NULL,
  `seq`         BIGINT      NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_log_seq` (`seq`),
  KEY `idx_log_instance_created` (`instance_id`, `created_at`),
  KEY `idx_log_task_id` (`task_id`),
  KEY `idx_log_level` (`level`),
  KEY `idx_log_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 同步点位（契约 1.2 / 1.4，引擎每 tick upsert）------------------------------------
CREATE TABLE IF NOT EXISTS `databridge_offset` (
  `id`           VARCHAR(64)   NOT NULL,
  `task_id`      VARCHAR(64)   NULL,
  `instance_id`  VARCHAR(64)   NULL,
  `shard_key`    VARCHAR(64)   NULL COMMENT '缺省 default，多分片时区分',
  `offset_value` VARCHAR(1024) NULL,
  `updated_at`   DATETIME(3)   NULL,
  `extra`   JSON          NULL,
  `seq`          BIGINT        NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_offset_seq` (`seq`),
  KEY `idx_offset_task_instance` (`task_id`, `instance_id`),
  KEY `idx_offset_instance_id` (`instance_id`),
  KEY `idx_offset_updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 数据管道 CDC（契约 1.7，运行态字段由引擎回报刷新）--------------------------------
CREATE TABLE IF NOT EXISTS `databridge_pipeline` (
  `id`                  VARCHAR(64)  NOT NULL,
  `name`                VARCHAR(128) NOT NULL,
  `source_id`           VARCHAR(64)  NULL,
  `target_id`           VARCHAR(64)  NULL,
  `sync_objects`        JSON         NULL COMMENT '同步对象数组，如 APP_USER.T_ORDER',
  `ddl_policy`          VARCHAR(16)  NULL COMMENT 'ignore | break | exception',
  `cdc_poll_column`     VARCHAR(128) NULL COMMENT '契约 1.7/5：真实 cdc 的轮询增量列（时间/自增列），NULL 表示未配',
  `poll_interval_sec`   INT          NULL COMMENT '契约 1.7/5：真实 cdc 轮询间隔（1~3600 秒），默认 5',
  `status`              VARCHAR(16)  NULL COMMENT 'running | stopped',
  `running_instance_id` VARCHAR(64)  NULL,
  `last_error`          TEXT         NULL,
  `batch_size`          INT          NULL,
  `failure_rate`        DOUBLE       NULL,
  `change_rows`         BIGINT       NULL COMMENT '运行态：累计变更行数',
  `current_qps`         INT          NULL COMMENT '运行态：当前 QPS',
  `lag_ms`              BIGINT       NULL COMMENT '运行态：同步延迟',
  `cdc_position`        VARCHAR(255) NULL COMMENT '运行态：SCN / binlog 位点',
  `started_at`          DATETIME(3)  NULL,
  `last_report_at`      DATETIME(3)  NULL,
  `remark`              VARCHAR(512) NULL,
  `created_at`          DATETIME(3)  NULL,
  `updated_at`          DATETIME(3)  NULL,
  `extra`          JSON         NULL,
  `seq`                 BIGINT       NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pipeline_seq` (`seq`),
  KEY `idx_pipeline_status` (`status`),
  KEY `idx_pipeline_source_id` (`source_id`),
  KEY `idx_pipeline_target_id` (`target_id`),
  KEY `idx_pipeline_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 数据开发 ETL 画布（契约 1.8）-----------------------------------------------------
CREATE TABLE IF NOT EXISTS `databridge_dataflow` (
  `id`                 VARCHAR(64)  NOT NULL,
  `name`               VARCHAR(128) NOT NULL,
  `nodes`              JSON         NULL COMMENT '画布节点（含 config.datasourceId / table）',
  `edges`              JSON         NULL,
  `schedule_cron`      VARCHAR(64)  NULL,
  `retry_count`        INT          NULL,
  `retry_interval_sec` INT          NULL,
  `batch_size`         INT          NULL,
  `total_rows`         BIGINT       NULL,
  `failure_rate`       DOUBLE       NULL,
  `enabled`            TINYINT(1)   NULL,
  `last_status`        VARCHAR(16)  NULL,
  `last_run_at`        DATETIME(3)  NULL,
  `running_instance_id` VARCHAR(64) NULL,
  `remark`             VARCHAR(512) NULL,
  `created_at`         DATETIME(3)  NULL,
  `updated_at`         DATETIME(3)  NULL,
  `extra`         JSON         NULL,
  `seq`                BIGINT       NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dataflow_seq` (`seq`),
  KEY `idx_dataflow_last_status` (`last_status`),
  KEY `idx_dataflow_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 数据服务定义（契约 1.9）----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `databridge_data_api` (
  `id`              VARCHAR(64)  NOT NULL,
  `name`            VARCHAR(128) NOT NULL,
  `path`            VARCHAR(128) NULL COMMENT '对外地址 /ds/{path}',
  `method`          VARCHAR(8)   NULL,
  `datasource_id`   VARCHAR(64)  NULL,
  `table_name`      VARCHAR(128) NULL,
  `fields`          JSON         NULL COMMENT '返回字段定义',
  `query_params`    JSON         NULL,
  `sql_mode`        VARCHAR(16)  NULL COMMENT '1.9.2 builder | custom',
  `custom_sql`      TEXT         NULL COMMENT '1.9.2 自定义只读 SQL（:name 占位符，值一律绑定）',
  `auth_enabled`    TINYINT(1)   NULL,
  `api_key`         VARCHAR(128) NULL,
  `rate_limit_qps`  INT          NULL,
  `ip_whitelist`    JSON         NULL,
  `status`          VARCHAR(16)  NULL COMMENT 'draft | published',
  `invoke_count`    BIGINT       NULL COMMENT '累计调用次数（recordCall 原子累加）',
  `error_count`     BIGINT       NULL,
  `avg_latency_ms`  DOUBLE       NULL COMMENT '滑动算术平均',
  `published_at`    DATETIME(3)  NULL,
  `remark`          VARCHAR(512) NULL,
  `created_at`      DATETIME(3)  NULL,
  `updated_at`      DATETIME(3)  NULL,
  `extra`      JSON         NULL,
  `seq`             BIGINT       NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dataapi_seq` (`seq`),
  KEY `idx_dataapi_path` (`path`),
  KEY `idx_dataapi_status` (`status`),
  KEY `idx_dataapi_datasource_id` (`datasource_id`),
  KEY `idx_dataapi_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 数据服务按天调用计数（替代内存 callLogs，供 GET /data-apis/:id/stats recentTrend）
CREATE TABLE IF NOT EXISTS `databridge_data_api_call_day` (
  `seq`         BIGINT      NOT NULL AUTO_INCREMENT,
  `api_id`      VARCHAR(64) NOT NULL,
  `date`        DATE        NOT NULL COMMENT 'UTC 日期',
  `count`       BIGINT      NOT NULL DEFAULT 0,
  `errors`      BIGINT      NOT NULL DEFAULT 0,
  `latency_sum` DOUBLE      NOT NULL DEFAULT 0 COMMENT '延迟求和，出参按 count 求均值',
  `avg_latency` DOUBLE      NOT NULL DEFAULT 0,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_call_day_api_date` (`api_id`, `date`),
  KEY `idx_call_day_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 数据服务调用明细日志（契约 1.9 GET /data-apis/calls）--------------------------------
-- 与 call_day（按天计数）互补：日计数表喂 /data-apis/:id/stats 的 recentTrend，
-- 本表存每次调用的明细（含被拒的请求），滚动保留最近 MAX_CALL_DETAILS 条
-- （插入侧每 50 次触发一条 DELETE，见 mysql/dataapi.store.js 的 pruneCallDetails）。
-- query_masked 是脱敏后 query 的 JSON 串（apiKey 值已替换为 ***），error_msg 只存前 500 字。
CREATE TABLE IF NOT EXISTS `databridge_data_api_call` (
  `seq`          BIGINT        NOT NULL AUTO_INCREMENT,
  `id`           VARCHAR(64)   NOT NULL COMMENT 'call- 前缀 + UUID（明细量大且不对外寻址，不回查 databridge_id_seq）',
  `api_id`       VARCHAR(64)   NULL COMMENT '路径不存在时未知，为 NULL',
  `api_name`     VARCHAR(128)  NULL,
  `path`         VARCHAR(128)  NULL COMMENT '请求的运行时路径片段（/ds/{path}），未注册的 path 也照记',
  `method`       VARCHAR(8)    NULL,
  `http_status`  INT           NULL COMMENT '200 或契约 1.9 的 401/403/404/429/502',
  `biz_code`     INT           NULL COMMENT '业务码，成功为 NULL',
  `ok`           TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 成功 0 失败（含被网关拒绝）',
  `latency_ms`   DECIMAL(10,2) NULL,
  `ip`           VARCHAR(64)   NULL,
  `query_masked` VARCHAR(1000) NULL COMMENT '脱敏 query 的 JSON 串',
  `error_msg`    VARCHAR(500)  NULL,
  `created_at`   DATETIME(3)   NULL,
  `extra`        JSON          NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_dataapicall_id` (`id`),
  KEY `idx_dataapicall_api_created` (`api_id`, `created_at`),
  KEY `idx_dataapicall_ok` (`ok`),
  KEY `idx_dataapicall_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 告警规则（契约 1.10）-------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `databridge_alert_rule` (
  `id`                VARCHAR(64)  NOT NULL,
  `name`              VARCHAR(128) NOT NULL,
  `scope`             VARCHAR(16)  NULL COMMENT 'all | task | dataflow | pipeline',
  `conditions`        JSON         NULL COMMENT 'task_failed | pipeline_error | lag_over_threshold',
  `threshold_lag_ms`  BIGINT       NULL,
  `channels`          JSON         NULL COMMENT '通知通道数组',
  `enabled`           TINYINT(1)   NULL,
  `remark`            VARCHAR(512) NULL,
  `created_at`        DATETIME(3)  NULL,
  `updated_at`        DATETIME(3)  NULL,
  `extra`        JSON         NULL,
  `seq`               BIGINT       NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_alertrule_seq` (`seq`),
  KEY `idx_alertrule_enabled` (`enabled`),
  KEY `idx_alertrule_scope` (`scope`),
  KEY `idx_alertrule_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 告警记录（契约 1.10，一条 = 规则 + 通道的一次投递）--------------------------------
CREATE TABLE IF NOT EXISTS `databridge_alert_record` (
  `id`             VARCHAR(64)  NOT NULL,
  `rule_id`        VARCHAR(64)  NULL,
  `rule_name`      VARCHAR(128) NULL,
  `level`          VARCHAR(8)   NULL COMMENT 'INFO | WARN | ERROR',
  `target_type`    VARCHAR(16)  NULL COMMENT 'task | dataflow | pipeline',
  `target_id`      VARCHAR(64)  NULL,
  `target_name`    VARCHAR(128) NULL,
  `message`        TEXT         NULL,
  `channel`        VARCHAR(32)  NULL,
  `channel_result` VARCHAR(64)  NULL,
  `is_read`        TINYINT(1)   NULL,
  `created_at`     DATETIME(3)  NULL,
  `extra`     JSON         NULL,
  `seq`            BIGINT       NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_alertrecord_seq` (`seq`),
  KEY `idx_alertrecord_read` (`is_read`),
  KEY `idx_alertrecord_level` (`level`),
  KEY `idx_alertrecord_target` (`target_type`, `target_id`),
  KEY `idx_alertrecord_rule_id` (`rule_id`),
  KEY `idx_alertrecord_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ID 序列（复刻 memoryStore 的 prefix + 自增语义，LAST_INSERT_ID 原子取号）---------
CREATE TABLE IF NOT EXISTS `databridge_id_seq` (
  `id_prefix` VARCHAR(8) NOT NULL COMMENT 'ds- | task- | inst- | log- | ofs- | pipe- | df- | api- | ar- | rec-',
  `next_val`  INT        NOT NULL DEFAULT 0 COMMENT '最近一次已分配的序号',
  PRIMARY KEY (`id_prefix`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
