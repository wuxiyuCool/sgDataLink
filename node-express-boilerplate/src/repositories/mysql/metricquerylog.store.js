/**
 * 问数日志仓储（MySQL 实现，契约 1.12）。滚动 5 万条：写入后按 seq 超限删最旧。
 */
const { defineStore, normalizePaging, escapeLike, toDbDateTime } = require('./sqlStore');
const { nowIso } = require('../memoryStore');
const db = require('../../db/mysql');

const MAX_LOGS = 50000;
let writesSinceTrim = 0;

const store = defineStore({
  table: 'databridge_metric_query_log',
  idPrefix: 'mlg-',
  startId: 18000,
  keywordFields: ['question', 'userName'],
  defaultSort: 'createdAt:desc',
  columns: {
    id: {},
    userName: { col: 'user_name' },
    question: { type: 'text' },
    matched: { type: 'json' },
    metricIds: { type: 'text', col: 'metric_ids' },
    m2sql: { type: 'text' },
    physicalSql: { type: 'text', col: 'physical_sql' },
    status: {},
    error: { type: 'text' },
    elapsedMs: { type: 'int', col: 'elapsed_ms' },
    resultPreview: { type: 'text', col: 'result_preview' },
    reviewed: { type: 'bool' },
    createdAt: { type: 'datetime', col: 'created_at' },
  },
});

/** 每 500 次写入才扫一次上限，避免每次 DELETE 子查询；多副本各删各的，代价可接受 */
const trim = async () => {
  writesSinceTrim += 1;
  if (writesSinceTrim < 500) return;
  writesSinceTrim = 0;
  try {
    await db.run(
      `DELETE FROM databridge_metric_query_log WHERE seq <= (SELECT MIN(seq) FROM (SELECT seq FROM databridge_metric_query_log ORDER BY seq DESC LIMIT 1 OFFSET ${MAX_LOGS}) t)`
    );
  } catch (err) {
    /* 裁剪失败不影响写入主链路 */
  }
};

const list = () => store.list();
const find = (query = {}) =>
  store.find({ filters: query.filters || {}, keyword: query.keyword, sort: query.sort || 'createdAt:desc' });
/**
 * 分页查询（createdAt 倒序）：keyword 命中 question/userName，status/userName 精确，
 * startTime|endTime 闭区间（UTC 口径同内存版）。与内存版 repository.page 逐参对齐。
 */
const page = async (query = {}) => {
  const paging = normalizePaging(query);
  const { size, offset } = paging;
  const where = [];
  const params = [];
  const status = String(query.status || '').trim();
  if (status) {
    where.push('`status` = ?');
    params.push(status);
  }
  const userName = String(query.userName || '').trim();
  if (userName) {
    where.push('`user_name` = ?');
    params.push(userName);
  }
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(`question` LIKE ? OR `user_name` LIKE ?)');
    params.push(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`);
  }
  const start = toDbDateTime(query.startTime);
  const end = toDbDateTime(query.endTime);
  if (start) {
    where.push('created_at >= ?');
    params.push(start);
  }
  if (end) {
    where.push('created_at <= ?');
    params.push(end);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, countRows] = await Promise.all([
    db.query(
      `SELECT * FROM databridge_metric_query_log ${whereSql} ORDER BY seq DESC LIMIT ${size} OFFSET ${offset}`,
      params
    ),
    db.query(`SELECT COUNT(*) AS total FROM databridge_metric_query_log ${whereSql}`, params),
  ]);
  const total = Number(countRows[0] && countRows[0].total) || 0;
  return {
    items: rows.map((row) => store.fromRow(row)),
    total,
    page: paging.page,
    size,
    pages: Math.ceil(total / size),
  };
};
const getById = (id) => store.getById(id);

/** 近段时间日志（dashboard chat/hotMetrics 聚合用，与内存版 recent 同名同义） */
const recent = async (sinceIso, limit = 5000) => {
  const start = toDbDateTime(sinceIso);
  if (!start) return [];
  const rows = await db.query(
    `SELECT * FROM databridge_metric_query_log WHERE created_at >= ? ORDER BY seq DESC LIMIT ${Number(limit) || 5000}`,
    [start]
  );
  return rows.map((row) => store.fromRow(row));
};

const create = async (data) => {
  const record = {
    userName: '',
    status: 'success',
    metricIds: '',
    elapsedMs: 0,
    reviewed: false,
    ...data,
    createdAt: data.createdAt || nowIso(),
  };
  const created = await store.insert(record);
  await trim();
  return created;
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

const deleteById = async (id) => (await store.deleteById(id)) || null;

module.exports = {
  list,
  find,
  page,
  recent,
  getById,
  create,
  update,
  delete: deleteById,
  count: () => store.count(),
  clear: () => store.clear(),
};
