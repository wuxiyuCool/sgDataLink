/**
 * MySQL 模式启动装配：建表 + ID 序列初始化 + 表结构与仓储列定义校验。
 *
 * 为什么要有校验：schema.sql 是人工维护的 DDL，各 <name>.store.js 的 columns 是另一份声明，
 * 两者一旦漂移，问题会在运行期以「Unknown column」的形式冒出来。这里在启动时一次性比对
 * information_schema，缺列就直接抛错（宁可起不来，也不要半能用）。
 *
 * ID 序列（databridge_id_seq）复刻 memoryStore 的「prefix + 自增」语义：
 * 首次遇到某个前缀时，取「表里现有的最大数字后缀」与「种子起始值」的较大者作为基准，
 * 之后每次取号都在同一条 UPDATE 里用 LAST_INSERT_ID(next_val + 1) 原子自增。
 */
const fs = require('fs');
const path = require('path');
const db = require('./mysql');
const logger = require('../config/logger');
const config = require('../config/config');
const { SEQ_TABLE, SCHEMA_SPECS } = require('../repositories/mysql/sqlStore');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

/** 与 memoryStore 各 store 的 prefix / startId 一一对应 */
const ID_SEQUENCES = [
  { prefix: 'ds-', startId: 1000, table: 'databridge_datasource' },
  { prefix: 'task-', startId: 2000, table: 'databridge_sync_task' },
  { prefix: 'inst-', startId: 3000, table: 'databridge_task_instance' },
  { prefix: 'log-', startId: 5000, table: 'databridge_run_log' },
  { prefix: 'ofs-', startId: 6000, table: 'databridge_offset' },
  { prefix: 'pipe-', startId: 7000, table: 'databridge_pipeline' },
  { prefix: 'df-', startId: 7500, table: 'databridge_dataflow' },
  { prefix: 'api-', startId: 8000, table: 'databridge_data_api' },
  { prefix: 'ar-', startId: 9000, table: 'databridge_alert_rule' },
  { prefix: 'rec-', startId: 9500, table: 'databridge_alert_record' },
];

/**
 * 启动时要校验列定义的 store。
 * 只是 require 就会让 defineStore 把列定义注册进 sqlStore 的 SCHEMA_SPECS，
 * 这里显式加载一遍，保证独立跑初始化脚本时校验也是完整的。
 */
require('../repositories/mysql/datasource.store');
require('../repositories/mysql/task.store');
require('../repositories/mysql/instance.store');
require('../repositories/mysql/log.store');
require('../repositories/mysql/offset.store');
require('../repositories/mysql/pipeline.store');
require('../repositories/mysql/dataflow.store');
require('../repositories/mysql/dataapi.store');
require('../repositories/mysql/alertrule.store');
require('../repositories/mysql/alertrecord.store');

/**
 * 把 schema.sql 切成逐条 DDL。
 * 只做行级 `--` 注释剥离与分号切分：DDL 里没有字符串字面量含分号的情况，
 * 且刻意不使用 multipleStatements，一条一条执行更利于定位失败点。
 * @returns {Array<string>}
 */
const readStatements = () => {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8').replace(/^\s*--.*$/gm, '');
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 10);
};

/** 逐表 CREATE TABLE IF NOT EXISTS（每张表自带 utf8mb4 字符集与排序规则） */
const createTables = async () => {
  const statements = readStatements();
  // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
  for (const statement of statements) {
    // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
    await db.run(statement);
  }
  logger.info('mysql schema ready: %d statements applied', statements.length);
};

/** 表实际拥有的列 */
const loadActualColumns = async (tables) => {
  const placeholders = tables.map(() => '?').join(', ');
  const rows = await db.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    tables
  );
  return rows.reduce((acc, row) => {
    const key = String(row.tableName).toLowerCase();
    acc[key] = acc[key] || [];
    acc[key].push(String(row.columnName).toLowerCase());
    return acc;
  }, {});
};

/**
 * 仓储列类型 -> 兜底 DDL 类型。
 * schema.sql 是权威定义（长度/字符集更精确），这里只在「旧库缺新列」时补一个可空列，
 * 保证升级（如 1.9.2 给 databridge_data_api 加 sql_mode / custom_sql）不需要人工跑迁移。
 */
const FALLBACK_COLUMN_TYPES = {
  str: 'VARCHAR(255)',
  text: 'TEXT',
  json: 'JSON',
  int: 'BIGINT',
  num: 'DOUBLE',
  bool: 'TINYINT(1)',
  datetime: 'DATETIME(3)',
};

