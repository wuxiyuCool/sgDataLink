/**
 * 告警规则仓储（MySQL 实现，契约 1.10）。
 *
 * 与内存版同名同返回结构（返回 Promise）；conditions / channels 用 JSON 列。
 * 注意内存版 create 的 updatedAt 取的是 data.createdAt（原文如此，非笔误），
 * 这里保持完全一致，避免两种驱动下列表页的「更新时间」表现不同。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name'];

const store = defineStore({
  table: 'databridge_alert_rule',
  idPrefix: 'ar-',
  startId: 9000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    scope: {},
    conditions: { type: 'json' },
    thresholdLagMs: { type: 'int' },
    channels: { type: 'json' },
    enabled: { type: 'bool' },
    remark: { type: 'text' },
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

const count = () => store.count();

/** 启用中的规则，触发告警时遍历 */
const findEnabled = () => find({ filters: { enabled: true } });

const create = async (data) => {
  const timestamp = nowIso();
  const record = {
    scope: 'all',
    conditions: [],
    thresholdLagMs: 5000,
    channels: [],
    enabled: true,
    ...data,
    id: data.id || (await store.nextId()),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.createdAt || timestamp,
  };
  return store.insert(record);
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

const deleteById = async (id) => (await store.deleteById(id)) || null;

module.exports = {
  list,
  find,
  page,
  getById,
  create,
  update,
  delete: deleteById,
  count,
  findEnabled,
  clear: () => store.clear(),
};
