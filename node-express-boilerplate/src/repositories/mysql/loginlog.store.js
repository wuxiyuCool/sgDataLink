/**
 * 登录日志仓储（MySQL 实现，契约 1.11 登录审计）。
 *
 * 与内存版 loginlog.repository.js 逐方法同名（add / page / clear）：
 * add 逐条 INSERT（id 用 llg- + UUID，不做对外寻址、不占 databridge_id_seq），
 * 每 PRUNE_EVERY 次插入把行数压回 MAX_LOGIN_LOGS；page 条件全部参数化。
 */
const { randomUUID } = require('crypto');
const { defineStore, normalizePaging, escapeLike, toDbDateTime } = require('./sqlStore');
const db = require('../../db/mysql');
const { nowIso } = require('../memoryStore');

const LOGIN_LOG_TABLE = 'databridge_login_log';

/** 滚动上限（与内存版 MAX_LOGIN_LOGS 同值） */
const MAX_LOGIN_LOGS = 10000;

/** 插入多少次后淘汰一次（登录低频，逐条 DELETE 没必要） */
const PRUNE_EVERY = 50;

const clamp = (value, max) => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
};

const store = defineStore({
  table: LOGIN_LOG_TABLE,
  idPrefix: 'llg-',
  startId: 0,
  keywordFields: ['username', 'ip'],
  defaultSort: 'createdAt:desc',
  columns: {
    id: {},
    userId: {},
    username: {},
    ip: {},
    ok: { type: 'bool' },
    errorMsg: { type: 'text' },
    createdAt: { type: 'datetime' },
  },
});

/** 淘汰超出上限的最旧行（seq 单调递增即插入序；低频，两步删即可） */
const prune = async () => {
  const rows = await db.query(
    `SELECT \`seq\` AS edge FROM ${LOGIN_LOG_TABLE} ORDER BY \`seq\` DESC LIMIT 1 OFFSET ${MAX_LOGIN_LOGS - 1}`
  );
  if (!rows.length) return;
  await db.run(`DELETE FROM ${LOGIN_LOG_TABLE} WHERE \`seq\` < ?`, [rows[0].edge]);
};

let insertCount = 0;

const add = async (record = {}) => {
  const log = {
    id: record.id || `llg-${randomUUID()}`,
    userId: clamp(record.userId, 64),
    username: clamp(record.username, 64),
    ip: clamp(record.ip, 64),
    ok: Boolean(record.ok),
    errorMsg: clamp(record.errorMsg, 255),
    createdAt: record.createdAt || nowIso(),
  };
  const inserted = await store.insert(log);
  insertCount += 1;
  if (insertCount % PRUNE_EVERY === 0) await prune();
  return inserted;
};

/**
 * 分页查询（createdAt 倒序）：keyword 命中 username/ip，
 * result=success|error，startTime|endTime 闭区间（UTC 口径同内存版）。
 * @param {Object} query { page, size, keyword, result, startTime, endTime }
 */
const page = async (query = {}) => {
  const { page, size, offset } = normalizePaging(query);
  const where = [];
  const params = [];
  if (query.result === 'success') where.push('`ok` = 1');
  else if (query.result === 'error') where.push('`ok` = 0');
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
    db.query(
      `SELECT * FROM ${LOGIN_LOG_TABLE} ${whereSql} ORDER BY seq DESC LIMIT ${size} OFFSET ${offset}`,
      params
    ),
    db.query(`SELECT COUNT(*) AS total FROM ${LOGIN_LOG_TABLE} ${whereSql}`, params),
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
  await db.run(`DELETE FROM ${LOGIN_LOG_TABLE}`);
  return true;
};

module.exports = { MAX_LOGIN_LOGS, add, page, clear };
