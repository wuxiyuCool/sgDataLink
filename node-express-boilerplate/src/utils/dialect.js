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

const assertSourceRef = (label, name) => {
  const value = String(name || '');
  if (!IDENT_PATTERN.test(value)) throw paramInvalid(`${label} 非法（标识符白名单）: ${value}`);
  return value;
};

const assertDate = (label, value) => {
  if (!DATE_PATTERN.test(String(value || ''))) throw paramInvalid(`${label} 需为 YYYY-MM-DD`);
  return String(value);
};

const assertTargetIdent = (label, name) => {
  const value = String(name || '');
  if (!IDENT_PATTERN.test(value)) throw paramInvalid(`${label} 非法（标识符白名单）: ${value}`);
  return value;
};

/* ---------------- 字段类型目录（界面录入与 DDL 生成共用口径） ---------------- */

/**
 * 类型族：库里存的 dataType 一律是 MySQL 风格规范串（如 VARCHAR(64)/DECIMAL(18,4)），
 * Oracle 侧由 oracleType 映射。界面只让用户选族 + 填长度/小数位，避免手打 `varchar`
 * 这种无长度串直接进 DDL（MySQL 建表会语法错，Oracle 侧 VARCHAR 同样非法）。
 */
const COLUMN_FAMILIES = [
  { family: 'VARCHAR', label: '变长字符串', hasLength: true, defaultLength: 64, max: { mysql: 65535, oracle: 4000 } },
  { family: 'CHAR', label: '定长字符串', hasLength: true, defaultLength: 1, max: { mysql: 255, oracle: 2000 } },
  { family: 'TEXT', label: '长文本', oracleAs: 'CLOB' },
  { family: 'INT', label: '整数', oracleAs: 'NUMBER(10)' },
  { family: 'BIGINT', label: '长整数', oracleAs: 'NUMBER(19)' },
  {
    family: 'DECIMAL',
    label: '定点数（金额/比率）',
    hasScale: true,
    defaultPrecision: 18,
    defaultScale: 4,
    oracleBase: 'NUMBER',
  },
  { family: 'DATE', label: '日期' },
  { family: 'DATETIME', label: '日期时间', oracleAs: 'TIMESTAMP' },
  { family: 'TIMESTAMP', label: '时间戳' },
];
const FAMILY_BY_NAME = COLUMN_FAMILIES.reduce((acc, item) => ({ ...acc, [item.family]: item }), {});
/** 源库原生类型别名 → 归一到族（引用表时拿到的是各家原生写法） */
const FAMILY_ALIASES = {
  VARCHAR2: 'VARCHAR',
  NVARCHAR: 'VARCHAR',
  NCHAR: 'CHAR',
  CHARACTER: 'CHAR',
  STRING: 'VARCHAR',
  NUMBER: 'DECIMAL',
  NUMERIC: 'DECIMAL',
  INTEGER: 'INT',
  SMALLINT: 'INT',
  TINYINT: 'INT',
  MEDIUMINT: 'INT',
  FLOAT: 'DECIMAL',
  DOUBLE: 'DECIMAL',
  REAL: 'DECIMAL',
  DATETIME2: 'DATETIME',
  TIME: 'VARCHAR',
  CLOB: 'TEXT',
  BLOB: 'TEXT',
  JSON: 'TEXT',
};

const parseColumnType = (raw) => {
  const text = String(raw || '')
    .trim()
    .toUpperCase();
  if (!text) return { family: 'VARCHAR', length: 64, scale: undefined };
  const base = text.replace(/\(.*/, '').trim();
  // 只取括号内的数字：VARCHAR2 的「2」属于类型名，不是长度
  const [, argList] = text.match(/\(([^)]*)\)/) || [];
  const nums = argList ? (argList.match(/\d+/g) || []).map(Number) : [];
  const named = FAMILY_BY_NAME[base] ? base : FAMILY_ALIASES[base];
  const family = named || 'VARCHAR';
  const spec = FAMILY_BY_NAME[family] || FAMILY_BY_NAME.VARCHAR;
  if (spec.hasLength) return { family, length: nums[0] || spec.defaultLength, scale: undefined };
  if (spec.hasScale) {
    const [precisionArg, scaleArg] = nums;
    let scale;
    // 只给精度不给小数位（oracle 的 NUMBER(10)）按整数处理，别一律补 4 位小数把量级改掉
    if (scaleArg === undefined) scale = precisionArg ? 0 : spec.defaultScale;
    else scale = scaleArg;
    return { family, length: precisionArg || spec.defaultPrecision, scale };
  }
  return { family, length: undefined, scale: undefined };
};

