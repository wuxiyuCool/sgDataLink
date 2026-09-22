/**
 * 告警记录仓储（内存实现，docs/API.md 第 1.10 节）。
 *
 * 一条记录 = 「某规则 + 某个通知通道」的一次投递；Mock 阶段不发真实 webhook，
 * channelResult 固定 'mock-sent'，第二阶段换成真实投递结果（成功文案 / HTTP 码）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现（alert_record 表，read 用 is_read 列 + created_at 索引）时只改本文件；
 * markRead 对应 `update ... set is_read = true where id = ?`。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['ruleName', 'targetName', 'message'];

const store = createMemoryStore({ prefix: 'rec-', startId: 9500 });

const list = () => store.all();

/** 查询（不分页），query = { filters, keyword, sort } */
const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:desc',
  });

/** 分页查询（告警中心列表页），支持 filters.level / filters.read / filters.targetType */
const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:desc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const count = () => store.size();

/** 未读告警记录数（告警中心角标用；module.exports 一直引用了它但实现漏了） */
const countUnread = () => list().filter((record) => !record.read).length;

const create = (data) => {
  const record = {
    level: 'ERROR',
    channelResult: 'mock-sent',
    read: false,
    ...data,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || nowIso(),
  };
  return store.insert(record);
};

const createMany = (records = []) => records.map((record) => create(record));

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

/** PATCH /alert-records/:id/read —— 标记已读，返回更新后的记录（不存在返回 null） */
const markRead = (id) => update(id, { read: true });

const deleteById = (id) => store.remove(id) || null;

/** 内存实现（DB_DRIVER=memory 时生效）；mysql 实现见 ./mysql/alertrecord.store.js */
const memoryImpl = {
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
  clear: store.clear,
};

// 双驱动门面：DB_DRIVER=mysql 时换成同名异步实现，方法签名统一返回 Promise
module.exports = require('./facade').pickImpl('alertrecord', memoryImpl);
