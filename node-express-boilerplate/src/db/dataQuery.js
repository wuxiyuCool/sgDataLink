/**
 * Data API 真实数据查询（docs/API.md 1.9 / 1.9.1 / 1.9.2，DB_DRIVER=mysql 真实模式专用）。
 *
 * 按数据源类型分发：
 *   mysql      → mysql2 一次性连接（dateStrings），LIMIT/OFFSET 分页
 *   oracle     → oracledb 6 thin（纯 JS，无需 Instant Client），ROWNUM 嵌套分页（兼容 11g+）
 *   postgresql → 尚未接驱动，抛明确错误（二阶段补）
 *
 * 三条能力：
 *   query()       builder 模式：按 tableName/fields 拼 SELECT（标识符白名单 + 值绑定）
 *   queryCustom() custom 模式：执行 customSql，先过 sqlGuard 只读校验，参数一律绑定
 *   listTables() / listColumns() 1.9.1 元数据浏览（information_schema / ALL_*，全绑定参数）
 *
 * 防注入：表名/字段名只允许标识符白名单（字母数字下划线$，可带 schema. 前缀）；
 * 值一律走绑定参数 —— custom 模式的 list 参数展开成逐个占位符（:x__0 / ?），
 * 分页包装用 COUNT(*) 子查询 + ROWNUM/LIMIT，用户文本永不与值拼接。
 */

const mysql = require('mysql2/promise');
const oracledb = require('oracledb');
const config = require('../config/config');
const guard = require('./sqlGuard');
const { dataQueryFailed, paramInvalid } = require('../utils/bizError');

oracledb.fetchAsString = [oracledb.DATE, oracledb.CLOB, oracledb.NUMBER];

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,63}(\.[A-Za-z_][A-Za-z0-9_$]{0,63})?$/;
const QUERY_TIMEOUT_MS = 10000;
/** 元数据浏览单次返回上限（表清单可能上千张，前端下拉只需一屏） */
const MAX_META_ROWS = 500;
/** 契约 1.9：行数硬上限 MAX_SIZE(500)，queryCustom 再兜一次 */
const MAX_PAGE_SIZE = 500;
/** 自定义 SQL 分页包装里的行号别名列，取结果列名时按它剔除（下划线不能开头，故带 dbr_ 前缀） */
const ROWNUM_ALIAS = 'dbr_rn';

/** 校验标识符合法（表名/列名），非法直接拒绝而不是转义 */
const assertIdent = (name, what) => {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw dataQueryFailed(`${what} 不是合法标识符，拒绝查询: ${String(name).slice(0, 80)}`);
  }
  return name;
};

/** 只读兜底校验：调用方（保存 / 运行时）已校验过，这里防绕过 */
const assertReadOnlySql = (sql) => {
  const result = guard.assertReadOnly(sql);
  if (!result.ok) throw paramInvalid(`customSql 校验失败: ${result.reason}`);
  return guard.normalizeSql(sql);
};

/** 一次性 mysql 短连接（不走管理端连接池：目标是用户库，池化会把凭据和连接混在一起） */
const openMysql = async (ds) =>
  mysql.createConnection({
    host: ds.host,
    port: Number(ds.port) || 3306,
    user: ds.username,
    password: ds.password,
    database: ds.database || undefined,
    dateStrings: true,
    charset: 'UTF8MB4',
    connectTimeout: QUERY_TIMEOUT_MS,
    multipleStatements: false,
  });

/** 一次性 oracle 短连接；callTimeout 兜住「连上但执行挂死」（thin 驱动单位毫秒） */
const openOracle = async (ds) => {
  const conn = await oracledb.getConnection({
    user: ds.username,
    password: ds.password,
    connectString: `${ds.host}:${Number(ds.port) || 1521}/${ds.database}`,
  });
  conn.callTimeout = QUERY_TIMEOUT_MS;
  return conn;
};

/**
 * mysql 侧没有 callTimeout，用 Promise.race 计时：超时直接 destroy 连接，
 * 让挂起的 query 立刻以 PROTOCOL_CONNECTION_LOST 失败退出，不留下野连接。
 * @returns {Promise<any>}
 */
