/* 契约 1.14 V11 二期联调用例：指标广场聚合 + 维度取值探查/码值登记 + 候选值进 prompt + 解析后值校正
 * 前置：admin(:3001) 与 engine(:8080) 已启动，且 admin 侧 ENGINE_SHARED_SECRET 与引擎一致（探查走真库）
 *   临时管理员 mtlint01 需已存在（重建见 test-metric-model.js 头注）
 * 跑法（cwd=node-express-boilerplate）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026a TEST_DS_HOST=$MYSQL_HOST TEST_DS_PORT=$MYSQL_PORT \
 *   TEST_DS_USER=$MYSQL_USER TEST_DS_PASS=$MYSQL_PASSWORD TEST_DS_DB=$MYSQL_DB \
 *   node ../deploy/tests/test-metric-dimvalue.js
 * 自建 ${RUN}_code 物理表与 ${RUN}_ 前缀资产，结束时全清理（含 chat.dimValuePrompt 设置行——
 * 共享元库里生产 admin 也读这张表，测试期间开过的开关必须还原）。 */
process.env.DB_DRIVER = 'mysql'
const db = require('../../node-express-boilerplate/src/db/mysql')
const metricKnowledge = require('../../node-express-boilerplate/src/services/metricKnowledge.service')
const metricChat = require('../../node-express-boilerplate/src/services/metricChat.service')
const metricDim = require('../../node-express-boilerplate/src/services/metricdim.service')

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
const RUN = `mdv${Date.now().toString(36)}`
const TBL = `${RUN}_code` // 码值演示表：region_code 存 E1/E2，业务名叫华东/华南
const DAY = (n) => {
  const d = new Date(Date.now() - n * 86400000)
  return d.toISOString().slice(0, 10)
}

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
const result = (r) => (r.json && r.json.result) || {}

const cleanup = async () => {
  const stmts = [
    ['DELETE FROM databridge_metric_dimvalue WHERE model_id IN (SELECT id FROM databridge_metric_model WHERE name LIKE ?)', [`联调码值%`]],
    ['DELETE v FROM databridge_metric_version v JOIN databridge_metric_metric m ON v.metric_id = m.id WHERE m.code LIKE ?', [`${RUN}_%`]],
    ['DELETE d FROM databridge_metric_dep d JOIN databridge_metric_metric m ON (d.parent_id = m.id OR d.child_id = m.id) WHERE m.code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`]],
    ['DELETE c FROM databridge_metric_model_column c JOIN databridge_metric_model mo ON c.model_id = mo.id WHERE mo.name LIKE ?', ['联调码值%']],
    ['DELETE FROM databridge_metric_model WHERE name LIKE ?', ['联调码值%']],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}%`]],
    ['DELETE FROM databridge_metric_setting WHERE setting_key IN (?, ?)', ['chat.dimValuePrompt', 'chat.dimValueTopN']],
    ["DELETE FROM databridge_datasource WHERE name LIKE '联调码值数据源-%'", []],
    // 红线 10：只删本套件自建的 ${RUN}_ 前缀表，绝不触碰平台表或用户登记的源表
    [`DROP TABLE IF EXISTS \`${TBL}\``, []],
  ]
  for (const [sql, args] of stmts) {
    try { await db.run(sql, args) } catch (e) { /* 单条失败不影响其余清理 */ }
  }
}

