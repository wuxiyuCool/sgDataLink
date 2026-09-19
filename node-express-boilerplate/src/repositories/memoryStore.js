/**
 * 通用内存 store —— DataBridge Mock 阶段唯一持久化手段（Map + 自增 ID）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 本文件与同目录下的 *.repository.js 一起构成 Repository 接口的「内存实现」。
 * 接入 PostgreSQL（knex/pg）时，只需把各 repository 内部实现换成 SQL 查询，
 * 保持 find / page / getById / create / update / delete 的函数签名不变，
 * service 与 controller 层无需任何改动。
 *
 * 依赖：无（纯 JS，不依赖 mongoose / pg / node_modules 之外的东西）。
 */

/** 深拷贝，避免调用方拿到 store 内部引用后误改内存数据 */
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** ISO 8601（UTC）时间字符串，契约要求时间统一该格式 */
const nowIso = () => new Date().toISOString();

/** 取字段值，支持 'a.b' 形式 */
const getField = (record, field) =>
  String(field)
    .split('.')
    .reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), record);

/** 单个过滤条件比较：数组=in，函数=predicate，字符串=忽略大小写相等，其它=严格相等 */
const matchOne = (record, key, expected) => {
  const actual = getField(record, key);
  if (Array.isArray(expected)) return expected.some((item) => matchOne(record, key, item));
  if (typeof expected === 'function') return Boolean(expected(actual, record));
  if (expected === null) return actual === null || actual === undefined;
  if (typeof expected === 'string' && typeof actual === 'string') return actual.toLowerCase() === expected.toLowerCase();
  return actual === expected;
};

/** 过滤：空值（undefined / null / ''）的条件视为不过滤 */
const matchesFilters = (record, filters = {}) =>
  Object.entries(filters)
    .filter(([, expected]) => expected !== undefined && expected !== null && expected !== '')
    .every(([key, expected]) => matchOne(record, key, expected));

/** 关键字：在声明的字段里做忽略大小写的包含匹配 */
const matchesKeyword = (record, keyword, keywordFields = []) => {
  if (!keyword || !keywordFields.length) return true;
  const needle = String(keyword).toLowerCase();
  return keywordFields.some((field) => {
    const value = getField(record, field);
    return typeof value === 'string' && value.toLowerCase().includes(needle);
  });
};

/** 排序表达式 'field:asc|desc'（兼容脚手架 sortBy 语义） */
const parseSort = (sort) => {
  if (!sort) return null;
  const [field, direction] = String(sort).split(':');
  if (!field) return null;
  return { field, desc: String(direction || 'desc').toLowerCase() === 'desc' };
};

const compareBy = (sortSpec) => (a, b) => {
  const left = getField(a, sortSpec.field);
  const right = getField(b, sortSpec.field);
  // 空值统一排在最后，避免 null 参与大小/数值比较
  const leftEmpty = left === null || left === undefined;
  const rightEmpty = right === null || right === undefined;
  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty) return 1;
  if (rightEmpty) return -1;
  let diff = 0;
  if (typeof left === 'number' && typeof right === 'number') diff = left - right;
  else diff = String(left).localeCompare(String(right));
  if (diff === 0) return 0;
  return sortSpec.desc ? -diff : diff;
};

/**
 * 过滤 + 关键字 + 排序，返回新数组（元素仍是 store 内部引用，调用方勿直接改）。
 * @param {Array} records 原始记录
 * @param {Object} query { filters, keyword, keywordFields, sort }
 */
const filterList = (records, query = {}) => {
  const { filters = {}, keyword, keywordFields = [], sort } = query;
  const filtered = records.filter(
    (record) => matchesFilters(record, filters) && matchesKeyword(record, keyword, keywordFields)
  );
  const spec = parseSort(sort);
  return spec ? filtered.slice().sort(compareBy(spec)) : filtered;
};

/**
 * 对内存记录数组做「过滤 + 关键字 + 排序 + 分页」。
 * @param {Array} records 原始记录（会被 clone 后返回）
 * @param {Object} query  { filters, keyword, keywordFields, sort, page, size }
 * @returns {{ items: Array, total: number, page: number, size: number, pages: number }}
 */
const queryList = (records, query = {}) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(query.size, 10) || 20, 1), 500);

  const sorted = filterList(records, query);
  const total = sorted.length;
  const start = (page - 1) * size;
  const items = sorted.slice(start, start + size).map(clone);

  return { items, total, page, size, pages: Math.ceil(total / size) || 0 };
};

/**
 * 创建一个带自增 ID 的内存 store。
 * @param {Object} options { prefix: 'ds-', startId: 1000 }
 */
const createMemoryStore = ({ prefix, startId = 0 }) => {
  const records = new Map();
  let sequence = startId;

  const nextId = () => {
    sequence += 1;
    return `${prefix}${sequence}`;
  };

  return {
    nextId,
    has: (id) => records.has(String(id)),
    raw: (id) => records.get(String(id)),
    get: (id) => (records.has(String(id)) ? clone(records.get(String(id))) : null),
    all: () => Array.from(records.values()).map(clone),
    insert: (record) => {
      const stored = clone(record);
      const id = String(stored.id);
      records.set(id, stored);
      // 允许显式指定 id（种子数据用），同时把自增序列推到位，避免后续自增 id 撞车
      if (id.startsWith(prefix)) {
        const numeric = Number(id.slice(prefix.length));
        if (Number.isFinite(numeric) && numeric > sequence) sequence = numeric;
      }
      return clone(stored);
    },
    replace: (id, record) => {
      const stored = clone(record);
      stored.id = String(id);
      records.set(String(id), stored);
      return clone(stored);
    },
    remove: (id) => {
      const existing = records.has(String(id)) ? clone(records.get(String(id))) : null;
      records.delete(String(id));
      return existing;
    },
    removeWhere: (predicate) => {
      const removed = [];
      Array.from(records.entries())
        .filter(([, record]) => predicate(record))
        .forEach(([id]) => {
          removed.push(clone(records.get(id)));
          records.delete(id);
        });
      return removed;
    },
    size: () => records.size,
    clear: () => {
      records.clear();
      sequence = startId;
    },
  };
};

module.exports = {
  clone,
  nowIso,
  getField,
  parseSort,
  filterList,
  queryList,
  createMemoryStore,
};
