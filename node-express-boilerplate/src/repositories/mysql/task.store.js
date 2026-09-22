/**
 * 同步任务仓储（MySQL 实现，契约 1.2）。
 *
 * 与内存版同名同返回结构（返回 Promise）；fieldMappings 用 JSON 列，
 * findByDataSource 换成 `source_id = ? OR target_id = ?`（内存版是 list().filter）。
 * 注意内存版没有导出 list，这里也刻意不导出，
 * 以免 run.service 的 listSchedulableRecords 在两种驱动下走不同排序路径。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name', 'sourceTable', 'targetTable'];

const store = defineStore({
  table: 'databridge_sync_task',
  idPrefix: 'task-',
  startId: 2000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    syncMode: {},
    sourceId: {},
    sourceTable: {},
    targetId: {},
    targetTable: {},
    writeMode: {},
    batchSize: { type: 'int' },
    incrementalColumn: {},
    fieldMappings: { type: 'json' },
    scheduleCron: {},
    retryCount: { type: 'int' },
    retryIntervalSec: { type: 'int' },
    totalRows: { type: 'int' },
    failureRate: { type: 'num' },
    enabled: { type: 'bool' },
    lastStatus: {},
    lastRunAt: { type: 'datetime' },
    remark: { type: 'text' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

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

/** 数据源被哪些任务引用（sourceId / targetId），供删除时的 40002 校验 */
const findByDataSource = (dataSourceId) => store.rows('(source_id = ? OR target_id = ?)', [dataSourceId, dataSourceId]);

/** 以某状态运行的任务，用于 start/stop 的幂等判断 */
const findRunning = () => find({ filters: { lastStatus: 'running' } });

const create = async (data) => {
  const timestamp = nowIso();
  const record = {
    syncMode: 'full',
    writeMode: 'insert',
    batchSize: 1000,
    incrementalColumn: null,
    fieldMappings: [],
    enabled: true,
    lastStatus: 'idle',
    lastRunAt: null,
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
