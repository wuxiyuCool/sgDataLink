/**
 * 同步点位（offset）仓储（MySQL 实现，契约 1.2 / 1.4）。
 *
 * 与内存版同名同返回结构（返回 Promise）。
 * upsert 的键是 (taskId, instanceId, shardKey)，与内存版一样用 NULL 安全的 NULL-safe 等值
 * （MySQL 的 <=>）匹配，命中则更新 offsetValue，否则插入；
 * 引擎每 tick 回报都会走这里，所以只保留必要的两条语句（SELECT + UPDATE/INSERT）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['offsetValue', 'shardKey'];

const store = defineStore({
  table: 'databridge_offset',
  idPrefix: 'ofs-',
  startId: 6000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'updatedAt:desc',
  columns: {
    id: {},
    taskId: {},
    instanceId: {},
    shardKey: {},
    offsetValue: { type: 'text' },
    updatedAt: { type: 'datetime' },
  },
});

const find = (query = {}) =>
  store.find({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'updatedAt:desc',
  });

const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'updatedAt:desc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const count = () => store.count();

const findByInstance = (instanceId) => find({ filters: { instanceId } });

const findByTask = (taskId) => find({ filters: { taskId } });

/** 某任务最新点位（任务无实例时作为 progress 的回退点位来源） */
const findLatestByTask = async (taskId) => (await findByTask(taskId))[0] || null;

/** 某实例最新点位 */
const findLatestByInstance = async (instanceId) => (await findByInstance(instanceId))[0] || null;

const create = async (data) => {
  const timestamp = nowIso();
  const record = {
    shardKey: 'default',
    ...data,
    id: data.id || (await store.nextId()),
    updatedAt: data.updatedAt || timestamp,
  };
  return store.insert(record);
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

/**
 * 按 (taskId, instanceId, shardKey) 覆盖写入点位。
 * @returns {Promise<Object|null>} 写入后的点位；offsetValue 为空时与内存版一样返回 null
 */
const upsert = async ({ taskId, instanceId, shardKey = 'default', offsetValue }) => {
  if (offsetValue === undefined || offsetValue === null || offsetValue === '') return null;
  const matches = await store.rows(
    '`task_id` <=> ? AND `instance_id` <=> ? AND `shard_key` <=> ?',
    [taskId, instanceId, shardKey],
    'ORDER BY `seq` ASC LIMIT 1'
  );
  if (matches.length) return update(matches[0].id, { offsetValue });
  return create({ taskId, instanceId, shardKey, offsetValue });
};

const deleteById = async (id) => (await store.deleteById(id)) || null;

/** 删除某实例的所有点位（实例被清理 / 引擎 start 失败回滚时配套使用） */
const deleteByInstance = (instanceId) => store.deleteByWhere('`instance_id` = ?', [instanceId]);

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
  clear: () => store.clear(),
};
