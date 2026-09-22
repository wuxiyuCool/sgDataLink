/**
 * MySQL 仓储公共内核 —— 把内存 store 的查询语义翻译成 SQL 的那一层。
 *
 * 内存版每个 repository 都是同一套模板（createMemoryStore + filterList/queryList +
 * create 默认值 + update 合并），这里用 defineStore() 提供同一套模板的异步 SQL 实现：
 * 各 `<name>.store.js` 只声明「表名 / ID 前缀 / 列映射 / 关键字字段 / 默认排序 /
 * create 默认值」，再补自己特有的 bespoke 方法，从而结构上保证
 * 「与内存版逐方法同名、入参与返回结构一致、只是返回 Promise」。
 *
 * 列类型（type）与写入前的归一 —— 目标库 sql_mode 含 STRICT_TRANS_TABLES，
 * 空串写 INT、ISO('...Z') 串写 DATETIME 都会直接报错，所以所有值先过 toColumnValue：
 * - str / text : undefined | null -> NULL，其它 String(value)
 * - int        : '' | null -> NULL，Number 后四舍五入取整（NaN -> NULL）
 * - num        : 同上但不取整（failureRate / avgLatencyMs 这类小数）
 * - bool       : TINYINT(1) 的 0 / 1（NULL 保留 NULL；读出 NULL 时省略该键，与内存版「没这个键」一致）
 * - json       : JSON.stringify（mysql2 对 JSON 列会自动 parse，读出侧两种都兼容）
 * - datetime   : ISO(UTC) <-> 'YYYY-MM-DD HH:MM:SS.SSS'（DATETIME(3) 无时区，避免会话时区偏移）
 *
 * 其它与内存版对齐的处理：
 * - `seq` 自增列还原「Map 插入序」，list() 与无排序查询一律 ORDER BY seq ASC；
 * - `extra` JSON 列兜住实体上未建列的字段，读出时并回对象（内存版无 schema，天然不丢字段）；
 * - 函数型过滤条件 / 嵌套字段（'a.b'）/ 未建列的键无法翻译成 SQL —— 这些查询回退成
 *   「整表取出 + 复用 memoryStore 的 filterList / queryList」，管理后台数据量（百级）下
 *   开销可忽略，换来语义完全一致。
 */
const { filterList, queryList, clone, nowIso, parseSort } = require('../memoryStore');
const db = require('../../db/mysql');
const logger = require('../../config/logger');

/** ID 序列（复刻内存 store 的 prefix + 自增语义） */
const SEQ_TABLE = 'databridge_id_seq';

/** 每实例日志保留上限，与 log.repository 内存版 MAX_LOGS_PER_INSTANCE 同值 */
const MAX_LOGS_PER_INSTANCE = 500;

/** 可安全回显进 SQL 的标识符（列名 / 表名都在本模块内定义，不接受外部输入） */
const quote = (identifier) => `\`${String(identifier).replace(/[^a-zA-Z0-9_]/g, '')}\``;

/** camelCase JS 键 -> snake_case 列名（列定义里可用 col 显式覆盖，如 trigger -> trigger_type） */
const columnKeyOf = (key) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

/** ISO(UTC) / 毫秒 / Date -> 'YYYY-MM-DD HH:MM:SS.SSS'（DATETIME(3) 写入格式，UTC） */
const toDbDateTime = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) return text;
  const time = Date.parse(text);
  if (Number.isNaN(time)) {
    // 严格模式下写坏值会让整条 insert 失败，宁可纠正成当前时间也不丢记录
    logger.warn('unparsable datetime %j stored as now()', text);
    return nowIso().replace('T', ' ').replace('Z', '');
  }
  return new Date(time).toISOString().replace('T', ' ').replace('Z', '');
};