/**
 * 归一成 MySQL 风格规范串（带必需的长度/小数位）。未知写法兜底成 VARCHAR(默认长度) 而不是抛错，
 * 免得引用表时源库的冷门类型把整个模型保存卡死；但超出目标库上限要给可读拒绝（不能静默截断）。
 */
const composeColumnType = (raw, dialectType = 'mysql') => {
  const { family, length, scale } = parseColumnType(raw);
  const spec = FAMILY_BY_NAME[family];
  if (spec.hasLength) {
    const max = (spec.max && spec.max[dialectType]) || 65535;
    const value = Number(length) || spec.defaultLength;
    if (value > max)
      throw paramInvalid(`${dialectType} 的 ${family} 长度上限 ${max}，当前 ${value}；请缩短列宽或在源侧截取`);
    return `${family}(${value})`;
  }
  if (spec.hasScale) {
    const precision = Number(length) || spec.defaultPrecision;
    const digits = scale === undefined ? spec.defaultScale : scale;
    if (dialectType === 'oracle' && precision > 38)
      throw paramInvalid(`oracle 的 NUMBER 精度上限 38，当前 ${precision}；请缩小精度或改用字符串存`);
    return `${family}(${precision},${digits})`;
  }
  return family;
};

/* ---------------- 类型映射 ---------------- */

/** MySQL 风格类型 → Oracle 类型；按前缀首个命中（顺序敏感：BIGINT 要先于 INT） */
const ORACLE_TYPE_MAP = [
  // 字符串必须带 CHAR 语义：MySQL 的 VARCHAR(n) 按字符计数，Oracle 默认按字节计数，
  // AL32UTF8 下中文一字符 3~4 字节，写成 VARCHAR2(n) 会在物化时 ORA-12899（值太长）
  ['VARCHAR', (n) => `VARCHAR2(${n[0] || 64} CHAR)`],
  ['CHAR', (n) => `CHAR(${n[0] || 1} CHAR)`],
  ['BIGINT', () => 'NUMBER(19)'],
  ['INT', () => 'NUMBER(10)'],
  ['DECIMAL', (n) => `NUMBER(${n[0] || 24},${n[1] === undefined ? 6 : n[1]})`],
  ['FLOAT', () => 'BINARY_DOUBLE'],
  ['DOUBLE', () => 'BINARY_DOUBLE'],
  ['DATETIME', () => 'TIMESTAMP'],
  ['TIMESTAMP', () => 'TIMESTAMP'],
  ['DATE', () => 'DATE'],
  ['TEXT', () => 'CLOB'],
];

/** 入参可以是任意一侧的原生写法：先归一（顺带校验长度上限）再映射 */
const oracleType = (type) => {
  const canonical = composeColumnType(type, 'oracle');
  const nums = (canonical.match(/\d+/g) || []).map(Number);
  const hit = ORACLE_TYPE_MAP.find(([prefix]) => canonical.startsWith(prefix));
  return hit ? hit[1](nums, canonical) : 'VARCHAR2(255)';
};

/**
 * 类型族目录（界面下拉的唯一来源）：label 是中文说明，rendered 是该方言下 DDL 里
 * 真实出现的类型名（Oracle 的字符串是 VARCHAR2、长文本是 CLOB、定点数是 NUMBER(p,s)）。
 */
const columnFamilyCatalog = (dialectType = 'mysql') =>
  COLUMN_FAMILIES.map((item) => ({
    family: item.family,
    label: item.label,
    rendered: dialectType === 'oracle' ? oracleType(item.family) : composeColumnType(item.family, 'mysql'),
    hasLength: Boolean(item.hasLength),
    hasScale: Boolean(item.hasScale),
    defaultLength: item.defaultLength,
    defaultPrecision: item.defaultPrecision,
    defaultScale: item.defaultScale,
    maxLength: (item.max && item.max[dialectType]) || (item.hasScale ? 38 : 65535),
  }));

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

