/* 契约 1.12 §6.4 方言层离线用例：mysql / oracle 的 SQL 生成黄金对照。
 * 特点：不连库、不起 admin/engine —— datasource.repository 用 require.cache 桩替换，
 * 因此可以在任何机器上跑（CI/离线都行），专门守「换库就语法错」这一类回归。
 * 跑法（cwd=node-express-boilerplate）：node ../deploy/tests/test-metric-dialect.js
 * 覆盖：标识符引用 / 日期字面量 / 行数限制 / 类型映射 / 建表幂等 / upsert 支持位 /
 *       空串=NULL 清洗规则 / 函数归一(NVL,IFNULL,DATE_FORMAT) / 跨库告警 / 模型 DDL 预览 */
const path = require('path')

const SRC = path.join(__dirname, '..', '..', 'node-express-boilerplate', 'src')

// 数据源仓储桩：buildStatements/validateTaskShape 只用到 getById(...).type
let stubType = 'mysql'
const dsRepoPath = require.resolve(path.join(SRC, 'repositories/datasource.repository'))
require.cache[dsRepoPath] = {
  id: dsRepoPath,
  filename: dsRepoPath,
  loaded: true,
  exports: { getById: async () => ({ id: 'ds-stub', type: stubType, status: 'enabled' }) },
}

