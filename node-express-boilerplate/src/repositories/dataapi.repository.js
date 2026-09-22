/**
 * 数据服务（Data API）仓储（内存实现，docs/API.md 第 1.9 节）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现时：data_api 表存定义，调用统计换成
 * `insert into data_api_call_log(...)` + 按天 `group by date` 聚合。
 * 这里把「调用统计」独立成模块级 Map（不落进记录本体），
 * 避免 GET /data-apis 列表把日志一起吐给前端。
 *
 * 统计口径（契约：每次调用累加 invokeCount / 延迟统计）：
 * - invokeCount：命中已发布 API 的请求数（含被鉴权/限流拒绝的，因为确实打过来了）
 * - errorCount：被网关拒绝（401/403/429）的次数
 * - avgLatencyMs：滑动算术平均（(n-1)/n * old + 1/n * new）
 * - recentTrend：按 UTC 日期计数的最近 N 天，日志最多保留 MAX_CALL_LOG_ENTRIES 条
 *
 * 调用明细日志（契约 1.9 GET /data-apis/calls）落在模块级数组 callDetails 里，
 * 环形缓冲只保留最近 MAX_CALL_DETAILS 条；addCall / pageCalls / callStats 与
 * mysql 版（databridge_data_api_call 表）逐方法同名、出参结构一致。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'path', 'tableName'];

/** 调用日志最多保留的条目数（按天聚合后的桶数，远超 7 天趋势所需，够用即可） */
const MAX_CALL_LOG_ENTRIES = 1000;

/** 调用明细日志滚动上限（契约 1.9：表滚动保留最近 5000 条） */
const MAX_CALL_DETAILS = 5000;

/** 日趋势天数（契约 1.5 dataApiCallStats.dayTrend：最近 7 天，含当天） */
const TREND_DAYS = 7;

const store = createMemoryStore({ prefix: 'api-', startId: 8000 });

/** apiId -> [{ date: 'YYYY-MM-DD', count, errors, latencySum }] */
const callLogs = new Map();

/** 调用明细（插入序数组，超出 MAX_CALL_DETAILS 后从头部丢弃最旧的） */
const callDetails = [];

/** 明细自增序号（内存版没有 SQL 的 seq 列，用它在 id 上还原插入序） */
let callSeq = 0;

const list = () => store.all();

/** 查询（不分页），query = { filters, keyword, sort } */
const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:asc',
  });

/** 分页查询，返回 { items, total, page, size, pages } */
const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const count = () => store.size();

/** 运行时按 path 查（契约 GET /ds/{path}）：同名 path 取最早创建的一条 */
const findByPath = (path) => find({ filters: { path }, sort: 'createdAt:asc' })[0] || null;

/** 是否引用了某个数据源，供数据源删除的 40002 校验 */
const findByDataSource = (dataSourceId) => list().filter((item) => item.datasourceId === dataSourceId);

const create = (data) => {
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
    id: data.id || store.nextId(),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.updatedAt || timestamp,
  };
  return store.insert(record);
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

const deleteById = (id) => {
  callLogs.delete(String(id));
  return store.remove(id) || null;
};

/** 'YYYY-MM-DD'（UTC）；非法时间落到今天 */
const utcDateOf = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : nowIso().slice(0, 10);
};

/**
 * 记录一次调用：累加统计字段 + 写按天日志桶。
 * @param {string} id dataApi id
 * @param {Object} input { latencyMs, ok, date } date 仅种子数据需要显式给
 * @returns {Object|null} 更新后的记录
 */
const recordCall = (id, { latencyMs = 0, ok = true, date } = {}) => {
  const existing = store.get(id);
  if (!existing) return null;

  const invokeCount = (existing.invokeCount || 0) + 1;
  const errorCount = (existing.errorCount || 0) + (ok ? 0 : 1);
  const latency = Math.max(Number(latencyMs) || 0, 0);
  const avgLatencyMs = Number((((existing.avgLatencyMs || 0) * (invokeCount - 1) + latency) / invokeCount).toFixed(2));

  const key = String(id);
  const buckets = callLogs.get(key) || [];
  const day = utcDateOf(date);
  const bucket = buckets.find((item) => item.date === day);
  if (bucket) {
    bucket.count += 1;
    bucket.latencySum += latency;
    if (!ok) bucket.errors += 1;
  } else {
    buckets.push({ date: day, count: 1, errors: ok ? 0 : 1, latencySum: latency });
    buckets.sort((a, b) => (a.date < b.date ? -1 : 1));
    while (buckets.length > MAX_CALL_LOG_ENTRIES) buckets.shift();
  }
  callLogs.set(key, buckets);

  return store.replace(id, { ...existing, invokeCount, errorCount, avgLatencyMs });
};

