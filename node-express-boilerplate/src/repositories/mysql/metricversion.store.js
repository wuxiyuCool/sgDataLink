/**
 * 指标版本快照仓储（MySQL 实现，契约 1.12）。与内存版同名同返回结构。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const store = defineStore({
  table: 'databridge_metric_version',
  idPrefix: 'mver-',
  startId: 13900,
  keywordFields: ['changeNote'],
  defaultSort: 'version:desc',
  columns: {
    id: {},
    metricId: { col: 'metric_id' },
    version: { type: 'int' },
    snapshot: { type: 'json' },
    changeNote: { type: 'text', col: 'change_note' },
    createBy: { col: 'create_by' },
    createdAt: { type: 'datetime', col: 'created_at' },
  },
});

const list = () => store.list();

const findByMetric = (metricId, query = {}) =>
  store.find({
    filters: { metricId },
    keyword: query.keyword,
    sort: query.sort || 'version:desc',
  });

const getByVersion = async (metricId, version) => {
  const rows = await store.rows('metric_id = ? AND version = ?', [String(metricId), Number(version)]);
  return rows.length ? rows[0] : null;
};

const create = (data) => {
  const record = {
    changeNote: '',
    createBy: '',
    ...data,
    createdAt: data.createdAt || nowIso(),
  };
  return store.insert(record);
};

module.exports = {
  list,
  findByMetric,
  getByVersion,
  create,
  clear: () => store.clear(),
};
