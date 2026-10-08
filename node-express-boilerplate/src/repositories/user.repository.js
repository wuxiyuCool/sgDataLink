/**
 * 平台用户仓储（内存实现，docs/API.md 第 1.11 节）。
 *
 * passwordHash 只在仓储内流转，任何出参方法都不带它出去由 service 的 toSafeUser 收口；
 * username 唯一性这里做线性查重（用户量级小），mysql 版靠唯一索引兜底。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['username', 'nickname'];

const store = createMemoryStore({ prefix: 'usr-', startId: 9700 });

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:asc',
  });

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

/** 按用户名精确查（登录入口；大小写不敏感，与 mysql 排序规则同口径） */
const getByUsername = (username) =>
  list().find((item) => String(item.username).toLowerCase() === String(username || '').toLowerCase()) || null;

/** 按 docKey 精确查（契约 1.9.5）；空 key 直接未命中 */
const getByDocKey = (docKey) => (docKey ? list().find((item) => item.docKey === String(docKey)) || null : null);

/** 按 chatKey 精确查（契约 1.12 问数对外服务）；空 key 直接未命中 */
const getByChatKey = (chatKey) => (chatKey ? list().find((item) => item.chatKey === String(chatKey)) || null : null);

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    role: 'user',
    status: 'active',
    mustChangePassword: false,
    ...data,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.createdAt || timestamp,
  };
  return store.insert(record);
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

const remove = (id) => store.remove(id) || null;

module.exports = require('./facade').pickImpl('user', {
  list,
  find,
  page,
  getById,
  getByUsername,
  getByDocKey,
  getByChatKey,
  count,
  create,
  update,
  remove,
});
