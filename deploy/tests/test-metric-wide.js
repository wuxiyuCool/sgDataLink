/* 契约 v1.15（V11 三期）联调用例：指标宽表物表
 * 覆盖：align=time 跨同源模型按时间粒度拼宽表（截断/时间全集 LEFT JOIN/空期次落 NULL）、
 *       目标建模表结构校验（缺列/类型只报错、不自动 ALTER、留痕列有则写无则跳）、
 *       粒度只能向粗对齐、同模型模式（align=model）行为不回退、
 *       Oracle 侧 MERGE INTO 幂等刷新（真库执行，只读业务表 + 只写平台自建表）。
 * 前置：本地 admin(:3001) + engine(:8080) 已起，DB_DRIVER=mysql，凭据在 node-express-boilerplate/.env
 * 跑法（cwd=node-express-boilerplate）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=<口令> node ../deploy/tests/test-metric-wide.js
 * 自建表全部 ${RUN}_ / ${RT}_ 前缀，结束 DROP；Oracle 侧走「模型删除连带 dropTable」清理。
 * Oracle 段可用 TEST_ORACLE_DS=（空串）跳过；数据源不存在/禁用也会自动跳过并说明。 */
process.env.DB_DRIVER = 'mysql'
const db = require('../../node-express-boilerplate/src/db/mysql')

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1'
const ADMIN_USER = process.env.ADMIN_USER || 'mtlint01'
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123'
const ORACLE_DS = process.env.TEST_ORACLE_DS === undefined ? 'ds-1158' : process.env.TEST_ORACLE_DS
const DS = {
  host: process.env.TEST_DS_HOST || '10.45.34.222',
  port: Number(process.env.TEST_DS_PORT || 3306),
  user: process.env.TEST_DS_USER || 'root',
  pass: process.env.TEST_DS_PASS || '',
  db: process.env.TEST_DS_DB || 'dataLink',
}
const RUN = `mw${Date.now().toString(36)}`
const RT = `mw${Math.floor(Date.now() / 1000).toString(36)}`.slice(0, 10)
const SRC1 = `${RUN}_sales`
const SRC2 = `${RUN}_visit`
const ADS = `${RUN}_ads`
const ADS2 = `${RUN}_ads_auto`

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`) }
}
const req = async (path, { method = 'GET', token, body } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await res.text()
  let json = null
  try { json = JSON.parse(t) } catch (e) { /* ignore */ }
  return { status: res.status, json, text: t }
}

const createdModels = []
const cleanup = async () => {
  // Oracle 自建表：先按建模删除（连带 DROP，平台建的表才允许）
  for (const id of createdModels.splice(0)) {
    try { await req(`/metric-models/${id}?dropTable=true`, { method: 'DELETE', token: TOK }) } catch (e) { /* ignore */ }
  }
  const stmts = [
    [`DROP TABLE IF EXISTS \`${ADS}\``, []],
    [`DROP TABLE IF EXISTS \`${ADS2}\``, []],
    [`DROP TABLE IF EXISTS \`${SRC1}\``, []],
    [`DROP TABLE IF EXISTS \`${SRC2}\``, []],
    ['DELETE v FROM databridge_metric_version v JOIN databridge_metric_metric m ON v.metric_id=m.id WHERE m.code LIKE ? OR m.code LIKE ?', [`${RUN}_%`, `${RT}_%`]],
    ['DELETE FROM databridge_metric_metric WHERE code LIKE ? OR code LIKE ?', [`${RUN}_%`, `${RT}_%`]],
    ['DELETE FROM databridge_metric_task_run WHERE task_id IN (SELECT id FROM databridge_metric_task WHERE name LIKE ?)', ['V15%']],
    ['DELETE FROM databridge_metric_task WHERE name LIKE ?', ['V15%']],
    ['DELETE FROM databridge_metric_dimvalue WHERE model_id IN (SELECT id FROM databridge_metric_model WHERE name LIKE ?)', ['V15%']],
    ['DELETE c FROM databridge_metric_model_column c JOIN databridge_metric_model m ON c.model_id=m.id WHERE m.name LIKE ?', ['V15%']],
    ['DELETE FROM databridge_metric_model WHERE name LIKE ?', ['V15%']],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ? OR code LIKE ?', [`${RUN}%`, `${RT}%`]],
    ['DELETE FROM databridge_datasource WHERE name LIKE ? OR name LIKE ?', [`V15数据源-${RUN}%`, `V15数据源2-${RUN}%`]],
  ]
  for (const [sql, args] of stmts) {
    try { await db.run(sql, Array.isArray(args) ? args : []) } catch (e) { /* 忽略单条 */ }
  }
}

let TOK = ''

