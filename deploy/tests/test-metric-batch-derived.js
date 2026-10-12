/* 契约 1.18 批量派生用例：POST /metrics/batch 的两种 item 形态。
 * 跑法（cwd 必须在 node-express-boilerplate，HTTP 段要 admin(:3001) 已启动）：
 *   cd node-express-boilerplate && set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 BASE=http://127.0.0.1:3001/api/v1 \
 *     node ../deploy/tests/test-metric-batch-derived.js
 * 资产全部 ${RUN} 前缀自建自清（物理表/数据源/域/模型/指标）。
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
const RUN = `bd${Date.now().toString(36)}`
const TBL = `${RUN}_bd`

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
    ['DELETE c FROM databridge_metric_model_column c JOIN databridge_metric_model mo ON c.model_id = mo.id WHERE mo.name LIKE ?', ['联调批量派生模型%']],
    ['DELETE FROM databridge_metric_model WHERE name LIKE ?', ['联调批量派生模型%']],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}%`]],
    ["DELETE FROM databridge_datasource WHERE name LIKE '联调批量派生数据源-%'", []],
    [`DROP TABLE IF EXISTS \`${TBL}\``, []],
  ]
  for (const [sql, args] of stmts) {
    try { await db.run(sql, args) } catch (e) { /* 单条失败不影响其余清理 */ }
  }
}

/** 形态 B（批量派生）的 item：defineType+defineParams 原样透传；domainId 由调用方补 */
const derivedItem = (code, name, defineParams) => ({
  code,
  name,
  defineType: 'METRIC',
  defineParams,
})