const withMysqlTimeout = (task, ms, conn) => {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (conn) {
        try {
          conn.destroy();
        } catch (err) {
          /* 销毁失败不重要，超时本身才是要点 */
        }
      }
      reject(dataQueryFailed(`查询超时(${ms}ms)，已销毁连接`));
    }, ms);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
};

/**
 * @param {Object} ds 数据源记录（含明文 password）
 * @param {Object} spec { tableName, fields: [{name,type}], filters: [{column, value}], page, size }
 * @returns {Promise<{fields:string[],rows:any[][],total:number}>}
 */
const query = async (ds, spec) => {
  const { tableName, fields = [], filters = [], page = 1, size = 20 } = spec;
  assertIdent(tableName, '表名');
  const cols = fields.map((f) => assertIdent(f.name, '字段名'));
  if (!cols.length) throw dataQueryFailed('数据服务未配置输出字段');
  const colList = cols.join(', ');
  const whereSql = filters.length ? ` WHERE ${filters.map((f) => `${assertIdent(f.column, '过滤字段')} = ?`).join(' AND ')}` : '';
  const bindValues = filters.map((f) => f.value);

  if (ds.type === 'mysql') return queryMysql(ds, tableName, colList, whereSql, bindValues, page, size);
  if (ds.type === 'oracle') return queryOracle(ds, tableName, colList, filters, page, size);
  throw dataQueryFailed(`暂不支持 ${ds.type} 类型的真实查询（postgresql 驱动二阶段接入），可先用 DB_DRIVER=memory 演示`);
};

