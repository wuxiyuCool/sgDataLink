/**
 * 平台用户仓储（MySQL 实现，契约 1.11）。
 *
 * username 唯一由 uk_user_username 索引兜底；getByUsername 走大小写不敏感比较
 * （列排序规则 utf8mb4_unicode_ci 本身 CI，无需 LOWER()）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['username', 'nickname'];

const store = defineStore({
  table: 'databridge_user',
  idPrefix: 'usr-',
  startId: 9700,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    username: {},
    passwordHash: { type: 'text' },
    nickname: {},
    role: {},
    status: {},
    mustChangePassword: { type: 'bool' },
    /** 1.9.5 文档中心免登录访问：权限位 + 个人 docKey（明文列，仅回本人） */
    docAccess: { type: 'bool' },
    docKey: {},
    docKeyUpdatedAt: { type: 'datetime' },
    chatAccess: { type: 'bool' },
    chatKey: {},
    chatKeyUpdatedAt: { type: 'datetime' },
    lastLoginAt: { type: 'datetime' },
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

const count = (filters = {}) => store.count(filters);

const getByUsername = async (username) => {
  const rows = await store.find({ filters: { username } });
  return rows.length ? rows[0] : null;
};

/** 按 docKey 精确查（契约 1.9.5 免登录取文档）；空 key 直接未命中，绝不退化成全表 */
const getByDocKey = async (docKey) => {
  if (!docKey) return null;
  const rows = await store.find({ filters: { docKey: String(docKey) } });
  return rows.length ? rows[0] : null;
};

/** 按 chatKey 精确查（契约 1.12 问数对外）；空 key 直接未命中，绝不退化成全表 */
const getByChatKey = async (chatKey) => {
  if (!chatKey) return null;
  const rows = await store.find({ filters: { chatKey: String(chatKey) } });
  return rows.length ? rows[0] : null;
};

const create = (data) => {
  const timestamp = nowIso();
  return store.insert({
    role: 'user',
    status: 'active',
    mustChangePassword: false,
    ...data,
    id: data.id || undefined,
    createdAt: data.createdAt || timestamp,
    updatedAt: data.createdAt || timestamp,
  });
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

const remove = (id) => store.deleteById(id);

module.exports = { list, find, page, getById, getByUsername, getByDocKey, getByChatKey, count, create, update, remove };
