/**
 * 指标版本快照仓储（内存实现，契约 1.12）。保存即写一条，metric_id+version 唯一。
 */
const { createMemoryStore, filterList, nowIso } = require('./memoryStore');

const store = createMemoryStore({ prefix: 'mver-', startId: 13900 });

const list = () => store.all();

const findByMetric = (metricId, query = {}) =>
  filterList(list(), {
    filters: { metricId },
    keyword: query.keyword,
    keywordFields: ['changeNote'],
    sort: query.sort || 'version:desc',
  });

const getByVersion = async (metricId, version) =>
  list().find((item) => item.metricId === metricId && Number(item.version) === Number(version)) || null;

const create = (data) => {
  const record = {
    changeNote: '',
    createBy: '',
    ...data,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || nowIso(),
  };
  return store.insert(record);
};

const memoryImpl = { list, findByMetric, getByVersion, create, clear: store.clear };

module.exports = require('./facade').pickImpl('metricversion', memoryImpl);
