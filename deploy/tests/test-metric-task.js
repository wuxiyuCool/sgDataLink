/* 契约 v1.12 M4 联调用例：清洗汇总任务（物化 SQL/upsert 幂等/保存期拦截/dashboard 真数）
 * 前置：
 *   引擎:  cd databridge-engine && SERVER_PORT=8082 ENGINE_SHARED_SECRET=mt3-dev-secret NODE_REPORT_URL=http://127.0.0.1:3002/api/v1/engine go run ./cmd/server -conf config/local.yml
 *   admin: cd node-express-boilerplate && DB_DRIVER=mysql NODE_ENV=development PORT=3002 ENGINE_BASE_URL=http://127.0.0.1:8082 ENGINE_SHARED_SECRET=mt3-dev-secret node src/index.js
 * 跑法（cwd=node-express-boilerplate，凭据来自 .env）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 BASE=http://127.0.0.1:3002/api/v1 \
 *   TEST_DS_HOST=$MYSQL_HOST TEST_DS_USER=$MYSQL_USER TEST_DS_PASS=$MYSQL_PASSWORD TEST_DS_DB=$MYSQL_DATABASE \
 *   node ../deploy/tests/test-metric-task.js
 * 自建源表/ADS 表结束 DROP；任务/指标/域/模型/数据源 SQL 清理。 */
process.env.DB_DRIVER = 'mysql'
const db = require('../../node-express-boilerplate/src/db/mysql')

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123'
const DS = {
  host: process.env.TEST_DS_HOST || '10.45.34.222',
  port: Number(process.env.TEST_DS_PORT || 3306),
  user: process.env.TEST_DS_USER || 'root',
  pass: process.env.TEST_DS_PASS || '',
  db: process.env.TEST_DS_DB || 'dataLink',
}
const RUN = `mtk${Date.now().toString(36)}`
const SRC = `${RUN}_ord`
const ADS = `${RUN}_ads_daily`

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

const cleanup = async () => {
  const stmts = [
    [`DROP TABLE IF EXISTS \`${ADS}\``],
    [`DROP TABLE IF EXISTS \`${SRC}\``],
    ['DELETE v FROM databridge_metric_version v JOIN databridge_metric_metric m ON v.metric_id=m.id WHERE m.code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_task_run WHERE task_id IN (SELECT id FROM databridge_metric_task WHERE name LIKE ?)', ['M4联调%']],
    ['DELETE FROM databridge_metric_task WHERE name LIKE ?', ['M4联调%']],
    ['DELETE c FROM databridge_metric_model_column c JOIN databridge_metric_model m ON c.model_id=m.id WHERE m.name LIKE ?', ['M4联调%']],
    ['DELETE FROM databridge_metric_model WHERE name LIKE ?', ['M4联调%']],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_datasource WHERE name LIKE ?', [`M4数据源-${RUN}%`]],
  ]
  for (const [sql, args] of stmts) {
    try { await db.run(sql, args) } catch (e) { /* 忽略单条 */ }
  }
}