/* ---------------- 时间粒度（指标宽表按时间对齐；只能向粗对齐） ---------------- */

/** 由细到粗；宽表目标粒度必须 ≥ 各指标声明的源粒度，否则会把一个月值摊到 30 天（静默错算） */
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];

const grainRank = (grain) => {
  const index = GRAINS.indexOf(String(grain || '').toLowerCase());
  if (index < 0) throw paramInvalid(`timeGrain ∈ ${GRAINS.join('|')}，当前: ${grain || '空'}`);
  return index;
};

/** 参与对齐的多个源粒度里最粗的那一档（空列表按 day） */
const coarsestGrain = (grains = []) => {
  const ranks = grains.map(grainRank);
  return GRAINS[ranks.length ? Math.max(...ranks) : 0];
};

const MYSQL_TRUNC = {
  day: "DATE_FORMAT(%s, '%Y-%m-%d')",
  week: 'YEARWEEK(%s, 3)',
  month: "DATE_FORMAT(%s, '%Y-%m')",
  quarter: "CONCAT(YEAR(%s), '-Q', QUARTER(%s))",
  year: "DATE_FORMAT(%s, '%Y')",
};

const ORACLE_TRUNC = {
  day: `TO_CHAR(%s, 'YYYY-MM-DD')`,
  week: `TO_CHAR(%s, 'IYYY-IW')`,
  month: `TO_CHAR(%s, 'YYYY-MM')`,
  quarter: `TO_CHAR(%s, 'YYYY-"Q"Q')`,
  year: `TO_CHAR(%s, 'YYYY')`,
};

const buildDateTrunc = (map) => (expr, grain) => map[GRAINS[grainRank(grain)]].replace(/%s/g, expr);

/* ---------------- 方言定义 ---------------- */

const MYSQL = {
  type: 'mysql',
  supports: { createIfNotExists: true, upsertOnDuplicate: true, upsert: true, emptyStringIsNull: false },
  dual: '',
  nowExpr: 'NOW()',
  etlColumn: '_etl_time',
  ident: (name) => `\`${assertTargetIdent('列名', name)}\``,
  table: (name) => `\`${assertTargetIdent('表名', name)}\``,
  /** FROM 子句里的源表：保持登记原样（可能带 schema 前缀），不做引号包裹 */
  sourceTable: (name) => String(name || ''),
  dateLiteral: (value) => `'${assertDate('日期', value)}'`,
  timeFilter: buildTimeFilter((value) => `'${value}'`),
  columnType: (type) => composeColumnType(type, 'mysql'),
  normalize: (expr) => normalizeExpr('mysql', expr),
  warnings: (label, exprs) => dialectWarnings('mysql', label, exprs),
  createTable: ({ table, defs }) =>
    `CREATE TABLE IF NOT EXISTS \`${assertTargetIdent('表名', table)}\` (${defs.join(
      ', '
    )}) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  tableExistsProbe: () => null,
  clearTarget: (table) => `TRUNCATE TABLE \`${assertTargetIdent('表名', table)}\``,
  limit: (sql, limit) => `${sql} LIMIT ${limit}`,
  /** 维度基数预检（超阈值就不取值，防大表 GROUP BY 压库 / 用户ID 灌进 prompt） */
  dimCountSql: ({ table, column }) =>
    `SELECT COUNT(DISTINCT ${MYSQL.ident(column)}) AS dim_count FROM ${assertSourceRef('表名', table)}`,
  /** 维度取值画像：NULL 不进词典，按出现次数取前 N */
  dimProfileSql: ({ table, column, limit }) =>
    `SELECT ${MYSQL.ident(column)} AS dim_value, COUNT(1) AS dim_hits FROM ${assertSourceRef(
      '表名',
      table
    )} WHERE ${MYSQL.ident(column)} IS NOT NULL GROUP BY ${MYSQL.ident(column)} ORDER BY dim_hits DESC LIMIT ${limit}`,
  /**
   * 幂等刷新的 UPDATE 尾巴。
   * etlColumn 由调用方按「目标表到底有没有这一列」传入（传空串则不写留痕列）——
   * 目标结构权威在建模页，任务侧不能凭空写一个表上不存在的列。
   */
  upsertTail: (updateCols, etlColumn = MYSQL.etlColumn) => {
    const parts = updateCols.map((col) => `${MYSQL.ident(col)} = VALUES(${MYSQL.ident(col)})`);
    if (etlColumn) parts.push(`${MYSQL.ident(etlColumn)} = ${MYSQL.nowExpr}`);
    return ` ON DUPLICATE KEY UPDATE ${parts.join(', ')}`;
  },
  dateTrunc: buildDateTrunc(MYSQL_TRUNC),
  /** 幂等刷新：MySQL 用 INSERT .. ON DUPLICATE KEY UPDATE（留痕列在 tail 里统一写） */
  upsertStatement: ({ table, columns, selectSql, updateCols, etlColumn = MYSQL.etlColumn }) =>
    `INSERT INTO ${MYSQL.table(table)} (${columns.map((c) => MYSQL.ident(c)).join(', ')}) ${selectSql}${MYSQL.upsertTail(
      updateCols,
      etlColumn
    )}`,
};