/** 'YYYY-MM-DD HH:MM:SS(.SSS)' -> 契约要求的 ISO 8601（UTC）；已是 ISO 的串只补 Z */
const toIsoDateTime = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (text.includes('T')) return text.endsWith('Z') ? text : `${text}Z`;
  if (!/^\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}/.test(text)) return text;
  const [datePart, timePart] = text.split(' ');
  const [hms, fraction] = timePart.split('.');
  const seconds = hms.split(':').length === 3 ? hms : `${hms}:00`;
  return `${datePart}T${seconds}.${String(fraction || '')
    .padEnd(3, '0')
    .slice(0, 3)}Z`;
};

/** JS 值 -> 列值 */
const toColumnValue = (type, value) => {
  const isText = type === 'str' || type === 'text';
  if (value === undefined || value === null) return null;
  if (value === '' && !isText) return null;
  if (value === '') return '';
  switch (type) {
    case 'int': {
      const num = Math.round(Number(value));
      return Number.isFinite(num) ? num : null;
    }
    case 'num': {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }
    case 'bool':
      return value === false || value === 0 || value === 'false' ? 0 : 1;
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'datetime':
      return toDbDateTime(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
};

/** 列值 -> JS 值 */
const fromColumnValue = (type, value) => {
  if (value === undefined) return null;
  switch (type) {
    case 'int':
    case 'num':
      return value === null ? null : Number(value);
    case 'bool':
      return value === null ? null : Boolean(value);
    case 'json':
      if (value === null) return null;
      // mysql2 对 JSON 列已自动 parse（5.7 实测给对象）；驱动行为变化时给字符串，两种都兼容
      if (typeof value === 'object') return value;
      try {
        return JSON.parse(value);
      } catch (err) {
        logger.warn('json column value is not valid json, kept as text: %s', String(value).slice(0, 120));
        return value;
      }
    case 'datetime':
      return toIsoDateTime(value);
    default:
      return value;
  }
};

/** LIKE 元字符转义（目标库 sql_mode 未开 NO_BACKSLASH_ESCAPES，默认转义符是反斜杠） */
const escapeLike = (keyword) => String(keyword).replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** 分页参数归一，与 memoryStore.queryList 同口径（size 1..500，缺省 20） */
const normalizePaging = (query = {}) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(query.size, 10) || 20, 1), 500);
  return { page, size, offset: (page - 1) * size };
};

const normalizeColumns = (columns) =>
  Object.entries(columns).reduce((acc, [key, column]) => {
    acc[key] = { type: 'str', col: columnKeyOf(key), ...column };
    return acc;
  }, {});

/**
 * WHERE + 参数（内存版 matchOne 的 SQL 版：等值 / IN + 多列关键字 LIKE）。
 * 值为 undefined / null / '' 的条件视为不过滤（与内存版一致）。
 * @returns {{sql: string, params: Array}|null} null 表示有 SQL 表达不了的条件，调用方走整表回退
 */
const buildWhere = (spec, filters = {}) => {
  const conditions = [];
  const params = [];
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '');
  const unsupported = entries.some(
    ([key, value]) =>
      key.includes('.') ||
      !spec.columns[key] ||
      typeof value === 'function' ||
      value instanceof Date ||
      (Array.isArray(value) && value.some((item) => typeof item === 'function' || item instanceof Date))
  );
  if (unsupported) return null;

  entries.forEach(([key, value]) => {
    const { type } = spec.columns[key];
    const column = quote(spec.columns[key].col);
    if (Array.isArray(value)) {
      const list = value.filter((item) => item !== undefined && item !== null && item !== '');
      if (!list.length) {
        // 内存版：数组是「任一命中」，空数组必定不命中
        conditions.push('1 = 0');
        return;
      }
      conditions.push(`${column} IN (${list.map(() => '?').join(', ')})`);
      list.forEach((item) => params.push(toColumnValue(type, item)));
      return;
    }
    if (type !== 'bool' && typeof value === 'boolean') {
      // 内存版是 'true' === true -> false，这里等价短路
      conditions.push('1 = 0');
      return;
    }
    conditions.push(`${column} = ?`);
    params.push(toColumnValue(type, value));
  });
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
};