const dialect = require(path.join(SRC, 'utils/dialect'))
const taskService = require(path.join(SRC, 'services/metrictask.service'))
const modelService = require(path.join(SRC, 'services/metricmodel.service'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`) }
}
const throwsWith = async (fn, keyword) => {
  try {
    await fn()
    return { ok: false, msg: '没有抛错' }
  } catch (e) {
    return { ok: String(e.message).includes(keyword), msg: e.message }
  }
}

/** 与生产同形的物化计划：4 个维度列 + 1 个聚合指标 + 1 条过滤 + 6 个月时间窗 */
const buildPlanFixture = () => ({
  dims: [
    { target: 'PRODUCE_LINE', sql: 'COALESCE(t.produce_line, \'\')', source: 'PRODUCE_LINE', type: 'VARCHAR(2)' },
    { target: 'PRODUCE_DT', sql: 't.PRODUCE_DT', source: 'PRODUCE_DT', type: 'DATE' },
  ],
  metrics: [
    { target: 'gk1', sql: 'SUM(CASE WHEN t.extend_col7 = 1 THEN NVL(t.material_weight, 0) END)', type: 'DECIMAL(24,6)' },
    { target: 'gk2', sql: 'COUNT(t.MATERIAL_ID)', type: 'BIGINT' },
  ],
  filters: ['t.extend_col7 = 1'],
  timeColumn: 'PRODUCE_DT',
  dateRange: { start: '2026-04-12', end: '2026-10-09' },
  fromTable: 'HR_PROD_MATERIAL',
})

const taskFixture = (writeMode) => ({
  name: '方言用例任务',
  sourceModelId: 'mdl-stub',
  metricIds: ['met-a', 'met-b'],
  dimensionColumnIds: ['PRODUCE_LINE', 'PRODUCE_DT'],
  cleanRules: [],
  timePreset: { mode: 'BETWEEN', start: '2026-04-12', end: '2026-10-09' },
  targetDatasourceId: 'ds-stub',
  targetModelId: '',
  targetTable: 'test_1_gk',
  writeMode,
  status: 'online',
})

const main = async () => {
  const m = dialect.dialectOf('mysql')
  const o = dialect.dialectOf('oracle')

  console.log('== 方言层单元对照 ==')
  check('mysql 日期用裸字面量', m.dateLiteral('2026-04-12') === `'2026-04-12'`)
  check('oracle 日期必须包 TO_DATE', o.dateLiteral('2026-04-12') === `TO_DATE('2026-04-12','YYYY-MM-DD')`)
  check('mysql 行数限制用 LIMIT', m.limit('SELECT 1', 100) === 'SELECT 1 LIMIT 100')
  // FETCH FIRST 需 12c+，与引擎侧 dbio 一致改 ROWNUM 嵌套（11g/12c 通用）
  check('oracle 行数限制用 ROWNUM 嵌套', o.limit('SELECT 1 ORDER BY x', 100) === 'SELECT * FROM (SELECT 1 ORDER BY x) dbr_page WHERE ROWNUM <= 100')
  check('mysql 标识符反引号', m.ident('gk1') === '`gk1`')
  check('oracle 标识符大写无引号', o.ident('gk1') === 'GK1')
  check('oracle ETL 列不能用下划线开头', o.etlColumn === 'ETL_TIME' && m.etlColumn === '_etl_time')
  check('oracle 空串等价 NULL 被标记', o.supports.emptyStringIsNull === true && m.supports.emptyStringIsNull === false)
  check('mysql 支持 ON DUPLICATE', m.supports.upsertOnDuplicate === true)
  check('oracle 无 FROM DUAL 需求、有 DUAL', m.dual === '' && o.dual === ' FROM DUAL')
  check('mysql 无需数据字典探测', m.tableExistsProbe('t') === null)
  check('oracle 探测 user_tables 大写表名', o.tableExistsProbe('test_1_gk').includes(`table_name = 'TEST_1_GK'`))
  const typeMap = ['VARCHAR(2)', 'DATE', 'DECIMAL(24,6)', 'BIGINT', 'INT', 'TEXT', 'DATETIME', 'NUMBER(10)']
  const mapped = typeMap.map((t) => o.columnType(t)).join(',')
  check(
    'MySQL 风格类型 → Oracle 类型映射',
    mapped === 'VARCHAR2(2 CHAR),DATE,NUMBER(24,6),NUMBER(19),NUMBER(10),CLOB,TIMESTAMP,NUMBER(10,0)',
    mapped
  )
  const long = await throwsWith(async () => o.columnType('VARCHAR(5000)'), '4000')
  check('超宽列给出可读拒绝而不是 ORA 报错', long.ok, long.msg)

  console.log('== 字段类型目录与归一（界面录入 → 规范 dataType）==')
  const compose = dialect.composeColumnType
  check('手打 varchar 补默认长度（无长度两库都建不出表）', compose('varchar') === 'VARCHAR(64)', compose('varchar'))
  check('空类型兜底 VARCHAR(64)', compose('') === 'VARCHAR(64)')
  check('目录外类型兜底成字符串而不是抛错', compose('BOOLEAN') === 'VARCHAR(64)', compose('BOOLEAN'))
  check(
    '源库原生写法归一到 MySQL 风格',
    compose('VARCHAR2(58)') === 'VARCHAR(58)' &&
      compose('NUMBER') === 'DECIMAL(18,4)' &&
      compose('timestamp(6)') === 'TIMESTAMP' &&
      compose('CLOB') === 'TEXT',
    [compose('VARCHAR2(58)'), compose('NUMBER'), compose('timestamp(6)'), compose('CLOB')].join(',')
  )
  check('NUMBER(10) 按整数处理（不擅自补 4 位小数）', compose('NUMBER(10)') === 'DECIMAL(10,0)', compose('NUMBER(10)'))
  check('DECIMAL(24,6) 原样保留', compose('DECIMAL(24,6)') === 'DECIMAL(24,6)')
  const overMysql = await throwsWith(async () => compose('VARCHAR(70000)', 'mysql'), '65535')
  check('mysql 超宽列拒绝并报上限', overMysql.ok, overMysql.msg)
  const overPrec = await throwsWith(async () => compose('DECIMAL(40,2)', 'oracle'), '38')
  check('oracle NUMBER 精度上限 38 有提示', overPrec.ok, overPrec.msg)
  const catM = dialect.columnFamilyCatalog('mysql')
  const catO = dialect.columnFamilyCatalog('oracle')
  const famOf = (list, fam) => list.find((item) => item.family === fam)
  check(
    '目录按方言给真实类型名',
    famOf(catM, 'VARCHAR').rendered === 'VARCHAR(64)' &&
      famOf(catO, 'VARCHAR').rendered === 'VARCHAR2(64 CHAR)' &&
      famOf(catO, 'TEXT').rendered === 'CLOB' &&
      famOf(catO, 'INT').rendered === 'NUMBER(10)' &&
      famOf(catO, 'DATETIME').rendered === 'TIMESTAMP',
    catO.map((c) => c.rendered).join(',')
  )
  check(
    '长度上限随方言变化（字符串 mysql 65535 / oracle 4000）',
    famOf(catM, 'VARCHAR').maxLength === 65535 && famOf(catO, 'VARCHAR').maxLength === 4000
  )
  check(
    '只有字符串/定点数族需要填长度/小数位',
    famOf(catO, 'DATE').hasLength === false && famOf(catM, 'DECIMAL').hasScale === true
  )
  const normalized = modelService.assertColumns(
    [
      { columnName: 'a', dataType: 'varchar', role: 'dimension' },
      { columnName: 'b', dataType: 'NUMBER(12)', role: 'measure' },
    ],
    'oracle'
  )
  check(
    '模型保存时列类型统一归一',
    normalized[0].dataType === 'VARCHAR(64)' && normalized[1].dataType === 'DECIMAL(12,0)',
    JSON.stringify(normalized.map((c) => c.dataType))
  )
  const ddlLoose = modelService.buildDdl(
    { code: 'zzgl' },
    'DWS',
    'zzgl_dws_probe',
    [{ columnName: 'shop_sign', dataType: 'varchar', role: 'dimension', bizName: '牌号' }],
    'oracle'
  )
  check(
    'DDL 里不再出现无长度类型名',
    ddlLoose.includes('SHOP_SIGN VARCHAR2(64 CHAR) NOT NULL') && !/VARCHAR\s+NOT NULL/.test(ddlLoose),
    ddlLoose
  )

  console.log('== 函数归一与跨库告警 ==')
  check(
    'NVL/IFNULL 归一为 COALESCE（两库通用）',
    m.normalize('NVL(a,0)+IFNULL(b,1)') === 'COALESCE(a,0)+COALESCE(b,1)' && o.normalize('NVL(a,0)') === 'COALESCE(a,0)'
  )
  check(
    'oracle 目标自动翻译 DATE_FORMAT 掩码',
    o.normalize("DATE_FORMAT(t.dt, '%Y-%m')") === "TO_CHAR(t.dt,'YYYY-MM')",
    o.normalize("DATE_FORMAT(t.dt, '%Y-%m')")
  )
  check('mysql 目标保留 DATE_FORMAT 原样', m.normalize("DATE_FORMAT(t.dt, '%Y-%m')") === "DATE_FORMAT(t.dt, '%Y-%m')")
  check('已自动翻译的写法不再重复告警', o.warnings('公式', "DATE_FORMAT(t.dt, '%Y-%m')").length === 0)
  const unhandled = o.warnings('公式', "DATE_FORMAT(t.dt, '%Y-%Q')")
  check('未覆盖的 %码 提示人工改写', unhandled.some((w) => w.includes('TO_CHAR')), JSON.stringify(unhandled))
  const backWarn = m.warnings('公式', 'DECODE(a,1,2)')
  check('mysql 目标对 DECODE 出告警', backWarn.some((w) => w.includes('DECODE') && w.includes('oracle')), JSON.stringify(backWarn))
  check('oracle 目标对 GROUP_CONCAT 出告警', o.warnings('过滤条件', 'GROUP_CONCAT(a)').some((w) => w.includes('mysql')))

  console.log('== 物化任务：Oracle 目标（此前报错的现场）==')
  stubType = 'oracle'
  const oracleStatements = await taskService.buildStatements(taskFixture('overwrite'), buildPlanFixture())
  const [oCreate, oTruncate, oInsert] = oracleStatements
  check('oracle 建表 3 条语句齐', oracleStatements.length === 3, String(oracleStatements.length))
  check('oracle CREATE 不带反引号', oCreate.indexOf('`') === -1, oCreate)
  check('oracle CREATE 不带 ENGINE/CHARSET', !/ENGINE=|CHARSET|COLLATE/i.test(oCreate), oCreate)
  check('oracle CREATE 不用 IF NOT EXISTS（靠数据字典探测幂等）', !/IF NOT EXISTS/i.test(oCreate))
  check('oracle CREATE 表名大写', oCreate.startsWith('CREATE TABLE TEST_1_GK ('), oCreate)
  check('oracle 列类型走 VARCHAR2(n CHAR)/NUMBER/TIMESTAMP', /VARCHAR2\(2 CHAR\)/.test(oCreate) && /NUMBER\(24,6\)/.test(oCreate) && /ETL_TIME TIMESTAMP/.test(oCreate), oCreate)
  check('oracle TRUNCATE 无反引号', oTruncate === 'TRUNCATE TABLE TEST_1_GK', oTruncate)
  check('oracle INSERT 列表大写无引号', oInsert.includes('INSERT INTO TEST_1_GK (PRODUCE_LINE, PRODUCE_DT, GK1, GK2, ETL_TIME)'), oInsert)
  check('oracle 时间窗用 TO_DATE（此前裸串会 ORA-01861）', /BETWEEN TO_DATE\('2026-04-12','YYYY-MM-DD'\) AND TO_DATE\('2026-10-09','YYYY-MM-DD'\)/.test(oInsert), oInsert)
  check('oracle 取当前时间用 SYSDATE', oInsert.includes(', SYSDATE') && !oInsert.includes('NOW()'), oInsert)
  check('oracle 源表名大写', oInsert.includes('FROM HR_PROD_MATERIAL t'))
  check('oracle 聚合里的 NVL 已归一', oInsert.includes('COALESCE(t.material_weight, 0)') && !oInsert.includes('NVL('), oInsert)

  const upsertReject = await throwsWith(() => taskService.buildStatements(taskFixture('upsert'), buildPlanFixture()), 'MERGE')
  check('oracle upsert 明确拒绝而不是产出坏 SQL', upsertReject.ok, upsertReject.msg)
  const fillReject = await throwsWith(
    () => taskService.validateTaskShape({ ...taskFixture('overwrite'), cleanRules: [{ type: 'fill', column: 'PRODUCE_LINE', value: '' }] }),
    '空串等价 NULL'
  )
  check('oracle 空值填充规则保存期拦截', fillReject.ok, fillReject.msg)
  const fillOk = await taskService.validateTaskShape({
    ...taskFixture('overwrite'),
    cleanRules: [{ type: 'fill', column: 'PRODUCE_LINE', value: '-' }],
  })
  check('oracle 改成实际占位值可保存', fillOk.rules.length === 1)

  console.log('== 物化任务：MySQL 目标（行为必须不变）==')
  stubType = 'mysql'
  const mysqlStatements = await taskService.buildStatements(taskFixture('upsert'), buildPlanFixture())
  const [myCreate, myInsert] = mysqlStatements
  check('mysql upsert 只两条（建表+INSERT，无 TRUNCATE）', mysqlStatements.length === 2, String(mysqlStatements.length))
  check('mysql CREATE 保留 IF NOT EXISTS + InnoDB/utf8mb4', myCreate.startsWith('CREATE TABLE IF NOT EXISTS `test_1_gk`') && myCreate.includes('ENGINE=InnoDB') && myCreate.includes('utf8mb4_unicode_ci'), myCreate)
  check('mysql 主键取维度列（upsert 依赖）', myCreate.includes('PRIMARY KEY (`PRODUCE_LINE`, `PRODUCE_DT`)'), myCreate)
  check('mysql ETL 列仍是 _etl_time DATETIME', myCreate.includes('`_etl_time` DATETIME'), myCreate)
  check('mysql 时间窗用裸字符串', /BETWEEN '2026-04-12' AND '2026-10-09'/.test(myInsert), myInsert)
  check('mysql upsert 尾部 ON DUPLICATE KEY UPDATE', /ON DUPLICATE KEY UPDATE `gk1` = VALUES\(`gk1`\), `gk2` = VALUES\(`gk2`\), `_etl_time` = NOW\(\)$/.test(myInsert), myInsert.slice(-160))

  let myFillMsg = ''
  try {
    await taskService.validateTaskShape({
      ...taskFixture('overwrite'),
      cleanRules: [{ type: 'fill', column: 'region', value: '' }],
    })
  } catch (e) {
    myFillMsg = e.message
  }
  check('mysql 空串填充不受限（只有 oracle 拦）', myFillMsg === '', myFillMsg)


  console.log('== 模型 DDL 预览按方言 ==')
  const domain = { code: 'dmtrade', name: '交易' }
  const cols = [
    { columnName: 'id', dataType: 'BIGINT', role: 'dimension', bizName: '主键', isKey: true },
    { columnName: 'amount', dataType: 'DECIMAL(18,4)', role: 'measure', bizName: '金额' },
    { columnName: 'pay_date', dataType: 'DATETIME', role: 'time', remark: '' },
  ]
  const ddlMysql = modelService.buildDdl(domain, 'DWD', 'dm_dwd_pay', cols, { type: 'mysql' })
  const ddlOracle = modelService.buildDdl(domain, 'DWD', 'dm_dwd_pay', cols, { type: 'oracle' })
  check('mysql DDL 内联 COMMENT + 表注释', ddlMysql.includes("COMMENT '主键'") && ddlMysql.includes("COMMENT 'DWD | domain=dmtrade'"), ddlMysql)
  check('oracle DDL 无 ENGINE/反引号且类型映射', !/ENGINE=|`/.test(ddlOracle) && ddlOracle.includes('NUMBER(19)') && ddlOracle.includes('TIMESTAMP'), ddlOracle)
  check('oracle DDL 注释拆成 COMMENT ON 语句', ddlOracle.includes('COMMENT ON TABLE DM_DWD_PAY IS') && ddlOracle.includes('COMMENT ON COLUMN DM_DWD_PAY.AMOUNT IS'), ddlOracle)

  console.log('== 未接入方言显式拒绝（不再静默按 mysql 生成）==')
  const pg = await throwsWith(async () => {
    stubType = 'postgresql'
    await taskService.buildStatements(taskFixture('overwrite'), buildPlanFixture())
  }, 'mysql / oracle')
  check('postgresql 目标给出可读拒绝', pg.ok, pg.msg)

  console.log('== 维度取值探查 SQL（契约 1.14，仍只能出自方言层）==')
  const mySql = dialect.dialectOf('mysql')
  const oraSql = dialect.dialectOf('oracle')
  const dimCount = mySql.dimCountSql({ table: 'dm_order_src', column: 'region' })
  check('mysql 基数预检走 COUNT(DISTINCT)', dimCount === 'SELECT COUNT(DISTINCT `region`) AS dim_count FROM dm_order_src', dimCount)
  const dimProfile = mySql.dimProfileSql({ table: 'dm_order_src', column: 'region', limit: 50 })
  check('mysql 取值 topN 用 LIMIT 且过滤 NULL', /LIMIT 50$/.test(dimProfile) && /IS NOT NULL/.test(dimProfile) && /GROUP BY/.test(dimProfile), dimProfile)
  const oraProfile = oraSql.dimProfileSql({ table: 'gmc.test', column: 'produce_line', limit: 50 })
  check('oracle 取值用 ROWNUM 嵌套（不用 LIMIT/FETCH FIRST）', /^\SELECT \* FROM \(/.test(oraProfile) && /ROWNUM <= 50/.test(oraProfile) && !/LIMIT/.test(oraProfile) && !/FETCH FIRST/.test(oraProfile), oraProfile)
  check('oracle 标识符与表名大写', oraProfile.includes('PRODUCE_LINE') && oraProfile.includes('GMC.TEST'), oraProfile)
  check('oracle 基数预检同样大写无引号', oraSql.dimCountSql({ table: 'gmc.test', column: 'x' }).includes('COUNT(DISTINCT X)'), oraSql.dimCountSql({ table: 'gmc.test', column: 'x' }))
  const injection = await throwsWith(() => mySql.dimProfileSql({ table: 't; DROP TABLE u', column: 'a', limit: 5 }), '标识符白名单')
  check('表名含分号/空格被标识符白名单拒绝', injection.ok, injection.msg)
  const badColumn = await throwsWith(() => mySql.dimCountSql({ table: 't', column: 'a` b' }), '标识符白名单')
  check('列名非法字符被拒（探查不得拼任意标识符）', badColumn.ok, badColumn.msg)

  console.log(`\ntest-metric-dialect: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test-metric-dialect crashed:', e.message, e.stack)
  process.exit(1)
})
