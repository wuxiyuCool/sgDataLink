/* 契约 1.12 指标中心 M0 底座用例：直连元库校验 12 张 metric 表结构与 9 个 ID 序列；
 * 外加 v1.17「编码占用事前校验」的 HTTP 用例（GET /metrics/code-check）。
 * 跑法（cwd 必须在 node-express-boilerplate，依赖其 .env/config；HTTP 段要 admin(:3001) 已启动）：
 *   cd node-express-boilerplate && set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=... node ../deploy/tests/test-metric-base.js
 * HTTP 段的资产全部 ${RUN} 前缀自建自清（物理表/数据源/域/模型/指标），
 * 红线：绝不拿平台真实表或别人的资产当删除样本。 */
process.env.DB_DRIVER = 'mysql'
const db = require('../../node-express-boilerplate/src/db/mysql')

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123'
const DS = {
  host: process.env.TEST_DS_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DS_PORT || 3306),
  user: process.env.TEST_DS_USER || 'root',
  pass: process.env.TEST_DS_PASS || '',
  db: process.env.TEST_DS_DB || 'dataLink',
}
const RUN = `cc${Date.now().toString(36)}`
const TBL = `${RUN}_cc` // 校验用例自建的物理表（模型要真实拉列，只能建一张自己的）

const TABLES = {
  databridge_metric_domain: ['id', 'name', 'code', 'parent_id', 'table_prefix', 'del_flag'],
  databridge_metric_model: ['id', 'datasource_id', 'domain_id', 'layer', 'table_name', 'create_type', 'table_ddl', 'time_column', 'status', 'del_flag'],
  databridge_metric_model_column: ['model_id', 'column_name', 'biz_name', 'data_type', 'role', 'agg_default', 'is_key'],
  databridge_metric_metric: ['id', 'code', 'name', 'alias', 'type', 'define_type', 'model_id', 'domain_id', 'expr', 'define_params', 'data_format', 'caliber', 'status', 'version', 'del_flag'],
  databridge_metric_dep: ['parent_id', 'child_id'],
  databridge_metric_version: ['id', 'metric_id', 'version', 'snapshot', 'change_note'],
  databridge_metric_task: ['id', 'domain_id', 'source_model_id', 'metric_ids', 'dimension_column_ids', 'clean_rules', 'time_preset', 'target_datasource_id', 'target_table', 'write_mode', 'schedule_cron', 'last_status', 'del_flag'],
  databridge_metric_task_run: ['id', 'task_id', 'trigger', 'status', 'sql_text', 'read_rows', 'write_rows', 'elapsed_ms'],
  databridge_metric_term: ['id', 'name', 'alias', 'description', 'related_metric_ids', 'del_flag'],
  databridge_metric_example: ['id', 'question', 'm2sql', 'enabled'],
  databridge_metric_query_log: ['id', 'user_name', 'question', 'matched', 'metric_ids', 'm2sql', 'physical_sql', 'status', 'reviewed'],
  databridge_metric_setting: ['setting_key', 'setting_value', 'secret', 'updated_by'],
}

const SEQUENCES = ['dom-', 'mdl-', 'met-', 'mver-', 'mtk-', 'mtr-', 'mterm-', 'mex-', 'mlg-']

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
const items = (r) => (result(r).items || [])

/** 只清本套件 ${RUN} 自建的资产（含软删行——它占着 code，不清会污染下一次跑测） */
const cleanup = async () => {
  const stmts = [
    ['DELETE v FROM databridge_metric_version v JOIN databridge_metric_metric m ON v.metric_id = m.id WHERE m.code LIKE ?', [`${RUN}_%`]],
    ['DELETE d FROM databridge_metric_dep d JOIN databridge_metric_metric m ON (d.parent_id = m.id OR d.child_id = m.id) WHERE m.code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`]],
    ['DELETE c FROM databridge_metric_model_column c JOIN databridge_metric_model mo ON c.model_id = mo.id WHERE mo.name LIKE ?', ['联调编码模型%']],
    ['DELETE FROM databridge_metric_model WHERE name LIKE ?', ['联调编码模型%']],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}%`]],
    ["DELETE FROM databridge_datasource WHERE name LIKE '联调编码数据源-%'", []],
    [`DROP TABLE IF EXISTS \`${TBL}\``, []],
  ]
  for (const [sql, args] of stmts) {
    try { await db.run(sql, args) } catch (e) { /* 单条失败不影响其余清理 */ }
  }
}

