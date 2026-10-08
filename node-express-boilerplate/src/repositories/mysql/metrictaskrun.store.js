/**
 * 指标任务执行记录仓储（MySQL 实现，契约 1.12）。与内存版同名同返回结构。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const store = defineStore({
  table: 'databridge_metric_task_run',
  idPrefix: 'mtr-',
  startId: 14900,
  keywordFields: ['taskId'],
  defaultSort: 'createdAt:desc',
  columns: {
    id: {},
    taskId: { col: 'task_id' },
    trigger: {},
    status: {},
    sqlText: { type: 'text', col: 'sql_text' },
    readRows: { type: 'int', col: 'read_rows' },
    writeRows: { type: 'int', col: 'write_rows' },
    elapsedMs: { type: 'int', col: 'elapsed_ms' },
    message: { type: 'text' },
    createdAt: { type: 'datetime', col: 'created_at' },
  },
});

const list = () => store.list();

const find = (query = {}) =>
  store.find({ filters: query.filters || {}, keyword: query.keyword, sort: query.sort || 'createdAt:desc' });

const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'createdAt:desc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const create = (data) => {
  const record = {
    trigger: 'manual',
    status: 'running',
    readRows: 0,
    writeRows: 0,
    elapsedMs: 0,
    message: null,
    ...data,
    createdAt: data.createdAt || nowIso(),
  };
  return store.insert(record);
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

const deleteById = async (id) => (await store.deleteById(id)) || null;

const count = () => store.count();

module.exports = {
  list,
  find,
  page,
  getById,
  create,
  update,
  delete: deleteById,
  count,
  clear: () => store.clear(),
};