const ORACLE = {
  type: 'oracle',
  // 无 IF NOT EXISTS（12cR2 起才有）、幂等刷新走 MERGE INTO、空串等价 NULL
  supports: { createIfNotExists: false, upsertOnDuplicate: false, upsert: true, emptyStringIsNull: true },
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
  dimCountSql: ({ table, column }) =>
    `SELECT COUNT(DISTINCT ${ORACLE.ident(column)}) AS DIM_COUNT FROM ${assertSourceRef('表名', table).toUpperCase()}`,
  // Oracle 无 LIMIT：内层聚合排序 + 外层 ROWNUM 嵌套（与上面的 limit 同一口径）
  dimProfileSql: ({ table, column, limit }) =>
    `SELECT * FROM (SELECT ${ORACLE.ident(column)} AS DIM_VALUE, COUNT(1) AS DIM_HITS FROM ${assertSourceRef(
      '表名',
      table
    ).toUpperCase()} WHERE ${ORACLE.ident(column)} IS NOT NULL GROUP BY ${ORACLE.ident(
      column
    )} ORDER BY DIM_HITS DESC) dbr_page WHERE ROWNUM <= ${limit}`,
  upsertTail: () => {
    throw paramInvalid('oracle 幂等刷新走 MERGE INTO（不用 upsertTail），请调用 upsertStatement');
  },
  dateTrunc: buildDateTrunc(ORACLE_TRUNC),
  /**
   * 幂等刷新：Oracle 无 ON DUPLICATE KEY，用 MERGE INTO 目标 USING (本次 SELECT)。
   * 别名保持大写无引号（与非引号标识符口径一致），UPDATE 分支不含主键。
   * etlColumn 由调用方按目标表实际列传入（空串=两分支都不写留痕列）。
   */
  upsertStatement: ({ table, columns, keys, selectSql, updateCols, etlColumn = ORACLE.etlColumn }) => {
    const target = ORACLE.table(table);
    const on = keys.map((key) => `s.${ORACLE.ident(key)} = d.${ORACLE.ident(key)}`).join(' AND ');
    const updates = updateCols.map((col) => `s.${ORACLE.ident(col)} = d.${ORACLE.ident(col)}`);
    if (etlColumn) updates.push(`s.${ORACLE.ident(etlColumn)} = ${ORACLE.nowExpr}`);
    const inserts = columns.map((col) => ORACLE.ident(col)).join(', ');
    const values = columns.map((col) => `d.${ORACLE.ident(col)}`).join(', ');
    return `MERGE INTO ${target} s USING (${selectSql}) d ON (${on}) WHEN MATCHED THEN UPDATE SET ${updates.join(
      ', '
    )} WHEN NOT MATCHED THEN INSERT (${inserts}) VALUES (${values})`;
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
  COLUMN_FAMILIES,
  GRAINS,
  grainRank,
  coarsestGrain,
  assertDate,
  assertTargetIdent,
  parseColumnType,
  composeColumnType,
  columnFamilyCatalog,
  oracleType,
  normalizeExpr,
  dialectWarnings,
  dialectOf,
  dialectOfSource,
  mysql: MYSQL,
  oracle: ORACLE,
};
