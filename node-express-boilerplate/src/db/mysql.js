/**
 * MySQL 连接池（DataBridge 管理后端第二阶段的持久化通道）。
 *
 * 设计要点：
 * - 池参数全部来自 src/config/config.js 的 `db.mysql`（env MYSQL_* / DB_DRIVER），
 *   connectionLimit 默认 10，charset 固定 utf8mb4（目标库默认字符集是 utf8，
 *   因此建表必须逐表显式声明 utf8mb4，见 src/db/schema.sql）。
 * - `dateStrings: true`：DATETIME 一律以字符串返回，避免驱动按本地时区解析 Date，
 *   时间列的 ISO(UTC)  <->  DB 格式转换统一在 src/repositories/mysql/sqlStore.js 里做。
 * - 池是懒加载的：`getMysqlPool()` 第一次调用才建，因此 memory 驱动下 require 本文件
 *   不会产生任何网络行为。
 * - `probeMysqlConnection()` 供数据源连通测试（POST /datasources/test）用，
 *   独立短连接，5s 超时，不占用业务池。
 */
const mysql = require('mysql2/promise');
const config = require('../config/config');

/** 连通测试超时（毫秒），契约要求真实建连但不希望前端长时间等待 */
const PROBE_CONNECT_TIMEOUT_MS = 5000;

let pool = null;

/** 归一化后的池参数（测试与运行时共用一份口径） */
const poolOptions = () => {
  const mysqlConfig = config.db.mysql || {};
  return {
    host: mysqlConfig.host,
    port: Number(mysqlConfig.port) || 3306,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
    connectionLimit: Number(mysqlConfig.connectionLimit) || 10,
    queueLimit: 0,
    waitForConnections: true,
    charset: 'UTF8MB4',
    dateStrings: true,
    // 长连接空闲时保持心跳，避免内网 NAT 把连接掐掉后第一次请求报错
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: Number(mysqlConfig.connectTimeoutMs) || 10000,
    // 只允许单条语句，避免拼接式 SQL 带来的注入面
    multipleStatements: false,
  };
};

/** 取（或懒建）连接池 */
const getMysqlPool = () => {
  if (!pool) pool = mysql.createPool(poolOptions());
  return pool;
};

/**
 * 查询并返回结果行。
 * @param {string} sql 带 ? 占位符的 SQL
 * @param {Array} [params] 参数（一律走占位符，不拼接）
 * @returns {Promise<Array>}
 */
const query = async (sql, params = []) => {
  const [rows] = await getMysqlPool().query(sql, params);
  return rows;
};

/**
 * 执行写入 / DDL，返回结果头 { affectedRows, insertId, warningStatus }。
 * 与 query() 一样走文本协议（参数由驱动转义），不使用 prepared statement，
 * 以便 JSON 列与 LIMIT/OFFSET 的绑定行为在 5.7 上保持一致。
 * @param {string} sql
 * @param {Array} [params]
 * @returns {Promise<{affectedRows: number, insertId: number}>}
 */
const run = async (sql, params = []) => {
  const [result] = await getMysqlPool().query(sql, params);
  return result || {};
};

/**
 * 一次拿多组查询结果（同一连接串行执行，减少池占用）。
 * @param {Array<[string, Array]>} statements [[sql, params]]
 * @returns {Promise<Array>} 按入参顺序的结果行数组
 */
const queryMany = async (statements = []) => {
  const connection = await getMysqlPool().getConnection();
  try {
    const results = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const [sql, params] of statements) {
      // 串行是有意的：并发跑在同一条连接上会串包
      // eslint-disable-next-line no-await-in-loop
      const [rows] = await connection.query(sql, params || []);
      results.push(rows);
    }
    return results;
  } finally {
    connection.release();
  }
};

/** 关闭连接池（优雅退出用，重复调用安全） */
const closeMysqlPool = async () => {
  if (!pool) return false;
  const closing = pool;
  pool = null;
  await closing.end();
  return true;
};

/**
 * 真实连通测试：独立短连接执行 `SELECT 1`。
 * @param {Object} connConfig { host, port, database, username, password }
 * @returns {Promise<{success: boolean, latencyMs: number, message: string}>}
 */
const probeMysqlConnection = async (connConfig = {}) => {
  const started = Date.now();
  let connection;
  try {
    connection = await mysql.createConnection({
      host: connConfig.host,
      port: Number(connConfig.port) || 3306,
      user: connConfig.username,
      password: connConfig.password === undefined || connConfig.password === null ? '' : String(connConfig.password),
      database: connConfig.database || undefined,
      charset: 'UTF8MB4',
      dateStrings: true,
      connectTimeout: PROBE_CONNECT_TIMEOUT_MS,
    });
    await connection.query('SELECT 1');
    return {
      success: true,
      latencyMs: Date.now() - started,
      message: `连接成功: mysql://${connConfig.host}:${Number(connConfig.port) || 3306}/${connConfig.database || ''}`,
    };
  } catch (err) {
    const code = err && err.code ? err.code : 'UNKNOWN_ERROR';
    return {
      success: false,
      latencyMs: Date.now() - started,
      message: `连接失败(${code}): ${err && err.message ? err.message : code}`,
    };
  } finally {
    if (connection) {
      // end() 失败只影响本次测试，不向上冒泡
      await connection.end().catch(() => {});
    }
  }
};

module.exports = {
  PROBE_CONNECT_TIMEOUT_MS,
  poolOptions,
  getMysqlPool,
  query,
  queryMany,
  run,
  closeMysqlPool,
  probeMysqlConnection,
};
