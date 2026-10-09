/**
 * SQL 方言层（契约 1.12 §6.4）：mysql / oracle 之间所有「SQL 文本差异」的唯一来源。
 *
 * 编译器（metricCompiler）、物化任务（metrictask）、模型 DDL 预览（metricmodel）、
 * 数据预览（metricExec）都只向这里取片段，不再各写各的 `ds.type === 'oracle'` 分支。
 * 收成一个文件的原因很具体：每漏一处就产出一个必然失败的语句 —— Oracle 目标表被建成
 * 反引号 + ENGINE=InnoDB、日期用裸字符串比较触发 ORA-01861、FETCH FIRST 在 11g 语法错，
 * 而这些决定全部源自同一个「目标库是哪家」的判断。
 *
 * 约定：标识符已由上游按 IDENT 白名单落库，这里只做形式转换，不再校验业务语义。
 */
const { paramInvalid } = require('./bizError');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;

const assertDate = (label, value) => {
  if (!DATE_PATTERN.test(String(value || ''))) throw paramInvalid(`${label} 需为 YYYY-MM-DD`);
  return String(value);
};

const assertTargetIdent = (label, name) => {
  const value = String(name || '');
  if (!IDENT_PATTERN.test(value)) throw paramInvalid(`${label} 非法（标识符白名单）: ${value}`);
  return value;
};

/* ---------------- 类型映射 ---------------- */

/** MySQL 风格类型 → Oracle 类型；按前缀首个命中（顺序敏感：TINYINT 要先于 INT） */
const ORACLE_TYPE_MAP = [
  ['VARCHAR', (n) => `VARCHAR2(${n[0] || 64})`],
  ['CHAR', (n) => `CHAR(${n[0] || 1})`],
  ['TINYINT', () => 'NUMBER(3)'],
  ['SMALLINT', () => 'NUMBER(5)'],
  ['BIGINT', () => 'NUMBER(19)'],
  ['INT', () => 'NUMBER(10)'],
  ['INTEGER', () => 'NUMBER(10)'],
  ['DECIMAL', (n) => `NUMBER(${n[0] || 24},${n[1] === undefined ? 6 : n[1]})`],
  ['NUMERIC', (n) => `NUMBER(${n[0] || 24},${n[1] === undefined ? 6 : n[1]})`],
  ['FLOAT', () => 'BINARY_DOUBLE'],
  ['DOUBLE', () => 'BINARY_DOUBLE'],
  ['DATETIME', () => 'TIMESTAMP'],
  ['TIMESTAMP', () => 'TIMESTAMP'],
  ['DATE', () => 'DATE'],
  ['TEXT', () => 'CLOB'],
];
/** 已是 Oracle 侧类型的直通（手工列/引用源库元数据时常见） */
const ORACLE_NATIVE = /^(VARCHAR2|NUMBER|BINARY_FLOAT|BINARY_DOUBLE|TIMESTAMP|CLOB)\b/;