const main = async () => {
  console.log('== 表存在性与字符集 ==')
  const rows = await db.query(
    "SELECT TABLE_NAME AS t, TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'databridge\\_metric%'"
  )
  const present = new Map(rows.map((r) => [String(r.t).toLowerCase(), String(r.c)]))
  check('12 张表齐全', present.size >= 12, `实际 ${present.size}`)
  Object.keys(TABLES).forEach((t) => check(`表存在 ${t}`, present.has(t.toLowerCase())))
  const badCollation = rows.filter((r) => !String(r.c).startsWith('utf8mb4'))
  check('全部 utf8mb4 排序规则', badCollation.length === 0, badCollation.map((r) => r.t).join(','))

  console.log('== 关键列 ==')
  const colRows = await db.query(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'databridge\\_metric%'"
  )
  const cols = new Map()
  colRows.forEach((r) => {
    const key = String(r.t).toLowerCase()
    if (!cols.has(key)) cols.set(key, [])
    cols.get(key).push(String(r.c).toLowerCase())
  })
  Object.entries(TABLES).forEach(([t, expected]) => {
    const actual = cols.get(t.toLowerCase()) || []
    const missing = expected.filter((c) => !actual.includes(c))
    check(`列完整 ${t}`, missing.length === 0, `缺 ${missing.join(',')}`)
  })

  console.log('== 索引红线 ==')
  const idx = await db.query(
    "SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('databridge_metric_metric','databridge_metric_domain','databridge_metric_dep','databridge_metric_setting') GROUP BY t, i, nu"
  )
  const hasUnique = (t, i) => idx.some((r) => String(r.t) === t && String(r.i) === i && Number(r.nu) === 0)
  check('metric.code 全库唯一', hasUnique('databridge_metric_metric', 'uk_metricmetric_code'))
  check('metric 依赖边 (parent,child) 唯一', hasUnique('databridge_metric_dep', 'uk_metricdep'))
  check('domain.code 唯一', hasUnique('databridge_metric_domain', 'uk_metricdomain_code'))
  check('setting_key 唯一', hasUnique('databridge_metric_setting', 'uk_metricsetting_key'))

  console.log('== ID 序列 ==')
  const seq = await db.query(
    "SELECT id_prefix AS p, next_val AS v FROM databridge_id_seq WHERE id_prefix IN ('dom-','mdl-','met-','mver-','mtk-','mtr-','mterm-','mex-','mlg-')"
  )
  const seqMap = new Map(seq.map((r) => [r.p, Number(r.v)]))
  SEQUENCES.forEach((p) => check(`序列存在 ${p}`, seqMap.has(p)))
  check('met- 序列起始 13000', seqMap.get('met-') >= 13000, `实际 ${seqMap.get('met-')}`)

  console.log('== 编码占用事前校验（v1.17 GET /metrics/code-check）==')
  await cleanup() // 幂等：先清上一次中途崩溃的残留（残留的软删行会占着 code）
  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('管理员登录（事前校验走 JWT 组）', login.status === 200 && result(login).token, login.text.slice(0, 140))
  const token = result(login).token

  // 自建样本资产：物理表 → 数据源 → 域 → 引用模型（模型要真实拉列，只能用自己的表）
  await db.run(
    `CREATE TABLE IF NOT EXISTS \`${TBL}\` (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      amt DECIMAL(18,2),
      pay_date DATE
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  )
  const dsRes = await req('/datasources', {
    method: 'POST', token,
    body: { name: `联调编码数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  const dsId = result(dsRes).id
  const domRes = await req('/metric-domains', { method: 'POST', token, body: { name: '联调编码域', code: `${RUN}_dom` } })
  const domId = result(domRes).id
  const modelRes = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '联调编码模型', datasourceId: dsId, domainId: domId, layer: 'DWD', tableName: TBL },
  })
  const modelId = result(modelRes).id
  check('校验样本就绪（引用模型真实拉到列）', Boolean(dsId && domId && modelId) && (result(modelRes).columns || []).length >= 3, modelRes.text.slice(0, 200))

  const makeMetric = (code, name, status = 'online') => req('/metrics', {
    method: 'POST', token,
    body: { domainId: domId, code, name, status, defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' } },
  })

  const freeCode = `${RUN}_free`
  const free = await req(`/metrics/code-check?codes=${freeCode}`, { token })
  const freeItem = items(free)[0] || {}
  check('未占用的编码 → available:true', free.status === 200 && freeItem.code === freeCode && freeItem.available === true, free.text.slice(0, 200))
  check('可用项不带 reason/takenBy（也没被 /:id 吃掉）', freeItem.reason === undefined && freeItem.takenBy === undefined && result(free).id === undefined, JSON.stringify(freeItem))
  const emptyList = await req('/metrics/code-check?codes=', { token })
  check('空列表合法回 items:[]', emptyList.status === 200 && Array.isArray(result(emptyList).items) && emptyList.json.result.items.length === 0, emptyList.text.slice(0, 160))

  const takenCode = `${RUN}_taken`
  const madeOnline = await makeMetric(takenCode, '编码占用·在线')
  check('在线指标创建（占用样本）', madeOnline.status === 200, madeOnline.text.slice(0, 180))
  const takenCheck = await req(`/metrics/code-check?codes=${takenCode}`, { token })
  const takenItem = items(takenCheck)[0] || {}
  const takenBy = takenItem.takenBy || {}
  check('已存在在线指标 → taken + takenBy.deleted=false', takenItem.available === false && takenItem.reason === 'taken' && takenBy.deleted === false, takenCheck.text.slice(0, 220))
  check('takenBy 带 id/名称/状态（界面要写清是谁占的）', takenBy.id === result(madeOnline).id && takenBy.name === '编码占用·在线' && takenBy.status === 'online', JSON.stringify(takenBy))

  // 软删仍占位：真的建完再删（不是插行 mock），并核到库里确实是 del_flag=1
  const goneCode = `${RUN}_gone`
  const madeGone = await makeMetric(goneCode, '编码占用·将删除')
  const goneId = result(madeGone).id
  const removed = await req(`/metrics/${goneId}`, { method: 'DELETE', token })
  const goneFlag = await db.query('SELECT del_flag AS d FROM databridge_metric_metric WHERE id = ?', [goneId])
  check('样本指标经 DELETE 真的软删（行还在、del_flag=1）', removed.status === 200 && Number((goneFlag[0] || {}).d) === 1, JSON.stringify(goneFlag[0] || {}))
  const goneCheck = await req(`/metrics/code-check?codes=${goneCode}`, { token })
  const goneItem = items(goneCheck)[0] || {}
  check('软删指标仍占位 → taken + takenBy.deleted=true', goneItem.available === false && goneItem.reason === 'taken' && (goneItem.takenBy || {}).deleted === true, goneCheck.text.slice(0, 240))

  const badCodes = encodeURIComponent('Bad_Code,ab,_lead,中文编码')
  const bad = await req(`/metrics/code-check?codes=${badCodes}`, { token })
  const badItems = items(bad)
  check('非法编码（大写/太短/下划线开头/中文）→ reason=invalid', badItems.length === 4 && badItems.every((i) => i.available === false && i.reason === 'invalid'), bad.text.slice(0, 260))

  const dupCode = `${RUN}_dup`
  const dup = await req(`/metrics/code-check?codes=${[dupCode, `${RUN}_solo`, dupCode].join(',')}`, { token })
  const dupItems = items(dup)
  check('同批重复的编码：每一次出现都标 duplicate-in-request', dupItems.filter((i) => i.code === dupCode).length === 2 && dupItems.filter((i) => i.code === dupCode).every((i) => i.available === false && i.reason === 'duplicate-in-request'), dup.text.slice(0, 300))
  check('按请求顺序逐项回显，重复不牵连其它项', dupItems.length === 3 && dupItems[1].code === `${RUN}_solo` && dupItems[1].available === true, JSON.stringify(dupItems.map((i) => `${i.code}/${i.reason || 'ok'}`)))

  const manyCodes = (n) => encodeURIComponent(Array.from({ length: n }, (_, i) => `${RUN}_m${i}`).join(','))
  const overflow = await req(`/metrics/code-check?codes=${manyCodes(51)}`, { token })
  check('codes 超 50 个 → 400/40001', overflow.status === 400 && (overflow.json || {}).code === 40001, overflow.text.slice(0, 160))
  const exactly = await req(`/metrics/code-check?codes=${manyCodes(50)}`, { token })
  check('正好 50 个放行（与 POST /metrics/batch 同上限）', exactly.status === 200 && items(exactly).length === 50, exactly.text.slice(0, 160))

  const noToken = await req(`/metrics/code-check?codes=${freeCode}`)
  check('未带 token → 401', noToken.status === 401, noToken.text.slice(0, 120))

  // 事前与事后同一份规则：事前说 taken 的，保存期必须同样被拒（同一条「占用」文案）
  const resaved = await makeMetric(takenCode, '编码占用·重投')
  check('事前 taken 的编码保存期同样 40001（口径同源，不另写一套）', resaved.status === 400 && (resaved.json || {}).code === 40001 && /占用/.test((resaved.json || {}).message || ''), resaved.text.slice(0, 200))

  console.log('== 清理 ==')
  await cleanup()
  const left = await db.query('SELECT COUNT(*) AS c FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`])
  check('自建指标（含软删占位行）已清干净', Number(left[0].c) === 0, JSON.stringify(left[0] || {}))
  const tableLeft = await db.query(
    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TBL]
  )
  check('自建物理表已 DROP', Number(tableLeft[0].c) === 0, JSON.stringify(tableLeft[0] || {}))

  console.log(`\ntest-metric-base: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => {
  console.error('test-metric-base crashed:', e.message)
  await cleanup()
  console.log(`test-metric-base: ${pass} pass, ${fail + 1} fail (异常终止)`)
  process.exit(1)
})