const main = async () => {
  await cleanup() // 幂等：先清上一次中途崩溃的残留
  console.log('== 样本就绪 ==')
  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('管理员登录', login.status === 200 && result(login).token, login.text.slice(0, 140))
  const token = result(login).token

  await db.run(
    `CREATE TABLE IF NOT EXISTS \`${TBL}\` (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      amt DECIMAL(18,2),
      pay_date DATE,
      region VARCHAR(64),
      status VARCHAR(32)
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  )
  const dsRes = await req('/datasources', {
    method: 'POST', token,
    body: { name: `联调批量派生数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  const dsId = result(dsRes).id
  const domRes = await req('/metric-domains', { method: 'POST', token, body: { name: '联调批量派生域', code: `${RUN}_dom` } })
  const domId = result(domRes).id
  const modelRes = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '联调批量派生模型', datasourceId: dsId, domainId: domId, layer: 'DWD', tableName: TBL },
  })
  const modelId = result(modelRes).id
  const colNames = (result(modelRes).columns || []).map((c) => c.columnName)
  check('样本模型真实拉到 5 列', Boolean(dsId && domId && modelId) && colNames.length >= 5, modelRes.text.slice(0, 200))

  const baseCode = `${RUN}_amt`
  const baseRes = await req('/metrics', {
    method: 'POST', token,
    body: {
      domainId: domId, code: baseCode, name: '批量派生基底·订单额', status: 'online',
      defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' },
    },
  })
  const baseId = result(baseRes).id
  check('原子基底指标创建', baseRes.status === 200 && Boolean(baseId), baseRes.text.slice(0, 200))

  console.log('== 形态 B：按维度展开 ==')
  const byDim = await req('/metrics/batch', {
    method: 'POST', token,
    body: {
      items: [
        derivedItem(`${RUN}_amt_by_region`, '按区域分订单额', { baseMetricId: baseCode, dimensions: ['region'] }),
        derivedItem(`${RUN}_amt_by_pay_date`, '按支付日期分订单额', { baseMetricId: baseCode, dimensions: ['pay_date'] }),
      ].map((it) => ({ ...it, domainId: domId })),
    },
  })
  const dimResults = result(byDim).results || []
  check('两条按维度派生全部成功（HTTP 恒 200）', byDim.status === 200 && result(byDim).created === 2 && result(byDim).failed === 0, byDim.text.slice(0, 260))
  check('results 按 index 回显编码与 id', dimResults.length === 2 && dimResults[0].index === 0 && dimResults[0].code === `${RUN}_amt_by_region` && Boolean(dimResults[1].id), JSON.stringify(dimResults))

  const regionId = dimResults[0].id
  const regionGet = await req(`/metrics/${regionId}`, { token })
  const regionMetric = result(regionGet)
  check('派生指标 type=DERIVED', regionMetric.type === 'DERIVED', JSON.stringify({ type: regionMetric.type }))
  check('expr 留空由服务端补成 ${基底code}', regionMetric.expr === `\${${baseCode}}`, String(regionMetric.expr))
  check('defineParams 原样留档（baseMetricId 存的是 code）', (regionMetric.defineParams || {}).baseMetricId === baseCode && ((regionMetric.defineParams || {}).dimensions || []).join() === 'region', JSON.stringify(regionMetric.defineParams))
  check('派生指标继承基底的取数模型', regionMetric.modelId === modelId || (regionMetric.defineParams || {}).modelId === modelId, JSON.stringify({ modelId: regionMetric.modelId, dp: (regionMetric.defineParams || {}).modelId }))
  const depRows = await db.query('SELECT parent_id AS p, child_id AS c FROM databridge_metric_dep WHERE parent_id = ?', [regionId])
  check('依赖边落库（派生 → 基底）', depRows.length === 1 && depRows[0].c === baseId, JSON.stringify(depRows))

  console.log('== 形态 B：按码值展开（filterSql）==')
  const byValue = await req('/metrics/batch', {
    method: 'POST', token,
    body: {
      items: [
        { ...derivedItem(`${RUN}_amt_01`, '订单额（华东）', { baseMetricId: baseCode, dimensions: ['region'], filterSql: "t.region='01'" }), domainId: domId },
        // 界面按码值拼的字面量：值里带单引号要翻倍转义，不能把 filterSql 拼断
        { ...derivedItem(`${RUN}_amt_on`, "订单额（O'Neil）", { baseMetricId: baseCode, filterSql: "t.region='O''Neil'" }), domainId: domId },
      ],
    },
  })
  const valueResults = result(byValue).results || []
  check('码值两条都通过（含带转义引号的过滤）', byValue.status === 200 && result(byValue).created === 2 && result(byValue).failed === 0, byValue.text.slice(0, 300))
  const onGet = result(await req(`/metrics/${valueResults[1].id}`, { token }))
  check('不带 dimensions 的纯限定派生成立，filterSql 原样留档', onGet.type === 'DERIVED' && ((onGet.defineParams || {}).dimensions === undefined || (onGet.defineParams || {}).dimensions.length === 0) && (onGet.defineParams || {}).filterSql === "t.region='O''Neil'", JSON.stringify({ type: onGet.type, dp: onGet.defineParams }))

  console.log('== 语义错逐条拒、不是整批拒 ==')
  const illegalDim = await req('/metrics/batch', {
    method: 'POST', token,
    body: { items: [{ ...derivedItem(`${RUN}_amt_bad_dim`, '维度越界样本', { baseMetricId: baseCode, dimensions: ['amt'] }), domainId: domId }] },
  })
  const illegalRes = (result(illegalDim).results || [])[0] || {}
  check('维度越界 → 逐条失败（HTTP 仍 200）', illegalRes.ok === false && result(illegalDim).failed === 1, illegalDim.text.slice(0, 260))
  check('越界原因点名可用列', /派生维度越界/.test(String(illegalRes.message || '')) && /region/.test(String(illegalRes.message || '')), String(illegalRes.message))

  const idAsBase = await req('/metrics/batch', {
    method: 'POST', token,
    body: { items: [{ ...derivedItem(`${RUN}_amt_by_id`, '基底误传 id', { baseMetricId: baseId, dimensions: ['region'] }), domainId: domId }] },
  })
  const idRes = (result(idAsBase).results || [])[0] || {}
  check('基底传成 id → 逐条失败并给出可执行提示', idRes.ok === false && /baseMetricId 要填基底的 code/.test(String(idRes.message || '')), String(idRes.message))

  console.log('== 形态不合规：整批 40001，一条都不建 ==')
  const shapeCases = [
    ['带 defineParams 却没有 defineType', [{ code: `${RUN}_s1`, name: '形态样本1', domainId: domId, defineParams: { baseMetricId: baseCode } }], /items\[0\].*defineType/],
    ['defineType 非法', [{ code: `${RUN}_s2`, name: '形态样本2', domainId: domId, defineType: 'BOGUS', defineParams: {} }], /items\[0\].*defineType 非法/],
    ['扁平形态缺 measureColumn', [{ code: `${RUN}_s3`, name: '形态样本3', domainId: domId, modelId, agg: 'sum' }], /items\[0\].*measureColumn/],
  ]
  for (const [label, bad, pattern] of shapeCases) {
    const r = await req('/metrics/batch', { method: 'POST', token, body: { items: bad } })
    check(`${label} → 400/40001 且点名下标`, r.status === 400 && (r.json || {}).code === 40001 && pattern.test(r.text), r.text.slice(0, 220))
  }
  const afterShape = await req(`/metrics/code-check?codes=${[`${RUN}_s1`, `${RUN}_s2`, `${RUN}_s3`].join(',')}`, { token })
  check('整批被拒时不留半成品（三个编码都还可用）', items(afterShape).length === 3 && items(afterShape).every((i) => i.available === true), afterShape.text.slice(0, 240))

  console.log('== A+B 同批混发：后一条引用同批刚建的基底 ==')
  const mixed = await req('/metrics/batch', {
    method: 'POST', token,
    body: {
      items: [
        { code: `${RUN}_cnt`, name: '混发新建原子·订单量', domainId: domId, modelId, measureColumn: 'id', agg: 'count', timeColumn: 'pay_date', status: 'online' },
        { ...derivedItem(`${RUN}_cnt_by_status`, '按状态分订单量', { baseMetricId: `${RUN}_cnt`, dimensions: ['status'] }), domainId: domId },
      ],
    },
  })
  check('顺序执行：第二条能引用第一条的 code', mixed.status === 200 && result(mixed).created === 2 && result(mixed).failed === 0, mixed.text.slice(0, 300))

  console.log('== 上限与老形态回归 ==')
  const overflow = await req('/metrics/batch', {
    method: 'POST', token,
    body: { items: Array.from({ length: 51 }, (_, i) => ({ code: `${RUN}_of${i}`, name: `上限样本${i}`, domainId: domId, modelId, measureColumn: 'amt', agg: 'sum' })) },
  })
  check('51 条 → 40001（上限 50 不变）', overflow.status === 400 && (overflow.json || {}).code === 40001, overflow.text.slice(0, 160))
  const legacy = await req('/metrics/batch', {
    method: 'POST', token,
    body: { items: [{ code: `${RUN}_legacy`, name: '扁平原子回归', domainId: domId, modelId, measureColumn: 'amt', agg: 'avg', timeColumn: 'pay_date', filterSql: "t.status='PAID'", status: 'online' }] },
  })
  const legacyRes = (result(legacy).results || [])[0] || {}
  check('v1.14 扁平形态零回归（折算 MEASURE 照常建）', legacy.status === 200 && legacyRes.ok === true, legacy.text.slice(0, 240))
  const legacyGet = await req(`/metrics/${legacyRes.id}`, { token })
  check('扁平项的 filterSql/timeColumn 进 defineParams', ((legacyGet.json || {}).result || {}).defineType === 'MEASURE' && (((legacyGet.json || {}).result || {}).defineParams || {}).filterSql === "t.status='PAID'", JSON.stringify((legacyGet.json || {}).result && (legacyGet.json || {}).result.defineParams))

  await cleanup()
  const left = await db.query('SELECT COUNT(*) AS n FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`])
  check('样本资产已清干净', Number(left[0].n) === 0, JSON.stringify(left[0]))

  console.log(`\n批量派生：${pass} 通过 / ${fail} 失败`)
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => {
  console.error('套件异常：', e && e.message ? e.message : e, e && e.cause ? e.cause : '')
  return cleanup().then(() => { process.exitCode = 1 })
})