/** 关键字 OR-LIKE（大小写不敏感由 utf8mb4_unicode_ci 排序规则保证，与内存版 toLowerCase 比对等价） */
const buildKeyword = (spec, keyword) => {
  if (!keyword) return null;
  const fields = spec.keywordFields.filter((field) => !field.includes('.') && spec.columns[field]);
  if (!fields.length) return null;
  return {
    sql: `(${fields.map((field) => `${quote(spec.columns[field].col)} LIKE ?`).join(' OR ')})`,
    params: fields.map(() => `%${escapeLike(keyword)}%`),
  };
};

/** ORDER BY：空值一律最后（内存版 compareBy 同口径），再按 seq 稳定同值顺序 */
const buildOrder = (spec, sort) => {
  const parsed = parseSort(sort);
  const column = parsed && (parsed.field === 'id' ? 'id' : (spec.columns[parsed.field] || {}).col);
  if (!column) return `ORDER BY ${quote('seq')} ASC`;
  return `ORDER BY ${quote(column)} IS NULL ASC, ${quote(column)} ${parsed.desc ? 'DESC' : 'ASC'}, ${quote('seq')} ASC`;
};

/** 行 -> 记录：列名转回 JS 键、布尔 NULL 省略键、最后并入 extra 兜底字段 */
const fromRow = (spec, row) => {
  if (!row) return null;
  const record = {};
  Object.entries(spec.columns).forEach(([key, column]) => {
    const value = fromColumnValue(column.type, row[column.col]);
    if (column.type === 'bool' && value === null) return;
    record[key] = value;
  });
  const extra = row.extra === null || row.extra === undefined ? null : fromColumnValue('json', row.extra);
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    Object.keys(extra).forEach((key) => {
      record[key] = extra[key];
    });
  }
  return record;
};

/** 记录 -> 行：未建列的字段收进 extra，保证换驱动不丢字段 */
const toRow = (spec, record) => {
  const known = Object.keys(spec.columns);
  const extra = {};
  Object.keys(record).forEach((key) => {
    if (key === 'extra' || known.includes(key) || record[key] === undefined) return;
    try {
      extra[key] = clone(record[key]);
    } catch (err) {
      // 循环引用一类型不进 JSON，丢弃即可，不能让整条写入失败
    }
  });
  const row = {};
  known.forEach((key) => {
    row[spec.columns[key].col] = toColumnValue(spec.columns[key].type, record[key]);
  });
  row.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
  return row;
};

/** 取号：一条 UPDATE 用 LAST_INSERT_ID(expr) 原子自增，同连接读回（借还专用连接，不与业务查询串包） */
const nextId = async (spec) => {
  const connection = await db.getMysqlPool().getConnection();
  try {
    // 序列行缺失（首次启动 / 新增前缀）时补一行。next_val 的语义是「最近一次已分配的序号」，
    // 与 memoryStore 的 startId（首个自增号 = startId + 1）对齐，所以这里种 startId，
    // 紧跟着的 +1 得到 startId + 1 —— 也就是契约示例里的 ds-1001。
    await connection.query(`INSERT IGNORE INTO ${quote(SEQ_TABLE)} (id_prefix, next_val) VALUES (?, ?)`, [
      spec.idPrefix,
      spec.startId,
    ]);
    await connection.query(`UPDATE ${quote(SEQ_TABLE)} SET next_val = LAST_INSERT_ID(next_val + 1) WHERE id_prefix = ?`, [
      spec.idPrefix,
    ]);
    const [rows] = await connection.query('SELECT LAST_INSERT_ID() AS next');
    const numeric = Number(rows[0] && rows[0].next);
    if (!Number.isFinite(numeric) || numeric < spec.startId) {
      throw new Error(`id sequence "${spec.idPrefix}" returned an invalid value: ${rows[0] && rows[0].next}`);
    }
    return `${spec.idPrefix}${numeric}`;
  } finally {
    connection.release();
  }
};