const queryMysql = async (ds, table, colList, whereSql, bindValues, page, size) => {
  const conn = await openMysql(ds);
  try {
    const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM ${table}${whereSql}`, bindValues);
    const [rows] = await conn.query(
      { sql: `SELECT ${colList} FROM ${table}${whereSql} LIMIT ? OFFSET ?`, rowsAsArray: true },
      [...bindValues, size, (page - 1) * size],
    );
    return { fields: colList.split(', '), rows, total: Number(total) };
  } finally {
    conn.destroy();
  }
};

const queryOracle = async (ds, table, colList, filters, page, size) => {
  const conn = await openOracle(ds);
  try {
    const whereSql = filters.length ? ` WHERE ${filters.map((f, i) => `${f.column} = :f${i}`).join(' AND ')}` : '';
    const binds = {};
    filters.forEach((f, i) => {
      binds[`f${i}`] = f.value;
    });
    const countResult = await conn.execute(`SELECT COUNT(*) AS CNT FROM ${table}${whereSql}`, binds, { outFormat: oracledb.OUT_FORMAT_ARRAY });
    const total = Number(countResult.rows[0][0]);
    const offset = (page - 1) * size;
    // ROWNUM 嵌套分页，兼容 11g/12c/19c
    const sql = `SELECT ${colList} FROM (SELECT a.*, ROWNUM rn FROM (SELECT ${colList} FROM ${table}${whereSql}) a WHERE ROWNUM <= :maxRow) WHERE rn > :minRow`;
    const { rows } = await conn.execute(sql, { ...binds, maxRow: offset + size, minRow: offset }, { outFormat: oracledb.OUT_FORMAT_ARRAY });
    const nCols = colList.split(', ').length;
    return { fields: colList.split(', '), rows: rows.map((r) => r.slice(0, nCols)), total };
  } finally {
    await conn.close();
  }
};

/**
 * custom 模式绑定准备（契约 1.9.2）：
 * list 参数按元素展开成逐个占位符（`:ids` → `:ids__0, :ids__1`），
 * mysql 侧再把 `:name` 按出现顺序换成 `?` 并给出绑定顺序；oracle 侧直接用命名绑定。
 * 值只进 binds，永不进 SQL 文本。
 * @returns {{ oracleSql: string, oracleBinds: Object, positionalSql: string, positionalValues: any[] }}
 */
const prepareBindings = (sql, params = []) => {
  const values = new Map();
  (params || []).forEach((p) => {
    if (p && p.name !== undefined) values.set(String(p.name), p.value);
  });
  // 占位符必须在声明列表里（保存期已校验，这里再兜一次，防手改库）
  const declared = guard.extractPlaceholders(sql);
  declared.forEach((name) => {
    if (!values.has(name)) throw paramInvalid(`SQL 占位符 :${name} 没有对应的 queryParams`);
  });
  // list（数组值）展开成逐个元素占位符，元素上限由 sqlGuard 保证
  const listSizes = {};
  declared.forEach((name) => {
    const value = values.get(name);
    if (Array.isArray(value)) {
      if (!value.length) throw paramInvalid(`list 参数 ${name} 为空，拒绝执行`);
      if (value.length > guard.MAX_LIST_ITEMS) {
        throw paramInvalid(`list 参数 ${name} 元素数 ${value.length} 超上限 ${guard.MAX_LIST_ITEMS}`);
      }
      listSizes[name] = value.length;
    }
  });
  const { sql: expandedSql, expanded } = guard.expandListPlaceholders(sql, listSizes);
  // 展开后的 :name__i 逐个登记成可绑定项
  const itemValues = new Map(values);
  expanded.forEach(({ name, itemNames }) => {
    const list = values.get(name);
    itemNames.forEach((item, index) => itemValues.set(item, list[index]));
  });

  const oracleSql = expandedSql;
  const oracleBinds = {};
  guard.extractPlaceholders(oracleSql).forEach((name) => {
    oracleBinds[name] = itemValues.get(name);
  });
  const positional = guard.toMysqlPositional(expandedSql);
  return {
    oracleSql,
    oracleBinds,
    positionalSql: positional.sql,
    positionalValues: positional.order.map((name) => {
      if (!itemValues.has(name)) throw paramInvalid(`SQL 占位符 :${name} 没有对应的参数值`);
      return itemValues.get(name);
    }),
  };
};

/**
 * 自定义 SQL 真实查询（契约 1.9.2）。
 * @param {Object} ds 数据源记录
 * @param {Object} spec { sql, params: [{name,type,value}], page, size }
 * @returns {Promise<{fields:string[],rows:any[][],total:number}>}
 */
const queryCustom = async (ds, spec = {}) => {
  const { sql, params = [], page = 1, size = 20 } = spec;
  const readonlySql = assertReadOnlySql(sql);
  const safePage = Math.max(Number(page) || 1, 1);
  const safeSize = Math.min(Math.max(Number(size) || 20, 1), MAX_PAGE_SIZE);
  const offset = (safePage - 1) * safeSize;
  const bound = prepareBindings(readonlySql, params);

  if (ds.type === 'mysql') return customMysql(ds, bound, safePage, safeSize, offset);
  if (ds.type === 'oracle') return customOracle(ds, bound, safePage, safeSize, offset);
  throw dataQueryFailed(`暂不支持 ${ds.type} 类型的真实查询（postgresql 驱动二阶段接入），可先用 DB_DRIVER=memory 演示`);
};

const customMysql = async (ds, bound, page, size, offset) => {
  const conn = await openMysql(ds);
  try {
    const task = (async () => {
      const [[countRow]] = await conn.query(`SELECT COUNT(*) AS total FROM (${bound.positionalSql}) dbr_cnt`, bound.positionalValues);
      const [rows, fields] = await conn.query(
        { sql: `${bound.positionalSql} LIMIT ? OFFSET ?`, rowsAsArray: true },
        [...bound.positionalValues, size, offset]
      );
      return { countRow, fields, rows };
    })();
    const { countRow, fields, rows } = await withMysqlTimeout(task, QUERY_TIMEOUT_MS, conn);
    return {
      fields: (fields || []).map((f) => f.name),
      rows,
      total: Number(countRow && countRow.total),
      page,
      size,
    };
  } finally {
    conn.destroy();
  }
};

const customOracle = async (ds, bound, page, size, offset) => {
  const conn = await openOracle(ds);
  try {
    const opts = { outFormat: oracledb.OUT_FORMAT_ARRAY };
    const countResult = await conn.execute(`SELECT COUNT(*) AS CNT FROM (${bound.oracleSql}) dbr_cnt`, bound.oracleBinds, opts);
    // ROWNUM 嵌套分页（11g+）；外层多出的 dbr_rn 列按「结果最后一列」剔除，不依赖列名匹配
    const paged = await conn.execute(
      `SELECT * FROM (SELECT a.*, ROWNUM ${ROWNUM_ALIAS} FROM (${bound.oracleSql}) a WHERE ROWNUM <= :dbr_maxrow) WHERE ${ROWNUM_ALIAS} > :dbr_minrow`,
      { ...bound.oracleBinds, dbr_maxrow: offset + size, dbr_minrow: offset },
      opts
    );
    const meta = paged.metaData || [];
    const fields = meta.slice(0, Math.max(meta.length - 1, 0)).map((m) => m.name);
    return {
      fields,
      rows: (paged.rows || []).map((row) => row.slice(0, fields.length)),
      total: Number(countResult.rows[0][0]),
      page,
      size,
    };
  } finally {
    await conn.close();
  }
};

/** LIKE 关键字归一：% 与 _ 是元字符，用户输入里原样当字面量看待 */
const likeParam = (keyword, upper) => {
  const escaped = String(keyword).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const wrapped = `%${escaped}%`;
  return upper ? wrapped.toUpperCase() : wrapped;
};

/**
 * 1.9.1 表清单：`[{ name, comment }]`（comment 可为 null）。
 * mysql → information_schema.TABLES（绑定当前库名 + keyword LIKE）；
 * oracle → ALL_TABLES LEFT JOIN ALL_TAB_COMMENTS（owner = username 大写）。
 */
const listTables = async (ds, keyword) => {
  if (ds.type === 'mysql') {
    const conn = await openMysql(ds);
    try {
      const like = keyword ? likeParam(keyword) : null;
      const sql = `
        SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment
          FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
           ${like ? 'AND TABLE_NAME LIKE ?' : ''}
         ORDER BY TABLE_NAME LIMIT ${MAX_META_ROWS}`;
      const [rows] = await conn.query(sql, like ? [ds.database, like] : [ds.database]);
      return rows.map((row) => ({ name: String(row.name), comment: row.comment ? String(row.comment) : null }));
    } finally {
      conn.destroy();
    }
  }
  if (ds.type === 'oracle') {
    const conn = await openOracle(ds);
    try {
      const owner = String(ds.username || '').toUpperCase();
      const hasKeyword = Boolean(keyword);
      const sql = `
        SELECT t.TABLE_NAME AS "name", c.COMMENTS AS "comment"
          FROM ALL_TABLES t
          LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
         WHERE t.OWNER = :owner${hasKeyword ? " AND t.TABLE_NAME LIKE :keyword" : ''}
         ORDER BY t.TABLE_NAME`;
      const binds = hasKeyword ? { owner, keyword: likeParam(keyword, true) } : { owner };
      const { rows } = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: MAX_META_ROWS });
      if (rows.length) {
        return rows.map((row) => ({ name: String(row[0]), comment: row[1] === null || row[1] === undefined ? null : String(row[1]) }));
      }
      // owner 精确匹配查不到时，放宽到该账号 ALL_TABLES 可见的全部 schema，名字带 schema. 前缀（列查询已支持前缀）
      const fallbackSql = `
        SELECT t.OWNER || '.' || t.TABLE_NAME AS "name", c.COMMENTS AS "comment"
          FROM ALL_TABLES t
          LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
         WHERE t.OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','APPQOSSYS','WMSYS','XDB','ORDSYS','MDSYS')${hasKeyword ? ' AND t.TABLE_NAME LIKE :keyword' : ' AND t.OWNER = :owner'}
         ORDER BY t.OWNER, t.TABLE_NAME`;
      const fb = await conn.execute(fallbackSql, hasKeyword ? { keyword: likeParam(keyword, true) } : { owner }, { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: MAX_META_ROWS });
      return fb.rows.map((row) => ({ name: String(row[0]), comment: row[1] === null || row[1] === undefined ? null : String(row[1]) }));
    } finally {
      await conn.close();
    }
  }
  throw dataQueryFailed(`暂不支持 ${ds.type} 类型的元数据浏览（postgresql 驱动二阶段接入）`);
};

/**
 * 1.9.1 列清单：`[{ name, type, nullable, comment }]`。
 * tableName 先过 IDENT_RE 白名单，再以绑定参数下发（列名查询本身不拼接标识符）。
 */
const listColumns = async (ds, tableName) => {
  const ident = assertIdent(tableName, '表名');
  const parts = ident.includes('.') ? ident.split('.') : [null, ident];
  const pureName = parts[parts.length - 1];

  if (ds.type === 'mysql') {
    const conn = await openMysql(ds);
    try {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME AS name,
                UPPER(DATA_TYPE) AS dataType,
                CHARACTER_MAXIMUM_LENGTH AS charLen,
                NUMERIC_PRECISION AS numPrecision,
                NUMERIC_SCALE AS numScale,
                IS_NULLABLE AS nullable,
                COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [ds.database, pureName]
      );
      return rows.map((row) => {
        let type = String(row.dataType);
        // VARCHAR/CHAR 带长度、DECIMAL 带精度，其余（BIGINT/TEXT/DATETIME）保持干净类型名
        if (['VARCHAR', 'CHAR', 'NVARCHAR'].includes(type) && row.charLen) type = `${type}(${row.charLen})`;
        else if (row.dataType === 'DECIMAL' && row.numPrecision) type = `${type}(${row.numPrecision},${row.numScale || 0})`;
        return {
          name: String(row.name),
          type,
          nullable: String(row.nullable).toUpperCase() === 'YES',
          comment: row.comment ? String(row.comment) : null,
        };
      });
    } finally {
      conn.destroy();
    }
  }
  if (ds.type === 'oracle') {
    const conn = await openOracle(ds);
    try {
      // 带 schema 前缀时用前缀作 owner，否则按契约用数据源 username 大写
      const owner = (parts[0] || String(ds.username || '')).toUpperCase();
      const result = await conn.execute(
        `SELECT col.COLUMN_NAME AS name, col.DATA_TYPE AS dataType,
                col.DATA_LENGTH AS dataLength, col.DATA_PRECISION AS dataPrecision,
                col.DATA_SCALE AS dataScale, col.NULLABLE AS nullable,
                cc.COMMENTS AS "comment"
           FROM ALL_TAB_COLUMNS col
           LEFT JOIN ALL_COL_COMMENTS cc
             ON cc.OWNER = col.OWNER AND cc.TABLE_NAME = col.TABLE_NAME AND cc.COLUMN_NAME = col.COLUMN_NAME
          WHERE col.OWNER = :owner AND col.TABLE_NAME = :tableName
          ORDER BY col.COLUMN_ID`,
        { owner, tableName: pureName.toUpperCase() },
        { outFormat: oracledb.OUT_FORMAT_ARRAY }
      );
      const rows = result.rows || [];
      return rows.map((row) => {
        const [columnName, rawType, dataLength, dataPrecision, dataScale, nullableFlag, comment] = row;
        const base = String(rawType);
        let type = base;
        // NUMBER 带精度时给 NUMBER(p,s)（契约示例里 SID 是 NUMBER(16,0)），字符类型带长度，其余保持裸类型
        if (base === 'NUMBER' && dataPrecision !== null && dataPrecision !== undefined) {
          type = `${base}(${dataPrecision},${dataScale || 0})`;
        } else if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR'].includes(base) && dataLength) {
          type = `${base}(${dataLength})`;
        }
        return {
          name: String(columnName),
          type,
          nullable: String(nullableFlag).toUpperCase() === 'Y',
          comment: comment === null || comment === undefined ? null : String(comment),
        };
      });
    } finally {
      await conn.close();
    }
  }
  throw dataQueryFailed(`暂不支持 ${ds.type} 类型的元数据浏览（postgresql 驱动二阶段接入）`);
};

module.exports = {
  query,
  queryCustom,
  listTables,
  listColumns,
  assertIdent,
  assertReadOnlySql,
  prepareBindings,
  IDENT_RE,
  QUERY_TIMEOUT_MS,
  MAX_META_ROWS,
  MAX_PAGE_SIZE,
  configRef: config,
};