/** 某 API 的按天调用日志（升序副本），用于 stats 的 recentTrend */
const getCallLog = (id) => (callLogs.get(String(id)) || []).map((item) => ({ ...item }));

/** 可空整数（httpStatus / bizCode）：null | undefined | '' | 非数字都归 null，与 mysql 版同口径 */
const toIntOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
};

/** 最近 days 天的 UTC 日期（含当天），升序 */
const recentUtcDates = (days = TREND_DAYS) => {
  const todayStart = Date.parse(`${nowIso().slice(0, 10)}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) =>
    new Date(todayStart - (days - 1 - index) * 86400000).toISOString().slice(0, 10)
  );
};

/**
 * 写一条调用明细（成功与被拒都写）：push 进环形缓冲，超出上限即丢弃最旧的若干条。
 * 入参归一后的键集合与 mysql 版 addCall 完全一致，所以 service 层不必区分驱动。
 * @param {Object} record { apiId, apiName, path, method, httpStatus, bizCode, ok, latencyMs, ip, queryMasked, errorMsg, createdAt }
 * @returns {Object} 写入后的明细
 */
const addCall = (record = {}) => {
  callSeq += 1;
  const detail = {
    id: record.id || `call-${callSeq}`,
    apiId: record.apiId || null,
    apiName: record.apiName || null,
    path: record.path || null,
    method: record.method || null,
    httpStatus: toIntOrNull(record.httpStatus),
    bizCode: toIntOrNull(record.bizCode),
    ok: Boolean(record.ok),
    latencyMs: Math.max(Number(record.latencyMs) || 0, 0),
    ip: record.ip || null,
    queryMasked: record.queryMasked || null,
    errorMsg: record.errorMsg || null,
    createdAt: record.createdAt || nowIso(),
  };
  callDetails.push(detail);
  if (callDetails.length > MAX_CALL_DETAILS) callDetails.splice(0, callDetails.length - MAX_CALL_DETAILS);
  return { ...detail };
};

/**
 * 明细分页（契约 1.9）：{ items, total, page, size, pages }，createdAt 倒序。
 * 形参刻意不叫 page / size —— 那两个名字在本模块顶层是列表分页函数。
 * @param {Object} query { page, size, apiId, result: 'success'|'error', keyword }
 */
const pageCalls = (query = {}) =>
  queryList(callDetails, {
    filters: {
      apiId: query.apiId,
      ok: query.result === 'success' || query.result === 'error' ? query.result === 'success' : undefined,
    },
    keyword: query.keyword,
    keywordFields: ['apiName', 'path'],
    sort: 'createdAt:desc',
    page: query.page,
    size: query.size,
  });

/**
 * 明细聚合（契约 1.5 dataApiCallStats），出参与 mysql 版逐键一致。
 * 日期口径同样是 UTC（nowIso / createdAt 都是 UTC ISO 串，取前 10 位即 UTC 日期）。
 */
const callStats = () => {
  const today = nowIso().slice(0, 10);
  const dates = recentUtcDates();
  const buckets = new Map(dates.map((date) => [date, { date, success: 0, error: 0 }]));
  let success = 0;
  let latencySum = 0;
  let todaySuccess = 0;
  let todayError = 0;
  callDetails.forEach((item) => {
    const passed = item.ok === true;
    if (passed) success += 1;
    latencySum += Number(item.latencyMs) || 0;
    const day = String(item.createdAt || '').slice(0, 10);
    if (day === today) {
      if (passed) todaySuccess += 1;
      else todayError += 1;
    }
    const bucket = buckets.get(day);
    if (bucket) bucket[passed ? 'success' : 'error'] += 1;
  });
  const total = callDetails.length;
  const error = total - success;
  return {
    total,
    success,
    error,
    errorRate: total ? Number(((error / total) * 100).toFixed(1)) : 0,
    avgLatencyMs: total ? Number((latencySum / total).toFixed(2)) : 0,
    todaySuccess,
    todayError,
    dayTrend: Array.from(buckets.values()).map((item) => ({ ...item })),
  };
};

/** 内存实现（DB_DRIVER=memory 时生效）；mysql 实现见 ./mysql/dataapi.store.js */
const memoryImpl = {
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
  clear: () => {
    callLogs.clear();
    callDetails.length = 0;
    callSeq = 0;
    store.clear();
  },
};

// 双驱动门面：DB_DRIVER=mysql 时换成同名异步实现，方法签名统一返回 Promise
module.exports = require('./facade').pickImpl('dataapi', memoryImpl);