/** 显式 id（种子数据）落库后把序列顶到位，避免后续自增撞号（内存版 store.insert 同语义） */
const bumpSequence = async (spec, id) => {
  const text = String(id === undefined || id === null ? '' : id);
  if (!text.startsWith(spec.idPrefix)) return;
  const numeric = Number(text.slice(spec.idPrefix.length));
  if (!Number.isFinite(numeric)) return;
  const value = Math.trunc(numeric);
  await db.run(
    `INSERT INTO ${quote(SEQ_TABLE)} (id_prefix, next_val) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE next_val = GREATEST(next_val, ?)`,
    [spec.idPrefix, value, value]
  );
};

/** defineStore 注册进来的列定义清单，供 src/db/init.js 启动时与 information_schema 比对 */
const SCHEMA_SPECS = [];

/**
 * 定义一个表的 store（内存 store 的异步 SQL 镜像）。
 * @param {Object} spec {
 *   table: 'databridge_datasource', idPrefix: 'ds-', startId: 1000,
 *   columns: { id: {}, name: { notNull: true }, port: { type: 'int' }, fieldMappings: { type: 'json' },
 *              createdAt: { type: 'datetime' }, trigger: { col: 'trigger_type' }, ... },
 *   keywordFields: ['name', ...], defaultSort: 'createdAt:asc'
 * }
 */
