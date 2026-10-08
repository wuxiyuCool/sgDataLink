/**
 * 清洗汇总任务仓储（MySQL 实现，契约 1.12 §7.2）。与内存版同名同返回结构。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const store = defineStore({
  table: 'databridge_metric_task',
  idPrefix: 'mtk-',
  startId: 14000,
  keywordFields: ['name'],
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    domainId: { col: 'domain_id' },
    sourceModelId: { col: 'source_model_id' },
    metricIds: { type: 'json', col: 'metric_ids' },
    dimensionColumnIds: { type: 'json', col: 'dimension_column_ids' },
    cleanRules: { type: 'json', col: 'clean_rules' },
    timePreset: { type: 'json', col: 'time_preset' },
    targetDatasourceId: { col: 'target_datasource_id' },
    targetModelId: { col: 'target_model_id' },
    targetTable: { col: 'target_table' },
    writeMode: { col: 'write_mode' },
    upsertKeys: { type: 'json', col: 'upsert_keys' },
    scheduleCron: { col: 'schedule_cron' },
    status: {},
    lastRunAt: { type: 'datetime', col: 'last_run_at' },
    lastStatus: { col: 'last_status' },
    delFlag: { type: 'bool', col: 'del_flag' },
    remark: { type: 'text' },
    createBy: { col: 'create_by' },
    createdAt: { type: 'datetime', col: 'created_at' },
    updatedAt: { type: 'datetime', col: 'updated_at' },
  },
});

const list = () => store.list();

const find = (query = {}) =>
  store.find({ filters: query.filters || {}, keyword: query.keyword, sort: query.sort || 'createdAt:asc' });

const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const create = async (data) => {
  const timestamp = nowIso();
  const record = {
    domainId: '',
    metricIds: [],
    dimensionColumnIds: [],
    cleanRules: [],
    timePreset: null,
    targetModelId: '',
    targetTable: '',
    writeMode: 'overwrite',
    upsertKeys: [],
    scheduleCron: '',
    status: 'online',
    lastStatus: 'idle',
    lastRunAt: null,
    delFlag: false,
    remark: '',
    createBy: '',
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
