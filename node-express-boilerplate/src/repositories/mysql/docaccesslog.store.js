/**
 * 文档中心访问日志仓储（MySQL 实现，契约 1.9.5）。
 *
 * 与内存版 docaccesslog.repository.js 同名方法（add / page / clear）：
 * add 逐条 INSERT（id=dal-+UUID，不占 databridge_id_seq），每 PRUNE_EVERY 次
 * 把行数压回 MAX_DOC_LOGS；page 条件全参数化（keyword 命中 username/ip）。
 */
const { randomUUID } = require('crypto');
const { defineStore, normalizePaging, escapeLike, toDbDateTime } = require('./sqlStore');
const db = require('../../db/mysql');
const { nowIso } = require('../memoryStore');

const LOG_TABLE = 'databridge_doc_access_log';

const MAX_DOC_LOGS = 10000;

const PRUNE_EVERY = 50;

const clamp = (value, max) => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
};

const toIntOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
};

const store = defineStore({
  table: LOG_TABLE,
  idPrefix: 'dal-',
  startId: 0,
  keywordFields: ['username', 'ip'],
  defaultSort: 'createdAt:desc',
  columns: {
    id: {},
    userId: {},
    username: {},
    authType: {},
    keyMasked: {},
    ip: {},
    ok: { type: 'bool' },
    httpStatus: { type: 'int' },
    bizCode: { type: 'int' },
    keyword: { type: 'text' },
    userAgent: { type: 'text' },
    errorMsg: { type: 'text' },
    createdAt: { type: 'datetime' },
  },
});

const prune = async () => {
  const rows = await db.query(
    `SELECT \`seq\` AS edge FROM ${LOG_TABLE} ORDER BY \`seq\` DESC LIMIT 1 OFFSET ${MAX_DOC_LOGS - 1}`
  );
  if (!rows.length) return;
  await db.run(`DELETE FROM ${LOG_TABLE} WHERE \`seq\` < ?`, [rows[0].edge]);
};

let insertCount = 0;

const add = async (record = {}) => {
  const log = {
    id: record.id || `dal-${randomUUID()}`,
    userId: clamp(record.userId, 64),
    username: clamp(record.username, 64),
    authType: clamp(record.authType, 8),
    keyMasked: clamp(record.keyMasked, 32),
    ip: clamp(record.ip, 64),
    ok: Boolean(record.ok),
    httpStatus: toIntOrNull(record.httpStatus),
    bizCode: toIntOrNull(record.bizCode),
    keyword: clamp(record.keyword, 64),
    userAgent: clamp(record.userAgent, 255),
    errorMsg: clamp(record.errorMsg, 255),
    createdAt: record.createdAt || nowIso(),
  };
  const inserted = await store.insert(log);
  insertCount += 1;
  if (insertCount % PRUNE_EVERY === 0) await prune();
  return inserted;
};

const page = async (query = {}) => {
  const { page, size, offset } = normalizePaging(query);
  const where = [];
  const params = [];
  if (query.result === 'success') where.push('`ok` = 1');
  else if (query.result === 'error') where.push('`ok` = 0');
  if (query.authType === 'jwt' || query.authType === 'docKey') {
    where.push('auth_type = ?');
    params.push(query.authType);
  }
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(username LIKE ? OR ip LIKE ?)');
    params.push(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`);
  }
  const start = toDbDateTime(query.startTime);
  const end = toDbDateTime(query.endTime);
  if (start) {
    where.push('created_at >= ?');
    params.push(start);
  }
  if (end) {
    where.push('created_at <= ?');
    params.push(end);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, countRows] = await Promise.all([
    db.query(`SELECT * FROM ${LOG_TABLE} ${whereSql} ORDER BY seq DESC LIMIT ${size} OFFSET ${offset}`, params),
    db.query(`SELECT COUNT(*) AS total FROM ${LOG_TABLE} ${whereSql}`, params),
  ]);
  const total = Number(countRows[0] && countRows[0].total) || 0;
  return {
    items: rows.map((row) => store.fromRow(row)),
    total,
    page,
    size,
    pages: Math.ceil(total / size),
  };
};

const clear = async () => {
  await db.run(`DELETE FROM ${LOG_TABLE}`);
  return true;
};

module.exports = { MAX_DOC_LOGS, add, page, clear };
