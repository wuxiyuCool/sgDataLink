/**
 * 维度取值档案仓储（MySQL 实现，契约 1.14）。
 * defineStore 提供基础读写与取号；一列的批量落档用「先标 stale，再 ON DUPLICATE 逐行覆盖」，
 * 目的是探查永不冲掉人工登记的 label（这是这张表存在的理由）。
 */
const { defineStore, toDbDateTime } = require('./sqlStore');
const { nowIso } = require('../memoryStore');
const db = require('../../db/mysql');

const TABLE = 'databridge_metric_dimvalue';

const store = defineStore({
  table: TABLE,
  idPrefix: 'mdv-',
  startId: 19000,
  keywordFields: ['value', 'label'],
  defaultSort: 'hits:desc',
  columns: {
    id: {},
    modelId: { col: 'model_id' },
    columnName: { col: 'column_name' },
    value: {},
    label: {},
    hits: { type: 'int' },
    source: {},
    stale: { type: 'bool' },
    profiledAt: { type: 'datetime', col: 'profiled_at' },
    createdAt: { type: 'datetime', col: 'created_at' },
    updatedAt: { type: 'datetime', col: 'updated_at' },
  },
});

const quoteValue = (text) => String(text === undefined || text === null ? '' : text).slice(0, 191);

const list = () => store.list();

const find = (query = {}) =>
  store.find({ filters: query.filters || {}, keyword: query.keyword, sort: query.sort || 'hits:desc' });

const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const listByModel = (modelId) =>
  store.rows('model_id = ?', [String(modelId)], 'ORDER BY column_name ASC, hits DESC, value ASC');

/**
 * 探查回写一列：先把该列的 auto 行标 stale（库里已消失的历史值留着不删），
 * 再逐行 upsert —— ON DUPLICATE 分支**故意不碰 label**，人工登记优先于探查。
 */
const replaceColumnValues = async (modelId, columnName, values = [], profiledAt = nowIso()) => {
  const timestamp = toDbDateTime(nowIso());
  await db.run(
    `UPDATE \`${TABLE}\` SET stale = 1, updated_at = ? WHERE model_id = ? AND column_name = ? AND source = 'auto'`,
    [timestamp, String(modelId), String(columnName)]
  );
  if (!values.length) return listByModel(modelId);
  // eslint-disable-next-line no-restricted-syntax
  for (const item of values) {
    // 逐行顺序写：一列的取值最多 topN 条，取号必须串行才不重号
    // eslint-disable-next-line no-await-in-loop
    const rowId = await store.nextId();
    // eslint-disable-next-line no-await-in-loop
    await db.run(
      `INSERT INTO \`${TABLE}\`
         (id, model_id, column_name, value, label, hits, source, stale, profiled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'auto', 0, ?, ?, ?)
       ON DUPLICATE KEY UPDATE hits = VALUES(hits), stale = 0, profiled_at = VALUES(profiled_at), updated_at = VALUES(updated_at)`,
      [
        rowId,
        String(modelId),
        String(columnName),
        quoteValue(item.value),
        quoteValue(item.label || ''),
        Number(item.hits || 0),
        toDbDateTime(profiledAt),
        timestamp,
        timestamp,
      ]
    );
  }
  return listByModel(modelId);
};

/** 人工登记业务名（01=华东）：档案里没有的值直接补录为 manual */
const saveLabels = async (modelId, columnName, entries = []) => {
  const timestamp = toDbDateTime(nowIso());
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    const rowId = await store.nextId();
    // eslint-disable-next-line no-await-in-loop
    await db.run(
      `INSERT INTO \`${TABLE}\`
         (id, model_id, column_name, value, label, hits, source, stale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'manual', 0, ?, ?)
       ON DUPLICATE KEY UPDATE label = VALUES(label), updated_at = VALUES(updated_at)`,
      [
        rowId,
        String(modelId),
        String(columnName),
        quoteValue(entry.value),
        quoteValue(entry.label || ''),
        timestamp,
        timestamp,
      ]
    );
  }
  return listByModel(modelId);
};

const removeColumn = async (modelId, columnName) => {
  await db.run(`DELETE FROM \`${TABLE}\` WHERE model_id = ? AND column_name = ?`, [String(modelId), String(columnName)]);
  return true;
};

const removeModel = async (modelId) => {
  await db.run(`DELETE FROM \`${TABLE}\` WHERE model_id = ?`, [String(modelId)]);
  return true;
};

module.exports = {
  list,
  find,
  page,
  getById,
  listByModel,
  replaceColumnValues,
  saveLabels,
  removeColumn,
  removeModel,
  clear: () => store.clear(),
};
