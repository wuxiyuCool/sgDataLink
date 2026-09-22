/**
 * 运行日志仓储（MySQL 实现，契约 1.3 / 1.4）。
 *
 * 与内存版同名同返回结构（返回 Promise）；
 * createMany 对应引擎 POST /engine/logs，改成单条多值 INSERT（id 仍逐条取号，保持序列语义）；
 * 内存版「每实例只留最近 MAX_LOGS_PER_INSTANCE 条」的淘汰规则在 SQL 版按同样口径实现
 * （排序 created_at DESC, seq DESC 取第 500 条之后的行删掉）。
 */
const { defineStore, MAX_LOGS_PER_INSTANCE } = require('./sqlStore');
const db = require('../../db/mysql');
const { nowIso } = require('../memoryStore');

const TABLE = 'databridge_run_log';
const KEYWORD_FIELDS = ['message'];

/** 单次淘汰最多删掉的行数（一次引擎回报的日志远小于该值，超出下轮继续淘汰） */
const PRUNE_BATCH = 5000;

const store = defineStore({
  table: TABLE,
  idPrefix: 'log-',
  startId: 5000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:desc',
  columns: {
    id: {},
    instanceId: {},
    taskId: {},
    level: {},
    message: { type: 'text' },
    createdAt: { type: 'datetime' },
  },
});

const find = (query = {}) =>
  store.find({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'createdAt:desc',
  });

const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'createdAt:asc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const count = () => store.count();

/** 超过上限的老实例日志丢弃（内存版 prune 的 SQL 版） */
const prune = async (instanceId) => {
  if (!instanceId) return;
  const stale = await db.query(
    `SELECT \`id\` FROM ${TABLE} WHERE \`instance_id\` = ?
       ORDER BY \`created_at\` DESC, \`seq\` DESC
      LIMIT ${MAX_LOGS_PER_INSTANCE}, ${PRUNE_BATCH}`,
    [instanceId]
  );
  if (!stale.length) return;
  const placeholders = stale.map(() => '?').join(', ');
  await db.run(
    `DELETE FROM ${TABLE} WHERE \`id\` IN (${placeholders})`,
    stale.map((row) => row.id)
  );
};

const create = async (data) => {
  const record = {
    level: 'INFO',
    ...data,
    id: data.id || (await store.nextId()),
    createdAt: data.createdAt || nowIso(),
  };
  const inserted = await store.insert(record);
  await prune(record.instanceId);
  return inserted;
};

/** 批量写入（对应 POST /engine/logs），返回写入后的日志数组 */
const createMany = async (logs = []) => {
  if (!logs.length) return [];
  const records = [];
  // 逐条取号是有意的：保证 id 与内存版一样随入参顺序递增
  for (const log of logs) {
    // eslint-disable-next-line no-await-in-loop
    records.push({
      level: 'INFO',
      ...log,
      id: log.id || (await store.nextId()),
      createdAt: log.createdAt || nowIso(),
    });
  }
  const created = await store.insertMany(records);
  const instanceIds = [...new Set(records.map((record) => record.instanceId).filter(Boolean))];
  await Promise.all(instanceIds.map(prune));
  return created;
};

const findByInstance = (instanceId) => find({ filters: { instanceId }, sort: 'createdAt:asc' });

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

const deleteById = async (id) => (await store.deleteById(id)) || null;

const deleteByInstance = (instanceId) => store.deleteByWhere('`instance_id` = ?', [instanceId]);

module.exports = {
  MAX_LOGS_PER_INSTANCE,
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
  clear: () => store.clear(),
};
