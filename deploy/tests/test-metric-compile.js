/* 契约 1.12 指标中心 M2 联调用例：三类指标/校验器/依赖/版本/编译器黄金对照（真库 mysql）
 * 前置：admin 已启动（默认 :3001，可 BASE 覆盖）；临时管理员 mtlint01 已存在
 *   重建：cd node-express-boilerplate && DB_DRIVER=mysql node -e "require('./src/services/account.service').createUser({username:'mtlint01',password:'MtLint_2026',role:'admin'}).then(()=>process.exit(0))"
 * 跑法（cwd=node-express-boilerplate）：
 *   set -a; source .env; set +a
 *   BASE=http://127.0.0.1:3002/api/v1 ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 \
 *   TEST_DS_HOST=$MYSQL_HOST TEST_DS_PORT=$MYSQL_PORT TEST_DS_USER=$MYSQL_USER TEST_DS_PASS=$MYSQL_PASSWORD TEST_DS_DB=$MYSQL_DATABASE \
 *   node ../deploy/tests/test-metric-compile.js
 * 脚本自建有后缀的 demo 物理表并在结束时整体清理（表/指标/域/模型/数据源/版本）。 */
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
const RUN = `mtd${Date.now().toString(36)}`
const T1 = `${RUN}_order` // demo 物理表 1（订单）
const T2 = `${RUN}_task` // 复用已有表做跨模型标量用例

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
  const bodyText = await res.text()
  let json = null
  try { json = JSON.parse(bodyText) } catch (e) { /* ignore */ }
  return { status: res.status, json, text: bodyText }
}

const cleanup = async () => {
  const stmts = [
    ['DELETE v FROM databridge_metric_version v JOIN databridge_metric_metric m ON v.metric_id=m.id WHERE m.code LIKE ?', [`${RUN}_%`]],
    ['DELETE d FROM databridge_metric_dep d JOIN databridge_metric_metric m ON (d.parent_id=m.id OR d.child_id=m.id) WHERE m.code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`]],
    [`DELETE c FROM databridge_metric_model_column c JOIN databridge_metric_model mo ON c.model_id=mo.id WHERE mo.name LIKE '联调指标模型%'`],
    ['DELETE FROM databridge_metric_model WHERE name LIKE ?', ['联调指标模型%']],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}%`]],
    ["DELETE FROM databridge_datasource WHERE name LIKE '联调指标数据源-%'", []],
    [`DROP TABLE IF EXISTS \`${T1}\``],
  ]
  for (const [sql, args] of stmts) {
    try { await db.run(sql, args) } catch (e) { /* 忽略单条失败 */ }
  }
}

