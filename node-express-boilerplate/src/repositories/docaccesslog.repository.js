/**
 * 文档中心访问日志仓储（内存实现，契约 1.9.5）。
 *
 * 只追加：每次 GET /data-apis/swagger.json（JWT 或 docKey，成败都记）。
 * keyMasked 只存掩码，完整 key/JWT 绝不入参；滚动保留最近 MAX_DOC_LOGS 条。
 */
const { randomUUID } = require('crypto');
const { createMemoryStore, queryList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['username', 'ip'];

const MAX_DOC_LOGS = 10000;

const store = createMemoryStore({ prefix: 'dal-', startId: 0 });

const add = (record = {}) => {
  const log = {
    id: record.id || `dal-${randomUUID()}`,
    userId: record.userId || null,
    username: record.username ? String(record.username).slice(0, 64) : null,
    authType: record.authType || null,
    keyMasked: record.keyMasked ? String(record.keyMasked).slice(0, 32) : null,
    ip: record.ip ? String(record.ip).slice(0, 64) : null,
    ok: Boolean(record.ok),
    httpStatus: record.httpStatus ?? null,
    bizCode: record.bizCode ?? null,
    keyword: record.keyword ? String(record.keyword).slice(0, 64) : null,
    userAgent: record.userAgent ? String(record.userAgent).slice(0, 255) : null,
    errorMsg: record.errorMsg ? String(record.errorMsg).slice(0, 255) : null,
    createdAt: record.createdAt || nowIso(),
  };
  const inserted = store.insert(log);
  const total = store.size();
  if (total > MAX_DOC_LOGS) {
    store
      .all()
      .slice(0, total - MAX_DOC_LOGS)
      .forEach((item) => store.remove(item.id));
  }
  return inserted;
};

/**
 * 分页查询（createdAt 倒序）：keyword 命中 username/ip，
 * result=success|error，authType=jwt|docKey，startTime|endTime 闭区间。
 */
const page = (query = {}) => {
  const filters = {};
  if (query.result === 'success') filters.ok = true;
  else if (query.result === 'error') filters.ok = false;
  if (query.authType) filters.authType = String(query.authType);
  const times = [];
  if (query.startTime) times.push((v) => Date.parse(v) >= Date.parse(query.startTime));
  if (query.endTime) times.push((v) => Date.parse(v) <= Date.parse(query.endTime));
  if (times.length) filters.createdAt = (value) => times.every((fn) => fn(value));
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

module.exports = require('./facade').pickImpl('docaccesslog', { add, page, clear });
