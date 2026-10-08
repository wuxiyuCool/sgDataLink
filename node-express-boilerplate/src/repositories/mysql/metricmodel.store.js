/**
 * 数据模型仓储（MySQL 实现，契约 1.12）。
 * 主表走 defineStore；columns 落独立表 databridge_metric_model_column（无 id 列，
 * bespoke 读写）：详情 getById 合并 columns，list/page 一律剥掉 columns，与内存版对齐。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');
const db = require('../../db/mysql');

const COL_TABLE = 'databridge_metric_model_column';
const KEYWORD_FIELDS = ['name', 'tableName'];

const store = defineStore({
  table: 'databridge_metric_model',
  idPrefix: 'mdl-',
  startId: 12000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    datasourceId: {},
    domainId: {},
    layer: {},
    tableName: {},
    createType: {},
    tableDdl: { type: 'text' },
    timeColumn: {},
    status: {},
    version: { type: 'int' },
    delFlag: { type: 'bool' },
    remark: { type: 'text' },
    createBy: {},
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

const COL_MAP = {
  columnName: 'column_name',
  bizName: 'biz_name',
  dataType: 'data_type',
  role: 'role',
  aggDefault: 'agg_default',
  isKey: 'is_key',
  unit: 'unit',
  remark: 'remark',
};

const readColumns = async (modelId) => {
  const rows = await db.query(
    `SELECT ${Object.values(COL_MAP).join(', ')} FROM \`${COL_TABLE}\` WHERE model_id = ? ORDER BY seq ASC`,
    [String(modelId)]
  );
  return rows.map((row) => ({
    columnName: row.column_name,
    bizName: row.biz_name || '',
    dataType: row.data_type,
    role: row.role,
    aggDefault: row.agg_default || '',
    isKey: Boolean(row.is_key),
    unit: row.unit || '',
    remark: row.remark || '',
  }));
};

const writeColumns = async (modelId, columns = []) => {
  await db.run(`DELETE FROM \`${COL_TABLE}\` WHERE model_id = ?`, [String(modelId)]);
  if (!columns.length) return;
  const names = Object.keys(COL_MAP);
  const placeholders = columns.map(() => `(?${names.map(() => ', ?').join('')})`).join(', ');
  const args = columns.reduce(
    (acc, column) =>
      acc.concat([
        String(modelId),
        ...names.map((key) => {
          if (key === 'isKey') return column.isKey ? 1 : 0;
          const value = column[key];
          return value === undefined || value === null ? '' : String(value);
        }),
      ]),
    []
  );
  await db.run(
    `INSERT INTO \`${COL_TABLE}\` (model_id, ${names
      .map((key) => `\`${COL_MAP[key]}\``)
      .join(', ')}) VALUES ${placeholders}`,
    args
  );
};

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

const getById = async (id) => {
  const record = await store.getById(id);
  if (!record) return null;
  return { ...record, columns: await readColumns(record.id) };
};

const create = async (data) => {
  const timestamp = nowIso();
  const { columns = [], ...rest } = data;
  const record = {
    createType: 'reference',
    layer: 'DWD',
    status: 'online',
    version: 1,
    timeColumn: '',
    tableDdl: null,
    delFlag: false,
    remark: '',
    createBy: '',
    ...rest,
    id: data.id || (await store.nextId()),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.updatedAt || timestamp,
  };
  const inserted = await store.insert(record);
  await writeColumns(inserted.id, columns);
  return { ...inserted, columns };
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  const { columns, ...rest } = patch;
  const merged = await store.replace(id, { ...existing, ...rest, id, updatedAt: nowIso() });
  if (Array.isArray(columns)) await writeColumns(id, columns);
  return merged;
};

const replaceColumns = async (id, columns = []) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  await writeColumns(id, columns);
  await store.replace(id, { ...existing, updatedAt: nowIso() });
  return { ...existing, columns };
};

const deleteById = async (id) => {
  const removed = await store.deleteById(id);
  if (!removed) return null;
  await db.run(`DELETE FROM \`${COL_TABLE}\` WHERE model_id = ?`, [String(id)]);
  return removed;
};

const count = () => store.count();

module.exports = {
  list,
  find,
  page,
  getById,
  create,
  update,
  replaceColumns,
  delete: deleteById,
  count,
  clear: async () => {
    await db.run(`DELETE FROM \`${COL_TABLE}\``);
    return store.clear();
  },
};