const main = async () => {
  await cleanup() // 幂等：先清上一次中途崩溃的残留
  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('管理员登录', login.status === 200 && result(login).token, login.text.slice(0, 120))
  const token = result(login).token

  console.log('== 码值演示表 + 引用模型 ==')
  await db.run(
    `CREATE TABLE IF NOT EXISTS \`${TBL}\` (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      region_code VARCHAR(16), amt DECIMAL(18,2), pay_date DATE
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  )
  const rows = []
  const codes = ['E1', 'E2', 'E3', 'E4']
  codes.forEach((code, i) => {
    for (let k = 0; k < 3; k += 1) rows.push(`('${code}',${(10 + i * 5 + k).toFixed(2)},'${DAY(1)}')`)
  })
  await db.run(`INSERT INTO \`${TBL}\` (region_code, amt, pay_date) VALUES ${rows.join(',')}`)
  const ds = await req('/datasources', {
    method: 'POST', token,
    body: { name: `联调码值数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  const dsId = result(ds).id
  const dom = await req('/metric-domains', { method: 'POST', token, body: { name: '联调码值域', code: `${RUN}_dom` } })
  const domId = result(dom).id
  const model = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '联调码值模型', datasourceId: dsId, domainId: domId, layer: 'DWD', tableName: TBL },
  })
  const modelId = result(model).id
  check('引用模型创建（真实拉列）', model.status === 200 && (result(model).columns || []).length >= 4, model.text.slice(0, 200))

  console.log('== 维度取值探查（真查库 + 基数保护）==')
  const profiled = await req(`/metric-models/${modelId}/profile-dimensions`, { method: 'POST', token, body: {} })
  const regionCol = (result(profiled).columns || []).find((c) => c.columnName === 'region_code') || {}
  check('探查成功且方言回显', profiled.status === 200 && result(profiled).dialect === 'mysql', profiled.text.slice(0, 200))
  check('码值列取到 4 个值并带命中数', (regionCol.values || []).length === 4 && regionCol.values.every((v) => v.hits > 0), JSON.stringify(regionCol).slice(0, 220))
  check('度量/时间列不探查（只维度）', !(result(profiled).columns || []).some((c) => c.columnName === 'amt' || c.columnName === 'pay_date'), JSON.stringify((result(profiled).columns || []).map((c) => c.columnName)))
  const guarded = await req(`/metric-models/${modelId}/profile-dimensions`, {
    method: 'POST', token, body: { columns: ['id'], distinctGuard: 2 },
  })
  const idCol = (result(guarded).columns || [])[0] || {}
  check('基数超阈值只标记不取值（高基数保护）', guarded.status === 200 && idCol.highCardinality === true && (idCol.values || []).length === 0, JSON.stringify(idCol).slice(0, 200))
  const badCol = await req(`/metric-models/${modelId}/profile-dimensions`, { method: 'POST', token, body: { columns: ['amt'] } })
  check('探查非维度列 → 40001 明确拒绝', badCol.status === 400 && badCol.json.code === 40001, badCol.text.slice(0, 160))

  console.log('== 码值业务名登记（01=华东 的正解：E1=华东）==')
  const labeled = await req(`/metric-models/${modelId}/dimension-values`, {
    method: 'PUT', token,
    body: { columnName: 'region_code', values: [{ value: 'E1', label: '华东' }, { value: 'E2', label: '华南' }, { value: 'ZZ', label: '未入库补录' }] },
  })
  check('登记成功且新增 manual 行', labeled.status === 200 && (result(labeled).values || []).some((v) => v.value === 'ZZ' && v.source === 'manual'), labeled.text.slice(0, 220))
  const reprobed = await req(`/metric-models/${modelId}/profile-dimensions`, { method: 'POST', token, body: { columns: ['region_code'] } })
  const reprobedCol = (result(reprobed).columns || [])[0] || {}
  const e1 = (reprobedCol.values || []).find((v) => v.value === 'E1') || {}
  check('重新探查不冲掉人工 label', e1.label === '华东', JSON.stringify(e1))
  check('人工补录值不被探查标 stale', (reprobedCol.values || []).some((v) => v.value === 'ZZ' && v.stale === false), JSON.stringify((reprobedCol.values || []).map((v) => `${v.value}/${v.source}/${v.stale}`)))
  const readBack = await req(`/metric-models/${modelId}/dimension-values?columnName=region_code`, { token })
  const readValues = (result(readBack).columns[0] || {}).values || []
  check('档案读回带 label 与探查时间', readBack.status === 200 && readValues.some((v) => v.value === 'E1' && v.label === '华东' && v.profiledAt), readBack.text.slice(0, 220))

  console.log('== 候选值进 prompt（开关默认关）==')
  const metric = await req('/metrics', {
    method: 'POST', token,
    body: {
      domainId: domId, code: `${RUN}_camt`, name: '码值订单额', alias: ['片区金额'], status: 'online',
      defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' }, unit: '元',
      caliber: '按片区码值汇总金额，用于验证取值校正',
    },
  })
  check('码值指标创建', metric.status === 200, metric.text.slice(0, 200))
  const forcedIndex = await metricKnowledge.buildIndex({ force: true })
  const offSchema = metricKnowledge.buildSchemaSection(metricKnowledge.recallWith(forcedIndex, '码值订单额，只看华东'))
  check('开关关闭时 prompt 不含取值（数据不出境）', !/取值:/.test(offSchema.columns), offSchema.columns.slice(0, 200))
  const settingsOff = await req('/metric-settings', { method: 'PUT', token, body: { settings: { chat: { dimValuePrompt: '1', dimValueTopN: '20' } } } })
  check('开启 chat.dimValuePrompt', settingsOff.status === 200 && settingsOff.json.result.updated.length === 2, settingsOff.text.slice(0, 200))
  const onIndex = await metricKnowledge.buildIndex({ force: true })
  const onRecall = metricKnowledge.recallWith(onIndex, '码值订单额，只看华东')
  const onSchema = metricKnowledge.buildSchemaSection(onRecall)
  check('开启后 prompt 维度行带「E1=华东」', /取值:[^\n]*E1=华东/.test(onSchema.columns), onSchema.columns.slice(0, 300))
  check('只提值名（华东）也能召回所属维度列', (onRecall.values || []).some((v) => v.value === 'E1') && (onRecall.columns || []).some((c) => c.columnName === 'region_code'), JSON.stringify((onRecall.columns || []).map((c) => c.columnName)))

  console.log('== 解析后值校正（业务名 → 库里真实值）==')
  const dimValues = await metricDim.valuesByModelId()
  const index = onIndex
  const tok = metricChat.toTokens('SELECT `码值订单额` FROM `联调码值域` WHERE `region_code` = \'华东\'', index)
  const parsed = metricChat.parseM2Sql(tok.text, tok.refs, dimValues)
  const filterSql = (parsed.filters || []).map((f) => f.sql).join(' ')
  check('华东被换成库里真实值 E1', /region_code = 'E1'/.test(filterSql), filterSql)
  check('corrections 记录本次替换', (parsed.corrections || []).some((c) => c.from === '华东' && c.to === 'E1' && c.via === 'label'), JSON.stringify(parsed.corrections))
  const tokIn = metricChat.toTokens('SELECT `码值订单额` FROM `联调码值域` WHERE `region_code` IN (\'华东\',\'华南\')', index)
  const parsedIn = metricChat.parseM2Sql(tokIn.text, tokIn.refs, dimValues)
  check('IN 列表逐元素校正', /IN \('E1', 'E2'\)/.test((parsedIn.filters || []).map((f) => f.sql).join('')), JSON.stringify(parsedIn.filters))
  const tokMiss = metricChat.toTokens('SELECT `码值订单额` FROM `联调码值域` WHERE `region_code` = \'不存在片区\'', index)
  const parsedMiss = metricChat.parseM2Sql(tokMiss.text, tokMiss.refs, dimValues)
  check('档案没有的值原样保留并记为待补录', /region_code = '不存在片区'/.test((parsedMiss.filters || []).map((f) => f.sql).join('')) && (parsedMiss.unmapped || []).length === 1, JSON.stringify(parsedMiss.unmapped))
  const parsedNoDim = metricChat.parseM2Sql(tok.text, tok.refs, new Map())
  check('无档案时不改写（零风险兜底）', /region_code = '华东'/.test((parsedNoDim.filters || []).map((f) => f.sql).join('')), JSON.stringify(parsedNoDim.filters))

  console.log('== 指标广场聚合 ==')
  const plaza = await req(`/metrics/plaza?domainId=${domId}`, { token })
  const section = (result(plaza).domains || [])[0] || {}
  const card = (section.items || []).find((m) => m.code === `${RUN}_camt`) || {}
  check('选域时含子孙域并成节', plaza.status === 200 && section.id === domId && (section.total || 0) >= 1, plaza.text.slice(0, 220))
  check('卡片带口径/模型名/被引用数/热度', card.name === '码值订单额' && card.modelName === '联调码值模型' && card.referencedBy === 0 && typeof card.hot7d === 'number', JSON.stringify(card).slice(0, 260))
  check('卡片带域面包屑 path', Array.isArray(card.domainPath) && card.domainPath.includes('联调码值域'), JSON.stringify(card.domainPath))
  const kwPlaza = await req(`/metrics/plaza?keyword=${encodeURIComponent('片区金额')}`, { token })
  const hitCode = `${RUN}_camt`
  check('关键字命中别名/口径', (result(kwPlaza).domains || []).some((d) => (d.items || []).some((m) => m.code === hitCode)), kwPlaza.text.slice(0, 200))
  const draftMetric = await req('/metrics', {
    method: 'POST', token,
    body: { domainId: domId, code: `${RUN}_cdraft`, name: '码值草稿额', status: 'draft', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum' } },
  })
  check('草稿指标创建', draftMetric.status === 200, draftMetric.text.slice(0, 160))
  const onlyOnline = await req(`/metrics/plaza?domainId=${domId}`, { token })
  check('广场默认只回 online', (result(onlyOnline).domains || []).every((d) => (d.items || []).every((m) => m.status === 'online')), JSON.stringify((result(onlyOnline).domains || []).flatMap((d) => d.items).map((m) => m.status)))
  const allStatus = await req(`/metrics/plaza?domainId=${domId}&status=all`, { token })
  check('status=all 才出现草稿', (result(allStatus).domains || []).some((d) => (d.items || []).some((m) => m.status === 'draft')))
  const draftOnly = await req(`/metrics/plaza?domainId=${domId}&status=draft`, { token })
  check('status=draft 只回草稿', (result(draftOnly).domains || []).every((d) => (d.items || []).every((m) => m.status === 'draft')))
  const badPlaza = await req('/metrics/plaza?limit=9999', { token })
  check('limit 越界 → 400（上限 500）', badPlaza.status === 400, badPlaza.text.slice(0, 160))

  console.log('== 从表批量生成指标 ==')
  const draftModel = await req('/metric-models', {
    method: 'POST', token,
    body: {
      name: '联调码值草稿模型', datasourceId: dsId, domainId: domId, layer: 'ADS', createType: 'ddl',
      tableName: `${RUN}_draft`, columns: [{ columnName: 'amt', dataType: 'DECIMAL(18,2)', role: 'measure' }],
    },
  })
  const draftModelId = result(draftModel).id
  check('草稿模型准备就绪（一期的引用闸门）', draftModel.status === 200 && result(draftModel).status === 'draft', draftModel.text.slice(0, 160))
  const batch = await req('/metrics/batch', {
    method: 'POST', token,
    body: {
      items: [
        { code: `${RUN}_bamt`, name: '批量·金额', domainId: domId, modelId, measureColumn: 'amt', agg: 'sum', unit: '元' },
        { code: `${RUN}_bcnt`, name: '批量·笔数', domainId: domId, modelId, measureColumn: 'id', agg: 'count' },
        { code: `${RUN}_bamt`, name: '重复码', domainId: domId, modelId, measureColumn: 'amt', agg: 'sum' },
        { code: `${RUN}_bdraft`, name: '挂在草稿模型上', domainId: domId, modelId: draftModelId, measureColumn: 'amt', agg: 'sum' },
      ],
    },
  })
  const batchRes = result(batch)
  check('批量创建 2 成 2 败（HTTP 200）', batch.status === 200 && batchRes.created === 2 && batchRes.failed === 2, batch.text.slice(0, 260))
  check('逐条回结果带 index 与原因', (batchRes.results || []).length === 4 && /占用|重复/.test(batchRes.results[2].message || '') && /草稿|启用/.test(batchRes.results[3].message || ''), JSON.stringify(batchRes.results).slice(0, 400))
  const batchEmpty = await req('/metrics/batch', { method: 'POST', token, body: { items: [] } })
  check('空 items → 40001', batchEmpty.status === 400 && batchEmpty.json.code === 40001, batchEmpty.text.slice(0, 140))

  console.log('== 真 LLM 问数：华东应当出 E1 的数 ==')
  // LLM 有随机性（同一问句偶尔会 clarify 或漏掉过滤），按真实使用习惯最多问两次，取落地更好的那次
  let asked = null
  let askedRes = {}
  for (let attempt = 0; attempt < 2; attempt += 1) {
    asked = await req('/metric-chat/ask', { method: 'POST', token, body: { question: '昨天的码值订单额是多少，只看华东' } })
    askedRes = result(asked)
    if (/E1/.test(String(askedRes.physicalSql || ''))) break
  }
  check('问数返回有效状态', asked.status === 200 && ['success', 'corrected', 'clarify', 'failed'].includes(askedRes.status), asked.text.slice(0, 200))
  check('落地 SQL 用库里真实码值（LLM 直取或值校正）', /E1/.test(String(askedRes.physicalSql || '')), `resp=${asked.text.slice(0, 420)}`)

  console.log('== 清理 ==')
  await cleanup()
  const leftRows = await db.query(`SELECT COUNT(*) AS c FROM databridge_metric_dimvalue WHERE model_id = ?`, [modelId])
  check('档案随清理删除', Number(leftRows[0].c) === 0, JSON.stringify(leftRows[0]))
  console.log(`\ntest-metric-dimvalue: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch(async (err) => {
  console.log('FATAL', err && err.message)
  await cleanup()
  console.log(`test-metric-dimvalue: ${pass} pass, ${fail + 1} fail (异常终止)`)
  process.exit(1)
})
