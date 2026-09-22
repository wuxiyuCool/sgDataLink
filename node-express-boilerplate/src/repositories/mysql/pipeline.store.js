/**
 * 数据管道（CDC）仓储（MySQL 实现，契约 1.7）。
 *
 * 与内存版同名同返回结构（返回 Promise）；syncObjects 用 JSON 列。
 * changeRows / currentQps / lagMs / cdcPosition / lastReportAt 是「运行态」列，
 * 由 Go 引擎每次 tick 的 /engine/report（带 pipelineId）刷进同一行，
 * GET /pipelines/:id/status 直接读它们。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name', 'sourceId', 'targetId'];

const store = defineStore({
  table: 'databridge_pipeline',
  idPrefix: 'pipe-',
  startId: 7000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    sourceId: {},
    targetId: {},
    syncObjects: { type: 'json' },
    ddlPolicy: {},
    status: {},
    runningInstanceId: {},
    lastError: { type: 'text' },
    batchSize: { type: 'int' },
    failureRate: { type: 'num' },
    changeRows: { type: 'int' },
    currentQps: { type: 'int' },
    lagMs: { type: 'int' },
    cdcPosition: {},
    startedAt: { type: 'datetime' },
    lastReportAt: { type: 'datetime' },
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

/** 是否引用了某个数据源（源端或目标端），供数据源删除的 40002 校验复用 */
const findByDataSource = (dataSourceId) => store.rows('(source_id = ? OR target_id = ?)', [dataSourceId, dataSourceId]);

const findRunning = () => find({ filters: { status: 'running' } });

const create = async (data) => {
  const timestamp = nowIso();
  const record = {
    ddlPolicy: 'ignore',
    status: 'stopped',
    runningInstanceId: null,
    lastError: null,
    syncObjects: [],
    batchSize: 1000,
    failureRate: 0,
    // ---- 运行态（引擎回报刷新）----
    changeRows: 0,
    currentQps: 0,
    lagMs: 0,
    cdcPosition: null,
    startedAt: null,
    lastReportAt: null,
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
  findRunning,
  clear: () => store.clear(),
};
