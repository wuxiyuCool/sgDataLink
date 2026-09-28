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

module.exports = { list, find, page, getById, getByUsername, count, create, update, remove };
