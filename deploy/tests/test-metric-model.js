/* 契约 1.12 指标中心 M1 联调用例（真库 mysql 模式，直连 10.45.34.222/dataLink）
 * 前置：admin 已启动（默认 :3001，可 BASE 覆盖）；临时管理员 mtlint01 需已存在
 *   重建：cd node-express-boilerplate && DB_DRIVER=mysql node -e "require('./src/services/account.service').createUser({username:'mtlint01',password:'MtLint_2026',role:'admin'}).then(u=>process.exit(0))"
 * 跑法（cwd=node-express-boilerplate，用 .env 凭据注册真实 mysql 数据源）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 TEST_DS_HOST=$MYSQL_HOST TEST_DS_PORT=$MYSQL_PORT \
 *   TEST_DS_USER=$MYSQL_USER TEST_DS_PASS=$MYSQL_PASSWORD TEST_DS_DB=$MYSQL_DB \
 *   node ../deploy/tests/test-metric-model.js
 * 尾部自动 SQL 清理（测试域/模型/数据源/设置项/普通用户，保留 mtlint01），脚本幂等可重复跑。 */
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
const RUN = `mt${Date.now().toString(36)}` // 幂等后缀：metric.code/域 code 终身唯一，每次跑用新码

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
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { /* 非 JSON 透传 */ }
  return { status: res.status, json, text }
}