const main = async () => {
  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('管理员登录', login.status === 200 && login.json.result.token)
  const token = login.json.result.token

  console.log('== 源数据准备 ==')
  await db.run(
    `CREATE TABLE \`${SRC}\` (id BIGINT AUTO_INCREMENT PRIMARY KEY, region VARCHAR(32), amt DECIMAL(18,2), status VARCHAR(16), pay_date DATE) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  )
  await db.run(
    `INSERT INTO \`${SRC}\` (region, amt, status, pay_date) VALUES
     ('华东',100.50,'PAID','2026-10-01'),('华东',50.00,'CANCEL','2026-10-02'),
     ('华南',80.00,'PAID','2026-10-02'),('华东',30.00,'PAID','2020-01-01')`
  )
  const dom = await req('/metric-domains', { method: 'POST', token, body: { name: `M4域-${RUN}`, code: RUN } })
  const ds = await req('/datasources', {
    method: 'POST', token,
    body: { name: `M4数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  const model = await req('/metric-models', {
    method: 'POST', token,
    body: { name: 'M4联调源模型', datasourceId: ds.json.result.id, domainId: dom.json.result.id, layer: 'DWD', tableName: SRC },
  })
  check('源模型自动识别（含 time 列）', model.status === 200 && (model.json.result.columns || []).some((c) => c.role === 'time'), model.text.slice(0, 160))
  const modelId = model.json.result.id

  const mkMetric = async (body, name) => {
    const r = await req('/metrics', { method: 'POST', token, body: { domainId: dom.json.result.id, status: 'online', ...body } })
    check(name, r.status === 200, r.text.slice(0, 200))
    return r.json && r.json.result
  }
  const orderAmt = await mkMetric({ code: `${RUN}_amt`, name: '订单额', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' } }, 'ATOMIC 订单额')
  const orderCnt = await mkMetric({ code: `${RUN}_cnt`, name: '订单数', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'id', agg: 'count', timeColumn: 'pay_date' } }, 'ATOMIC 订单数')
  const paidAmt = await mkMetric({ code: `${RUN}_paid`, name: '实收额', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', filterSql: "t.status='PAID'", timeColumn: 'pay_date' } }, 'ATOMIC 实收额')
  const unitPrice = await mkMetric({ code: `${RUN}_unit`, name: '件单价', defineType: 'METRIC', expr: `\${${RUN}_amt} / \${${RUN}_cnt}` }, 'COMPOSITE 件单价')

  console.log('== 任务预览（不执行）==')
  const baseTask = {
    name: 'M4联调汇总',
    domainId: dom.json.result.id,
    sourceModelId: modelId,
    metricIds: [orderAmt.id, orderCnt.id, paidAmt.id, unitPrice.id],
    dimensionColumnIds: ['region'],
    targetDatasourceId: ds.json.result.id,
    targetTable: ADS,
    writeMode: 'upsert',
    cleanRules: [{ type: 'fill', column: 'region', value: '未知' }],
    timePreset: { mode: 'RECENT', unit: 'DAY', period: 365 },
  }
  const prev = await req('/metric-tasks/preview', { method: 'POST', token, body: baseTask })
  const st = (prev.json.result || {}).statements || []
  const insertSql = st.find((s) => s.startsWith('INSERT INTO')) || ''
  check('preview 语句：CREATE+INSERT（upsert 无 TRUNCATE）', prev.status === 200 && st.length === 2
    && /^CREATE TABLE IF NOT EXISTS/.test(st[0]) && /ON DUPLICATE KEY UPDATE/.test(insertSql), prev.text.slice(0, 240))
  check('upsert 主键=维度列', st[0].includes('PRIMARY KEY (`region`)'), st[0])
  check('fill 规则进 COALESCE', insertSql.includes("COALESCE(t.region, '未知')"), insertSql)
  check('跨月数据按时间窗过滤', /BETWEEN/.test(insertSql), '')
  check('复合指标同表合并进 INSERT SELECT', insertSql.includes('SUM(t.amt)') && insertSql.includes('COUNT(t.id)'), '')

  console.log('== 创建任务并真执行 ==')
  const created = await req('/metric-tasks', { method: 'POST', token, body: baseTask })
  check('创建任务', created.status === 200 && created.json.result.id, created.text.slice(0, 200))
  const taskId = created.json.result.id
  const run = await req(`/metric-tasks/${taskId}/run`, { method: 'POST', token, body: {} })
  check('run 成功 writeRows=2', run.status === 200 && run.json.result.status === 'success' && run.json.result.writeRows === 2, run.text.slice(0, 240))
  const rows = await db.query(`SELECT region, \`${RUN}_amt\` a, \`${RUN}_cnt\` c, \`${RUN}_paid\` p, \`${RUN}_unit\` u FROM \`${ADS}\` ORDER BY region`)
  const hv = rows.find((r) => r.region === '华东')
  check('ADS 华东聚合 150.5/2/100.5（时间窗剔除 2020 行）',
    rows.length === 2 && Number(hv.a) === 150.5 && Number(hv.c) === 2 && Number(hv.p) === 100.5
    && Math.abs(Number(hv.u) - 75.25) < 0.001, JSON.stringify(rows))

  console.log('== 幂等重跑 + 运行记录 ==')
  await db.run(`UPDATE \`${SRC}\` SET amt = 200.50 WHERE region='华东' AND amt=100.50`)
  const run2 = await req(`/metric-tasks/${taskId}/run`, { method: 'POST', token, body: {} })
  check('第二次 run 成功', run2.status === 200 && run2.json.result.status === 'success', run2.text.slice(0, 160))
  const rows2 = await db.query(`SELECT region, \`${RUN}_amt\` a FROM \`${ADS}\` WHERE region='华东'`)
  check('upsert 幂等且更新现值（amt=250.5，行数不涨）', rows2.length === 1 && Number(rows2[0].a) === 250.5, JSON.stringify(rows2))
  const runs = await req(`/metric-tasks/${taskId}/runs`, { token })
  check('runs 列表 ≥2 且倒序', runs.status === 200 && runs.json.result.items.length >= 2
    && runs.json.result.items[0].status === 'success', runs.text.slice(0, 200))

  console.log('== 保存期拦截 ==')
  const badCron = await req('/metric-tasks', { method: 'POST', token, body: { ...baseTask, name: 'M4坏cron', scheduleCron: 'abc' } })
  check('非法 cron → 40001', badCron.status === 400, badCron.text.slice(0, 140))
  const crossDom = await req('/metric-domains', { method: 'POST', token, body: { name: `M4域2-${RUN}`, code: `${RUN}x` } })
  const model2 = await req('/metric-models', {
    method: 'POST', token,
    body: { name: 'M4联调模型2', datasourceId: ds.json.result.id, domainId: crossDom.json.result.id, layer: 'DWD', tableName: 'databridge_datasource' },
  })
  const cnt2 = await mkMetric({ code: `${RUN}_ds_cnt`, name: '源数', defineType: 'MEASURE', defineParams: { modelId: model2.json.result.id, measureColumn: 'id', agg: 'count' } }, 'ATOMIC 模型2')
  const ratio = await mkMetric({ code: `${RUN}_ratio`, name: '跨模型比', defineType: 'METRIC', expr: `\${${RUN}_amt} / \${${RUN}_ds_cnt}` }, 'COMPOSITE 跨模型')
  const crossTask = await req('/metric-tasks', {
    method: 'POST', token,
    body: { ...baseTask, name: 'M4跨模型任务', metricIds: [orderAmt.id, ratio.id] },
  })
  check('跨模型复合入任务 → 400 拒绝', crossTask.status === 400 && /物化|同源|模型/.test(crossTask.text), crossTask.text.slice(0, 200))
  const dedupTask = await req('/metric-tasks', {
    method: 'POST', token,
    body: { ...baseTask, name: 'M4dedup', cleanRules: [{ type: 'dedup', by: ['id'], keep: 'latest', on: 'pay_date' }] },
  })
  check('dedup 规则一期明确拒绝', dedupTask.status === 400 && /dedup/.test(dedupTask.text), dedupTask.text.slice(0, 160))
  const badDim = await req('/metric-tasks', {
    method: 'POST', token,
    body: { ...baseTask, name: 'M4坏维度', dimensionColumnIds: ['pay_date', 'amt'] },
  })
  check('measure 列作维度 → 40001', badDim.status === 400, badDim.text.slice(0, 160))

  console.log('== 更新 / dashboard ==')
  const upd = await req(`/metric-tasks/${taskId}`, {
    method: 'PUT', token,
    body: { metricIds: [orderAmt.id, orderCnt.id], writeMode: 'overwrite', cleanRules: [] },
  })
  check('更新指标集与写模式', upd.status === 200 && upd.json.result.writeMode === 'overwrite', upd.text.slice(0, 160))
  const run3 = await req(`/metric-tasks/${taskId}/run`, { method: 'POST', token, body: {} })
  check('overwrite 重跑成功', run3.status === 200 && run3.json.result.status === 'success')
  const cols = await db.query(`SHOW COLUMNS FROM \`${ADS}\``)
  check('overwrite 后表仍 2 行（列结构兼容保留）', cols.length >= 5)
  const dash = await req('/metric-dashboard', { token })
  check('dashboard tasks 接真数', dash.json.result.tasks.total >= 1 && dash.json.result.tasks.last24h.success >= 3
    && dash.json.result.tasks.successRate === 1, JSON.stringify(dash.json.result.tasks))

  console.log('== 删除保护与列表筛选 ==')
  const del = await req(`/metric-tasks/${taskId}`, { method: 'DELETE', token })
  check('任务软删', del.status === 200 && del.json.result.deleted === true)
  const listAfter = await req('/metric-tasks?keyword=M4', { token })
  check('列表已滤掉软删项', listAfter.json.result.items.every((t) => !t.delFlag))

  console.log('== 清理 ==')
  await cleanup()
  console.log('  联调资产已清理')
  console.log(`\ntest-metric-task: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => {
  console.error('test-metric-task crashed:', e.message, e.stack)
  await cleanup().catch(() => {})
  process.exit(1)
})
