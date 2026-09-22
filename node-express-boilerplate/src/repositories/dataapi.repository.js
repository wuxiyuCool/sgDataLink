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
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'path', 'tableName'];

/** 调用日志最多保留的条目数（按天聚合后的桶数，远超 7 天趋势所需，够用即可） */
const MAX_CALL_LOG_ENTRIES = 1000;

const store = createMemoryStore({ prefix: 'api-', startId: 8000 });

/** apiId -> [{ date: 'YYYY-MM-DD', count, errors, latencySum }] */
const callLogs = new Map();

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

/** 内存实现（DB_DRIVER=memory 时生效）；mysql 实现见 ./mysql/dataapi.store.js */
const memoryImpl = {
  MAX_CALL_LOG_ENTRIES,
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
  clear: () => {
    callLogs.clear();
    store.clear();
  },
};

// 双驱动门面：DB_DRIVER=mysql 时换成同名异步实现，方法签名统一返回 Promise
module.exports = require('./facade').pickImpl('dataapi', memoryImpl);
