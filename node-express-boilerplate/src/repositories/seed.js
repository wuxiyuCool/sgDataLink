/**
 * DataBridge 种子数据 —— 「双驱动种子实体生成器」。
 *
 * 这里只描述「要注入哪些实体」，不关心落到内存还是落到 MySQL：
 * 所有写入都走 src/repositories 的门面对象（DB_DRIVER 决定具体实现），
 * 所以同一份种子在两种驱动下产出同样的 ID 与同样的字段
 * （ds-1001..ds-1003、task-2001..、inst-3001..、log-5001..、ofs-6001..、
 *  pipe-7001、df-7501、api-8001、ar-9001、rec-9501..）。
 *
 * 调用点（src/index.js）：
 * - DB_DRIVER=memory：启动即注入（原行为，只是改成 await）；
 * - DB_DRIVER=mysql ：建表后若 databridge_datasource 是空表才注入一次，
 *                     有数据就跳过（幂等，重启不会重复插）。
 *
 * 只有 MEM_MOCK=false 且 DB_DRIVER=memory（即走脚手架的 MongoDB 分支）时不注入。
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

/** 三类数据源：10.x 网段与名字含 fail 的按 mock 规则必定连不上 */
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

/** GET /data-apis/:id/stats 的 recentTrend 铺底：3 个历史日的调用次数与错误数 */
const callTrend = [
  { daysAgo: 3, count: 24, errors: 1 },
  { daysAgo: 1, count: 40, errors: 1 },
  { daysAgo: 0, count: 12, errors: 0 },
];

/**
 * 种子点位（ofs-6001..）。引用了上面创建的实例 id，所以在 seedEntities 里逐条写入。
 * 覆盖三种演示形态：running 实例的 default 分片、成功全量实例的两个 shard、增量实例的位点。
 */
const seedOffsets = (running, fullSucceeded, incSucceeded, incFailed, fullTask, incrementalTask) => [
  {
    taskId: fullTask.id,
    instanceId: running.id,
    shardKey: 'default',
    offsetValue: 'UPDATE_TIME=2026-09-18T12:00:00Z/ROWID=aaa',
    updatedAt: '2026-09-19T01:05:00Z',
  },
  {
    taskId: fullTask.id,
    instanceId: fullSucceeded.id,
    shardKey: 'shard-01',
    offsetValue: 'ROWID=AAAKYmAAEAAAf7XAA1',
    updatedAt: '2026-09-18T01:06:00Z',
  },
  {
    taskId: fullTask.id,
    instanceId: fullSucceeded.id,
    shardKey: 'shard-02',
    offsetValue: 'ROWID=AAAKYmAAEAAAf7XAA2',
    updatedAt: '2026-09-18T01:08:00Z',
  },
  {
    taskId: incrementalTask.id,
    instanceId: incSucceeded.id,
    shardKey: 'default',
    offsetValue: 'UPDATE_TIME=2026-09-18T21:59:00Z',
    updatedAt: '2026-09-18T22:03:20Z',
  },
  {
    taskId: incrementalTask.id,
    instanceId: incFailed.id,
    shardKey: 'default',
    offsetValue: 'UPDATE_TIME=2026-09-17T21:58:00Z',
    updatedAt: '2026-09-17T22:04:10Z',
  },
];

/** 'YYYY-MM-DD'（UTC，相对今天） */
const utcDateDaysAgo = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** 每个种子实体的仓储依赖集中传入，便于单测替换 */
const repositories = {
  datasourceRepository,
  taskRepository,
  instanceRepository,
  logRepository,
  offsetRepository,
  pipelineRepository,
  dataflowRepository,
  dataApiRepository,
  alertruleRepository,
  alertrecordRepository,
};

/**
 * 生成并写入全部种子实体（内存 / MySQL 通用）。
 *
 * 写入顺序刻意保持串行：内存版是同步执行所以天然有序，
 * mysql 版每条都要 await 取号，并发下发会让 ID 与前缀顺序对不上
 * （文档示例锚定 ds-1001..ds-1003、api-8001，前端与验收脚本都按这些 id 走）。
 *
 * @param {Object} repos 十个仓储门面对象
 * @returns {Promise<Object>} 各表写入后的记录数
 */