const main = async () => {
  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('管理员登录', login.status === 200 && login.json.result.token, login.text.slice(0, 140))
  const token = login.json.result.token

  console.log('== 准备：demo 物理表 + 域 + 数据源 + 模型 ==')
  await db.run(
    `CREATE TABLE IF NOT EXISTS \`${T1}\` (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      region VARCHAR(32) NOT NULL DEFAULT '',
      amt DECIMAL(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT '',
      pay_date DATE NULL
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  )
  await db.run(`INSERT INTO \`${T1}\` (region, amt, status, pay_date) VALUES ('华东',100.5,'PAID','2026-10-01'),('华东',50.0,'CANCEL','2026-10-02'),('华南',80.0,'PAID','2026-10-02')`)

  const dom = await req('/metric-domains', { method: 'POST', token, body: { name: '联调指标域', code: `${RUN}` } })
  check('建域', dom.status === 200, dom.text.slice(0, 140))
  const dsRes = await req('/datasources', {
    method: 'POST', token,
    body: { name: `联调指标数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  check('建数据源', dsRes.status === 200, dsRes.text.slice(0, 140))
  const model1 = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '联调指标模型订单', datasourceId: dsRes.json.result.id, domainId: dom.json.result.id, layer: 'DWD', tableName: T1 },
  })
  check('模型1 自动拉列', model1.status === 200 && model1.json.result.columns.length === 5, model1.text.slice(0, 200))
  const model2 = await req('/metric-models', {
    method: 'POST', token,
    body: {
      name: '联调指标模型任务', datasourceId: dsRes.json.result.id, domainId: dom.json.result.id, layer: 'DWD', tableName: 'databridge_sync_task',
      columns: [
        { columnName: 'id', dataType: 'VARCHAR', role: 'dimension' },
        { columnName: 'name', dataType: 'VARCHAR', role: 'dimension' },
        { columnName: 'batch_size', dataType: 'INT', role: 'measure', aggDefault: 'sum' },
        { columnName: 'created_at', dataType: 'DATETIME', role: 'time' },
      ],
    },
  })
  check('模型2 手工列', model2.status === 200 && model2.json.result.columns.length === 4, model2.text.slice(0, 200))

  const mk = (body, name) => req('/metrics', { method: 'POST', token, body })
    .then((r) => { check(name, r.status === 200 && r.json.result.id, r.text.slice(0, 240)); return r.json && r.json.result })
  const mkFail = (body, name, pattern) => req('/metrics', { method: 'POST', token, body })
    .then((r) => { check(name, r.status === 400 && (!pattern || pattern.test(r.text)), r.text.slice(0, 200)) })

  console.log('== ATOMIC ==')
  const orderAmt = await mk({ code: `${RUN}_order_amt`, name: '订单总额', defineType: 'MEASURE', domainId: dom.json.result.id, defineParams: { modelId: model1.json.result.id, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' }, unit: '元', status: 'online' }, 'ATOMIC MEASURE 订单总额')
  check('expr 自动生成 SUM(t.amt)', orderAmt && orderAmt.expr === 'SUM(t.amt)' && orderAmt.type === 'ATOMIC', JSON.stringify(orderAmt && orderAmt.expr))
  const orderCnt = await mk({ code: `${RUN}_order_cnt`, name: '订单数', defineType: 'MEASURE', domainId: dom.json.result.id, defineParams: { modelId: model1.json.result.id, measureColumn: 'id', agg: 'count', timeColumn: 'pay_date' }, status: 'online' }, 'ATOMIC MEASURE 订单数')
  const paidAmt = await mk({ code: `${RUN}_paid_amt`, name: '实收金额', defineType: 'MEASURE', domainId: dom.json.result.id, defineParams: { modelId: model1.json.result.id, measureColumn: 'amt', agg: 'sum', filterSql: "t.status='PAID'", timeColumn: 'pay_date' }, status: 'online' }, 'ATOMIC 带过滤')
  const distinctRegion = await mk({ code: `${RUN}_region_uv`, name: '区域数', defineType: 'FIELD', domainId: dom.json.result.id, defineParams: { modelId: model1.json.result.id, timeColumn: 'pay_date' }, expr: 'COUNT(DISTINCT t.region)', status: 'online' }, 'ATOMIC FIELD 手写聚合')
  await mkFail({ code: `${RUN}_bad_field`, name: '坏FIELD', defineType: 'FIELD', domainId: dom.json.result.id, defineParams: { modelId: model1.json.result.id }, expr: 't.region' }, 'FIELD 缺聚合函数 → 40001', /聚合函数/)

  console.log('== COMPOSITE（合并扫描黄金对照）==')
  const unitPrice = await mk({ code: `${RUN}_unit_price`, name: '件单价', defineType: 'METRIC', domainId: dom.json.result.id, expr: `\${${RUN}_order_amt} / \${${RUN}_order_cnt}`, status: 'online' }, 'COMPOSITE 件单价')
  check('类型推导 COMPOSITE', unitPrice && unitPrice.type === 'COMPOSITE', JSON.stringify(unitPrice && unitPrice.type))
  const pv = await req(`/metrics/${unitPrice.id}/preview`, { method: 'POST', token, body: { dateRange: { start: '2026-10-01', end: '2026-10-31' }, dimensions: ['region'] } })
  const sql1 = (pv.json.result || {}).sql || ''
  check('同表合并单扫描', pv.status === 200 && /GROUP BY t.region/.test(sql1) && /SUM\(t.amt\)/.test(sql1) && /COUNT\(t.id\)/.test(sql1) && !/FROM.*SELECT.*SELECT/.test(sql1), sql1)
  check('时间 WHERE BETWEEN', /t.pay_date BETWEEN '2026-10-01' AND '2026-10-31'/.test(sql1))
  check('preview 经引擎真实执行（M3）', pv.status === 200 && pv.json.result.executable === true && pv.json.result.rows.length === 2, pv.text.slice(0, 220))

  const paidShare = await mk({ code: `${RUN}_paid_share`, name: '实收占比', defineType: 'METRIC', domainId: dom.json.result.id, expr: `\${${RUN}_paid_amt} / \${${RUN}_order_amt}`, dataFormat: 'PERCENT', status: 'online' }, 'COMPOSITE 实收占比')
  const pv2 = await req(`/metrics/${paidShare.id}/preview`, { method: 'POST', token, body: {} })
  const sql2 = (pv2.json.result || {}).sql || ''
  check('过滤编译进 CASE WHEN', /SUM\(CASE WHEN t.status='PAID' THEN t.amt END\)/.test(sql2), sql2)

  console.log('== DERIVED（继承+限定）==')
  const derived = await mk({
    code: `${RUN}_paid_cnt_by_region`, name: '分区域单量(有效)', defineType: 'METRIC', domainId: dom.json.result.id,
    expr: `\${${RUN}_order_cnt}`,
    defineParams: { baseMetricId: `${RUN}_order_cnt`, dimensions: ['region'], filterSql: 't.amt > 0' },
    status: 'online',
  }, 'DERIVED 派生指标')
  check('类型推导 DERIVED', derived && derived.type === 'DERIVED', JSON.stringify(derived && derived.type))
  const pv3 = await req(`/metrics/${derived.id}/preview`, { method: 'POST', token, body: { dimensions: ['region'] } })
  check('DERIVED 过滤进 CASE', /COUNT\(CASE WHEN t.amt > 0 THEN t.id END\)/.test((pv3.json.result || {}).sql || ''), (pv3.json.result || {}).sql)
  const pv4 = await req(`/metrics/${derived.id}/preview`, { method: 'POST', token, body: { dimensions: ['status'] } })
  check('越界维度 → 40001', pv4.status === 400 && /限定维度/.test(pv4.text), pv4.text.slice(0, 160))

  console.log('== 跨模型标量路径 ==')
  const taskCnt = await mk({ code: `${RUN}_task_cnt`, name: '任务数', defineType: 'MEASURE', domainId: dom.json.result.id, defineParams: { modelId: model2.json.result.id, measureColumn: 'id', agg: 'count', timeColumn: 'created_at' }, status: 'online' }, 'ATOMIC 模型2')
  const cross = await mk({ code: `${RUN}_cross_ratio`, name: '单任务订单比', defineType: 'METRIC', domainId: dom.json.result.id, expr: `\${${RUN}_order_cnt} / \${${RUN}_task_cnt}`, status: 'online' }, '跨模型 COMPOSITE')
  const pv5 = await req(`/metrics/${cross.id}/preview`, { method: 'POST', token, body: {} })
  const sql5 = (pv5.json.result || {}).sql || ''
  check('跨模型标量：两路子查询拼接', pv5.status === 200 && (sql5.match(/\(SELECT/g) || []).length === 2, sql5)
  const pv6 = await req(`/metrics/${cross.id}/preview`, { method: 'POST', token, body: { dimensions: ['region'] } })
  check('跨表带维度 → 拒绝', pv6.status === 400 && /标量/.test(pv6.text), pv6.text.slice(0, 160))

  console.log('== 校验红线 ==')
  await mkFail({ code: `${RUN}_bad_agg`, name: '坏公式聚合', defineType: 'METRIC', domainId: dom.json.result.id, expr: `SUM(\${${RUN}_order_amt})` }, 'COMPOSITE 禁聚合', /聚合/)
  await mkFail({ code: `${RUN}_bad_char`, name: '坏字符', defineType: 'METRIC', domainId: dom.json.result.id, expr: `\${${RUN}_order_amt} FROM x` }, 'COMPOSITE 禁表名/FROM', /禁止|非法/)
  await mkFail({ code: `${RUN}_bad_ref`, name: '坏引用', defineType: 'METRIC', domainId: dom.json.result.id, expr: `\${${RUN}_not_exist} + 1` }, '引用不存在', /不存在/)
  // 循环：b1 → a1 → b1
  const cycA = await mk({ code: `${RUN}_cyc_a`, name: '环A', defineType: 'MEASURE', domainId: dom.json.result.id, defineParams: { modelId: model1.json.result.id, measureColumn: 'amt', agg: 'max', timeColumn: 'pay_date' }, status: 'online' }, '环A 原子')
  const cycB = await mk({ code: `${RUN}_cyc_b`, name: '环B', defineType: 'METRIC', domainId: dom.json.result.id, expr: `\${${RUN}_cyc_a} + 1`, status: 'online' }, '环B=A+1')
  const makeCycle = await req(`/metrics/${cycA.id}`, {
    method: 'PUT', token,
    body: { defineType: 'METRIC', defineParams: {}, expr: `\${${RUN}_cyc_b} + 1` },
  })
  check('改成回指公式 → 40001 环检测', makeCycle.status === 400 && /循环/.test(makeCycle.text), makeCycle.text.slice(0, 200))

  console.log('== tree / lineage / versions ==')
  const tree = await req(`/metrics/${unitPrice.id}/tree`, { token })
  const t = tree.json.result
  check('tree 两叶子', tree.status === 200 && t.children.length === 2 && t.children.every((c) => c.type === 'ATOMIC'), tree.text.slice(0, 200))
  const lineage = await req(`/metrics/${orderCnt.id}/lineage`, { token })
  check('lineage parents 含件单价', lineage.json.result.parents.some((p) => p.code === `${RUN}_unit_price`), lineage.text.slice(0, 200))
  const renamed = await req(`/metrics/${orderAmt.id}`, { method: 'PUT', token, body: { name: '订单总金额', changeNote: '改名' } })
  check('更新生成 v2', renamed.status === 200 && renamed.json.result.version === 2, renamed.text.slice(0, 160))
  const vers = await req(`/metrics/${orderAmt.id}/versions`, { token })
  check('版本列表 v1+v2', (vers.json.result.items || []).length >= 2)
  const roll = await req(`/metrics/${orderAmt.id}/rollback`, { method: 'POST', token, body: { version: 1 } })
  check('回滚 v1 → 名称还原且 v3', roll.status === 200 && roll.json.result.name === '订单总额' && roll.json.result.version === 3, roll.text.slice(0, 200))

  console.log('== 删除保护 ==')
  const delUsed = await req(`/metrics/${orderCnt.id}`, { method: 'DELETE', token })
  check('被引用禁删 → 40903', delUsed.status === 409 && delUsed.json.code === 40903, delUsed.text.slice(0, 160))
  const delUnit = await req(`/metrics/${unitPrice.id}`, { method: 'DELETE', token })
  check('先删件单价', delUnit.status === 200)
  const delDerived = await req(`/metrics/${derived.id}`, { method: 'DELETE', token })
  check('再删派生（另一条引用边）', delDerived.status === 200, delDerived.text.slice(0, 160))
  const delCross = await req(`/metrics/${cross.id}`, { method: 'DELETE', token })
  check('再删跨模型比（第三条引用边）', delCross.status === 200, delCross.text.slice(0, 160))
  const delCnt = await req(`/metrics/${orderCnt.id}`, { method: 'DELETE', token })
  check('解除全部引用后可删', delCnt.status === 200, delCnt.text.slice(0, 160))
  const delDomain = await req(`/metric-domains/${dom.json.result.id}`, { method: 'DELETE', token })
  check('域下有指标 → 40902', delDomain.status === 409 && delDomain.json.code === 40902)

  console.log('== dashboard 指标计数 ==')
  const dash = await req('/metric-dashboard', { token })
  check('dashboard 统计到 COMPOSITE/ATOMIC', dash.json.result.metrics.total > 5 && dash.json.result.metrics.byType.COMPOSITE >= 2, JSON.stringify(dash.json.result.metrics))

  console.log('== 清理 ==')
  await cleanup()
  await db.run(`DROP TABLE IF EXISTS \`${T1}\``)
  console.log('  demo 表与联调资产已清理')

  console.log(`\ntest-metric-compile: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test-metric-compile crashed:', e.message, e.stack)
  cleanup().finally(() => process.exit(1))
})
