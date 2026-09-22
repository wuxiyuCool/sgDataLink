/**
 * 数据服务（Data API）仓储（MySQL 实现，契约 1.9）。
 *
 * 与内存版的差别只在「调用统计」的落点：
 * - 内存版把按天日志放在模块级 Map（不落进记录本体），
 *   这里换成 databridge_data_api_call_day 表（api_id + date 唯一），
 *   getCallLog 仍返回同样的 [{ date, count, errors, latencySum }] 升序数组，
 *   所以 dataApi.service 的 recentTrend 聚合逻辑一行没改；
 * - invokeCount / errorCount / avgLatencyMs 的累加改成单条原子 UPDATE
 *   （MySQL 从左到右求值 SET 列表，avg 表达式先算，拿到的仍是自增前的 invoke_count），
 *   并发调用下不会丢计数；内存版靠单线程天然没有这个问题。
 *
 * 调用明细日志（契约 1.9 GET /data-apis/calls）落 databridge_data_api_call 表：
 * addCall 逐条 INSERT，每 PRUNE_EVERY 次插入跑一条 DELETE 把行数压回 MAX_CALL_DETAILS；
 * pageCalls / callStats 直接按该表查，内存版用同名方法 + 数组环形缓冲对齐同一套出参。
 * 删除数据服务只清日计数表，明细是审计日志所以留着（apiName/path 是调用时的快照）。
 *
 * 滑动窗口限流器仍在内存（utils/rateWindow），不入库。
 */
const { randomUUID } = require('crypto');
const { defineStore } = require('./sqlStore');
const db = require('../../db/mysql');
const logger = require('../../config/logger');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name', 'path', 'tableName'];

/** 按天日志最多保留的桶数（与内存版 MAX_CALL_LOG_ENTRIES 同值） */
const MAX_CALL_LOG_ENTRIES = 1000;

/** 调用明细日志滚动上限（契约 1.9：表滚动保留最近 5000 条） */
const MAX_CALL_DETAILS = 5000;

/** 明细插入多少次后跑一次淘汰（明细是追加型热点表，逐条淘汰的开销没必要） */
const PRUNE_EVERY = 50;

/** 单次淘汰最多删掉的桶数 */
const PRUNE_BATCH = 500;

const CALL_DAY_TABLE = 'databridge_data_api_call_day';

/** 调用明细表（契约 1.9 /calls） */
const CALL_TABLE = 'databridge_data_api_call';

/** 日趋势天数（契约 1.5 dataApiCallStats.dayTrend：最近 7 天，含当天） */
const TREND_DAYS = 7;

/** 列宽兜底：目标库 sql_mode 含 STRICT_TRANS_TABLES，超长字符串会直接让整条 INSERT 失败 */
const clamp = (value, max) => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
};

/** 'YYYY-MM-DD'（UTC，相对今天偏移 days 天） */
const utcDateOffset = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/** 可空整数列（http_status / biz_code）：null | undefined | '' | 非数字都落 NULL */
const toIntOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
};

