/**
 * 同步点位（offset）仓储（内存实现）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现（sync_offset 表，唯一键 task_id + instance_id + shard_key）时只改本文件；
 * upsert / findByInstance / findLatestByTask 对应 SQL 的 insert ... on conflict do update 与
 * select ... order by updated_at desc limit 1，service 层不变。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['offsetValue', 'shardKey'];

const store = createMemoryStore({ prefix: 'ofs-', startId: 6000 });

const list = () => store.all();

/** 查询（不分页），query = { filters, keyword, sort } */
const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'updatedAt:desc',
  });

/** 分页查询，返回 { items, total, page, size, pages } */
const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'updatedAt:desc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const count = () => store.size();

const findByInstance = (instanceId) => find({ filters: { instanceId } });

const findByTask = (taskId) => find({ filters: { taskId } });

/** 某任务最新点位（任务无实例时用作 progress 的回退点位来源） */
const findLatestByTask = (taskId) => findByTask(taskId)[0] || null;

/** 某实例最新点位 */
const findLatestByInstance = (instanceId) => findByInstance(instanceId)[0] || null;

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    shardKey: 'default',
    ...data,
    id: data.id || store.nextId(),
    updatedAt: data.updatedAt || timestamp,
  };
  return store.insert(record);
};

/**
 * 按 (taskId, instanceId, shardKey) 覆盖写入点位；引擎每 tick 回报会频繁调用。
 * @returns {Object} 写入后的点位
 */
const upsert = ({ taskId, instanceId, shardKey = 'default', offsetValue }) => {
  if (offsetValue === undefined || offsetValue === null || offsetValue === '') return null;
  const existing = list().find(
    (item) => item.taskId === taskId && item.instanceId === instanceId && item.shardKey === shardKey
  );
  if (existing) return update(existing.id, { offsetValue });
  return create({ taskId, instanceId, shardKey, offsetValue });
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

const deleteById = (id) => store.remove(id) || null;

/** 删除某实例的所有点位（实例被清理时配套使用） */
const deleteByInstance = (instanceId) => store.removeWhere((item) => item.instanceId === instanceId);

module.exports = {
  find,
  page,
  getById,
  create,
  update,
  delete: deleteById,
  count,
  findByInstance,
  findByTask,
  findLatestByTask,
  findLatestByInstance,
  upsert,
  deleteByInstance,
  clear: store.clear,
};