const main = async () => {
  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('管理员登录', login.status === 200 && login.json.result && login.json.result.token, login.text.slice(0, 160))
  TOK = login.json.result.token

  console.log('== 源数据准备（两张同库不同粒度的表）==')
  await db.run(
    `CREATE TABLE \`${SRC1}\` (id BIGINT AUTO_INCREMENT PRIMARY KEY, region VARCHAR(32), amt DECIMAL(18,2), pay_date DATE) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  )
  await db.run(
    `INSERT INTO \`${SRC1}\` (region, amt, pay_date) VALUES
     ('华东',100.00,'2026-09-05'),('华南',200.00,'2026-09-20'),('华东',300.00,'2026-10-11')`
  )
  await db.run(
    `CREATE TABLE \`${SRC2}\` (id BIGINT AUTO_INCREMENT PRIMARY KEY, site VARCHAR(32), uv BIGINT, visit_date DATE) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  )
  await db.run(
    `INSERT INTO \`${SRC2}\` (site, uv, visit_date) VALUES ('A',5,'2026-09-10'),('B',3,'2026-09-28')`
  )
  const dom = await req('/metric-domains', { method: 'POST', token: TOK, body: { name: `V15域-${RUN}`, code: RUN } })
  const domId = dom.json.result.id
  const ds = await req('/datasources', {
    method: 'POST', token: TOK,
    body: { name: `V15数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  const dsId = ds.json.result.id
  const mkModel = async (name, tableName) => {
    const r = await req('/metric-models', {
      method: 'POST', token: TOK,
      body: { name, datasourceId: dsId, domainId: domId, layer: 'DWD', tableName, createType: 'reference' },
    })
    check(`源模型 ${name} 登记`, r.status === 200 && (r.json.result.columns || []).some((c) => c.role === 'time'), r.text.slice(0, 160))
    return r.json.result
  }
  const sales = await mkModel('V15销售明细', SRC1)
  const visit = await mkModel('V15访问明细', SRC2)

  const mkMetric = async (body, name) => {
    const r = await req('/metrics', { method: 'POST', token: TOK, body: { domainId: domId, status: 'online', ...body } })
    check(name, r.status === 200, r.text.slice(0, 200))
    return r.json && r.json.result
  }
  const amt = await mkMetric({ code: `${RUN}_amt`, name: '销售额', defineType: 'MEASURE', defineParams: { modelId: sales.id, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' } }, 'ATOMIC 销售额')
  const cnt = await mkMetric({ code: `${RUN}_cnt`, name: '订单数', defineType: 'MEASURE', defineParams: { modelId: sales.id, measureColumn: 'id', agg: 'count', timeColumn: 'pay_date' } }, 'ATOMIC 订单数')
  const uv = await mkMetric({ code: `${RUN}_uv`, name: '访客数', defineType: 'MEASURE', defineParams: { modelId: visit.id, measureColumn: 'uv', agg: 'sum', timeColumn: 'visit_date' } }, 'ATOMIC 访客数（另一模型）')
  const monthAmt = await mkMetric({ code: `${RUN}_mamt`, name: '月度口径额', defineType: 'MEASURE', defineParams: { modelId: sales.id, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date', timeGrain: 'month' } }, 'ATOMIC 月粒度指标（defineParams.timeGrain）')

  console.log('== 时间宽表：保存期闸门 ==')
  const timeTask = {
    name: 'V15时间宽表',
    domainId: domId,
    sourceModelId: sales.id,
    metricIds: [amt.id, cnt.id, uv.id],
    align: 'time',
    timeGrain: 'month',
    dimensionColumnIds: [],
    cleanRules: [],
    targetDatasourceId: dsId,
    targetModelId: '',
    targetTable: ADS2,
    writeMode: 'overwrite',
    timePreset: { mode: 'BETWEEN', start: '2026-09-01', end: '2026-10-31' },
  }
  const withDim = await req('/metric-tasks/preview', { method: 'POST', token: TOK, body: { ...timeTask, dimensionColumnIds: ['region'] } })
  check('align=time 带非时间维度 → 40001', withDim.status === 400 && /时间宽表/.test(withDim.text), withDim.text.slice(0, 200))
  const noGrain = await req('/metric-tasks/preview', { method: 'POST', token: TOK, body: { ...timeTask, timeGrain: '' } })
  check('align=time 缺 timeGrain → 40001', noGrain.status === 400 && /timeGrain/.test(noGrain.text), noGrain.text.slice(0, 160))
  const badGrain = await req('/metric-tasks/preview', { method: 'POST', token: TOK, body: { ...timeTask, timeGrain: 'hour' } })
  check('非法粒度档位 → 40001', badGrain.status === 400 && /timeGrain/.test(badGrain.text), badGrain.text.slice(0, 160))
  const tooFine = await req('/metric-tasks/preview', {
    method: 'POST', token: TOK,
    body: { ...timeTask, metricIds: [amt.id, monthAmt.id], timeGrain: 'day' },
  })
  check('目标粒度比指标更细 → 40001（只能向粗对齐）', tooFine.status === 400
    && /更细/.test(tooFine.text) && tooFine.text.includes(`${RUN}_mamt(month)`), tooFine.text.slice(0, 260))
  const coarseOk = await req('/metric-tasks/preview', {
    method: 'POST', token: TOK,
    body: { ...timeTask, metricIds: [monthAmt.id], timeGrain: 'quarter' },
  })
  check('目标粒度比指标更粗 → 允许（月→季是再聚合）', coarseOk.status === 200, coarseOk.text.slice(0, 160))
  const fillRule = await req('/metric-tasks/preview', { method: 'POST', token: TOK, body: { ...timeTask, cleanRules: [{ type: 'fill', column: 'region', value: '未知' }] } })
  check('align=time 的 fill 规则明确拒绝', fillRule.status === 400 && /fill/.test(fillRule.text), fillRule.text.slice(0, 160))
  const renameDim = await req('/metric-tasks/preview', { method: 'POST', token: TOK, body: { ...timeTask, cleanRules: [{ type: 'rename', column: 'region', to: 'region_name' }] } })
  check('align=time 的 rename 只能作用于时间列', renameDim.status === 400 && /rename/.test(renameDim.text), renameDim.text.slice(0, 160))
  const crossDs = await req('/datasources', {
    method: 'POST', token: TOK,
    body: { name: `V15数据源2-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  const notSame = await req('/metric-tasks/preview', { method: 'POST', token: TOK, body: { ...timeTask, targetDatasourceId: crossDs.json.result.id } })
  check('跨数据源拼宽表 → 拒绝（单连接红线）', notSame.status === 400 && /同源|一致|数据源/.test(notSame.text), notSame.text.slice(0, 200))

  console.log('== 目标建模表：缺列只报错 ==')
  const adsModel = await req('/metric-models', {
    method: 'POST', token: TOK,
    body: {
      name: 'V15宽表目标模型', datasourceId: dsId, domainId: domId, layer: 'ADS', tableName: ADS, createType: 'ddl',
      timeColumn: 'stat_period',
      columns: [
        { columnName: 'stat_period', dataType: 'VARCHAR(32)', role: 'dimension', isKey: true, bizName: '统计期次' },
        { columnName: 'note_flag', dataType: 'VARCHAR(8)', role: 'dimension', bizName: '占位列' },
      ],
    },
  })
  check('目标 ddl 模型创建（草稿）', adsModel.status === 200 && adsModel.json.result.status === 'draft', adsModel.text.slice(0, 160))
  const adsId = adsModel.json.result.id
  const draftTarget = await req('/metric-tasks/target-schema', { method: 'POST', token: TOK, body: { ...timeTask, targetModelId: adsId } })
  check('草稿模型不能作目标（表结构未确认）', draftTarget.status === 400 && /草稿/.test(draftTarget.text), draftTarget.text.slice(0, 200))
  const online = await req(`/metric-models/${adsId}`, { method: 'PUT', token: TOK, body: { status: 'online' } })
  check('目标模型启用后才能作任务目标', online.status === 200 && online.json.result.status === 'online', online.text.slice(0, 120))
  const gapSchema = await req('/metric-tasks/target-schema', { method: 'POST', token: TOK, body: { ...timeTask, targetModelId: adsId } })
  const gap = (gapSchema.json || {}).result || {}
  check('target-schema 回显缺列清单', gapSchema.status === 200 && gap.matched === false
    && (gap.missingColumns || []).map((c) => c.name).join(',') === [`${RUN}_amt`, `${RUN}_cnt`, `${RUN}_uv`].join(',')
    && (gap.missingColumns || []).every((c) => /DECIMAL|BIGINT/.test(c.suggestType)), JSON.stringify(gap.missingColumns))
  check('target-schema 回显目标模型与对齐模式', gap.targetModel && gap.targetModel.id === adsId
    && gap.align === 'time' && gap.timeGrain === 'month' && gap.autoCreate === false, JSON.stringify({ t: gap.targetModel, a: gap.align, g: gap.timeGrain }))
  const saveGap = await req('/metric-tasks', { method: 'POST', token: TOK, body: { ...timeTask, targetModelId: adsId, targetTable: undefined } })
  check('缺列保存 → 40001 且报文点名去建模页补列', saveGap.status === 400 && /缺列/.test(saveGap.text) && /建模/.test(saveGap.text), saveGap.text.slice(0, 300))

  const fullCols = [
    { columnName: 'stat_period', dataType: 'VARCHAR(32)', role: 'dimension', isKey: true, bizName: '统计期次' },
    { columnName: RUN + '_amt', dataType: 'DECIMAL(24,6)', role: 'measure', bizName: '销售额' },
    { columnName: RUN + '_cnt', dataType: 'BIGINT', role: 'measure', bizName: '订单数' },
    { columnName: RUN + '_uv', dataType: 'DECIMAL(24,6)', role: 'measure', bizName: '访客数' },
    { columnName: '_etl_time', dataType: 'DATETIME', role: 'time', bizName: '物化时间' },
  ]
  const putCols = await req(`/metric-models/${adsId}/columns`, { method: 'PUT', token: TOK, body: { columns: fullCols } })
  check('补列后目标模型字段完整', putCols.status === 200, putCols.text.slice(0, 160))
  const mismatch = await req(`/metric-models/${adsId}/columns`, {
    method: 'PUT', token: TOK,
    body: { columns: fullCols.map((c) => (c.columnName.endsWith('_uv') ? { ...c, dataType: 'VARCHAR(32)' } : c)) },
  })
  const badSchema = await req('/metric-tasks/target-schema', { method: 'POST', token: TOK, body: { ...timeTask, targetModelId: adsId } })
  const bad = (badSchema.json || {}).result || {}
  check('类型族不兼容 → mismatchColumns（写不进字符串列）', mismatch.status === 200 && bad.matched === false
    && (bad.mismatchColumns || []).some((c) => c.name === `${RUN}_uv`), JSON.stringify(bad.mismatchColumns))
  const badSave = await req('/metric-tasks', { method: 'POST', token: TOK, body: { ...timeTask, targetModelId: adsId } })
  check('类型不兼容保存 → 40001', badSave.status === 400 && /不兼容/.test(badSave.text), badSave.text.slice(0, 240))
  await req(`/metric-models/${adsId}/columns`, { method: 'PUT', token: TOK, body: { columns: fullCols } })

  console.log('== 时间宽表：语句形状（方言层产物）==')
  const schema = await req('/metric-tasks/target-schema', { method: 'POST', token: TOK, body: { ...timeTask, targetModelId: adsId } })
  const sc = (schema.json || {}).result || {}
  check('补齐后 matched=true 且不再报缺列', schema.status === 200 && sc.matched === true
    && (sc.missingColumns || []).length === 0 && (sc.mismatchColumns || []).length === 0, JSON.stringify({ m: sc.matched }))
  check('宽表列=对齐键+全部指标+留痕列', (sc.columns || []).map((c) => c.name).join(',')
    === ['stat_period', `${RUN}_amt`, `${RUN}_cnt`, `${RUN}_uv`, '_etl_time'].join(','), JSON.stringify((sc.columns || []).map((c) => c.name)))
  check('对齐键标注为时间并带粒度', (sc.columns || [])[0].source === '时间' && /month/.test((sc.columns || [])[0].comment), JSON.stringify((sc.columns || [])[0]))
  check('upsert 主键=对齐键（overwrite 下不声明）', (sc.primaryKeys || []).length === 0, JSON.stringify(sc.primaryKeys))
  check('目标建模表存在 → 不出 CREATE', sc.createSql === null && !/CREATE TABLE/.test(sc.insertSql || ''), String(sc.createSql))
  const groups = sc.groups || []
  check('按源模型分组（两模型两时间列）', groups.length === 2
    && groups[0].timeColumn === 'pay_date' && groups[1].timeColumn === 'visit_date'
    && groups[0].fromTable === SRC1 && groups[1].fromTable === SRC2, JSON.stringify(groups.map((g) => [g.fromTable, g.timeColumn])))
  const insert = sc.insertSql || ''
  check('月粒度用 DATE_FORMAT 截断且 GROUP BY 重复表达式', insert.includes("DATE_FORMAT(t.pay_date, '%Y-%m') AS `stat_period`")
    && /GROUP BY DATE_FORMAT\(t\.pay_date, '%Y-%m'\)/.test(insert) && !/GROUP BY 1/.test(insert), insert.slice(0, 400))
  check('每模型一个子查询 + UNION 时间全集 + LEFT JOIN', (insert.match(/LEFT JOIN/g) || []).length === 2
    && /FROM \(SELECT `stat_period` FROM /.test(insert) && (insert.match(/UNION/g) || []).length === 1, insert.slice(0, 500))
  check('时间全集做基表（不以某张表为基准）', insert.includes('FROM (SELECT `stat_period` FROM (') && insert.includes(') u LEFT JOIN'), insert.slice(-420))
  check('时间窗按各自时间列下推到子查询', /t\.pay_date BETWEEN '2026-09-01' AND '2026-10-31'/.test(insert)
    && /t\.visit_date BETWEEN '2026-09-01' AND '2026-10-31'/.test(insert), '')

  console.log('== 真执行：空期次落 NULL + 幂等 ==')
  const created = await req('/metric-tasks', { method: 'POST', token: TOK, body: { ...timeTask, targetModelId: adsId, targetTable: '' } })
  check('宽表任务保存（目标=建模表）', created.status === 200 && created.json.result.id, created.text.slice(0, 240))
  const taskId = created.json.result.id
  check('任务落库 align/timeGrain/targetTable 以模型为准', created.json.result.align === 'time'
    && created.json.result.timeGrain === 'month' && created.json.result.targetTable === ADS, JSON.stringify({ a: created.json.result.align, t: created.json.result.targetTable }))
  const ct = await req(`/metric-models/${adsId}/create-table`, { method: 'POST', token: TOK })
  check('目标表由建模页生成（度量列可空）', ct.status === 200 && ct.json.result.tableStatus === 'created', ct.text.slice(0, 300))
  const ctBody = await req(`/metric-models/${adsId}`, { token: TOK })
  check('生成的 ADS DDL 里度量列是 NULL 不是 NOT NULL', /`mw[0-9a-z]+_amt` DECIMAL\(24,6\) NULL/.test((ctBody.json.result.tableDdl || '')), (ctBody.json.result.tableDdl || '').slice(0, 300))
  const run1 = await req(`/metric-tasks/${taskId}/run`, { method: 'POST', token: TOK, body: {} })
  check('宽表物化 run 成功 writeRows=2', run1.status === 200 && run1.json.result.status === 'success' && run1.json.result.writeRows === 2, run1.text.slice(0, 300))
  const adsRows = await db.query(`SELECT stat_period p, \`${RUN}_amt\` a, \`${RUN}_cnt\` c, \`${RUN}_uv\` u, _etl_time e FROM \`${ADS}\` ORDER BY stat_period`)
  check('2026-09 = 300/2/8（跨模型按月对齐）', adsRows.length === 2 && Number(adsRows[0].a) === 300
    && Number(adsRows[0].c) === 2 && Number(adsRows[0].u) === 8, JSON.stringify(adsRows))
  check('2026-10 有销售无访问 → 指标列落 NULL（不是 0）', adsRows[1] && adsRows[1].p === '2026-10'
    && Number(adsRows[1].a) === 300 && adsRows[1].u === null, JSON.stringify(adsRows[1]))
  check('留痕列按目标表实际列写入', adsRows.every((r) => r.e), JSON.stringify(adsRows.map((r) => r.e)))

  const upTask = await req(`/metric-tasks/${taskId}`, { method: 'PUT', token: TOK, body: { writeMode: 'upsert' } })
  check('改为 upsert 保存成功（主键=对齐键）', upTask.status === 200 && upTask.json.result.writeMode === 'upsert', upTask.text.slice(0, 240))
  await db.run(`UPDATE \`${SRC1}\` SET amt = 500.00 WHERE pay_date = '2026-10-11'`)
  const run2 = await req(`/metric-tasks/${taskId}/run`, { method: 'POST', token: TOK, body: {} })
  const adsRows2 = await db.query(`SELECT stat_period p, \`${RUN}_amt\` a FROM \`${ADS}\` ORDER BY stat_period`)
  check('upsert 幂等：行数不涨且现值更新（10 月 300→500）', run2.status === 200 && run2.json.result.status === 'success'
    && adsRows2.length === 2 && Number(adsRows2[1].a) === 500 && Number(adsRows2[0].a) === 300, JSON.stringify(adsRows2))

  console.log('== 留痕列/粒度形状 ==')
  const noEtl = await req(`/metric-models/${adsId}/columns`, {
    method: 'PUT', token: TOK,
    body: { columns: fullCols.filter((c) => c.columnName !== '_etl_time') },
  })
  const noEtlSchema = await req('/metric-tasks/target-schema', { method: 'POST', token: TOK, body: { ...timeTask, targetModelId: adsId, writeMode: 'upsert' } })
  const ne = (noEtlSchema.json || {}).result || {}
  check('目标表没有留痕列 → 语句里不写它（不自动 ALTER）', noEtl.status === 200 && ne.matched === true
    && !/_etl_time/.test(ne.insertSql || ''), JSON.stringify({ s: noEtl.status, m: ne.matched, miss: ne.missingColumns, sql: String(ne.insertSql).slice(0, 160) }))
  check('upsert 主键回显=对齐键', (ne.primaryKeys || []).join(',') === 'stat_period', JSON.stringify(ne.primaryKeys))
  check('MySQL 幂等走 ON DUPLICATE KEY UPDATE', /ON DUPLICATE KEY UPDATE/.test(ne.insertSql || '')
    && !/`stat_period` = VALUES/.test(ne.insertSql || ''), String(ne.insertSql).slice(-260))
  await req(`/metric-models/${adsId}/columns`, { method: 'PUT', token: TOK, body: { columns: fullCols } })
  const week = await req('/metric-tasks/preview', { method: 'POST', token: TOK, body: { ...timeTask, timeGrain: 'week' } })
  const weekSql = ((week.json.result || {}).statements || []).find((s) => s.startsWith('INSERT')) || ''
  check('周粒度用 YEARWEEK(mode=3)', weekSql.includes('YEARWEEK(t.pay_date, 3)') && weekSql.includes('YEARWEEK(t.visit_date, 3)'), weekSql.slice(0, 300))
  const quarter = await req('/metric-tasks/preview', { method: 'POST', token: TOK, body: { ...timeTask, timeGrain: 'quarter' } })
  const qSql = ((quarter.json.result || {}).statements || []).find((s) => s.startsWith('INSERT')) || ''
  check('季粒度用 CONCAT(YEAR,-Q,QUARTER)', qSql.includes("CONCAT(YEAR(t.pay_date), '-Q', QUARTER(t.pay_date))"), qSql.slice(0, 320))
  const legacy = await req('/metric-tasks/target-schema', { method: 'POST', token: TOK, body: { ...timeTask, align: 'model', dimensionColumnIds: ['region'], metricIds: [amt.id], targetModelId: '', targetTable: ADS2 } })
  const lg = (legacy.json || {}).result || {}
  check('align=model 不回退：仍可带维度 + 自动建表', legacy.status === 200 && lg.align === 'model' && lg.autoCreate === true
    && (lg.columns || []).map((c) => c.name).join(',') === ['region', `${RUN}_amt`, '_etl_time'].join(','), JSON.stringify((lg.columns || []).map((c) => c.name)))
  check('自动建表的指标列也改为允许 NULL', /DECIMAL\(24,6\) NULL/.test(lg.createSql || '') && !/DEFAULT 0 NOT NULL/.test(lg.createSql || ''), String(lg.createSql))

  console.log('== Oracle：MERGE INTO 真库执行 ==')
  const dsList = await req('/datasources?size=50', { token: TOK })
  const ods = (dsList.json.result.items || []).find((d) => d.id === ORACLE_DS && d.status !== 'disabled')
  if (!ORACLE_DS) {
    console.log('  skip  TEST_ORACLE_DS 为空，跳过 Oracle 段')
  } else if (!ods) {
    console.log(`  skip  未登记可用的 Oracle 数据源（${ORACLE_DS || '未配置'}），跳过 Oracle 段`)
  } else {
    const odom = await req('/metric-domains', { method: 'POST', token: TOK, body: { name: `V15OD域-${RT}`, code: RT } })
    const odomId = odom.json.result.id
    // A) 模型模式 + upsert：源=Oracle 侧一张主数据表（只读，平台不写它），目标=平台自建表
    //    → 真数据覆盖 MERGE 的 INSERT 与 UPDATE 两个分支（引用视图不行：ALL_TABLES 不含视图）
    const ref = await req('/metric-models', {
      method: 'POST', token: TOK,
      body: { name: 'V15Oracle主数据', datasourceId: ORACLE_DS, domainId: odomId, layer: 'DWD', tableName: 'AQD_MD_DOMAINS', createType: 'reference' },
    })
    check('Oracle 主数据表登记为引用模型', ref.status === 200 && (ref.json.result.columns || []).some((c) => c.columnName === 'VALUE_TYPE'), ref.text.slice(0, 220))
    const oMet = await req('/metrics', {
      method: 'POST', token: TOK,
      body: {
        domainId: odomId, status: 'online', code: `${RT}_dcnt`, name: '域值条目数', defineType: 'MEASURE',
        defineParams: { modelId: ref.json.result.id, measureColumn: 'DOM_ID', agg: 'count', timeColumn: '' },
      },
    })
    check('Oracle 计数指标创建', oMet.status === 200, oMet.text.slice(0, 200))
    const oads = await req('/metric-models', {
      method: 'POST', token: TOK,
      body: {
        name: 'V15Oracle宽表', datasourceId: ORACLE_DS, domainId: odomId, layer: 'ADS', tableName: `${RT}_MERGEADS`, createType: 'ddl',
        columns: [
          { columnName: 'val_type', dataType: 'VARCHAR(16)', role: 'dimension', isKey: true, bizName: '值类型' },
          { columnName: `${RT}_dcnt`, dataType: 'BIGINT', role: 'measure', bizName: '条目数' },
          { columnName: 'etl_time', dataType: 'DATETIME', role: 'time', bizName: '物化时间' },
        ],
      },
    })
    check('Oracle 目标模型创建', oads.status === 200, oads.text.slice(0, 200))
    createdModels.push(oads.json.result.id)
    await req(`/metric-models/${oads.json.result.id}`, { method: 'PUT', token: TOK, body: { status: 'online' } })
    const oct = await req(`/metric-models/${oads.json.result.id}/create-table`, { method: 'POST', token: TOK })
    check('Oracle 目标表生成成功（CREATE + COMMENT ON 一批下发）', oct.status === 200 && oct.json.result.tableStatus === 'created'
      && /COMMENT ON TABLE/.test(oct.json.result.ddl || ''), oct.text.slice(0, 600))
    const oTask = {
      name: 'V15Oracle幂等', domainId: odomId, sourceModelId: ref.json.result.id,
      metricIds: [oMet.json.result.id], dimensionColumnIds: ['VALUE_TYPE'], align: 'model',
      // 目标建模表用业务名（val_type），靠 rename 规则把源列名映射过去——目标结构权威在建模页（契约 1.15 §C）
      cleanRules: [{ type: 'rename', column: 'VALUE_TYPE', to: 'val_type' }],
      targetDatasourceId: ORACLE_DS, targetModelId: oads.json.result.id, writeMode: 'upsert',
    }
    const noRename = await req('/metric-tasks/target-schema', {
      method: 'POST', token: TOK, body: { ...oTask, cleanRules: [] },
    })
    check('目标表用业务名时缺列点名源列名（VALUE_TYPE）', noRename.status === 200
      && (noRename.json.result.missingColumns || []).some((c) => c.name === 'VALUE_TYPE'), JSON.stringify(noRename.json.result))
    const oSchema = await req('/metric-tasks/target-schema', { method: 'POST', token: TOK, body: oTask })
    const osc = (oSchema.json || {}).result || {}
    check('Oracle 目标 upsert 不再被拒（走 MERGE）', oSchema.status === 200 && osc.dialect === 'oracle'
      && (osc.missingColumns || []).length === 0 && /^MERGE INTO/.test(osc.insertSql || ''), JSON.stringify({ d: osc.dialect, m: osc.missingColumns, e: osc.insertSql }))
    check('MERGE 形状：USING 本次 SELECT + ON 主键 + UPDATE/INSERT 两分支', /USING \(SELECT/i.test(osc.insertSql)
      && /ON \(s\.VAL_TYPE = d\.VAL_TYPE\)/i.test(osc.insertSql)
      && /WHEN MATCHED THEN UPDATE SET s\.[A-Z0-9_]*_DCNT = d\.[A-Z0-9_]*_DCNT, s\.ETL_TIME = SYSDATE/i.test(osc.insertSql)
      && /WHEN NOT MATCHED THEN INSERT \(VAL_TYPE,\s*[A-Z0-9_]*_DCNT,\s*ETL_TIME\) VALUES \(d\.VAL_TYPE/i.test(osc.insertSql), osc.insertSql)
    check('留痕列在 SELECT 里带别名（MERGE 才能按 d.ETL_TIME 引用）', /SYSDATE AS ETL_TIME/i.test(osc.insertSql), String(osc.insertSql).slice(0, 260))
    check('Oracle 标识符全大写无引号且 GROUP BY 重复表达式', !/"/.test(osc.insertSql)
      && /GROUP BY t\.VALUE_TYPE/i.test(osc.insertSql) && !/GROUP BY 1/i.test(osc.insertSql), String(osc.insertSql).slice(0, 300))
    const oCreated = await req('/metric-tasks', { method: 'POST', token: TOK, body: oTask })
    check('Oracle 任务保存', oCreated.status === 200 && oCreated.json.result.id, oCreated.text.slice(0, 300))
    const orun = await req(`/metric-tasks/${oCreated.json.result.id}/run`, { method: 'POST', token: TOK, body: {} })
    check('MERGE 真库执行成功且有写入行', orun.status === 200 && orun.json.result.status === 'success'
      && Number(orun.json.result.writeRows) > 0, orun.text.slice(0, 400))
    const orun2 = await req(`/metric-tasks/${oCreated.json.result.id}/run`, { method: 'POST', token: TOK, body: {} })
    check('二次 MERGE 不产生重复行（ON 命中走 UPDATE 分支）', orun2.status === 200 && orun2.json.result.status === 'success'
      && Number(orun2.json.result.writeRows) === Number(orun.json.result.writeRows), JSON.stringify({ a: orun.json.result.writeRows, b: orun2.json.result.writeRows }))
    await req(`/metric-tasks/${oCreated.json.result.id}`, { method: 'DELETE', token: TOK })

    // B) 时间模式：源=平台自建 Oracle 表（有 DATE 列，空表）→ 校验 TO_CHAR 截断 + JOIN 形状真被 Oracle 接受
    const osrc = await req('/metric-models', {
      method: 'POST', token: TOK,
      body: {
        name: 'V15Oracle时间源', datasourceId: ORACLE_DS, domainId: odomId, layer: 'DWD', tableName: `${RT}_MERGTSRC`, createType: 'ddl', timeColumn: 'stat_date',
        columns: [
          { columnName: 'stat_date', dataType: 'DATE', role: 'time', isKey: true, bizName: '统计日期' },
          { columnName: 'qty', dataType: 'DECIMAL(18,4)', role: 'measure', bizName: '数量' },
        ],
      },
    })
    check('Oracle 时间源模型创建', osrc.status === 200, osrc.text.slice(0, 200))
    createdModels.push(osrc.json.result.id)
    await req(`/metric-models/${osrc.json.result.id}`, { method: 'PUT', token: TOK, body: { status: 'online' } })
    const osrcCt = await req(`/metric-models/${osrc.json.result.id}/create-table`, { method: 'POST', token: TOK })
    check('Oracle 时间源表生成', osrcCt.status === 200 && osrcCt.json.result.tableStatus === 'created', osrcCt.text.slice(0, 300))
    const oQty = await req('/metrics', {
      method: 'POST', token: TOK,
      body: { domainId: odomId, status: 'online', code: `${RT}_qty`, name: '产量', defineType: 'MEASURE', defineParams: { modelId: osrc.json.result.id, measureColumn: 'qty', agg: 'sum', timeColumn: 'stat_date' } },
    })
    check('Oracle 求和指标创建', oQty.status === 200, oQty.text.slice(0, 200))
    const oads2 = await req('/metric-models', {
      method: 'POST', token: TOK,
      body: {
        name: 'V15Oracle时间表', datasourceId: ORACLE_DS, domainId: odomId, layer: 'ADS', tableName: `${RT}_MERGTADS`, createType: 'ddl', timeColumn: 'stat_period',
        columns: [
          { columnName: 'stat_period', dataType: 'VARCHAR(32)', role: 'dimension', isKey: true, bizName: '统计期次' },
          { columnName: `${RT}_qty`, dataType: 'DECIMAL(24,6)', role: 'measure', bizName: '产量' },
          { columnName: 'etl_time', dataType: 'DATETIME', role: 'time', bizName: '物化时间' },
        ],
      },
    })
    check('Oracle 时间宽表模型创建', oads2.status === 200, oads2.text.slice(0, 200))
    createdModels.push(oads2.json.result.id)
    await req(`/metric-models/${oads2.json.result.id}`, { method: 'PUT', token: TOK, body: { status: 'online' } })
    const oads2Ct = await req(`/metric-models/${oads2.json.result.id}/create-table`, { method: 'POST', token: TOK })
    check('Oracle 时间宽表生成', oads2Ct.status === 200 && oads2Ct.json.result.tableStatus === 'created', oads2Ct.text.slice(0, 300))
    const oTimeTask = {
      name: 'V15Oracle时间宽表', domainId: odomId, sourceModelId: osrc.json.result.id, metricIds: [oQty.json.result.id],
      align: 'time', timeGrain: 'month', dimensionColumnIds: [], cleanRules: [],
      targetDatasourceId: ORACLE_DS, targetModelId: oads2.json.result.id, writeMode: 'upsert',
      timePreset: { mode: 'BETWEEN', start: '2026-01-01', end: '2026-12-31' },
    }
    const oTimeSchema = await req('/metric-tasks/target-schema', { method: 'POST', token: TOK, body: oTimeTask })
    const ots = (oTimeSchema.json || {}).result || {}
    check('Oracle 月粒度用 TO_CHAR(...,YYYY-MM)', /TO_CHAR\(t\.stat_date,\s*'YYYY-MM'\)/i.test(ots.insertSql || '')
      && !/DATE_FORMAT/.test(ots.insertSql || ''), String(ots.insertSql).slice(0, 400))
    check('Oracle 宽表形状：时间全集 UNION + LEFT JOIN + MERGE 幂等', /^MERGE INTO/.test(ots.insertSql || '')
      && /LEFT JOIN/i.test(ots.insertSql) && /ON \(s\.STAT_PERIOD = d\.STAT_PERIOD\)/i.test(ots.insertSql), String(ots.insertSql).slice(0, 500))
    check('Oracle 时间窗用 TO_DATE 字面量', /TO_DATE\('2026-01-01','YYYY-MM-DD'\)/.test(ots.insertSql || ''), String(ots.insertSql).slice(0, 300))
    const oTimeCreated = await req('/metric-tasks', { method: 'POST', token: TOK, body: oTimeTask })
    check('Oracle 时间宽表任务保存', oTimeCreated.status === 200, oTimeCreated.text.slice(0, 300))
    const oTimeRun = await req(`/metric-tasks/${oTimeCreated.json.result.id}/run`, { method: 'POST', token: TOK, body: {} })
    check('Oracle 宽表 MERGE 语句被真实 Oracle 接受执行', oTimeRun.status === 200 && oTimeRun.json.result.status === 'success', oTimeRun.text.slice(0, 500))
    await req(`/metric-tasks/${oTimeCreated.json.result.id}`, { method: 'DELETE', token: TOK })
    const refBusy = await req(`/metric-models/${ref.json.result.id}`, { method: 'DELETE', token: TOK })
    check('模型被指标引用时禁删（40903）', refBusy.status === 409 && refBusy.json.code === 40903, refBusy.text.slice(0, 200))
    await req(`/metrics/${oMet.json.result.id}`, { method: 'DELETE', token: TOK })
    const refDel = await req(`/metric-models/${ref.json.result.id}`, { method: 'DELETE', token: TOK })
    check('引用型模型删除时平台不 DROP（业务表原样保留）', refDel.status === 200 && refDel.json.result.dropped === false, refDel.text.slice(0, 200))
  }

  console.log('== 清理 ==')
  await cleanup()
  console.log('  联调资产已清理')
  console.log(`\ntest-metric-wide: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => {
  console.error('test-metric-wide crashed:', e.message, e.stack)
  await cleanup().catch(() => {})
  process.exit(1)
})
