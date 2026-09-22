/**
 * 告警记录仓储（MySQL 实现，契约 1.10）。
 *
 * 与内存版同名同返回结构（返回 Promise）。
 * `read` 是 MySQL 关键字，列名用 is_read，JS 侧键名仍是 read（门面语义 1:1）；
 * countUnread 与内存版一样把 NULL 视作未读；markRead 对应
 * `update ... set is_read = 1 where id = ?`（复用通用 update，返回更新后的记录）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['ruleName', 'targetName', 'message'];

const store = defineStore({
  table: 'databridge_alert_record',
  idPrefix: 'rec-',
  startId: 9500,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:desc',
  columns: {
    id: {},
    ruleId: {},
    ruleName: {},
    level: {},
    targetType: {},
    targetId: {},
    targetName: {},
    message: { type: 'text' },
    channel: {},
    channelResult: {},
    read: { col: 'is_read', type: 'bool' },
    createdAt: { type: 'datetime' },
  },
});

const list = () => store.list();

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
    sort: query.sort || 'createdAt:desc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const count = () => store.count();

/** 未读告警记录数（告警中心角标）：read 为 NULL 或 0 都算未读，与内存版 !record.read 同口径 */
const countUnread = () => store.countWhere('(`is_read` IS NULL OR `is_read` = 0)');

const create = async (data) => {
  const record = {
    level: 'ERROR',
    channelResult: 'mock-sent',
    read: false,
    ...data,
    id: data.id || (await store.nextId()),
    createdAt: data.createdAt || nowIso(),
  };
  return store.insert(record);
};

const createMany = async (records = []) => {
  if (!records.length) return [];
  const created = [];
  // 逐条取号是有意的：id 递增顺序与入参顺序一致（内存版 createMany 同语义）
  for (const record of records) {
    // eslint-disable-next-line no-await-in-loop
    created.push({
      level: 'ERROR',
      channelResult: 'mock-sent',
      read: false,
      ...record,
      id: record.id || (await store.nextId()),
      createdAt: record.createdAt || nowIso(),
    });
  }
  return store.insertMany(created);
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

/** PATCH /alert-records/:id/read —— 标记已读，返回更新后的记录（不存在返回 null） */
const markRead = (id) => update(id, { read: true });

const deleteById = async (id) => (await store.deleteById(id)) || null;

module.exports = {
  list,
  find,
  page,
  getById,
  create,
  createMany,
  update,
  markRead,
  delete: deleteById,
  count,
  countUnread,
  clear: () => store.clear(),
};
