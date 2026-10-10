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
  `sql_mode`        VARCHAR(16)  NULL COMMENT '1.9.2/1.9.3 builder | custom | forward',
  `custom_sql`      TEXT         NULL COMMENT '1.9.2 自定义只读 SQL（:name 占位符，值一律绑定）',
  `forward_url`     VARCHAR(1000) NULL COMMENT '1.9.3 转发目标地址（http/https，:name 占位符自动 URL 编码）',
  `forward_method`  VARCHAR(8)   NULL COMMENT '1.9.3 GET | POST',
  `forward_headers` JSON         NULL COMMENT '1.9.3 固定下游请求头 [{name,value}]，调用方 header 不下传',
  `forward_body_template` TEXT   NULL COMMENT '1.9.3 POST 模板（:name 替换后按 JSON 发送）',
  `forward_timeout_ms`  INT      NULL COMMENT '1.9.3 下游超时 100~60000，默认 10000',
  `forward_passthrough_query` TINYINT(1) NULL COMMENT '1.9.3 是否合并调用方 query（apiKey 除外）',
  `api_doc`         JSON         NULL COMMENT '1.9.4 文档配置 {summary,description,paramDocs,responseExample}，创建/更新时为空则后端自动生成模板',
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

-- 登录日志（契约 1.11 /doc  Swagger 查看登录审计）：成功与失败都记，口令本身绝不落库
CREATE TABLE IF NOT EXISTS `databridge_login_log` (
  `seq`        BIGINT       NOT NULL AUTO_INCREMENT,
  `id`         VARCHAR(64)  NOT NULL COMMENT 'llg- 前缀 + UUID',
  `user_id`    VARCHAR(64)  NULL COMMENT '登录失败（用户不存在）时为 NULL',
  `username`   VARCHAR(64)  NULL COMMENT '登录尝试的原始用户名',
  `ip`         VARCHAR(64)  NULL,
  `ok`         TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 成功 0 失败',
  `error_msg`  VARCHAR(255) NULL COMMENT '失败原因（bad_credentials | account_disabled），不含口令',
  `created_at` DATETIME(3)  NULL,
  `extra`      JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_loginlog_id` (`id`),
  KEY `idx_loginlog_username` (`username`, `created_at`),
  KEY `idx_loginlog_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 文档中心访问日志（契约 1.9.5）：swagger.json 每次请求（JWT 或 docKey，成败都记）
-- key 只存掩码（前 6 位+***），完整 key/JWT/口令绝不落库；滚动保留最近 1 万条
CREATE TABLE IF NOT EXISTS `databridge_doc_access_log` (
  `seq`         BIGINT       NOT NULL AUTO_INCREMENT,
  `id`          VARCHAR(64)  NOT NULL COMMENT 'dal- 前缀 + UUID',
  `user_id`     VARCHAR(64)  NULL COMMENT '认证失败时为 NULL',
  `username`    VARCHAR(64)  NULL,
  `auth_type`   VARCHAR(8)   NULL COMMENT 'jwt | docKey；未认证失败为 NULL',
  `key_masked`  VARCHAR(32)  NULL COMMENT 'docKey 掩码（前 6 位+***）',
  `ip`          VARCHAR(64)  NULL,
  `ok`          TINYINT(1)   NOT NULL DEFAULT 0,
  `http_status` INT          NULL,
  `biz_code`    INT          NULL,
  `keyword`     VARCHAR(64)  NULL COMMENT '请求携带的 path/名称模糊词',
  `user_agent`  VARCHAR(255) NULL,
  `error_msg`   VARCHAR(255) NULL,
  `created_at`  DATETIME(3)  NULL,
  `extra`       JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_docaccesslog_id` (`id`),
  KEY `idx_doclog_username` (`username`, `created_at`),
  KEY `idx_doclog_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 平台用户（契约 1.11）：密码只存 bcrypt 哈希，明文永不落库；username 唯一由应用层校验 + 本索引兜底
CREATE TABLE IF NOT EXISTS `databridge_user` (
  `seq`                   BIGINT       NOT NULL AUTO_INCREMENT,
  `id`                    VARCHAR(64)  NOT NULL COMMENT 'usr- 前缀',
  `username`              VARCHAR(64)  NOT NULL,
  `password_hash`         VARCHAR(128) NOT NULL COMMENT 'bcryptjs cost10，禁止任何形式回显',
  `nickname`              VARCHAR(128) NULL,
  `role`                  VARCHAR(16)  NOT NULL DEFAULT 'user' COMMENT 'admin | user',
  `status`                VARCHAR(16)  NOT NULL DEFAULT 'active' COMMENT 'active | disabled',
  `must_change_password`  TINYINT(1)   NULL COMMENT '1=新建/被重置后首登需改密',
  `doc_access`            TINYINT(1)   NULL COMMENT '1.9.5 文档中心免登录访问权限（admin 开通）',
  `doc_key`               VARCHAR(64)  NULL COMMENT '1.9.5 dok- 前缀个人文档密钥，明文只回本人；关闭权限即清空',
  `doc_key_updated_at`    DATETIME(3)  NULL,
  `chat_access`           TINYINT(1)   NULL COMMENT '契约 1.12 问数对外服务权限（admin 开通即生成 chk- key，关闭清空）',
  `chat_key`              VARCHAR(64)  NULL COMMENT 'chk- 前缀个人问数密钥（X-CHAT-KEY），明文只回本人',
  `chat_key_updated_at`   DATETIME(3)  NULL,
  `last_login_at`         DATETIME(3)  NULL,
  `created_at`            DATETIME(3)  NULL,
  `updated_at`            DATETIME(3)  NULL,
  `extra`                 JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_user_id` (`id`),
  UNIQUE KEY `uk_user_username` (`username`),
  KEY `idx_user_role` (`role`),
  KEY `idx_user_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ID 序列（复刻 memoryStore 的 prefix + 自增语义，LAST_INSERT_ID 原子取号）---------
CREATE TABLE IF NOT EXISTS `databridge_id_seq` (
  `id_prefix` VARCHAR(8) NOT NULL COMMENT 'ds- | task- | inst- | log- | ofs- | pipe- | df- | api- | ar- | rec-',
  `next_val`  INT        NOT NULL DEFAULT 0 COMMENT '最近一次已分配的序号',
  PRIMARY KEY (`id_prefix`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- =============================================================================
-- 指标中心（契约 1.12；实施规格 docs/METRIC-DEV.md §5）
-- ID 前缀：dom- mdl- mcat- met- mver- mtk- mtr- mterm- mex- mlg-（model_column/metric_dep/
-- metric_setting 无字符串 id，用自然键）。
-- 枚举列（layer/type/status 等）不加 DB 约束，由 service 层按契约枚举校验（与既有表一致）。
-- metric.code 唯一键全库终身制：软删不释放 code，被引用的指标删除由 service 层 40903 拦截。
-- =============================================================================

CREATE TABLE IF NOT EXISTS `databridge_metric_domain` (
  `seq`          BIGINT       NOT NULL AUTO_INCREMENT,
  `id`           VARCHAR(64)  NOT NULL COMMENT 'dom- 前缀',
  `name`         VARCHAR(128) NOT NULL,
  `code`         VARCHAR(64)  NOT NULL COMMENT '域编码 ^[a-z][a-z0-9_]{1,30}$，界面建表前缀来源',
  `parent_id`    VARCHAR(64)  NOT NULL DEFAULT '0',
  `table_prefix` VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '空则取 code',
  `owner`        VARCHAR(64)  NOT NULL DEFAULT '',
  `sort`         INT          NOT NULL DEFAULT 0,
  `del_flag`     TINYINT(1)   NOT NULL DEFAULT 0,
  `remark`       VARCHAR(512) NOT NULL DEFAULT '',
  `create_by`    VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`   DATETIME(3)  NULL,
  `updated_at`   DATETIME(3)  NULL,
  `extra`        JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricdomain_id` (`id`),
  UNIQUE KEY `uk_metricdomain_code` (`code`),
  KEY `idx_metricdomain_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databridge_metric_model` (
  `seq`           BIGINT       NOT NULL AUTO_INCREMENT,
  `id`            VARCHAR(64)  NOT NULL COMMENT 'mdl- 前缀',
  `name`          VARCHAR(128) NOT NULL,
  `datasource_id` VARCHAR(64)  NOT NULL,
  `domain_id`     VARCHAR(64)  NOT NULL,
  `layer`         VARCHAR(8)   NOT NULL COMMENT 'ODS | DIM | DWD | DWS | ADS',
  `category_id`   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '契约 1.16：建模分层树的分类节点（mcat-），空串＝该层未分类；旧库补列为 NULL，服务端读时归一成空串',
  `table_name`    VARCHAR(128) NOT NULL,
  `create_type`   VARCHAR(16)  NOT NULL COMMENT 'reference 引用已有表 | ddl 界面建表',
  `table_ddl`     TEXT         NULL COMMENT 'create_type=ddl 时的建表语句留档',
  `table_status`  VARCHAR(16)  NOT NULL DEFAULT 'none' COMMENT '契约 1.13：none 未建 | created 平台已建 | exists 引用表 | failed 建表失败',
  `table_msg`     VARCHAR(512) NOT NULL DEFAULT '' COMMENT '建表/删表失败的原始报错（界面展示与重试）',
  `table_at`      DATETIME(3)  NULL COMMENT '最近一次建表动作时间',
  `time_column`   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '默认时间维度列',
  `status`        VARCHAR(16)  NOT NULL DEFAULT 'online' COMMENT 'draft 草稿（ddl 模型初始态，不能建表/被引用）| online 启用 | offline 停用',
  `version`       INT          NOT NULL DEFAULT 1,
  `del_flag`      TINYINT(1)   NOT NULL DEFAULT 0,
  `remark`        VARCHAR(512) NOT NULL DEFAULT '',
  `create_by`     VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`    DATETIME(3)  NULL,
  `updated_at`    DATETIME(3)  NULL,
  `extra`         JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricmodel_id` (`id`),
  KEY `idx_metricmodel_ds_table` (`datasource_id`, `table_name`),
  KEY `idx_metricmodel_domain` (`domain_id`),
  KEY `idx_metricmodel_category` (`category_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databridge_metric_model_column` (
  `seq`         BIGINT       NOT NULL AUTO_INCREMENT,
  `model_id`    VARCHAR(64)  NOT NULL,
  `column_name` VARCHAR(64)  NOT NULL,
  `biz_name`    VARCHAR(128) NOT NULL DEFAULT '' COMMENT '中文业务名，LLM schema/M2SQL 召回用',
  `data_type`   VARCHAR(32)  NOT NULL,
  `role`        VARCHAR(16)  NOT NULL COMMENT 'dimension | measure | time',
  `agg_default` VARCHAR(16)  NOT NULL DEFAULT '' COMMENT 'measure 默认聚合 sum|count|max|min|avg|count_distinct',
  `is_key`      TINYINT(1)   NOT NULL DEFAULT 0,
  `unit`        VARCHAR(16)  NOT NULL DEFAULT '',
  `remark`      VARCHAR(512) NOT NULL DEFAULT '',
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricmodelcol` (`model_id`, `column_name`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 建模分层树的「分类」节点（契约 1.16 / V11 四期）：全局按层的归组节点，与指标域正交。
-- 树上层的 5 个根（ODS|DIM|DWD|DWS|ADS）由 service 的 LAYERS 常量虚拟化生成，不落库、不可增删改名；
-- 分类只动元数据，不参与物理表命名，任何分类操作零 DDL。
CREATE TABLE IF NOT EXISTS `databridge_metric_model_category` (
  `seq`         BIGINT       NOT NULL AUTO_INCREMENT,
  `id`          VARCHAR(64)  NOT NULL COMMENT 'mcat- 前缀',
  `name`        VARCHAR(64)  NOT NULL COMMENT '同层内大小写不敏感唯一（service 校验），跨层同名允许',
  `layer`       VARCHAR(8)   NOT NULL COMMENT 'ODS | DIM | DWD | DWS | ADS；创建后不可改（= 树上的挂载位置）',
  `description` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '分类口径说明，界面节点副标题与 tooltip',
  `sort`        INT          NOT NULL DEFAULT 0 COMMENT '同层内排序，tree 的 children 按 sort asc 再 createdAt asc',
  `del_flag`    TINYINT(1)   NOT NULL DEFAULT 0,
  `create_by`   VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`  DATETIME(3)  NULL,
  `updated_at`  DATETIME(3)  NULL,
  `extra`       JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metriccategory_id` (`id`),
  KEY `idx_metriccategory_layer` (`layer`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databridge_metric_metric` (
  `seq`           BIGINT       NOT NULL AUTO_INCREMENT,
  `id`            VARCHAR(64)  NOT NULL COMMENT 'met- 前缀',
  `code`          VARCHAR(64)  NOT NULL COMMENT '指标编码 ^[a-z][a-z0-9_]{2,63}$，复合公式 ${code} 引用锚点，创建后不可改',
  `name`          VARCHAR(128) NOT NULL,
  `alias`         JSON         NULL COMMENT '别名数组',
  `type`          VARCHAR(16)  NOT NULL COMMENT 'ATOMIC | DERIVED | COMPOSITE（保存时按规则推导，不人工填）',
  `define_type`   VARCHAR(16)  NOT NULL COMMENT 'MEASURE | FIELD | METRIC',
  `model_id`      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ATOMIC 必填；DERIVED 空=继承基底',
  `domain_id`     VARCHAR(64)  NOT NULL DEFAULT '',
  `expr`          TEXT         NULL COMMENT '聚合 SQL 片段（ATOMIC）/ 标量公式（COMPOSITE），见 METRIC-DEV §6',
  `define_params` JSON         NULL COMMENT '编译器输入：measureColumn/agg/filterSql/baseMetricId/dimensions/timePreset/refs',
  `unit`          VARCHAR(32)  NOT NULL DEFAULT '',
  `data_format`   VARCHAR(16)  NOT NULL DEFAULT 'DECIMAL' COMMENT 'DECIMAL | PERCENT | THOUSANDTH',
  `caliber`       TEXT         NULL COMMENT '业务口径',
  `owner`         VARCHAR(64)  NOT NULL DEFAULT '',
  `status`        VARCHAR(8)   NOT NULL DEFAULT 'draft' COMMENT 'draft | online | offline',
  `version`       INT          NOT NULL DEFAULT 1,
  `is_publish`    TINYINT(1)   NOT NULL DEFAULT 0,
  `del_flag`      TINYINT(1)   NOT NULL DEFAULT 0,
  `remark`        VARCHAR(512) NOT NULL DEFAULT '',
  `create_by`     VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`    DATETIME(3)  NULL,
  `updated_at`    DATETIME(3)  NULL,
  `extra`         JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricmetric_id` (`id`),
  UNIQUE KEY `uk_metricmetric_code` (`code`),
  KEY `idx_metricmetric_model` (`model_id`),
  KEY `idx_metricmetric_domain` (`domain_id`),
  KEY `idx_metricmetric_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 指标依赖边：保存时由 expr 解析重建（删旧插新）；lineage/tree/循环检测/影响分析的共同数据源
CREATE TABLE IF NOT EXISTS `databridge_metric_dep` (
  `seq`       BIGINT       NOT NULL AUTO_INCREMENT,
  `parent_id` VARCHAR(64)  NOT NULL COMMENT '引用方（派生/复合指标）',
  `child_id`  VARCHAR(64)  NOT NULL COMMENT '被引用方（基底/子指标）',
  `ref_expr`  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '公式中的引用位置说明',
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricdep` (`parent_id`, `child_id`),
  KEY `idx_metricdep_child` (`child_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databridge_metric_version` (
  `seq`         BIGINT       NOT NULL AUTO_INCREMENT,
  `id`          VARCHAR(64)  NOT NULL COMMENT 'mver- 前缀',
  `metric_id`   VARCHAR(64)  NOT NULL,
  `version`     INT          NOT NULL,
  `snapshot`    JSON         NOT NULL COMMENT '指标行完整快照',
  `change_note` VARCHAR(512) NOT NULL DEFAULT '',
  `create_by`   VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`  DATETIME(3)  NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricversion_id` (`id`),
  KEY `idx_metricversion_metric` (`metric_id`, `version`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databridge_metric_task` (
  `seq`                  BIGINT       NOT NULL AUTO_INCREMENT,
  `id`                   VARCHAR(64)  NOT NULL COMMENT 'mtk- 前缀',
  `name`                 VARCHAR(128) NOT NULL,
  `domain_id`            VARCHAR(64)  NOT NULL,
  `source_model_id`      VARCHAR(64)  NOT NULL,
  `metric_ids`           JSON         NULL COMMENT '本任务汇总的指标 id 数组',
  `dimension_column_ids` JSON         NULL COMMENT 'GROUP BY 的模型字段 id 数组',
  `clean_rules`          JSON         NULL COMMENT '清洗规则数组 filter/dedup/fill/rename（METRIC-DEV §7.2.2）',
  `time_preset`          JSON         NULL COMMENT '{mode:BETWEEN|RECENT, unit:DAY|WEEK|MONTH, period}',
  `align_mode`           VARCHAR(8)   NOT NULL DEFAULT 'model' COMMENT 'model=同模型聚合 | time=跨同源模型按时间粒度拼宽表(v1.15)',
  `time_grain`           VARCHAR(16)  NOT NULL DEFAULT '' COMMENT 'align=time 的目标粒度 day|week|month|quarter|year(v1.15)',
  `target_datasource_id` VARCHAR(64)  NOT NULL,
  `target_model_id`      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '已存在的 ADS 模型；空=运行时自动建表',
  `target_table`         VARCHAR(128) NOT NULL DEFAULT '',
  `write_mode`           VARCHAR(16)  NOT NULL DEFAULT 'overwrite' COMMENT 'overwrite | append | upsert(mysql ON DUP / oracle MERGE INTO)',
  `upsert_keys`          JSON         NULL,
  `schedule_cron`        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '空=手动；Quartz 6 位，格式同契约 1.2',
  `status`               VARCHAR(8)   NOT NULL DEFAULT 'online' COMMENT 'online | offline(暂停调度)',
  `last_run_at`          DATETIME(3)  NULL,
  `last_status`          VARCHAR(16)  NOT NULL DEFAULT 'idle' COMMENT 'idle | running | success | failed',
  `del_flag`             TINYINT(1)   NOT NULL DEFAULT 0,
  `remark`               VARCHAR(512) NOT NULL DEFAULT '',
  `create_by`            VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`           DATETIME(3)  NULL,
  `updated_at`           DATETIME(3)  NULL,
  `extra`                JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricktask_id` (`id`),
  KEY `idx_metricktask_domain` (`domain_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databridge_metric_task_run` (
  `seq`        BIGINT      NOT NULL AUTO_INCREMENT,
  `id`         VARCHAR(64) NOT NULL COMMENT 'mtr- 前缀',
  `task_id`    VARCHAR(64) NOT NULL,
  `trigger`    VARCHAR(8)  NOT NULL COMMENT 'manual | cron',
  `status`     VARCHAR(8)  NOT NULL COMMENT 'running | success | failed',
  `sql_text`   TEXT        NULL COMMENT '实际执行的清洗 SQL，多语句以换行分隔',
  `read_rows`  BIGINT      NOT NULL DEFAULT 0,
  `write_rows` BIGINT      NOT NULL DEFAULT 0,
  `elapsed_ms` BIGINT      NOT NULL DEFAULT 0,
  `message`    TEXT        NULL,
  `created_at` DATETIME(3) NULL,
  `extra`      JSON        NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metrickrun_id` (`id`),
  KEY `idx_metrickrun_task` (`task_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databridge_metric_term` (
  `seq`                BIGINT       NOT NULL AUTO_INCREMENT,
  `id`                 VARCHAR(64)  NOT NULL COMMENT 'mterm- 前缀',
  `name`               VARCHAR(128) NOT NULL,
  `alias`              JSON         NULL,
  `description`        TEXT         NULL COMMENT '给 LLM 的术语解释',
  `related_metric_ids` JSON         NULL,
  `related_model_ids`  JSON         NULL,
  `del_flag`           TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`         DATETIME(3)  NULL,
  `updated_at`         DATETIME(3)  NULL,
  `extra`              JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricterm_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databridge_metric_example` (
  `seq`        BIGINT       NOT NULL AUTO_INCREMENT,
  `id`         VARCHAR(64)  NOT NULL COMMENT 'mex- 前缀',
  `question`   VARCHAR(512) NOT NULL,
  `m2sql`      TEXT         NOT NULL COMMENT 'M2SQL 语义 SQL（few-shot 示例答案）',
  `note`       VARCHAR(512) NOT NULL DEFAULT '',
  `enabled`    TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at` DATETIME(3)  NULL,
  `extra`      JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricexample_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 问数日志：滚动保留最近 5 万条（service 层按 seq 裁剪，仿 databridge_doc_access_log 1 万条做法）
CREATE TABLE IF NOT EXISTS `databridge_metric_query_log` (
  `seq`            BIGINT        NOT NULL AUTO_INCREMENT,
  `id`             VARCHAR(64)   NOT NULL COMMENT 'mlg- 前缀',
  `user_name`      VARCHAR(64)   NOT NULL DEFAULT '',
  `question`       VARCHAR(1024) NOT NULL,
  `matched`        JSON          NULL COMMENT '召回元素明细',
  `metric_ids`     VARCHAR(1024) NOT NULL DEFAULT '' COMMENT '命中指标 id 逗号分隔冗余列（hotMetrics 计数用，勿解析 matched）',
  `m2sql`          TEXT          NULL,
  `physical_sql`   TEXT          NULL,
  `status`         VARCHAR(8)    NOT NULL COMMENT 'success | corrected | failed | clarify',
  `error`          TEXT          NULL,
  `elapsed_ms`     BIGINT        NOT NULL DEFAULT 0,
  `result_preview` TEXT          NULL,
  `reviewed`       TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1=人工审核通过，可转 example',
  `created_at`     DATETIME(3)   NULL,
  `extra`          JSON          NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricqlog_id` (`id`),
  KEY `idx_metricqlog_created` (`created_at`),
  KEY `idx_metricqlog_status` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 指标中心系统配置：表内值优先于 env（LLM_* 回落，METRIC-DEV §5.12/§10.2）
CREATE TABLE IF NOT EXISTS `databridge_metric_setting` (
  `seq`           BIGINT      NOT NULL AUTO_INCREMENT,
  `setting_key`   VARCHAR(64) NOT NULL COMMENT 'llm.baseUrl | llm.apiKey | llm.model | llm.timeoutMs | llm.embed.enabled | llm.embedModel',
  `setting_value` TEXT        NOT NULL,
  `secret`        TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '1=API 掩码回显（仿 docKey 做法），明文不出接口',
  `updated_by`    VARCHAR(64) NOT NULL DEFAULT '',
  `updated_at`    DATETIME(3) NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_metricsetting_key` (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 维度取值档案 + 码值业务名（契约 1.14 / V11 二期）：
-- source=auto 是探查回写的真实值，label 是人工登记的"库里 01、业务叫华东"；两者同表，避免"档案/字典"两套概念。
CREATE TABLE IF NOT EXISTS `databridge_metric_dimvalue` (
  `seq`          BIGINT       NOT NULL AUTO_INCREMENT,
  `id`           VARCHAR(64)  NOT NULL COMMENT 'mdv- 前缀',
  `model_id`     VARCHAR(64)  NOT NULL,
  `column_name`  VARCHAR(128) NOT NULL,
  `value`        VARCHAR(191) NOT NULL COMMENT '库里真实值',
  `label`        VARCHAR(191) NOT NULL DEFAULT '' COMMENT '业务名，探查不会覆盖人工登记',
  `hits`         BIGINT       NOT NULL DEFAULT 0 COMMENT '探查时的行数，用于排序与"脏值"识别',
  `source`       VARCHAR(8)   NOT NULL DEFAULT 'auto' COMMENT 'auto=探查 / manual=人工补录',
  `stale`        TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1=本次探查已见不到该值（不删，历史数据仍可被引用）',
  `profiled_at`  DATETIME(3)  NULL,
  `created_at`   DATETIME(3)  NULL,
  `updated_at`   DATETIME(3)  NULL,
  `extra`        JSON         NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_dimvalue_key` (`model_id`, `column_name`, `value`),
  KEY `idx_dimvalue_model` (`model_id`, `column_name`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