const seedEntities = async (repos) => {
  const {
    datasourceRepository: datasourceRepo,
    taskRepository: tasks,
    instanceRepository: instances,
    logRepository: logs,
    offsetRepository: offsets,
    pipelineRepository: pipelines,
    dataflowRepository: dataflows,
    dataApiRepository: dataApis,
    alertruleRepository: alertRules,
    alertrecordRepository: alertRecords,
  } = repos;

  const createdDatasources = [];
  // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
  for (const item of datasources) {
    // eslint-disable-next-line no-await-in-loop
    createdDatasources.push(await datasourceRepo.create(item));
  }
  const sourceOracleDs = createdDatasources[0];
  const targetMysqlDs = createdDatasources[1];

  const fullTask = await tasks.create({
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
    // 调度配置（对标 FDL）：由 services/scheduler.service.js 真实按 cron 触发
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

  const incrementalTask = await tasks.create({
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
    // 每天 01:30 触发；重试 5 次、间隔 120s，用于演示字段回显
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
  const runningInstance = await instances.create({
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

  const succeedFullInstance = await instances.create({
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

  const succeedIncInstance = await instances.create({
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

  const failedIncInstance = await instances.create({
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

  await logs.createMany([
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
  ]);

  // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
  for (const item of seedOffsets(
    runningInstance,
    succeedFullInstance,
    succeedIncInstance,
    failedIncInstance,
    fullTask,
    incrementalTask
  )) {
    // eslint-disable-next-line no-await-in-loop
    await offsets.create(item);
  }

  // ==================== 以下为 FineDataLink 对标的四个模块（docs/API.md 1.7~1.10）====================

  /**
   * 数据管道（1.7）：一条 running 的 cdc 演示管道。
   * 运行态字段（changeRows / currentQps / lagMs / cdcPosition）就是 GET /pipelines/:id/status 的返回值，
   * 引擎每 tick 回报会覆盖它们；这里给的是契约示例值。
   * lagMs=820 低于种子规则 ar-9001 的阈值 5000，所以启动后不会立刻刷告警。
   */
  const pipeline = await pipelines.create({
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
  await instances.create({
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
  await dataflows.create({
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
  const dataApi = await dataApis.create({
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
    invokeCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
    publishedAt: '2026-09-05T02:00:00Z',
    remark: '调用方式：GET /ds/order-query?page=1&size=20，Header X-API-Key: dk-9f3a...',
    createdAt: '2026-09-01T08:50:00Z',
  });

  /**
   * 给 GET /data-apis/:id/stats 的 recentTrend 铺底（按 UTC 日期计数的调用日志）。
   * 累加完再把统计字段回写成契约示例值，保证列表页数字与文档一致。
   */
  const calls = [];
  callTrend.forEach((day) => {
    const date = utcDateDaysAgo(day.daysAgo);
    for (let index = 0; index < day.count; index += 1) {
      // 每天末尾的 day.errors 条算失败（原先的判定反了：那样会把 count-errors 条记成错误，
      // 明细日志上线后这个偏差会直接呈现在「调用明细」页上，所以顺手改对）
      calls.push({ latencyMs: 10 + (index % 9), ok: index < day.count - day.errors, date });
    }
  });
  // memory 驱动下这些调用按顺序执行完（门面包装的同步实现不会让出事件循环）；
  // mysql 驱动下每条都是原子 UPDATE + 按天 upsert，顺序无关
  await Promise.all(calls.map((call) => dataApis.recordCall(dataApi.id, call)));
  /**
   * 同一批调用也写进明细日志（契约 1.9 GET /data-apis/calls、1.5 dataApiCallStats），
   * 否则全新初始化的演示环境里「调用明细」页与调用统计卡都是空的，而列表页 invokeCount 却有数。
   */
  await Promise.all(
    calls.map((call, index) =>
      dataApis.addCall({
        apiId: dataApi.id,
        apiName: dataApi.name,
        path: dataApi.path,
        method: 'GET',
        httpStatus: call.ok ? 200 : 401,
        bizCode: call.ok ? null : 40101,
        ok: call.ok,
        latencyMs: call.latencyMs,
        ip: '127.0.0.1',
        queryMasked: JSON.stringify({ page: (index % 3) + 1, size: 20, apiKey: '***' }),
        errorMsg: call.ok ? null : '未提供 API Key（请用 X-API-KEY 头或 apiKey 查询参数携带）',
        createdAt: `${call.date}T09:15:00.000Z`,
      })
    )
  );
  await dataApis.update(dataApi.id, { invokeCount: 138, errorCount: 2, avgLatencyMs: 14 });

  // 告警规则（1.10）+ 两条历史记录（一条已读、一条未读，便于演示 read 筛选与 PATCH）
  const alertRule = await alertRules.create({
    name: '同步失败钉钉告警',
    scope: 'all',
    conditions: ['task_failed', 'pipeline_error', 'lag_over_threshold'],
    thresholdLagMs: 5000,
    channels: [{ type: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=MOCK' }],
    enabled: true,
    remark: '只写 alert-record（channelResult=mock-sent），不发真实 webhook',
    createdAt: '2026-09-01T09:00:00Z',
  });

  await alertRecords.createMany([
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

  const counts = {
    datasources: await datasourceRepo.count(),
    tasks: await tasks.count(),
    instances: await instances.count(),
    logs: await logs.count(),
    offsets: await offsets.count(),
    pipelines: await pipelines.count(),
    dataflows: await dataflows.count(),
    dataApis: await dataApis.count(),
    alertRules: await alertRules.count(),
    alertRecords: await alertRecords.count(),
  };
  return { created: createdDatasources.length, ...counts };
};

/** 是否已注入过种子（数据源或任务非空即认为已注入，幂等保护） */
const hasSeedData = async () => {
  const [datasourceCount, taskCount] = await Promise.all([datasourceRepository.count(), taskRepository.count()]);
  return datasourceCount > 0 || taskCount > 0;
};

/**
 * 注入种子数据（幂等：已有数据则跳过）。
 * @returns {Promise<boolean>} 是否执行了注入
 */
const seedMockData = async () => {
  if (!config.memMock && config.db.driver !== 'mysql') {
    logger.info('seed skipped: not in memory-mock mode and driver is %s', config.db.driver);
    return false;
  }
  if (await hasSeedData()) {
    logger.info('seed skipped: databridge already has data (driver=%s)', config.db.driver);
    return false;
  }

  const result = await seedEntities(repositories);
  logger.info(
    'seed data injected (driver=%s): %d datasources, %d tasks, %d instances, %d logs, %d offsets, ' +
      '%d pipelines, %d dataflows, %d data-apis, %d alert-rules, %d alert-records',
    config.db.driver,
    result.datasources,
    result.tasks,
    result.instances,
    result.logs,
    result.offsets,
    result.pipelines,
    result.dataflows,
    result.dataApis,
    result.alertRules,
    result.alertRecords
  );
  return true;
};

module.exports = {
  datasources,
  fullTaskMappings,
  incrementalTaskMappings,
  seedEntities,
  seedMockData,
  hasSeedData,
};