const cleanup = async () => {
  process.env.DB_DRIVER = 'mysql'
  const db = require('../../node-express-boilerplate/src/db/mysql')
  const stmts = [
    ["DELETE FROM databridge_metric_model_column WHERE model_id LIKE 'mdl-%' AND model_id IN (SELECT id FROM databridge_metric_model WHERE domain_id IN (SELECT id FROM databridge_metric_domain WHERE code LIKE ?))", [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_task_run WHERE id LIKE ?', ['mtr-%']],
    ['DELETE FROM databridge_metric_model WHERE id IN (SELECT id FROM (SELECT id FROM databridge_metric_model m WHERE m.domain_id IN (SELECT id FROM databridge_metric_domain WHERE code LIKE ?)) x)', [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_setting WHERE setting_key = ?', ['llm.model']],
    // 注意：若真库已配真实 embed 独立端点/密钥，跑本测试会清掉（与 llm.model 同风险，重配即可）
    ["DELETE FROM databridge_metric_setting WHERE setting_key IN ('llm.embed.baseUrl','llm.embed.apiKey')", []],
    ["DELETE FROM databridge_datasource WHERE name LIKE '联调数据源-%'", []],
    ["DELETE FROM databridge_user WHERE username LIKE 'mtuser_%'", []],
    ["DELETE FROM databridge_login_log WHERE username LIKE 'mtuser_%' OR username = 'mtlint01'", []],
  ]
  for (const [sql, args] of stmts) {
    try { await db.run(sql, args) } catch (e) { /* 表间无依赖时忽略个别失败 */ }
  }
}

const main = async () => {
  console.log(`== 鉴权红线（${BASE}）==`)
  check('无 token /metric-domains → 401', (await req('/metric-domains')).status === 401)
  check('无 token /metric-dashboard → 401', (await req('/metric-dashboard')).status === 401)
  check('无 token /metric-settings → 401', (await req('/metric-settings')).status === 401)

  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('管理员登录', login.status === 200 && login.json && login.json.result.token, login.text.slice(0, 120))
  const token = login.json.result.token

  console.log('== 指标域 ==')
  const root = await req('/metric-domains', { method: 'POST', token, body: { name: '联调根域', code: `${RUN}_root` } })
  check('创建根域', root.status === 200 && root.json.result.id, root.text.slice(0, 160))
  const rootId = root.json.result && root.json.result.id
  const child = await req('/metric-domains', { method: 'POST', token, body: { name: '联点子域', code: `${RUN}_child`, parentId: rootId } })
  check('创建子域', child.status === 200 && child.json.result.parentId === rootId, child.text.slice(0, 160))
  const dup = await req('/metric-domains', { method: 'POST', token, body: { name: '重复码', code: `${RUN}_root` } })
  check('重复 code → 40001', dup.status === 400 && dup.json.code === 40001)
  const badCode = await req('/metric-domains', { method: 'POST', token, body: { name: '坏码', code: 'BAD-CODE' } })
  check('非法 code 格式 → 400', badCode.status === 400)
  const rename = await req(`/metric-domains/${rootId}`, { method: 'PUT', token, body: { code: `${RUN}_renamed` } })
  check('修改 code → 40001（编码终身制）', rename.status === 400 && rename.json.code === 40001)
  const delParent = await req(`/metric-domains/${rootId}`, { method: 'DELETE', token })
  check('删有子域的根 → 40902', delParent.status === 409 && delParent.json.code === 40902, delParent.text.slice(0, 160))
  const tree = await req('/metric-domains/tree', { token })
  const rootNode = (tree.json.result.items || []).find((n) => n.id === rootId)
  check('tree 含父子结构', tree.status === 200 && rootNode && rootNode.children.length >= 1)

  console.log('== 数据源+模型（真实库联调）==')
  const ds = await req('/datasources', {
    method: 'POST', token,
    body: { name: `联调数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  check('注册真实 mysql 数据源', ds.status === 200 && ds.json.result.id, ds.text.slice(0, 160))
  const dsId = ds.json.result && ds.json.result.id
  check('数据源口令不回显', !ds.text.includes(DS.pass))

  const refModel = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '联调引用模型', datasourceId: dsId, domainId: rootId, layer: 'DWD', tableName: 'databridge_datasource' },
  })
  const refCols = refModel.json.result && refModel.json.result.columns
  check('引用表创建 + 真实拉列', refModel.status === 200 && Array.isArray(refCols) && refCols.length >= 10, refModel.text.slice(0, 200))
  check('列角色识别出 time 列', Array.isArray(refCols) && refCols.some((c) => c.role === 'time'))
  check('默认 timeColumn 自动取时间列', Boolean(refModel.json.result && refModel.json.result.timeColumn))
  const refId = refModel.json.result && refModel.json.result.id
  const dupModel = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '重表', datasourceId: dsId, domainId: rootId, layer: 'DWD', tableName: 'databridge_datasource' },
  })
  check('同表重复登记 → 40904', dupModel.status === 409 && dupModel.json.code === 40904, dupModel.text.slice(0, 160))
  const badLayer = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '坏层', datasourceId: dsId, domainId: rootId, layer: 'ODSX', tableName: `t_${RUN}` },
  })
  check('非法 layer → 400', badLayer.status === 400)

  const newCols = [
    { columnName: 'order_id', dataType: 'BIGINT', role: 'dimension', isKey: true },
    { columnName: 'pay_date', dataType: 'DATE', role: 'time' },
    { columnName: 'amt', dataType: 'DECIMAL(18,2)', role: 'measure', aggDefault: 'sum', bizName: '金额' },
  ]
  const putCols = await req(`/metric-models/${refId}/columns`, { method: 'PUT', token, body: { columns: newCols } })
  check('PUT /columns 全量替换', putCols.status === 200, putCols.text.slice(0, 160))
  const detail = await req(`/metric-models/${refId}`, { token })
  check('详情 columns 落库回读', detail.status === 200 && detail.json.result.columns.length === 3)
  const badDupCol = await req(`/metric-models/${refId}/columns`, {
    method: 'PUT', token,
    body: { columns: [{ columnName: 'a', dataType: 'INT', role: 'dimension' }, { columnName: 'A', dataType: 'INT', role: 'measure' }] },
  })
  check('列名大小写重复 → 40001', badDupCol.status === 400 && badDupCol.json.code === 40001)

  const ddlModel = await req('/metric-models', {
    method: 'POST', token,
    body: {
      name: '联调建表模型', datasourceId: dsId, domainId: child.json.result.id, layer: 'ADS',
      createType: 'ddl', tableName: `${RUN}_ads_demo`, columns: newCols,
    },
  })
  check('ddl 模式创建 + tableDdl 留档', ddlModel.status === 200
    && /CREATE TABLE IF NOT EXISTS/.test(ddlModel.json.result.tableDdl || '')
    && /utf8mb4/.test(ddlModel.json.result.tableDdl || ''), ddlModel.text.slice(0, 200))
  const delChild = await req(`/metric-domains/${child.json.result.id}`, { method: 'DELETE', token })
  check('删有模型的域 → 40902', delChild.status === 409 && delChild.json.code === 40902)
  const delModel = await req(`/metric-models/${ddlModel.json.result.id}`, { method: 'DELETE', token })
  check('模型软删', delModel.status === 200 && delModel.json.result.deleted === true)

  console.log('== 预览 DDL ==')
  const preview = await req('/metric-models/preview-ddl', {
    method: 'POST', token,
    body: { domainId: rootId, layer: 'DWS', name: '订单日汇总', columns: newCols },
  })
  const pv = (preview.json && preview.json.result) || {}
  check('中文名生成哈希表名（前缀_分层_哈希）', preview.status === 200 && new RegExp(`^${RUN}_root_dws_`).test(pv.tableName || ''), preview.text.slice(0, 200))
  check('preview 生成 utf8mb4 DDL + 主键', /utf8mb4/.test(pv.ddl || '') && /PRIMARY KEY \(`order_id`\)/.test(pv.ddl || ''))
  const asciiPreview = await req('/metric-models/preview-ddl', {
    method: 'POST', token,
    body: { domainId: rootId, layer: 'DWS', name: 'order_daily', columns: newCols },
  })
  check('英文名保留语义后缀', (asciiPreview.json.result || {}).tableName === `${RUN}_root_dws_order_daily`)

  console.log('== 首页概览 ==')
  const dash = await req('/metric-dashboard', { token })
  const d = dash.json && dash.json.result
  check('dashboard 结构完整', dash.status === 200 && d && d.domains.total >= 2 && d.models.total >= 1
    && d.metrics.byType && 'ATOMIC' in d.metrics.byType && d.tasks.last24h && Array.isArray(d.hotMetrics), dash.text.slice(0, 240))

  console.log('== 系统配置（admin 专属）==')
  const settingsGet = await req('/metric-settings', { token })
  check('GET 8 个配置项（含 embed baseUrl/apiKey）', settingsGet.status === 200 && settingsGet.json.result.items.length === 8
    && settingsGet.json.result.items.some((i) => i.settingKey === 'llm.embed.baseUrl')
    && settingsGet.json.result.items.some((i) => i.settingKey === 'llm.embed.apiKey'))
  const apiKeyItem = settingsGet.json.result.items.find((i) => i.settingKey === 'llm.apiKey')
  check('llm.apiKey 掩码或空（无明文）', !apiKeyItem.value || /\*\*\*$/.test(apiKeyItem.value))
  const settingsPut = await req('/metric-settings', { method: 'PUT', token, body: { settings: { llm: { model: `${RUN}-model` } } } })
  check('PUT llm.model 保存（嵌套契约形态）', settingsPut.status === 200 && settingsPut.json.result.updated.includes('llm.model'), settingsPut.text.slice(0, 200))
  const afterPut = await req('/metric-settings', { token })
  const modelItem = afterPut.json.result.items.find((i) => i.settingKey === 'llm.model')
  check('读回 source=table 新值', modelItem.source === 'table' && modelItem.value === `${RUN}-model`)
  const keepPut = await req('/metric-settings', { method: 'PUT', token, body: { settings: { llm: { model: '' } } } })
  check('空串=保持不变', keepPut.status === 200 && keepPut.json.result.updated.length === 0, keepPut.text.slice(0, 160))
  const badKey = await req('/metric-settings', { method: 'PUT', token, body: { settings: { llm: { sneaky: 'x' } } } })
  check('未识别 key → 400', badKey.status === 400)
  const embedPut = await req('/metric-settings', { method: 'PUT', token, body: { settings: { llm: { embed: { baseUrl: 'https://embed.example.test/v1', apiKey: 'sk-embed-test-123456' } } } } })
  check('PUT embed 独立端点/密钥（嵌套 llm.embed.*）', embedPut.status === 200
    && embedPut.json.result.updated.includes('llm.embed.baseUrl') && embedPut.json.result.updated.includes('llm.embed.apiKey'), embedPut.text.slice(0, 200))
  const embedGet = await req('/metric-settings', { token })
  const embedUrlItem = embedGet.json.result.items.find((i) => i.settingKey === 'llm.embed.baseUrl')
  const embedKeyItem = embedGet.json.result.items.find((i) => i.settingKey === 'llm.embed.apiKey')
  check('embed baseUrl 明文读回、apiKey 仅掩码', embedUrlItem.value === 'https://embed.example.test/v1' && embedKeyItem.value === 'sk-emb***', `${embedUrlItem.value}|${embedKeyItem.value}`)

  const userCreate = await req('/users', { method: 'POST', token, body: { username: `mtuser_${RUN}`, password: 'MtUser_2026', role: 'user' } })
  check('建普通用户', userCreate.status === 200)
  const userLogin = await req('/auth/login', { method: 'POST', body: { username: `mtuser_${RUN}`, password: 'MtUser_2026' } })
  const utoken = userLogin.json.result && userLogin.json.result.token
  check('普通用户读域放行', utoken && (await req('/metric-domains', { token: utoken })).status === 200)
  check('普通用户改配置 → 403', (await req('/metric-settings', { method: 'PUT', token: utoken, body: { settings: { llm: { model: 'x' } } } })).status === 403)

  console.log('== 清理 ==')
  await cleanup()
  console.log('  联调残留已按后缀清理')

  console.log(`\ntest-metric-model: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test-metric-model crashed:', e.message, e.stack)
  process.exit(1)
})
