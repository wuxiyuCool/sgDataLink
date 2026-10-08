/**
 * 问数日志仓储（内存实现，契约 1.12）。滚动保留最近 MAX_LOGS 条（按插入序裁剪）。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const MAX_LOGS = 50000;

const store = createMemoryStore({ prefix: 'mlg-', startId: 18000 });

const trim = () => {
  const all = store.all();
  if (all.length <= MAX_LOGS) return;
  all.slice(0, all.length - MAX_LOGS).forEach((item) => store.remove(item.id));
};

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['question', 'userName'],
    sort: query.sort || 'createdAt:desc',
  });

/** 与 mysql 版 page 逐参对齐：keyword/status/userName 精确 + startTime|endTime 闭区间（createdAt 倒序） */
const page = (query = {}) => {
  const status = String(query.status || '').trim();
  const userName = String(query.userName || '').trim();
  const start = query.startTime ? new Date(query.startTime).getTime() : null;
  const end = query.endTime ? new Date(query.endTime).getTime() : null;
  const filtered = list().filter((record) => {
    if (status && record.status !== status) return false;
    if (userName && record.userName !== userName) return false;
    const at = new Date(record.createdAt).getTime();
    if (start !== null && at < start) return false;
    if (end !== null && at > end) return false;
    return true;
  });
  return queryList(filtered, {
    keyword: query.keyword,
    keywordFields: ['question', 'userName'],
    sort: 'createdAt:desc',
    page: query.page,
    size: query.size,
  });
};

/** 近段时间的日志（dashboard chat/hotMetrics 聚合用）：createdAt 倒序截断 */
const recent = async (sinceIso, limit = 5000) => {
  const since = Date.parse(sinceIso);
  return filterList(list(), { sort: 'createdAt:desc' })
    .filter((record) => Date.parse(record.createdAt) >= since)
    .slice(0, limit);
};

const getById = (id) => store.get(id);

const create = (data) => {
  const record = {
    userName: '',
    status: 'success',
    metricIds: '',
    elapsedMs: 0,
    reviewed: false,
    ...data,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || nowIso(),
  };
  const inserted = store.insert(record);
  trim();
  return inserted;
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

const memoryImpl = {
  list,
  find,
  page,
  recent,
  getById,
  create,
  update,
  delete: (id) => store.remove(id) || null,
  count: () => store.size(),
  clear: store.clear,
};

module.exports = require('./facade').pickImpl('metricquerylog', memoryImpl);