const assertOracleLength = (rendered) => {
  const n = Number((rendered.match(/\((\d+)/) || [])[1]);
  if (n > 4000) throw paramInvalid(`Oracle VARCHAR2/CHAR 上限 4000，当前 ${rendered}；请缩短列宽或在源侧截取`);
  return rendered;
};

const oracleType = (type) => {
  const raw = String(type || '')
    .toUpperCase()
    .trim();
  if (ORACLE_NATIVE.test(raw)) return raw;
  const nums = (raw.match(/\d+/g) || []).map(Number);
  const base = raw.replace(/\(.*/, '').trim();
  const hit = ORACLE_TYPE_MAP.find(([prefix]) => base.startsWith(prefix));
  return assertOracleLength(hit ? hit[1](nums, base) : 'VARCHAR2(255)');
};

/* ---------------- 函数归一与方言告警 ---------------- */

/** 两库都支持的 ANSI 写法优先：编译期改写，用户界面保持原写法 */
const FN_NORMALIZE = [
  [/\b(NVL|IFNULL)\s*\(/gi, 'COALESCE('], // 两家都有 NVL 或 IFNULL，但没有对方的那个
];

/** 只存在于单家库的函数/裸关键字：跨库执行必报 ORA-00904 或 FUNCTION does not exist */
const DIALECT_TOKENS = [
  [/\bDECODE\s*\(/i, 'DECODE', 'oracle'],
  [/\bNVL2\s*\(/i, 'NVL2', 'oracle'],
  [/\bTO_CHAR\s*\(/i, 'TO_CHAR', 'oracle'],
  [/\bTO_DATE\s*\(/i, 'TO_DATE', 'oracle'],
  [/\bTO_NUMBER\s*\(/i, 'TO_NUMBER', 'oracle'],
  [/\bNUMTODSINTERVAL\s*\(/i, 'NUMTODSINTERVAL', 'oracle'],
  [/\bREGEXP_LIKE\s*\(/i, 'REGEXP_LIKE', 'oracle'],
  [/\bTRUNC\s*\(/i, 'TRUNC', 'oracle'], // MySQL 的 TRUNC 只截数值，日期语义会静默出错
  [/\bSYSDATE\b/i, 'SYSDATE', 'oracle'],
  [/\bROWNUM\b/i, 'ROWNUM', 'oracle'],
  [/\bDATE_FORMAT\s*\(/i, 'DATE_FORMAT', 'mysql'],
  [/\bSTR_TO_DATE\s*\(/i, 'STR_TO_DATE', 'mysql'],
  [/\bGROUP_CONCAT\s*\(/i, 'GROUP_CONCAT', 'mysql'],
  [/\bSUBSTRING_INDEX\s*\(/i, 'SUBSTRING_INDEX', 'mysql'],
  [/\bFIND_IN_SET\s*\(/i, 'FIND_IN_SET', 'mysql'],
  [/\bIF\s*\(/i, 'IF', 'mysql'], // Oracle 无 IF() 函数，需 CASE WHEN
];

/** DATE_FORMAT 的 %码 → Oracle 格式模型；掩码里出现未覆盖的 %码则整体不翻译 */
const ORACLE_MASK = [
  ['%Y', 'YYYY'],
  ['%m', 'MM'],
  ['%d', 'DD'],
  ['%H', 'HH24'],
  ['%i', 'MI'],
  ['%s', 'SS'],
  ['%y', 'YY'],
  ['%M', 'MON'],
  ['%D', 'DY'],
];

const translateMask = (mask) => {
  const out = ORACLE_MASK.reduce((acc, [code, fmt]) => acc.split(code).join(fmt), mask);
  return /%[A-Za-z]/.test(out) ? null : out;
};

/** 只处理「首参不含逗号、掩码为单引号字面量」的常见写法；复杂嵌套交 warnings 人工改写 */
const DATE_FORMAT_CALL = /\bDATE_FORMAT\s*\(\s*([^,)]+)\s*,\s*'([^']+)'\s*\)/gi;

const rewriteDateFormat = (expr) =>
  String(expr).replace(DATE_FORMAT_CALL, (all, arg, mask) => {
    const fmt = translateMask(mask);
    return fmt ? `TO_CHAR(${String(arg).trim()},'${fmt}')` : all;
  });

const normalizeExpr = (type, expr) => {
  let out = String(expr || '');
  FN_NORMALIZE.forEach(([re, to]) => {
    out = out.replace(re, to);
  });
  if (type === 'oracle') out = rewriteDateFormat(out);
  return out;
};

/**
 * 保存期方言告警（不阻断）：表达式里出现「只有对方库认」的写法时给出可执行的提示。
 * 已被归一化消化掉的写法不再唠叨（NVL/IFNULL 恒改写；oracle 目标上的 DATE_FORMAT 翻译成功即视为已处理）。
 */
const dialectWarnings = (type, label, exprs) => {
  const raw = (Array.isArray(exprs) ? exprs : [exprs]).filter(Boolean).join(' ');
  const normalized = normalizeExpr(type, raw);
  const other = type === 'oracle' ? 'mysql' : 'oracle';
  const hits = DIALECT_TOKENS.filter(([re, fn, owner]) => {
    if (!re.test(raw)) return false;
    if ((fn === 'NVL' || fn === 'IFNULL') && !re.test(normalized)) return false;
    if (owner === 'mysql' && type === 'oracle' && !re.test(normalized)) return false;
    return true;
  });
  const warnings = hits.map(([, fn, owner]) =>
    owner === other
      ? `${label}含 ${owner} 专属写法 ${fn}，在 ${type} 数据源上执行会报错${
          fn === 'DATE_FORMAT' ? '（常用掩码可自动翻译为 TO_CHAR，含未知 %码 时需手工改写）' : ''
        }`
      : `${label}含 ${type} 专属写法 ${fn}，迁到 ${other} 数据源会报错`
  );
  if (type === 'oracle' && /\bDATE_FORMAT\s*\(/i.test(normalized)) {
    warnings.push(`${label}的 DATE_FORMAT 掩码含未支持的 %码，Oracle 侧需手工改写为 TO_CHAR 格式模型`);
  }
  return [...new Set(warnings)];
};

/* ---------------- 时间过滤（两家共用形状，只差日期字面量） ---------------- */

const buildTimeFilter = (dateLiteral) => (timeColumn, dateRange) => {
  if (!dateRange || (!dateRange.start && !dateRange.end)) return null;
  if (!timeColumn) throw paramInvalid('模型未配置时间列，无法按时间范围编译（可在模型上设置 timeColumn）');
  const col = `t.${timeColumn}`;
  if (dateRange.start && dateRange.end) {
    return `${col} BETWEEN ${dateLiteral(assertDate('dateRange.start', dateRange.start))} AND ${dateLiteral(
      assertDate('dateRange.end', dateRange.end)
    )}`;
  }
  if (dateRange.start) return `${col} >= ${dateLiteral(assertDate('dateRange.start', dateRange.start))}`;
  return `${col} <= ${dateLiteral(assertDate('dateRange.end', dateRange.end))}`;
};

/* ---------------- 方言定义 ---------------- */

const MYSQL = {
  type: 'mysql',
  supports: { createIfNotExists: true, upsertOnDuplicate: true, emptyStringIsNull: false },
  dual: '',
  nowExpr: 'NOW()',
  etlColumn: '_etl_time',
  ident: (name) => `\`${assertTargetIdent('列名', name)}\``,
  table: (name) => `\`${assertTargetIdent('表名', name)}\``,
  /** FROM 子句里的源表：保持登记原样（可能带 schema 前缀），不做引号包裹 */
  sourceTable: (name) => String(name || ''),
  dateLiteral: (value) => `'${assertDate('日期', value)}'`,
  timeFilter: buildTimeFilter((value) => `'${value}'`),
  columnType: (type) => {
    const raw = String(type || '')
      .toUpperCase()
      .trim();
    return raw.replace(/^NUMERIC/, 'DECIMAL');
  },
  normalize: (expr) => normalizeExpr('mysql', expr),
  warnings: (label, exprs) => dialectWarnings('mysql', label, exprs),
  createTable: ({ table, defs }) =>
    `CREATE TABLE IF NOT EXISTS \`${assertTargetIdent('表名', table)}\` (${defs.join(
      ', '
    )}) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  tableExistsProbe: () => null,
  clearTarget: (table) => `TRUNCATE TABLE \`${assertTargetIdent('表名', table)}\``,
  limit: (sql, limit) => `${sql} LIMIT ${limit}`,
  upsertTail: (updateCols) =>
    ` ON DUPLICATE KEY UPDATE ${updateCols.map((col) => `\`${col}\` = VALUES(\`${col}\`)`).join(', ')}, \`${
      MYSQL.etlColumn
    }\` = ${MYSQL.nowExpr}`,
};

const ORACLE = {
  type: 'oracle',
  // 无 IF NOT EXISTS（12cR2 起才有）、无 ON DUPLICATE（需 MERGE INTO）、空串等价 NULL
  supports: { createIfNotExists: false, upsertOnDuplicate: false, emptyStringIsNull: true },
  dual: ' FROM DUAL',
  nowExpr: 'SYSDATE',
  // 非引号标识符必须字母开头，`_ETL_TIME` 会 ORA-00911 → 目标表 ETL 列改叫 ETL_TIME
  etlColumn: 'ETL_TIME',
  ident: (name) => assertTargetIdent('列名', name).toUpperCase(),
  table: (name) => assertTargetIdent('表名', name).toUpperCase(),
  sourceTable: (name) => String(name || '').toUpperCase(),
  dateLiteral: (value) => `TO_DATE('${assertDate('日期', value)}','YYYY-MM-DD')`,
  timeFilter: buildTimeFilter((value) => `TO_DATE('${value}','YYYY-MM-DD')`),
  columnType: oracleType,
  normalize: (expr) => normalizeExpr('oracle', expr),
  warnings: (label, exprs) => dialectWarnings('oracle', label, exprs),
  createTable: ({ table, defs }) => `CREATE TABLE ${assertTargetIdent('表名', table).toUpperCase()} (${defs.join(', ')})`,
  // 幂等建表靠数据字典探测：已存在则跳过 CREATE（等价 MySQL 的 IF NOT EXISTS）
  tableExistsProbe: (table) =>
    `SELECT COUNT(*) AS CNT FROM user_tables WHERE table_name = '${assertTargetIdent('表名', table).toUpperCase()}'`,
  clearTarget: (table) => `TRUNCATE TABLE ${assertTargetIdent('表名', table).toUpperCase()}`,
  // FETCH FIRST 要 12c+；与引擎侧 dbio 的 oracle 分页保持一致 —— ROWNUM 嵌套（11g/12c 通用）
  limit: (sql, limit) => `SELECT * FROM (${sql}) dbr_page WHERE ROWNUM <= ${limit}`,
  upsertTail: () => {
    throw paramInvalid('oracle 目标表一期不支持 upsert（需 MERGE INTO，未实现），请改用 overwrite 或 append');
  },
};

const registry = { mysql: MYSQL, oracle: ORACLE };

const dialectOf = (type) => {
  const dialect = registry[String(type || '').toLowerCase()];
  if (!dialect) throw paramInvalid(`方言层目前只支持 ${Object.keys(registry).join(' / ')}，当前数据源类型: ${type || '空'}`);
  return dialect;
};

/** 入参可以是数据源类型字符串或数据源对象 */
const dialectOfSource = (source) => dialectOf(typeof source === 'string' ? source : (source || {}).type);

module.exports = {
  DATE_PATTERN,
  IDENT_PATTERN,
  DIALECT_TOKENS,
  ORACLE_TYPE_MAP,
  assertDate,
  assertTargetIdent,
  assertOracleLength,
  oracleType,
  normalizeExpr,
  dialectWarnings,
  dialectOf,
  dialectOfSource,
  mysql: MYSQL,
  oracle: ORACLE,
};
