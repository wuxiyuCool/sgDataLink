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
 * 滑动窗口限流器仍在内存（utils/rateWindow），不入库。
 */
const { defineStore } = require('./sqlStore');
const db = require('../../db/mysql');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name', 'path', 'tableName'];

/** 按天日志最多保留的桶数（与内存版 MAX_CALL_LOG_ENTRIES 同值） */
const MAX_CALL_LOG_ENTRIES = 1000;

/** 单次淘汰最多删掉的桶数 */
const PRUNE_BATCH = 500;

const CALL_DAY_TABLE = 'databridge_data_api_call_day';

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

const deleteById = async (id) => {
  await db.run(`DELETE FROM ${CALL_DAY_TABLE} WHERE \`api_id\` = ?`, [String(id)]);
  return (await store.deleteById(id)) || null;
};

const clear = async () => {
  await db.run(`DELETE FROM ${CALL_DAY_TABLE}`);
  return store.clear();
};

module.exports = {
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
  clear,
};
