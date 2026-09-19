/**
 * 运行日志仓储（内存实现）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现（task_log 表，按 instance_id + created_at 建索引）时只改本文件；
 * createMany / page 对应批量 insert 与分页 select。
 *
 * 内存阶段为了不吃爆内存，每个实例只保留最近 MAX_LOGS_PER_INSTANCE 条。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const MAX_LOGS_PER_INSTANCE = 500;

const KEYWORD_FIELDS = ['message'];

const store = createMemoryStore({ prefix: 'log-', startId: 5000 });

const list = () => store.all();

/** 查询（不分页），query = { filters, keyword, sort } */
const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:desc',
  });

/** 分页查询（实例日志页用），支持 filters.level / filters.instanceId / filters.taskId */
const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:asc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const count = () => store.size();

const create = (data) => {
  const record = {
    level: 'INFO',
    ...data,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || nowIso(),
  };
  const inserted = store.insert(record);
  prune(record.instanceId);
  return inserted;
};

/** 批量写入（对应 POST /engine/logs），返回写入后的日志数组 */
const createMany = (logs = []) => logs.map((log) => create(log));

/** 简单淘汰：超过上限的老实例日志丢弃 */
const prune = (instanceId) => {
  if (!instanceId) return;
  const existing = find({ filters: { instanceId }, sort: 'createdAt:desc' });
  if (existing.length <= MAX_LOGS_PER_INSTANCE) return;
  existing.slice(MAX_LOGS_PER_INSTANCE).forEach((log) => store.remove(log.id));
};

const findByInstance = (instanceId) => find({ filters: { instanceId }, sort: 'createdAt:asc' });

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

const deleteById = (id) => store.remove(id) || null;

const deleteByInstance = (instanceId) => store.removeWhere((item) => item.instanceId === instanceId);

module.exports = {
  find,
  page,
  getById,
  create,
  createMany,
  update,
  delete: deleteById,
  count,
  findByInstance,
  deleteByInstance,
  clear: store.clear,
};