const store = defineStore({
  table: 'databridge_data_api',
  idPrefix: 'api-',
  startId: 8000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    path: {},
    method: {},
    datasourceId: {},
    tableName: {},
    fields: { type: 'json' },
    queryParams: { type: 'json' },
    /** 1.9.2：builder（拼 SELECT）| custom（执行 customSql） */
    sqlMode: {},
    customSql: { type: 'text' },
    authEnabled: { type: 'bool' },
    apiKey: {},
    rateLimitQps: { type: 'int' },
    ipWhitelist: { type: 'json' },
    status: {},
    invokeCount: { type: 'int' },
    errorCount: { type: 'int' },
    avgLatencyMs: { type: 'num' },
    publishedAt: { type: 'datetime' },
    remark: { type: 'text' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

/**
 * 调用明细 store：同样走 defineStore，白拿「列映射 + buildWhere + 关键词 LIKE + 分页信封」，
 * pageCalls 的 result=success|error 在方法内部翻成 filters.ok = true|false。
 */
const callStore = defineStore({
  table: CALL_TABLE,
  idPrefix: 'call-',
  startId: 0,
  keywordFields: ['apiName', 'path'],
  defaultSort: 'createdAt:desc',
  columns: {
    id: {},
    apiId: {},
    apiName: {},
    path: {},
    method: {},
    httpStatus: { type: 'int' },
    bizCode: { type: 'int' },
    ok: { type: 'bool' },
    latencyMs: { type: 'num' },
    ip: {},
    queryMasked: { type: 'text' },
    errorMsg: { type: 'text' },
    createdAt: { type: 'datetime' },
  },
});

const list = () => store.list();

const find = (query = {}) =>
  store.find({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'createdAt:asc',
  });

const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const count = () => store.count();

/** 运行时按 path 查（契约 GET /ds/{path}）：同名 path 取最早创建的一条 */
const findByPath = async (path) => {
  const rows = await store.rows(
    '`path` = ?',
    [path],
    'ORDER BY `created_at` IS NULL ASC, `created_at` ASC, `seq` ASC LIMIT 1'
  );
  return rows[0] || null;
};

const findByDataSource = (dataSourceId) => store.rows('`datasource_id` = ?', [dataSourceId]);

const create = async (data) => {
  const timestamp = nowIso();
  const record = {
    method: 'GET',
    fields: [],
    queryParams: [],
    sqlMode: 'builder',
    customSql: null,
    authEnabled: true,
    apiKey: null,
    rateLimitQps: 20,
    ipWhitelist: [],
    status: 'draft',
    invokeCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
    ...data,
    id: data.id || (await store.nextId()),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.updatedAt || timestamp,
  };
  return store.insert(record);
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

/** 'YYYY-MM-DD'（UTC）；非法时间落到今天（与内存版 utcDateOf 同口径） */
const utcDateOf = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : nowIso().slice(0, 10);
};

/** 日计数桶超出上限时丢弃最旧的（内存版 buckets.shift() 的 SQL 版） */
const pruneCallDays = async (apiId) => {
  const stale = await db.query(
    `SELECT \`seq\` FROM ${CALL_DAY_TABLE} WHERE \`api_id\` = ? ORDER BY \`date\` DESC LIMIT ${MAX_CALL_LOG_ENTRIES}, ${PRUNE_BATCH}`,
    [apiId]
  );
  if (!stale.length) return;
  const placeholders = stale.map(() => '?').join(', ');
  await db.run(
    `DELETE FROM ${CALL_DAY_TABLE} WHERE \`seq\` IN (${placeholders})`,
    stale.map((row) => row.seq)
  );
};

/**
 * 记录一次调用：原子累加统计字段 + upsert 按天计数桶。
 * @param {string} id dataApi id
 * @param {Object} input { latencyMs, ok, date } date 仅种子数据需要显式给
 * @returns {Promise<Object|null>} 更新后的记录
 */
const recordCall = async (id, { latencyMs = 0, ok = true, date } = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  const latency = Math.max(Number(latencyMs) || 0, 0);
  const error = ok ? 0 : 1;

  // avg_latency_ms 放在最左边先算，后面的 invoke_count 才还是自增前的值（滑动算术平均）
  await db.run(
    `UPDATE databridge_data_api
        SET avg_latency_ms = ROUND(((avg_latency_ms * invoke_count) + ?) / (invoke_count + 1), 2),
            invoke_count = invoke_count + 1,
            error_count = error_count + ?
      WHERE id = ?`,
    [latency, error, String(id)]
  );

  const day = utcDateOf(date);
  const inserted = await db.run(
    `INSERT INTO ${CALL_DAY_TABLE} (api_id, \`date\`, \`count\`, errors, latency_sum, avg_latency)
     VALUES (?, ?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       avg_latency = ROUND((latency_sum + VALUES(latency_sum)) / (\`count\` + 1), 2),
       \`count\` = \`count\` + 1,
       errors = errors + VALUES(errors),
       latency_sum = latency_sum + VALUES(latency_sum)`,
    [String(id), day, error, latency, latency]
  );
  // affectedRows = 1 表示这条 INSERT 真的新建了桶，此时才需要淘汰（与内存版一致）
  if (inserted.affectedRows === 1) await pruneCallDays(id);

  return store.getById(id);
};

/** 某 API 的按天调用日志（升序），用于 stats 的 recentTrend */
const getCallLog = async (id) => {
  const rows = await db.query(
    `SELECT \`date\`, \`count\`, errors, latency_sum FROM ${CALL_DAY_TABLE} WHERE \`api_id\` = ? ORDER BY \`date\` ASC`,
    [String(id)]
  );
  return rows.map((row) => ({
    date: String(row.date),
    count: Number(row.count),
    errors: Number(row.errors),
    latencySum: Number(row.latency_sum) || 0,
  }));
};

/**
 * 明细表滚动淘汰：一条 SQL 删掉超出 MAX_CALL_DETAILS 的最旧行（seq 单调递增即插入序）。
 * 自引用 DELETE 在 5.7 上要靠派生表绕开「can't specify target table」，
 * 万一优化器不接受（derived_merge 打开时理论上可能），退化成「先查边界 seq 再删」两步。
 */
const pruneCallDetails = async () => {
  const offset = MAX_CALL_DETAILS - 1;
  try {
    await db.run(
      `DELETE FROM ${CALL_TABLE}
        WHERE \`seq\` < (SELECT edge FROM (SELECT \`seq\` AS edge FROM ${CALL_TABLE}
                                            ORDER BY \`seq\` DESC LIMIT 1 OFFSET ${offset}) AS keep_edge)`
    );
  } catch (err) {
    logger.warn('data api call detail prune single-statement failed (%s), fallback to two-step', err.message);
    const rows = await db.query(`SELECT \`seq\` AS edge FROM ${CALL_TABLE} ORDER BY \`seq\` DESC LIMIT 1 OFFSET ${offset}`);
    const edge = rows.length ? rows[0].edge : null;
    if (edge === null || edge === undefined) return;
    await db.run(`DELETE FROM ${CALL_TABLE} WHERE \`seq\` < ?`, [edge]);
  }
};

/** 插入计数（进程级）：每 PRUNE_EVERY 次插入淘汰一次，避免每条明细都跑一遍 DELETE */
let callInserts = 0;

/**
 * 写一条调用明细（契约 1.9 /calls，成功与被拒都写）。
 * 字段长度在这里按 DDL 列宽兜底截断：目标库 STRICT_TRANS_TABLES 下超长会直接让 INSERT 失败，
 * 而 ip / path 之类来自请求，长度不可信。
 * @param {Object} record { apiId, apiName, path, method, httpStatus, bizCode, ok, latencyMs, ip, queryMasked, errorMsg, createdAt }
 * @returns {Promise<Object>} 落库后的记录
 */
const addCall = async (record = {}) => {
  const detail = {
    id: record.id || `call-${randomUUID()}`,
    apiId: clamp(record.apiId, 64),
    apiName: clamp(record.apiName, 128),
    path: clamp(record.path, 128),
    method: clamp(record.method, 8),
    httpStatus: toIntOrNull(record.httpStatus),
    bizCode: toIntOrNull(record.bizCode),
    ok: Boolean(record.ok),
    latencyMs: Math.max(Number(record.latencyMs) || 0, 0),
    ip: clamp(record.ip, 64),
    queryMasked: clamp(record.queryMasked, 1000),
    errorMsg: clamp(record.errorMsg, 500),
    createdAt: record.createdAt || nowIso(),
  };
  const inserted = await callStore.insert(detail);
  callInserts += 1;
  if (callInserts % PRUNE_EVERY === 0) await pruneCallDetails();
  return inserted;
};

/**
 * 明细分页（契约 1.9）：{ items, total, page, size, pages }，createdAt 倒序。
 * @param {Object} query { page, size, apiId, result: 'success'|'error', keyword }
 */
const pageCalls = (query = {}) =>
  callStore.page({
    filters: {
      apiId: query.apiId,
      ok: query.result === 'success' || query.result === 'error' ? query.result === 'success' : undefined,
    },
    keyword: query.keyword,
    sort: 'createdAt:desc',
    page: query.page,
    size: query.size,
  });

/**
 * 明细聚合（契约 1.5 dataApiCallStats）：总量 / 成败 / 错误率 / 平均延迟 / 今日成败 / 最近 7 天趋势。
 * 全表 <= 5000 行，一次条件聚合 + 一次按日分组即可；created_at 存的是 UTC，
 * 所以日边界与 dayTrend 的分组键都在 UTC 侧算，和内存版同口径。
 */
const callStats = async () => {
  const todayStart = `${utcDateOffset(0)} 00:00:00`;
  const trendStart = `${utcDateOffset(-(TREND_DAYS - 1))} 00:00:00`;
  const [totals, trendRows] = await db.queryMany([
    [
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(\`ok\`), 0) AS success,
              COALESCE(SUM(1 - \`ok\`), 0) AS error,
              COALESCE(ROUND(AVG(\`latency_ms\`), 2), 0) AS avgLatencyMs,
              COALESCE(SUM(CASE WHEN \`created_at\` >= ? THEN \`ok\` ELSE 0 END), 0) AS todaySuccess,
              COALESCE(SUM(CASE WHEN \`created_at\` >= ? THEN 1 - \`ok\` ELSE 0 END), 0) AS todayError
         FROM ${CALL_TABLE}`,
      [todayStart, todayStart],
    ],
    [
      `SELECT DATE(\`created_at\`) AS day,
              COALESCE(SUM(\`ok\`), 0) AS success,
              COALESCE(SUM(1 - \`ok\`), 0) AS error
         FROM ${CALL_TABLE}
        WHERE \`created_at\` >= ?
        GROUP BY DATE(\`created_at\`)`,
      [trendStart],
    ],
  ]);
  const row = totals[0] || {};
  const total = Number(row.total) || 0;
  const success = Number(row.success) || 0;
  const error = Number(row.error) || 0;
  const buckets = new Map(
    trendRows.map((item) => [String(item.day), { success: Number(item.success) || 0, error: Number(item.error) || 0 }])
  );
  const dayTrend = Array.from({ length: TREND_DAYS }, (_, index) => {
    const date = utcDateOffset(index - (TREND_DAYS - 1));
    const bucket = buckets.get(date) || { success: 0, error: 0 };
    return { date, success: bucket.success, error: bucket.error };
  });
  return {
    total,
    success,
    error,
    errorRate: total ? Number(((error / total) * 100).toFixed(1)) : 0,
    avgLatencyMs: Number(row.avgLatencyMs) || 0,
    todaySuccess: Number(row.todaySuccess) || 0,
    todayError: Number(row.todayError) || 0,
    dayTrend,
  };
};

const deleteById = async (id) => {
  await db.run(`DELETE FROM ${CALL_DAY_TABLE} WHERE \`api_id\` = ?`, [String(id)]);
  return (await store.deleteById(id)) || null;
};

const clear = async () => {
  await db.run(`DELETE FROM ${CALL_DAY_TABLE}`);
  await db.run(`DELETE FROM ${CALL_TABLE}`);
  return store.clear();
};

module.exports = {
  MAX_CALL_LOG_ENTRIES,
  MAX_CALL_DETAILS,
  TREND_DAYS,
  list,
  find,
  page,
  getById,
  findByPath,
  create,
  update,
  delete: deleteById,
  count,
  findByDataSource,
  recordCall,
  getCallLog,
  addCall,
  pageCalls,
  callStats,
  clear,
};
