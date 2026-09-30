/**
 * 登录日志仓储（内存实现，契约 1.11 登录审计）。
 *
 * 只追加不修改：add 写一条（成功/失败都记），page 供 admin 查询页倒序分页。
 * 滚动保留最近 MAX_LOGIN_LOGS 条（与 mysql 版同口径），口令等敏感值绝不入参。
 */
const { randomUUID } = require('crypto');
const { createMemoryStore, queryList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['username', 'ip'];

/** 滚动上限（登录频次低，1 万条约够覆盖数月审计） */
const MAX_LOGIN_LOGS = 10000;

const store = createMemoryStore({ prefix: 'llg-', startId: 0 });

const add = (record = {}) => {
  const log = {
    id: record.id || `llg-${randomUUID()}`,
    userId: record.userId || null,
    username: record.username ? String(record.username).slice(0, 64) : null,
    ip: record.ip ? String(record.ip).slice(0, 64) : null,
    ok: Boolean(record.ok),
    errorMsg: record.errorMsg ? String(record.errorMsg).slice(0, 255) : null,
    createdAt: record.createdAt || nowIso(),
  };
  const inserted = store.insert(log);
  const total = store.size();
  if (total > MAX_LOGIN_LOGS) {
    // Map 保持插入序：all() 前部即最旧记录
    store
      .all()
      .slice(0, total - MAX_LOGIN_LOGS)
      .forEach((item) => store.remove(item.id));
  }
  return inserted;
};

/**
 * 分页查询（createdAt 倒序）。
 * @param {Object} query { page, size, keyword, result: 'success'|'error', startTime, endTime }
 */
const page = (query = {}) => {
  const filters = {};
  if (query.result === 'success') filters.ok = true;
  else if (query.result === 'error') filters.ok = false;
  if (query.startTime) {
    const start = Date.parse(query.startTime);
    if (Number.isFinite(start)) filters.createdAt = (value) => Date.parse(value) >= start;
  }
  if (query.endTime) {
    const end = Date.parse(query.endTime);
    if (Number.isFinite(end)) {
      const prev = filters.createdAt;
      filters.createdAt = prev
        ? (value) => prev(value) && Date.parse(value) <= end
        : (value) => Date.parse(value) <= end;
    }
  }
  return queryList(store.all(), {
    filters,
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: 'createdAt:desc',
    page: query.page,
    size: query.size,
  });
};

const clear = () => {
  store.clear();
  return true;
};

module.exports = require('./facade').pickImpl('loginlog', { add, page, clear });
