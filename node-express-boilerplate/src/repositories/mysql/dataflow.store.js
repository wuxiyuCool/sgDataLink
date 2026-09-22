/**
 * 数据开发（ETL 编排画布）仓储（MySQL 实现，契约 1.8）。
 *
 * 与内存版同名同返回结构（返回 Promise）；nodes / edges 用 JSON 列。
 * findByDataSource 要钻进 nodes[].config.datasourceId，
 * 5.7 的 JSON 路径匹配在通配符 + 严格模式下可读性差且易踩坑，
 * 这里与内存版一样「全表取出后在 JS 里判断」（画布数量是十级，开销可忽略）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name'];

const store = defineStore({
  table: 'databridge_dataflow',
  idPrefix: 'df-',
  startId: 7500,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    nodes: { type: 'json' },
    edges: { type: 'json' },
    scheduleCron: {},
    retryCount: { type: 'int' },
    retryIntervalSec: { type: 'int' },
    batchSize: { type: 'int' },
    totalRows: { type: 'int' },
    failureRate: { type: 'num' },
    enabled: { type: 'bool' },
    lastStatus: {},
    lastRunAt: { type: 'datetime' },
    runningInstanceId: {},
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

/** 是否引用了某个数据源（任一 input/output 节点的 config.datasourceId），供 40002 校验 */
const findByDataSource = async (dataSourceId) => {
  const dataflows = await list();
  return dataflows.filter((dataflow) =>
    (dataflow.nodes || []).some((node) => node && node.config && node.config.datasourceId === dataSourceId)
  );
};

const create = async (data) => {
  const timestamp = nowIso();
  const record = {
    nodes: [],
    edges: [],
    scheduleCron: null,
    retryCount: 3,
    retryIntervalSec: 60,
    enabled: true,
    lastStatus: 'idle',
    lastRunAt: null,
    runningInstanceId: null,
    ...data,
    id: data.id || (await store.nextId()),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.updatedAt || timestamp,
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
  findByDataSource,
  clear: () => store.clear(),
};
