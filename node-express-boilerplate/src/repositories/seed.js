/**
 * DataBridge Mock 种子数据。
 *
 * 仅在 MEM_MOCK=true 时由 src/index.js 调用，保证前端一打开就有列表 / 详情 / 进度 / 日志 / 点位可看。
 * ID 完全由仓储的自增序列生成，因此落库结果就是契约示例里的
 * ds-1001..ds-1003、task-2001..task-2002、inst-3001..、log-5001..、ofs-6001..
 * （docs/API.md 第 0 节「ID 为字符串（mock 用自增前缀）」）。
 *
 * 【第二阶段替换点】接入真实数据库后本文件只保留 e2e / 演示环境用，生产不注入。
 */
const config = require('../config/config');
const logger = require('../config/logger');
const datasourceRepository = require('./datasource.repository');
const taskRepository = require('./task.repository');
const instanceRepository = require('./instance.repository');
const logRepository = require('./log.repository');
const offsetRepository = require('./offset.repository');
const pipelineRepository = require('./pipeline.repository');
const dataflowRepository = require('./dataflow.repository');
const dataApiRepository = require('./dataapi.repository');
const alertruleRepository = require('./alertrule.repository');
const alertrecordRepository = require('./alertrecord.repository');

const datasources = [
  {
    name: '生产Oracle',
    type: 'oracle',
    host: '10.0.0.11',
    port: 1521,
    database: 'ORCLPDB1',
    username: 'app_user',
    password: 'Oracle#Pass1',
    remark: '源库；host 属 10.x 网段，按契约 mock 连通测试必定失败',
    status: 'enabled',
    createdAt: '2026-09-01T08:00:00Z',
  },
  {
    name: '业务MySQL',
    type: 'mysql',
    host: '192.168.1.21',
    port: 3306,
    database: 'dst',
    username: 'sync_user',
    password: 'MySQL#Pass1',
    remark: '目标库；mock 连通测试成功',
    status: 'enabled',
    createdAt: '2026-09-01T08:05:00Z',
  },
  {
    name: '预发PostgreSQL(fail)',
    type: 'postgresql',
    host: '172.16.0.30',
    port: 5432,
    database: 'warehouse',
    username: 'dw_user',
    password: 'PG#Pass1234',
    remark: '未被任何任务引用，可直接删除；名称含 fail，mock 连通测试必定失败',
    status: 'disabled',
    createdAt: '2026-09-02T09:00:00Z',
  },
];

const fullTaskMappings = [
  {
    sourceField: 'ID',
    targetField: 'ID',
    sourceType: 'NUMBER',
    targetType: 'BIGINT',
    primaryKey: true,
    transform: null,
  },
  {
    sourceField: 'AMOUNT',
    targetField: 'AMOUNT',
    sourceType: 'NUMBER(18,2)',
    targetType: 'DECIMAL(18,2)',
    primaryKey: false,
    // 转换组件占位：Mock 阶段只回显，不参与模拟执行
    transform: { type: 'trim', value: null },
  },
  { sourceField: 'UPDATE_TIME', targetField: 'UPDATE_TIME', sourceType: 'DATE', targetType: 'DATETIME', primaryKey: false },
  {
    sourceField: 'REMARK',
    targetField: 'REMARK',
    sourceType: 'VARCHAR2(200)',
    targetType: 'VARCHAR(200)',
    primaryKey: false,
    transform: { type: 'upper', value: null },
  },
];

const incrementalTaskMappings = [
  { sourceField: 'ITEM_ID', targetField: 'ITEM_ID', sourceType: 'NUMBER', targetType: 'BIGINT', primaryKey: true },
  { sourceField: 'ORDER_ID', targetField: 'ORDER_ID', sourceType: 'NUMBER', targetType: 'BIGINT', primaryKey: false },
  {
    sourceField: 'PRICE',
    targetField: 'PRICE',
    sourceType: 'NUMBER(10,4)',
    targetType: 'DECIMAL(10,4)',
    primaryKey: false,
    // constant 类型必须带 value，与 docs/API.md 1.2 的 transform 约束一致
    transform: { type: 'constant', value: '0' },
  },
  {
    sourceField: 'UPDATE_TIME',
    targetField: 'UPDATE_TIME',
    sourceType: 'DATE',
    targetType: 'DATETIME',
    primaryKey: false,
  },
];