/**
 * 校验每张表都包含 store 声明的列：表不存在直接抛错；
 * 缺列时补一次 ALTER TABLE ADD COLUMN（可空，不影响既有行），补不上才算失败。
 * 多出的列只告警 —— 内存版没有 schema，允许库里留额外列。
 * @throws {Error} 表不存在或补列失败
 */
const validateColumns = async () => {
  const entries = SCHEMA_SPECS.map((spec) => ({
    table: spec.table,
    expected: Object.values(spec.columns)
      .map((column) => ({ col: column.col.toLowerCase(), type: column.type }))
      // extra / seq 是 sqlStore 的公共列（seq 是自增主键），缺失不能自动补，只能报错
      .concat([{ col: 'extra', type: 'json' }, { col: 'seq', type: null }]),
  }));
  const actual = await loadActualColumns(entries.map((entry) => entry.table).concat(SEQ_TABLE));
  const problems = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const { table, expected } of entries) {
    const columns = actual[table.toLowerCase()];
    if (!columns) {
      problems.push(`表 ${table} 不存在`);
      // eslint-disable-next-line no-continue
      continue;
    }
    const missing = expected.filter((column) => !columns.includes(column.col));
    // eslint-disable-next-line no-restricted-syntax
    for (const column of missing) {
      const ddlType = FALLBACK_COLUMN_TYPES[column.type];
      if (!ddlType) {
        problems.push(`表 ${table} 缺少列 ${column.col}`);
        // eslint-disable-next-line no-continue
        continue;
      }
      try {
        // 表名 / 列名均来自本仓库内的 store 定义（不接受外部输入），标识符按 ` 包裹
        // eslint-disable-next-line no-await-in-loop
        await db.run(`ALTER TABLE \`${table}\` ADD COLUMN \`${column.col}\` ${ddlType} NULL`);
        logger.warn('table %s missing column %s -> added as %s', table, column.col, ddlType);
      } catch (err) {
        problems.push(`表 ${table} 缺少列 ${column.col} 且自动补列失败: ${err.message}`);
      }
    }
    const extraColumns = columns.filter((column) => !expected.some((item) => item.col === column));
    if (extraColumns.length) {
      logger.warn('table %s has columns not declared by the store: %s', table, extraColumns.join(', '));
    }
  }
  if (problems.length) {
    throw new Error(`MySQL 表结构与仓储列定义不一致：\n  - ${problems.join('\n  - ')}`);
  }
};

/**
 * ID 序列初始化：基准值 = max(种子起始值, 表内现有最大数字后缀)。
 * 已存在的序列只往上顶、不回退，所以重复启动与并发启动都安全。
 */
const ensureSequences = async () => {
  // eslint-disable-next-line no-restricted-syntax
  for (const { prefix, startId, table } of ID_SEQUENCES) {
    // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
    const rows = await db.query(`SELECT \`id\` FROM \`${table}\` WHERE \`id\` LIKE ?`, [`${prefix}%`]);
    const maxExisting = rows.reduce((max, row) => {
      const numeric = Number(String(row.id).slice(prefix.length));
      return Number.isFinite(numeric) && numeric > max ? numeric : max;
    }, 0);
    const base = Math.max(startId, maxExisting);
    // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
    await db.run(
      `INSERT INTO \`${SEQ_TABLE}\` (id_prefix, next_val) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE next_val = GREATEST(next_val, ?)`,
      [prefix, base, base]
    );
  }
  logger.info('mysql id sequences ready: %d prefixes', ID_SEQUENCES.length);
};

/**
 * MySQL 模式初始化：建池 -> 建表 -> 校验列 -> 初始化序列。
 * @returns {Promise<{driver: string, database: string}>}
 */
const initMysql = async () => {
  // 连一次库把错误尽早暴露出来（池是懒连接的，不测就一直不到真正建连）
  await db.query('SELECT 1');
  await createTables();
  await validateColumns();
  await ensureSequences();
  logger.info(
    'mysql driver enabled: %s@%s:%d/%s, connectionLimit=%d, schema=%s',
    config.db.mysql.user,
    config.db.mysql.host,
    config.db.mysql.port,
    config.db.mysql.database,
    config.db.mysql.connectionLimit,
    path.basename(SCHEMA_FILE)
  );
  return { driver: 'mysql', database: config.db.mysql.database };
};

module.exports = {
  ID_SEQUENCES,
  SCHEMA_FILE,
  readStatements,
  createTables,
  ensureSequences,
  validateColumns,
  initMysql,
};