const defineStore = (definition) => {
  const spec = { keywordFields: [], defaultSort: null, ...definition, columns: normalizeColumns(definition.columns) };
  SCHEMA_SPECS.push(spec);
  const selectColumns = [...Object.values(spec.columns).map((column) => quote(column.col)), quote('extra')].join(', ');
  const baseSql = `SELECT ${selectColumns} FROM ${quote(spec.table)}`;

  /** filters / keyword / sort 有一项 SQL 表达不了 -> 整表 + 内存版过滤器 */
  const fallbackNeeded = (query) => {
    const filters = query.filters || {};
    return (
      buildWhere(spec, filters) === null ||
      (Boolean(query.keyword) && !spec.keywordFields.filter((field) => spec.columns[field]).length) ||
      Boolean(
        query.sort &&
          parseSort(query.sort) &&
          !(spec.columns[parseSort(query.sort).field] || parseSort(query.sort).field === 'id')
      )
    );
  };

  const jsQuery = async (query, { paginate }) => {
    const rows = await db.query(`${baseSql} ORDER BY ${quote('seq')} ASC`);
    const merged = { ...query, filters: query.filters || {}, keywordFields: spec.keywordFields };
    const records = rows.map((row) => fromRow(spec, row));
    return paginate ? queryList(records, merged) : filterList(records, merged);
  };

  const selectionOf = (query) => {
    const where = buildWhere(spec, query.filters || {});
    const keyword = buildKeyword(spec, query.keyword);
    const clauses = [];
    const params = [];
    if (where.sql) {
      clauses.push(where.sql.replace(/^WHERE /, ''));
      params.push(...where.params);
    }
    if (keyword) {
      clauses.push(keyword.sql);
      params.push(...keyword.params);
    }
    return { whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  };

  const insertRow = async (record) => {
    const row = toRow(spec, record);
    const columns = Object.keys(row);
    await db.run(
      `INSERT INTO ${quote(spec.table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((column) => row[column])
    );
    await bumpSequence(spec, record.id);
    return clone(record);
  };

  const updateRow = async (record) => {
    const row = toRow(spec, record);
    const columns = Object.keys(row).filter((column) => column !== 'id');
    const result = await db.run(
      `UPDATE ${quote(spec.table)} SET ${columns.map((column) => `${quote(column)} = ?`).join(', ')} WHERE ${quote(
        'id'
      )} = ?`,
      [...columns.map((column) => row[column]), String(record.id)]
    );
    if (!result.affectedRows) {
      // 值完全相同时 affectedRows 也是 0，所以只在行确实不存在时补一次 INSERT
      const existing = await db.query(`SELECT ${quote('id')} FROM ${quote(spec.table)} WHERE ${quote('id')} = ?`, [
        String(record.id),
      ]);
      if (!existing.length) return insertRow(record);
    }
    return clone(record);
  };

  const getById = async (id) => {
    if (id === undefined || id === null || id === '') return null;
    const rows = await db.query(`${baseSql} WHERE ${quote('id')} = ?`, [String(id)]);
    return rows.length ? clone(fromRow(spec, rows[0])) : null;
  };

  return {
    spec,
    table: spec.table,
    idPrefix: spec.idPrefix,
    startId: spec.startId,
    keywordFields: spec.keywordFields,
    defaultSort: spec.defaultSort,
    /** 便捷出口，供 bespoke 方法复用 */
    fromRow: (row) => fromRow(spec, row),
    toRow: (record) => toRow(spec, record),
    selectSql: () => baseSql,
    where: (filters) => buildWhere(spec, filters),
    order: (sort) => buildOrder(spec, sort),
    paging: normalizePaging,
    clone,
    nextId: () => nextId(spec),
    bumpSequence: (id) => bumpSequence(spec, id),
    /** 内存版 store.all()：全表按插入序 */
    list: async () => {
      const rows = await db.query(`${baseSql} ORDER BY ${quote('seq')} ASC`);
      return rows.map((row) => fromRow(spec, row));
    },
    /**
     * bespoke 方法用的最小查询出口：按 WHERE 片段（不含 WHERE 关键字）取映射后的记录。
     * whereSql 由本目录内的代码拼接，参数一律走 ? 占位符。
     */
    rows: async (whereSql, params = [], orderSql = `ORDER BY ${quote('seq')} ASC`) => {
      const sql = `${baseSql} ${whereSql ? `WHERE ${whereSql}` : ''} ${orderSql}`.replace(/\s+/g, ' ');
      const rows = await db.query(sql, params);
      return rows.map((row) => fromRow(spec, row));
    },
    /** 内存版 filterList 语义：filters + keyword + sort，不分页 */
    find: async (query = {}) => {
      if (fallbackNeeded(query)) return jsQuery(query, { paginate: false });
      const selection = selectionOf(query);
      const rows = await db.query(
        `${baseSql} ${selection.whereSql} ${buildOrder(spec, query.sort || spec.defaultSort)}`.replace(/\s+/g, ' '),
        selection.params
      );
      return rows.map((row) => fromRow(spec, row));
    },
    /** 内存版 queryList 语义：{ items, total, page, size, pages } */
    page: async (query = {}) => {
      if (fallbackNeeded(query)) return jsQuery(query, { paginate: true });
      const { page, size, offset } = normalizePaging(query);
      const selection = selectionOf(query);
      const [countRows, rows] = await Promise.all([
        db.query(
          `${`SELECT COUNT(*) AS total FROM ${quote(spec.table)}`} ${selection.whereSql}`.replace(/\s+/g, ' '),
          selection.params
        ),
        db.query(
          `${baseSql} ${selection.whereSql} ${buildOrder(
            spec,
            query.sort || spec.defaultSort
          )} LIMIT ${size} OFFSET ${offset}`.replace(/\s+/g, ' '),
          selection.params
        ),
      ]);
      const total = Number(countRows[0] ? countRows[0].total : 0);
      return { items: rows.map((row) => fromRow(spec, row)), total, page, size, pages: Math.ceil(total / size) || 0 };
    },
    getById,
    /** 内存版 store.insert：显式 id 会顶高序列 */
    insert: async (record) => {
      if (record.id === undefined || record.id === null || record.id === '') {
        return insertRow({ ...record, id: await nextId(spec) });
      }
      return insertRow({ ...record, id: String(record.id) });
    },
    /** 内存版 store.replace：整行覆盖（不存在则插入） */
    replace: async (id, record) => updateRow({ ...record, id: String(id) }),
    /** 内存版 store.remove：返回被删记录或 null */
    deleteById: async (id) => {
      const key = String(id);
      const rows = await db.query(`${baseSql} WHERE ${quote('id')} = ?`, [key]);
      if (!rows.length) return null;
      await db.run(`DELETE FROM ${quote(spec.table)} WHERE ${quote('id')} = ?`, [key]);
      return clone(fromRow(spec, rows[0]));
    },
    /** 条件计数（内存版没有的便捷方法：countByStatus / countUnread / 种子判空） */
    count: async (filters = {}) => {
      const where = buildWhere(spec, filters);
      if (!where) return (await jsQuery({ filters }, { paginate: false })).length;
      const rows = await db.query(
        `${`SELECT COUNT(*) AS total FROM ${quote(spec.table)}`} ${where.sql}`.replace(/\s+/g, ' '),
        where.params
      );
      return Number(rows[0] ? rows[0].total : 0);
    },
    /** 自定义 WHERE 片段的计数（countUnread 这类「NULL 也算」的口径用得上） */
    countWhere: async (whereSql, params = []) => {
      const rows = await db.query(
        `SELECT COUNT(*) AS total FROM ${quote(spec.table)}${whereSql ? ` WHERE ${whereSql}` : ''}`,
        params
      );
      return Number(rows[0] ? rows[0].total : 0);
    },
    /** 内存版 store.removeWhere 的 SQL 版：按条件批删并返回被删记录 */
    deleteByWhere: async (whereSql, params = []) => {
      const rows = await db.query(`${baseSql} WHERE ${whereSql} ORDER BY ${quote('seq')} ASC`, params);
      if (!rows.length) return [];
      await db.run(`DELETE FROM ${quote(spec.table)} WHERE ${whereSql}`, params);
      return rows.map((row) => fromRow(spec, row));
    },
    /** 按 id 批删（内存版没有，dataapi 删日计数用） */
    deleteByIds: async (ids = []) => {
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(', ');
      const result = await db.run(
        `DELETE FROM ${quote(spec.table)} WHERE ${quote('id')} IN (${placeholders})`,
        ids.map(String)
      );
      return { affectedRows: result.affectedRows };
    },
    /** 多行批量插入（引擎 POST /engine/logs 用；id 由调用方先取好，保持与内存版逐条 create 同序） */
    insertMany: async (records = []) => {
      if (!records.length) return [];
      const rows = records.map((record) => toRow(spec, record));
      const columns = Object.keys(rows[0]);
      const values = rows.map(() => `(${columns.map(() => '?').join(', ')})`);
      await db.run(
        `INSERT INTO ${quote(spec.table)} (${columns.map(quote).join(', ')}) VALUES ${values.join(', ')}`,
        rows.reduce((acc, row) => acc.concat(columns.map((column) => row[column])), [])
      );
      await Promise.all(records.map((record) => bumpSequence(spec, record.id)));
      return records.map(clone);
    },
    /** 内存版 store.clear：清表 + 序列复位（复位到 startId，下一个号仍是 startId + 1） */
    clear: async () => {
      await db.run(`DELETE FROM ${quote(spec.table)}`);
      await db.run(`UPDATE ${quote(SEQ_TABLE)} SET next_val = ? WHERE id_prefix = ?`, [spec.startId, spec.idPrefix]);
      return true;
    },
  };
};

module.exports = {
  defineStore,
  SCHEMA_SPECS,
  SEQ_TABLE,
  MAX_LOGS_PER_INSTANCE,
  quote,
  columnKeyOf,
  toDbDateTime,
  toIsoDateTime,
  toColumnValue,
  fromColumnValue,
  fromRow,
  toRow,
  buildWhere,
  buildKeyword,
  buildOrder,
  escapeLike,
  normalizePaging,
  nextId,
  bumpSequence,
  clone,
  nowIso,
};