/**
 * 注入种子数据（幂等：已有数据则跳过）。
 * @returns {boolean} 是否执行了注入
 */
const seedMockData = () => {
  if (!config.memMock) {
    logger.info('seed skipped: not in memory-mock mode');
    return false;
  }
  if (datasourceRepository.count() > 0 || taskRepository.count() > 0) {
    return false;
  }

  const createdDatasources = datasources.map((item) => datasourceRepository.create(item));
  const sourceOracleDs = createdDatasources[0];
  const targetMysqlDs = createdDatasources[1];

  const fullTask = taskRepository.create({
    name: '订单表全量同步',
    syncMode: 'full',
    sourceId: sourceOracleDs.id,
    sourceTable: 'T_ORDER',
    targetId: targetMysqlDs.id,
    targetTable: 'T_ORDER_MIRROR',
    writeMode: 'upsert',
    batchSize: 1000,
    incrementalColumn: null,
    fieldMappings: fullTaskMappings,
    // 调度配置（对标 FDL）：Mock 阶段仅存储回显，不会真正按 cron 触发
    scheduleCron: '0 0 2 * * ?',
    retryCount: 3,
    retryIntervalSec: 60,
    totalRows: 100000,
    failureRate: 0,
    enabled: true,
    lastStatus: 'running',
    lastRunAt: '2026-09-19T01:00:00Z',
    createdAt: '2026-09-01T08:10:00Z',
    remark: '全量演示任务：当前有一次 running 实例，编辑/删除会返回 40003，重复启动返回 40901',
  });

  const incrementalTask = taskRepository.create({
    name: '订单明细增量同步',
    syncMode: 'incremental',
    sourceId: sourceOracleDs.id,
    sourceTable: 'T_ORDER_ITEM',
    targetId: targetMysqlDs.id,
    targetTable: 't_order_item',
    writeMode: 'insert',
    batchSize: 500,
    incrementalColumn: 'UPDATE_TIME',
    fieldMappings: incrementalTaskMappings,
    // 每天 01:30 触发（Mock 阶段不生效）；重试 5 次、间隔 120s，用于演示字段回显
    scheduleCron: '0 30 1 * * ?',
    retryCount: 5,
    retryIntervalSec: 120,
    totalRows: 20000,
    failureRate: 0,
    enabled: true,
    lastStatus: 'success',
    lastRunAt: '2026-09-18T22:00:00Z',
    createdAt: '2026-09-01T08:20:00Z',
    remark: '增量演示任务：含 incrementalColumn=UPDATE_TIME，可正常编辑/删除/启动',
  });

  // running 实例（与 docs/API.md 第 1.2 节 progress 示例一致）
  const runningInstance = instanceRepository.create({
    taskId: fullTask.id,
    taskName: fullTask.name,
    syncMode: 'full',
    status: 'running',
    // 契约 1.6：种子里的历史实例都是人工触发
    trigger: 'manual',
    progress: 46,
    totalRows: 100000,
    readRows: 46000,
    writeRows: 45200,
    rateRowsPerSec: 2300,
    startedAt: '2026-09-19T01:00:00Z',
    finishedAt: null,
    message: null,
  });

  const succeedFullInstance = instanceRepository.create({
    taskId: fullTask.id,
    taskName: fullTask.name,
    syncMode: 'full',
    status: 'success',
    trigger: 'manual',
    progress: 100,
    totalRows: 100000,
    readRows: 100000,
    writeRows: 99800,
    rateRowsPerSec: 1350,
    startedAt: '2026-09-18T01:00:00Z',
    finishedAt: '2026-09-18T01:12:30Z',
    message: 'mock 全量同步完成',
  });

  const succeedIncInstance = instanceRepository.create({
    taskId: incrementalTask.id,
    taskName: incrementalTask.name,
    syncMode: 'incremental',
    status: 'success',
    trigger: 'manual',
    progress: 100,
    totalRows: 20000,
    readRows: 20000,
    writeRows: 19900,
    rateRowsPerSec: 1000,
    startedAt: '2026-09-18T22:00:00Z',
    finishedAt: '2026-09-18T22:03:20Z',
    message: 'mock 增量同步完成，位点已推进',
  });

  const failedIncInstance = instanceRepository.create({
    taskId: incrementalTask.id,
    taskName: incrementalTask.name,
    syncMode: 'incremental',
    status: 'failed',
    trigger: 'manual',
    progress: 63,
    totalRows: 20000,
    readRows: 12600,
    writeRows: 12300,
    rateRowsPerSec: 0,
    startedAt: '2026-09-17T22:00:00Z',
    finishedAt: '2026-09-17T22:04:10Z',
    message: 'ORA-01555: snapshot too old (mock)',
  });

  const logs = [
    {
      instanceId: runningInstance.id,
      taskId: fullTask.id,
      level: 'INFO',
      message: 'sync started: T_ORDER -> T_ORDER_MIRROR (batchSize=1000, writeMode=upsert)',
      createdAt: '2026-09-19T01:00:01Z',
    },
    {
      instanceId: runningInstance.id,
      taskId: fullTask.id,
      level: 'INFO',
      message: 'batch 45/100 committed, 1000 rows',
      createdAt: '2026-09-19T01:04:00Z',
    },
    {
      instanceId: runningInstance.id,
      taskId: fullTask.id,
      level: 'INFO',
      message: 'batch 46/100 committed, 1000 rows',
      createdAt: '2026-09-19T01:05:00Z',
    },
    {
      instanceId: runningInstance.id,
      taskId: fullTask.id,
      level: 'WARN',
      message: 'write lag detected, throttle to 2000 rows/s',
      createdAt: '2026-09-19T01:05:30Z',
    },
    {
      instanceId: succeedFullInstance.id,
      taskId: fullTask.id,
      level: 'INFO',
      message: 'batch 100/100 committed, 1000 rows',
      createdAt: '2026-09-18T01:12:20Z',
    },
    {
      instanceId: succeedFullInstance.id,
      taskId: fullTask.id,
      level: 'INFO',
      message: 'full sync finished, 100000 rows written',
      createdAt: '2026-09-18T01:12:30Z',
    },
    {
      instanceId: succeedIncInstance.id,
      taskId: incrementalTask.id,
      level: 'INFO',
      message: 'incremental batch 40/40 committed, 500 rows',
      createdAt: '2026-09-18T22:03:10Z',
    },
    {
      instanceId: succeedIncInstance.id,
      taskId: incrementalTask.id,
      level: 'INFO',
      message: 'offset advanced to UPDATE_TIME=2026-09-18T21:59:00Z',
      createdAt: '2026-09-18T22:03:20Z',
    },
    {
      instanceId: failedIncInstance.id,
      taskId: incrementalTask.id,
      level: 'ERROR',
      message: 'batch 63/100 failed: ORA-01555: snapshot too old (mock)',
      createdAt: '2026-09-17T22:04:10Z',
    },
  ];
  logRepository.createMany(logs);

  const offsets = [
    {
      taskId: fullTask.id,
      instanceId: runningInstance.id,
      shardKey: 'default',
      offsetValue: 'UPDATE_TIME=2026-09-18T12:00:00Z/ROWID=aaa',
      updatedAt: '2026-09-19T01:05:00Z',
    },
    {
      taskId: fullTask.id,
      instanceId: succeedFullInstance.id,
      shardKey: 'shard-01',
      offsetValue: 'ROWID=AAAKYmAAEAAAf7XAA1',
      updatedAt: '2026-09-18T01:06:00Z',
    },
    {
      taskId: fullTask.id,
      instanceId: succeedFullInstance.id,
      shardKey: 'shard-02',
      offsetValue: 'ROWID=AAAKYmAAEAAAf7XAA2',
      updatedAt: '2026-09-18T01:08:00Z',
    },
    {
      taskId: incrementalTask.id,
      instanceId: succeedIncInstance.id,
      shardKey: 'default',
      offsetValue: 'UPDATE_TIME=2026-09-18T21:59:00Z',
      updatedAt: '2026-09-18T22:03:20Z',
    },
    {
      taskId: incrementalTask.id,
      instanceId: failedIncInstance.id,
      shardKey: 'default',
      offsetValue: 'UPDATE_TIME=2026-09-17T21:58:00Z',
      updatedAt: '2026-09-17T22:04:10Z',
    },
  ];
  offsets.forEach((item) => offsetRepository.create(item));

  // ==================== 以下为 FineDataLink 对标的四个新模块（docs/API.md 1.7~1.10）====================

  /**
   * 数据管道（1.7）：一条 running 的 cdc 演示管道。
   * 运行态字段（changeRows / currentQps / lagMs / cdcPosition）就是 GET /pipelines/:id/status 的返回值，
   * 引擎每 tick 回报会覆盖它们；这里给的是契约示例值。
   * lagMs=820 低于种子规则 ar-9001 的阈值 5000，所以启动后不会立刻刷告警。
   */
  const pipeline = pipelineRepository.create({
    name: '订单库实时镜像',
    sourceId: sourceOracleDs.id,
    targetId: targetMysqlDs.id,
    syncObjects: ['APP_USER.T_ORDER', 'APP_USER.T_ORDER_ITEM'],
    ddlPolicy: 'ignore',
    status: 'running',
    runningInstanceId: 'inst-3101',
    lastError: null,
    batchSize: 1000,
    failureRate: 0,
    changeRows: 12480,
    currentQps: 46,
    lagMs: 820,
    cdcPosition: 'SCN=28461937451',
    startedAt: '2026-09-19T01:00:00Z',
    lastReportAt: '2026-09-19T01:05:00Z',
    remark: 'cdc 演示管道：running 中改删返回 40003，重复 start 返回 40901',
    createdAt: '2026-09-01T08:30:00Z',
  });

  // 管道实例 id 直接取契约 1.7 示例值 inst-3101，便于前端对照（cdc 无进度，totalRows 为 null）
  instanceRepository.create({
    id: pipeline.runningInstanceId,
    taskId: null,
    pipelineId: pipeline.id,
    taskName: pipeline.name,
    syncMode: 'cdc',
    status: 'running',
    trigger: 'manual',
    progress: 0,
    totalRows: null,
    readRows: 12480,
    writeRows: 12480,
    rateRowsPerSec: 46,
    startedAt: '2026-09-19T01:00:00Z',
    finishedAt: null,
    message: null,
  });

  // 数据开发（1.8）：与契约示例完全一致的五节点画布（input → filter → join → validate → output）
  dataflowRepository.create({
    name: '订单宽表加工',
    nodes: [
      { id: 'n1', type: 'input', name: '读Oracle T_ORDER', config: { datasourceId: sourceOracleDs.id, table: 'T_ORDER' } },
      { id: 'n2', type: 'filter', name: '过滤无效单', config: { condition: "STATUS != 'INVALID'" } },
      { id: 'n3', type: 'join', name: '关联明细', config: { joinType: 'left', on: 'ORDER_ID' } },
      { id: 'n4', type: 'validate', name: '质量校验', config: { rules: ['ID not null'] } },
      {
        id: 'n5',
        type: 'output',
        name: '写MySQL 宽表',
        config: { datasourceId: targetMysqlDs.id, table: 'T_ORDER_WIDE', writeMode: 'overwrite' },
      },
    ],
    edges: [
      { source: 'n1', target: 'n2' },
      { source: 'n2', target: 'n3' },
      { source: 'n3', target: 'n4' },
      { source: 'n4', target: 'n5' },
    ],
    // 契约示例是手动运行（scheduleCron=null）；想演示 cron 触发改成 '0 0 3 * * ?' 即可
    scheduleCron: null,
    retryCount: 3,
    retryIntervalSec: 60,
    enabled: true,
    lastStatus: 'idle',
    lastRunAt: null,
    remark: 'ETL 演示画布：run 时取首个 input 与最后 output 拼 full 快照下发引擎',
    createdAt: '2026-09-01T08:40:00Z',
  });

  // 数据服务（1.9）：一条已发布、带 apiKey 的查询服务；apiKey 是演示固定值，重新发布会换真随机 key
  const dataApi = dataApiRepository.create({
    name: '订单查询服务',
    path: 'order-query',
    method: 'GET',
    datasourceId: targetMysqlDs.id,
    tableName: 'T_ORDER_MIRROR',
    fields: [
      { name: 'ID', type: 'BIGINT' },
      { name: 'AMOUNT', type: 'DECIMAL(18,2)' },
      { name: 'CUSTOMER', type: 'VARCHAR(200)' },
      { name: 'UPDATE_TIME', type: 'DATE' },
    ],
    queryParams: [{ name: 'minAmount', type: 'number', required: false }],
    authEnabled: true,
    apiKey: 'dk-9f3a1c2d4e5f60718293a4b5c6d7e8f9',
    rateLimitQps: 20,
    ipWhitelist: [],
    status: 'published',
    invokeCount: 138,
    errorCount: 2,
    avgLatencyMs: 14,
    publishedAt: '2026-09-05T02:00:00Z',
    remark: '调用方式：GET /ds/order-query?page=1&size=20，Header X-API-Key: dk-9f3a...',
    createdAt: '2026-09-01T08:50:00Z',
  });

  /**
   * 给 GET /data-apis/:id/stats 的 recentTrend 铺底（按 UTC 日期计数的内存日志）。
   * 累加完再把统计字段回写成契约示例值，保证列表页数字与文档一致。
   */
  [
    { daysAgo: 3, count: 24, errors: 1 },
    { daysAgo: 1, count: 40, errors: 1 },
    { daysAgo: 0, count: 12, errors: 0 },
  ].forEach((day) => {
    const date = new Date(Date.now() - day.daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (let index = 0; index < day.count; index += 1) {
      dataApiRepository.recordCall(dataApi.id, { latencyMs: 10 + (index % 9), ok: index >= day.count - day.errors, date });
    }
  });
  dataApiRepository.update(dataApi.id, { invokeCount: 138, errorCount: 2, avgLatencyMs: 14 });

  // 告警规则（1.10）+ 两条历史记录（一条已读、一条未读，便于演示 read 筛选与 PATCH）
  const alertRule = alertruleRepository.create({
    name: '同步失败钉钉告警',
    scope: 'all',
    conditions: ['task_failed', 'pipeline_error', 'lag_over_threshold'],
    thresholdLagMs: 5000,
    channels: [{ type: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=MOCK' }],
    enabled: true,
    remark: 'Mock 阶段只写 alert-record（channelResult=mock-sent），不发真实 webhook',
    createdAt: '2026-09-01T09:00:00Z',
  });

  alertrecordRepository.createMany([
    {
      ruleId: alertRule.id,
      ruleName: alertRule.name,
      level: 'ERROR',
      targetType: 'task',
      targetId: incrementalTask.id,
      targetName: incrementalTask.name,
      message: `实例 ${failedIncInstance.id} 同步失败: ${failedIncInstance.message}`,
      channel: 'dingtalk',
      channelResult: 'mock-sent',
      read: true,
      createdAt: '2026-09-17T22:04:11Z',
    },
    {
      ruleId: alertRule.id,
      ruleName: alertRule.name,
      level: 'WARN',
      targetType: 'pipeline',
      targetId: pipeline.id,
      targetName: pipeline.name,
      message: '数据管道 订单库实时镜像 同步延迟 6120ms，已超过告警阈值 5000ms',
      channel: 'dingtalk',
      channelResult: 'mock-sent',
      read: false,
      createdAt: '2026-09-19T01:04:00Z',
    },
  ]);

  logger.info(
    'seed data injected: %d datasources, %d tasks, %d instances, %d logs, %d offsets, ' +
      '%d pipelines, %d dataflows, %d data-apis, %d alert-rules, %d alert-records',
    datasourceRepository.count(),
    taskRepository.count(),
    instanceRepository.count(),
    logRepository.count(),
    offsetRepository.count(),
    pipelineRepository.count(),
    dataflowRepository.count(),
    dataApiRepository.count(),
    alertruleRepository.count(),
    alertrecordRepository.count()
  );
  return true;
};

module.exports = {
  seedMockData,
};
