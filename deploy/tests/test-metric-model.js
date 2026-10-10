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

/** 本套件会写/删这几项配置——它们是共享元库里的真实生产配置，必须先快照后还原 */
const SETTINGS_TOUCHED = ['llm.model', 'llm.embed.baseUrl', 'llm.embed.apiKey']
/** 只快照一次，且必须在 main() 写配置之前拍：cleanup 末尾再拍就会把本套件写进去的假模型名当成用户原值 */
let settingsSnapshot = null

const snapshotSettings = async () => {
  if (settingsSnapshot) return settingsSnapshot
  process.env.DB_DRIVER = 'mysql'
  const db = require('../../node-express-boilerplate/src/db/mysql')
  try {
    settingsSnapshot = await db.query(
      `SELECT setting_key, setting_value, secret, updated_by, updated_at FROM databridge_metric_setting
        WHERE setting_key IN (${SETTINGS_TOUCHED.map(() => '?').join(', ')})`,
      SETTINGS_TOUCHED
    )
  } catch (e) {
    // 表还不存在（首次启动）时没什么可还原的
    settingsSnapshot = []
  }
  return settingsSnapshot
}

const cleanup = async () => {
  process.env.DB_DRIVER = 'mysql'
  const db = require('../../node-express-boilerplate/src/db/mysql')
  // 血泪教训（2026-10-09）：这里的 DELETE 曾把用户在线上配好的 llm.model 抹掉，
  // 回落成 env 默认值 deepseek-chat → 被内网网关模型白名单 400 拒，问数整体不可用。
  const snapshot = await snapshotSettings()
  const stmts = [
    // 生命周期用例会在联调库真建表；软删模型默认不动物理表，这里兜底清掉本次 RUN 前缀的表（绝不涉及平台表）
    [`DROP TABLE IF EXISTS \`${RUN}_ads_demo\``, []],
    [`DROP TABLE IF EXISTS \`${RUN}_ads_none\``, []],
    [`DROP TABLE IF EXISTS \`${RUN}_ads_drop\``, []],
    ['DELETE FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`]],
    ["DELETE FROM databridge_metric_model_column WHERE model_id LIKE 'mdl-%' AND model_id IN (SELECT id FROM databridge_metric_model WHERE domain_id IN (SELECT id FROM databridge_metric_domain WHERE code LIKE ?))", [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_task_run WHERE id LIKE ?', ['mtr-%']],
    ['DELETE FROM databridge_metric_model WHERE id IN (SELECT id FROM (SELECT id FROM databridge_metric_model m WHERE m.domain_id IN (SELECT id FROM databridge_metric_domain WHERE code LIKE ?)) x)', [`${RUN}_%`]],
    // 全库清扫：回归联调域码族（mtd/msq/mtk/m5c/mt+时间戳36 进制）中零模型零指标的空域
    // （历史缺陷：code=RUN 无后缀时 LIKE RUN_% 匹配不到；套件中途崩溃也会残留）
    ["DELETE FROM databridge_metric_domain WHERE (code LIKE 'mtd%' OR code LIKE 'msq%' OR code LIKE 'mtk%' OR code LIKE 'm5c%' OR (code LIKE 'mt%' AND code NOT LIKE 'mtd%' AND code NOT LIKE 'mtk%')) AND code <> ? AND code NOT LIKE 'dm%' AND id NOT IN (SELECT domain_id FROM databridge_metric_model) AND id NOT IN (SELECT domain_id FROM databridge_metric_metric)", [`${RUN}x`]],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}%`]],
    // 分层树分类（契约 1.16）：本套件建的分类都带 RUN 前缀，段尾软删过，这里连软删行一起清掉
    ['DELETE FROM databridge_metric_model_category WHERE name LIKE ?', [`${RUN}%`]],
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
  // 把快照里的真实配置写回去（跑测试期间被改/被删的都还原，不让线上问数失去模型设置）
  for (const row of snapshot) {
    try {
      await db.run(
        `REPLACE INTO databridge_metric_setting (setting_key, setting_value, secret, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [row.setting_key, row.setting_value, row.secret, row.updated_by, row.updated_at]
      )
    } catch (e) { /* 单条还原失败不影响其余 */ }
  }
}

const main = async () => {
  await snapshotSettings() // 先拍用户原值，再开始任何写操作（含本套件的 llm.model PUT）
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

  console.log('== 模型生命周期（草稿→启用→生成表→删除连带 DROP；真建真删 ' + `${RUN}_ads_demo` + '）==')
  const ddlId = (ddlModel.json.result || {}).id
  check('界面建表新建即草稿', ddlModel.json.result.status === 'draft', ddlModel.text.slice(0, 120))
  check('草稿表状态 none（还没建表）', ddlModel.json.result.tableStatus === 'none')
  check('引用表登记即存在（exists）', (refModel.json.result || {}).tableStatus === 'exists')

  const draftCreate = await req(`/metric-models/${ddlId}/create-table`, { method: 'POST', token })
  check('草稿不可生成表 → 40001', draftCreate.status === 400 && draftCreate.json.code === 40001
    && /启用/.test(draftCreate.text), draftCreate.text.slice(0, 200))

  const draftMetric = await req('/metrics', {
    method: 'POST', token,
    body: {
      domainId: rootId, code: `${RUN}_draftref`, name: '草稿引用试装', status: 'online',
      defineType: 'MEASURE', defineParams: { modelId: ddlId, measureColumn: 'amt', agg: 'sum' },
    },
  })
  check('草稿模型不可被指标引用（报错指明先启用）', draftMetric.status === 400
    && /草稿|启用/.test(draftMetric.text), draftMetric.text.slice(0, 220))

  const enable = await req(`/metric-models/${ddlId}`, { method: 'PUT', token, body: { status: 'online' } })
  check('启用草稿 → online', enable.status === 200 && enable.json.result.status === 'online', enable.text.slice(0, 160))

  const createTable = await req(`/metric-models/${ddlId}/create-table`, { method: 'POST', token })
  check('生成表真执行（created + executed）', createTable.status === 200
    && createTable.json.result.tableStatus === 'created'
    && createTable.json.result.executed === true
    && !createTable.json.result.tableMsg, createTable.text.slice(0, 300))

  // 建表是否真落到库里：直接预览这张新表（SELECT 走真实引擎，空表也返回 3 个列名）
  const createdPreview = await req(`/metric-models/${ddlId}/preview`, { token })
  check('生成的物理表可被真实读取（3 列）', createdPreview.status === 200
    && createdPreview.json.result.executable === true
    && (createdPreview.json.result.columns || []).length === 3, createdPreview.text.slice(0, 240))

  const again = await req(`/metric-models/${ddlId}/create-table`, { method: 'POST', token })
  check('重复生成表幂等（仍 created）', again.status === 200
    && again.json.result.tableStatus === 'created', again.text.slice(0, 200))

  const refDrop = await req(`/metric-models/${refId}?dropTable=true`, { method: 'DELETE', token })
  check('引用表 dropTable → 40001（平台永不 DROP 源表）', refDrop.status === 400
    && refDrop.json.code === 40001 && /引用表|界面建表/.test(refDrop.text), refDrop.text.slice(0, 200))
  check('被拒后引用模型未被误删', (await req(`/metric-models/${refId}`, { token })).status === 200)

  const neverBuilt = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '联调从未建表', datasourceId: dsId, domainId: rootId, layer: 'ADS', createType: 'ddl', tableName: `${RUN}_ads_none`, columns: newCols },
  })
  const neverBuiltId = (neverBuilt.json.result || {}).id
  await req(`/metric-models/${neverBuiltId}`, { method: 'PUT', token, body: { status: 'online' } })
  const dropNeverBuilt = await req(`/metric-models/${neverBuiltId}?dropTable=true`, { method: 'DELETE', token })
  check('未建表的 ddl 模型 dropTable → 40001', dropNeverBuilt.status === 400
    && dropNeverBuilt.json.code === 40001 && /拒绝 DROP|并未创建/.test(dropNeverBuilt.text), dropNeverBuilt.text.slice(0, 200))

  const delChild = await req(`/metric-domains/${child.json.result.id}`, { method: 'DELETE', token })
  check('删有模型的域 → 40902', delChild.status === 409 && delChild.json.code === 40902)
  const delModel = await req(`/metric-models/${ddlId}`, { method: 'DELETE', token })
  check('模型软删（默认不动物理表）', delModel.status === 200 && delModel.json.result.deleted === true
    && delModel.json.result.dropped === false, delModel.text.slice(0, 160))

  // 平台自建表走完整回路：重新登记 → 启用 → 建表 → 带 dropTable 删除 → 表应真的没了
  const rebuild = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '联调建表再删', datasourceId: dsId, domainId: rootId, layer: 'ADS', createType: 'ddl', tableName: `${RUN}_ads_drop`, columns: newCols },
  })
  const rebuildId = (rebuild.json.result || {}).id
  await req(`/metric-models/${rebuildId}`, { method: 'PUT', token, body: { status: 'online' } })
  check('重建模型并建表', (await req(`/metric-models/${rebuildId}/create-table`, { method: 'POST', token })).json.result.tableStatus === 'created')
  const dropOk = await req(`/metric-models/${rebuildId}?dropTable=true`, { method: 'DELETE', token })
  check('删除平台自建表（dropped=true）', dropOk.status === 200 && dropOk.json.result.deleted === true
    && dropOk.json.result.dropped === true, dropOk.text.slice(0, 240))
  // 表名此刻已无人登记，再登记成引用模型能成功；随后预览必然报「表不存在」——以此证明 DROP 真的执行了
  const ghost = await req('/metric-models', {
    method: 'POST', token,
    body: { name: '已删表回读', datasourceId: dsId, domainId: rootId, layer: 'ADS', tableName: `${RUN}_ads_drop` },
  })
  const ghostResult = (ghost.json || {}).result || {}
  const ghostId = ghostResult.id
  const ghostPreview = ghostId ? await req(`/metric-models/${ghostId}/preview`, { token }) : null
  check('DROP 后物理表确实不存在', ghost.status !== 200
    || ((ghostResult.columns || []).length === 0
      && ghostPreview && (ghostPreview.status >= 400 || ghostPreview.json.result.executable !== true)),
  `${ghost.text.slice(0, 120)}|${(ghostPreview && ghostPreview.text || '').slice(0, 160)}`)

  console.log('== 字段类型归一 / 编辑约束 / 方言目录 ==')
  const catRes = await req('/metric-models/column-types', { token })
  const cat = (catRes.json && catRes.json.result) || {}
  const fam = (list, name) => (list || []).find((f) => f.family === name) || {}
  check('类型目录双方言', catRes.status === 200 && fam(cat.mysql, 'VARCHAR').rendered === 'VARCHAR(64)'
    && fam(cat.oracle, 'VARCHAR').rendered === 'VARCHAR2(64 CHAR)' && fam(cat.oracle, 'VARCHAR').maxLength === 4000,
  catRes.text.slice(0, 200))
  check('只有字符串/定点数族要填长度', fam(cat.mysql, 'VARCHAR').hasLength === true && fam(cat.mysql, 'DATE').hasLength === false)

  // 手打的无长度/异方言类型（用户截图里的现场）：保存要归一，DDL 不能出现 VARCHAR 不带长度
  const looseModel = await req('/metric-models', {
    method: 'POST', token,
    body: {
      name: '联调指标模型归一', datasourceId: dsId, domainId: rootId, layer: 'DWS', createType: 'ddl',
      tableName: `${RUN}_norm_demo`,
      columns: [
        { columnName: 'shop_sign', bizName: '牌号', dataType: 'varchar', role: 'dimension' },
        { columnName: 'weight', bizName: '重量', dataType: 'NUMBER(24,6)', role: 'measure' },
        { columnName: 'etl_dt', bizName: '时间', dataType: 'TIMESTAMP(6)', role: 'time' },
      ],
    },
  })
  const normCols = ((looseModel.json || {}).result || {}).columns || []
  check('dataType 服务端归一（varchar→VARCHAR(64)、NUMBER(24,6)→DECIMAL(24,6)、TIMESTAMP(6)→TIMESTAMP）',
    looseModel.status === 200 && normCols[0].dataType === 'VARCHAR(64)'
      && normCols[1].dataType === 'DECIMAL(24,6)' && normCols[2].dataType === 'TIMESTAMP',
  JSON.stringify(normCols.map((c) => c.dataType)))
  const normId = normCols.length && looseModel.json.result.id
  const badUpd = await req(`/metric-models/${normId}`, {
    method: 'PUT', token, body: { name: 'x', domainId: rootId, datasourceId: dsId },
  })
  check('编辑不可迁移域/数据源（多传 → 40001，前端因此不下发）',
    badUpd.status === 400 && /domainId/.test(badUpd.text) && /datasourceId/.test(badUpd.text), badUpd.text.slice(0, 160))
  const okUpd = await req(`/metric-models/${normId}`, {
    method: 'PUT', token,
    body: { layer: 'DWS', columns: [...normCols, { columnName: 'steel_type', bizName: '钢种', dataType: 'varchar', role: 'dimension' }] },
  })
  const afterUpd = await req(`/metric-models/${normId}`, { token })
  const ddlAfter = ((afterUpd.json || {}).result || {}).tableDdl || ''
  check('改字段后留档 DDL 同步重算（新列进入 CREATE，且无「VARCHAR 不带长度」）',
    okUpd.status === 200 && /steel_type/i.test(ddlAfter) && !/VARCHAR\s+NOT NULL/.test(ddlAfter), ddlAfter.slice(0, 200))

  // Oracle 数据源上的 DDL 方言（建记录即可，preview-ddl 不连库）
  const oraDs = await req('/datasources', {
    method: 'POST', token,
    body: { name: `联调指标数据源-${RUN}-ora`, type: 'oracle', host: '127.0.0.1', port: 1521, database: 'ORCLPDB', username: 'scott', password: 'tiger' },
  })
  const oraPreview = await req('/metric-models/preview-ddl', {
    method: 'POST', token,
    body: {
      domainId: rootId, layer: 'DWS', tableName: `${RUN}_ora_demo`, datasourceId: oraDs.json.result.id,
      columns: [{ columnName: 'shop_sign', bizName: '牌号', dataType: 'varchar', role: 'dimension' }],
    },
  })
  const opv = (oraPreview.json || {}).result || {}
  check('preview-ddl 带 datasourceId 出 Oracle 方言（VARCHAR2 + COMMENT ON，无反引号/ENGINE）',
    oraPreview.status === 200 && opv.dialect === 'oracle' && /CREATE TABLE .*SHOP_SIGN VARCHAR2\(64 CHAR\) NOT NULL/.test(opv.ddl || '')
      && /COMMENT ON COLUMN/.test(opv.ddl || '') && !/`|ENGINE=/.test(opv.ddl || ''), oraPreview.text.slice(0, 240))
  const overWide = await req('/metric-models/preview-ddl', {
    method: 'POST', token,
    body: {
      domainId: rootId, layer: 'DWS', tableName: `${RUN}_ora_wide`, datasourceId: oraDs.json.result.id,
      columns: [{ columnName: 'big', dataType: 'VARCHAR(5000)', role: 'dimension' }],
    },
  })
  check('oracle 超宽列按 40001 拒绝', overWide.status === 400 && /4000/.test(overWide.text), overWide.text.slice(0, 160))
  await req(`/metric-models/${normId}`, { method: 'DELETE', token })
  await req(`/datasources/${oraDs.json.result.id}`, { method: 'DELETE', token })

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

  console.log('== 建模分层树与分类 ==')
  // 本段全程只动元数据：分类增删改 + 模型归类都不产 DDL，建的 ddl 模型也不调 create-table（不落物理表）。
  // 自建分类/模型一律 ${RUN} 前缀，段尾显式删除 + cleanup() 兜底，绝不拿平台真实资产当样本。
  const layersOf = (r) => ((r.json || {}).result || {}).layers || []
  const layerOf = (r, name) => layersOf(r).find((l) => l.layer === name) || {}
  const nodeOf = (r, layer, id) => ((layerOf(r, layer).children || []).find((n) => n.id === id) || {})
  // 真库里可能已有别的分类（如 seed 的「交易域」），排序断言只看本段自己建的那几个节点
  const runNodes = (r, layer) => (layerOf(r, layer).children || []).filter((n) => String(n.name).startsWith(RUN))
  const itemsOf = (r) => (((r.json || {}).result || {}).items || [])
  const idsOf = (items) => items.map((m) => m.id).join(',')
  const tree0 = await req('/metric-model-categories/tree', { token })
  const base = { DWD: layerOf(tree0, 'DWD'), DIM: layerOf(tree0, 'DIM') }
  check('无 token /metric-model-categories/tree → 401', (await req('/metric-model-categories/tree')).status === 401)
  check('tree 5 个分层根恒定出现 + 中文 label（对齐前端 LAYER_OPTIONS）+ total=分类数',
    tree0.status === 200 && layersOf(tree0).length === 5
      && layersOf(tree0).map((l) => l.layer).join() === 'ODS,DIM,DWD,DWS,ADS'
      && layersOf(tree0).map((l) => l.label).join() === '贴源层,维度层,明细层,汇总层,应用层'
      && tree0.json.result.total === layersOf(tree0).reduce((s, l) => s + (l.children || []).length, 0),
  tree0.text.slice(0, 300))
  check('一个分类都没有的分层也回 children:[] / modelCount:0（界面无需兜底空层）',
    (layerOf(tree0, 'ODS').children || []).length === 0 && layerOf(tree0, 'ODS').modelCount === 0
      && layerOf(tree0, 'ODS').uncategorized === 0, tree0.text.slice(0, 200))

  const badCatLayer = await req('/metric-model-categories', { method: 'POST', token, body: { name: `${RUN}_坏层`, layer: 'ODSX' } })
  check('分类非法 layer → 400/40001', badCatLayer.status === 400 && badCatLayer.json.code === 40001, badCatLayer.text.slice(0, 160))
  const noNameCat = await req('/metric-model-categories', { method: 'POST', token, body: { layer: 'DWD' } })
  check('分类 name 必填 → 400/40001', noNameCat.status === 400 && noNameCat.json.code === 40001, noNameCat.text.slice(0, 160))
  const longDescCat = await req('/metric-model-categories', {
    method: 'POST', token, body: { name: `${RUN}_长描述`, layer: 'DWD', description: 'x'.repeat(513) },
  })
  check('分类 description >512 → 400/40001', longDescCat.status === 400 && longDescCat.json.code === 40001, longDescCat.text.slice(0, 160))

  const catDwd = await req('/metric-model-categories', {
    method: 'POST', token,
    body: { name: `${RUN}_trade`, layer: 'DWD', description: '交易域：订单/访问等明细事实', sort: 2 },
  })
  check('创建分类（mcat- 前缀 + 中文口径说明落库）',
    catDwd.status === 200 && /^mcat-/.test(((catDwd.json || {}).result || {}).id || '')
      && catDwd.json.result.description === '交易域：订单/访问等明细事实' && catDwd.json.result.sort === 2,
  catDwd.text.slice(0, 240))
  const catDwdId = (catDwd.json.result || {}).id
  const dupCat = await req('/metric-model-categories', { method: 'POST', token, body: { name: `${RUN}_TRADE`, layer: 'DWD' } })
  check('同层重名（大小写不敏感）→ 40001', dupCat.status === 400 && dupCat.json.code === 40001 && /同名分类/.test(dupCat.text), dupCat.text.slice(0, 200))
  const catDim = await req('/metric-model-categories', {
    method: 'POST', token, body: { name: `${RUN}_trade`, layer: 'DIM', description: '维度登记：码表与主数据' },
  })
  check('跨层同名允许（分类是全局按层，同层才判重）', catDim.status === 200 && catDim.json.result.id !== catDwdId, catDim.text.slice(0, 200))
  const catDimId = (catDim.json.result || {}).id
  const catSort1 = await req('/metric-model-categories', { method: 'POST', token, body: { name: `${RUN}_sort1`, layer: 'DWD', sort: 1 } })
  const catSort1Id = ((catSort1.json || {}).result || {}).id
  const catSort1b = await req('/metric-model-categories', { method: 'POST', token, body: { name: `${RUN}_sort1b`, layer: 'DWD', sort: 1 } })
  const catSort1bId = ((catSort1b.json || {}).result || {}).id
  const treeSorted = await req('/metric-model-categories/tree', { token })
  const sortedSorts = (layerOf(treeSorted, 'DWD').children || []).map((n) => n.sort)
  check('children 按 sort:asc 再 createdAt:asc（同 sort 谁先建谁在前）',
    runNodes(treeSorted, 'DWD').map((n) => n.name).join() === `${RUN}_sort1,${RUN}_sort1b,${RUN}_trade`
      && sortedSorts.every((v, i) => i === 0 || sortedSorts[i - 1] <= v),
  JSON.stringify((layerOf(treeSorted, 'DWD').children || []).map((n) => `${n.name}:${n.sort}`)))

  const mkCatModel = async (suffix, layer, extra = {}) => {
    const res = await req('/metric-models', {
      method: 'POST', token,
      body: {
        name: `${RUN}_${suffix}`, datasourceId: dsId, domainId: rootId, layer,
        createType: 'ddl', tableName: `${RUN}_cat_${suffix}`, columns: newCols, ...extra,
      },
    })
    return { id: ((res.json || {}).result || {}).id, res }
  }
  const mA = await mkCatModel('a', 'DWD')
  const mB = await mkCatModel('b', 'DWD')
  const mC = await mkCatModel('c', 'DIM')
  check('分层树用例模型就绪（DWD×2 + DIM×1，不调 create-table 因此零物理表）',
    Boolean(mA.id && mB.id && mC.id), `${mA.id}|${mB.id}|${mC.id}`)

  const mCDetail = (await req(`/metric-models/${mC.id}`, { token })).json.result || {}
  check('模型详情 categoryId 归一为空串（不是 undefined）',
    Object.prototype.hasOwnProperty.call(mCDetail, 'categoryId') && mCDetail.categoryId === '', JSON.stringify(mCDetail).slice(0, 200))
  const refDetail = (await req(`/metric-models/${refId}`, { token })).json.result || {}
  check('旧行（自动补列为 NULL）读时也归一成空串', refDetail.categoryId === '', JSON.stringify(refDetail.categoryId))
  const listNorm = await req(`/metric-models?domainId=${rootId}&size=200`, { token })
  check('列表行同样归一（每个 item 的 categoryId 都是字符串）',
    itemsOf(listNorm).length > 0 && itemsOf(listNorm).every((m) => typeof m.categoryId === 'string'),
  JSON.stringify(itemsOf(listNorm).map((m) => m.categoryId)))

  const mD = await mkCatModel('d', 'DWD', { categoryId: catDwdId })
  check('createModel 带 categoryId：创建即归类并回读',
    Boolean(mD.id) && ((mD.res.json || {}).result || {}).categoryId === catDwdId, mD.res.text.slice(0, 200))
  const crossCreate = await req('/metric-models', {
    method: 'POST', token,
    body: { name: `${RUN}_bad`, datasourceId: dsId, domainId: rootId, layer: 'ADS', createType: 'ddl', tableName: `${RUN}_cat_bad`, columns: newCols, categoryId: catDwdId },
  })
  check('createModel 跨层 categoryId → 40001（ADS 模型不进 DWD 分类）',
    crossCreate.status === 400 && crossCreate.json.code === 40001 && /跨层/.test(crossCreate.text), crossCreate.text.slice(0, 220))

  const treeC = await req('/metric-model-categories/tree', { token })
  check('分层根 modelCount/uncategorized 随模型增减（计数口径＝全量未删除模型）',
    layerOf(treeC, 'DWD').modelCount === base.DWD.modelCount + 3
      && layerOf(treeC, 'DWD').uncategorized === base.DWD.uncategorized + 2,
  JSON.stringify({ before: base.DWD, after: layerOf(treeC, 'DWD') }))
  check('分类节点 modelCount 只数自己名下的模型',
    nodeOf(treeC, 'DWD', catDwdId).modelCount === 1 && nodeOf(treeC, 'DWD', catSort1Id).modelCount === 0,
  JSON.stringify((layerOf(treeC, 'DWD').children || []).map((n) => `${n.name}:${n.modelCount}`)))
  const byCat = await req(`/metric-models?categoryId=${catDwdId}&size=200`, { token })
  check('categoryId 精确筛', itemsOf(byCat).length === 1 && itemsOf(byCat)[0].id === mD.id, idsOf(itemsOf(byCat)))
  const noneDwd = await req('/metric-models?layer=DWD&categoryId=none&size=200', { token })
  check('categoryId=none 筛出未分类（与树上 uncategorized 同数，且不把已归类的捞进来）',
    itemsOf(noneDwd).length === layerOf(treeC, 'DWD').uncategorized
      && itemsOf(noneDwd).every((m) => !m.categoryId)
      && itemsOf(noneDwd).some((m) => m.id === mA.id) && !itemsOf(noneDwd).some((m) => m.id === mD.id),
  idsOf(itemsOf(noneDwd)))
  const noneRoot = await req(`/metric-models?domainId=${rootId}&categoryId=none&size=500`, { token })
  check('none 谓词在 MySQL 整表回退路径也认得 NULL 旧行', itemsOf(noneRoot).some((m) => m.id === refId), idsOf(itemsOf(noneRoot)).slice(0, 200))

  const assignCross = await req('/metric-model-categories/assign', {
    method: 'POST', token, body: { categoryId: catDwdId, modelIds: [mA.id, mB.id, mC.id, 'mdl-nope-9999'] },
  })
  const ares = (assignCross.json || {}).result || {}
  check('assign 跨层/缺模型都不整批失败，HTTP 恒 200', assignCross.status === 200 && assignCross.json.code === 0, assignCross.text.slice(0, 200))
  check('assign 的 assigned/failed 与逐条 results 对齐', ares.assigned === 2 && ares.failed === 2 && (ares.results || []).length === 4, JSON.stringify(ares).slice(0, 300))
  check('跨层那条被点名：message 说清分类层与模型层', (() => {
    const hit = (ares.results || []).find((r) => r.id === mC.id) || {}
    return hit.ok === false && /跨层/.test(hit.message || '') && /DIM/.test(hit.message || '') && /DWD/.test(hit.message || '')
  })(), JSON.stringify(ares).slice(0, 300))
  check('不存在的模型也被点名', (() => {
    const hit = (ares.results || []).find((r) => r.id === 'mdl-nope-9999') || {}
    return hit.ok === false && /不存在/.test(hit.message || '')
  })(), JSON.stringify(ares).slice(0, 300))
  const treeAssigned = await req('/metric-model-categories/tree', { token })
  check('归类后分类计数与未分类桶同步归位', nodeOf(treeAssigned, 'DWD', catDwdId).modelCount === 3
    && layerOf(treeAssigned, 'DWD').uncategorized === base.DWD.uncategorized, JSON.stringify(layerOf(treeAssigned, 'DWD')))
  const unassign = await req('/metric-model-categories/assign', { method: 'POST', token, body: { categoryId: '', modelIds: [mB.id] } })
  check('categoryId 空串＝移出回未分类', unassign.status === 200 && unassign.json.result.assigned === 1
    && ((await req(`/metric-models/${mB.id}`, { token })).json.result || {}).categoryId === '', unassign.text.slice(0, 200))

  const crossUpd = await req(`/metric-models/${mA.id}`, { method: 'PUT', token, body: { categoryId: catDimId } })
  check('updateModel 跨层 categoryId → 40001', crossUpd.status === 400 && crossUpd.json.code === 40001 && /跨层/.test(crossUpd.text), crossUpd.text.slice(0, 220))
  check('被拒后模型归属不变（不是先写后拒）',
    ((await req(`/metric-models/${mA.id}`, { token })).json.result || {}).categoryId === catDwdId)
  const sameUpd = await req(`/metric-models/${mC.id}`, { method: 'PUT', token, body: { categoryId: catDimId } })
  check('updateModel 同层归类成功并落库', sameUpd.status === 200 && (sameUpd.json.result || {}).categoryId === catDimId
    && ((await req(`/metric-models/${mC.id}`, { token })).json.result || {}).categoryId === catDimId, sameUpd.text.slice(0, 200))

  const putLayer = await req(`/metric-model-categories/${catDwdId}`, { method: 'PUT', token, body: { name: `${RUN}_trade2`, layer: 'ADS' } })
  check('PUT /metric-model-categories/:id 带 layer → 40001（换层请新建分类再批量归类）',
    putLayer.status === 400 && putLayer.json.code === 40001 && /新建分类/.test(putLayer.text), putLayer.text.slice(0, 220))
  const putCat = await req(`/metric-model-categories/${catSort1Id}`, {
    method: 'PUT', token, body: { name: `${RUN}_sort1改`, description: '改过的口径说明', sort: 9 },
  })
  const treePut = await req('/metric-model-categories/tree', { token })
  const putSorts = (layerOf(treePut, 'DWD').children || []).map((n) => n.sort)
  check('PUT 只改 name/description/sort 也生效，children 随之重排（sort 9 落到末位）',
    putCat.status === 200 && putCat.json.result.description === '改过的口径说明'
      && runNodes(treePut, 'DWD').map((n) => n.name).join() === `${RUN}_sort1b,${RUN}_trade,${RUN}_sort1改`
      && putSorts.every((v, i) => i === 0 || putSorts[i - 1] <= v),
  JSON.stringify((layerOf(treePut, 'DWD').children || []).map((n) => `${n.name}:${n.sort}`)))
  const putMissing = await req('/metric-model-categories/mcat-not-exist', { method: 'PUT', token, body: { name: `${RUN}_孤儿` } })
  check('改不存在的分类 → 404/40401', putMissing.status === 404 && putMissing.json.code === 40401, putMissing.text.slice(0, 160))

  const treeBeforeDel = await req('/metric-model-categories/tree', { token })
  const inCatIds = itemsOf(await req(`/metric-models?categoryId=${catDwdId}&size=200`, { token })).map((m) => m.id)
  const delCat = await req(`/metric-model-categories/${catDwdId}`, { method: 'DELETE', token })
  const moved = (delCat.json || {}).result || {}
  check('删除分类＝软删 + 名下模型自动降级，movedModels 报出搬走的模型数',
    delCat.status === 200 && moved.deleted === true && moved.movedModels === inCatIds.length && inCatIds.length >= 2,
  `${delCat.text.slice(0, 160)} | moved=${inCatIds.length}`)
  const noneAfterDel = await req('/metric-models?layer=DWD&categoryId=none&size=500', { token })
  check('降级后的模型重新出现在未分类桶（none 里）',
    inCatIds.every((id) => itemsOf(noneAfterDel).some((m) => m.id === id)), idsOf(itemsOf(noneAfterDel)))
  const treeAfterDel = await req('/metric-model-categories/tree', { token })
  check('已删分类不在树上，分层根 modelCount 不变、uncategorized 接手了名下模型',
    !(layerOf(treeAfterDel, 'DWD').children || []).some((n) => n.id === catDwdId)
      && layerOf(treeAfterDel, 'DWD').modelCount === layerOf(treeBeforeDel, 'DWD').modelCount
      && layerOf(treeAfterDel, 'DWD').uncategorized === layerOf(treeBeforeDel, 'DWD').uncategorized + moved.movedModels,
  JSON.stringify({ before: layerOf(treeBeforeDel, 'DWD'), after: layerOf(treeAfterDel, 'DWD') }))
  const assignDeleted = await req('/metric-model-categories/assign', { method: 'POST', token, body: { categoryId: catDwdId, modelIds: [mA.id] } })
  check('已删分类不可再归类（逐条点名 分类不存在，仍 200）',
    assignDeleted.status === 200 && assignDeleted.json.result.failed === 1
      && /分类不存在/.test(((assignDeleted.json.result.results || [])[0] || {}).message || ''), assignDeleted.text.slice(0, 220))

  // 段尾自清理：本段建的分类与模型全部删掉（分类软删会把名下模型退回未分类，再软删模型）
  // eslint-disable-next-line no-restricted-syntax
  for (const id of [catDimId, catSort1Id, catSort1bId]) {
    // eslint-disable-next-line no-await-in-loop
    await req(`/metric-model-categories/${id}`, { method: 'DELETE', token })
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const id of [mA.id, mB.id, mC.id, mD.id]) {
    // eslint-disable-next-line no-await-in-loop
    await req(`/metric-models/${id}`, { method: 'DELETE', token })
  }
  const treeFinal = await req('/metric-model-categories/tree', { token })
  check(`本段分类/模型清理干净（树上不再有 ${RUN} 前缀节点，且 modelCount=uncategorized+各分类计数）`,
    layersOf(treeFinal).every((l) => (l.children || []).every((n) => !String(n.name).startsWith(RUN)))
      && layersOf(treeFinal).every((l) => l.modelCount === l.uncategorized + (l.children || []).reduce((s, n) => s + n.modelCount, 0)),
  treeFinal.text.slice(0, 240))

  console.log('== 首页概览 ==')
  const dash = await req('/metric-dashboard', { token })
  const d = dash.json && dash.json.result
  check('dashboard 结构完整', dash.status === 200 && d && d.domains.total >= 2 && d.models.total >= 1
    && d.metrics.byType && 'ATOMIC' in d.metrics.byType && d.tasks.last24h && Array.isArray(d.hotMetrics), dash.text.slice(0, 240))

  console.log('== 系统配置（admin 专属）==')
  const settingsGet = await req('/metric-settings', { token })
  check('GET 10 个配置项（含 embed 与问数候选值开关）', settingsGet.status === 200 && settingsGet.json.result.items.length === 10
    && settingsGet.json.result.items.some((i) => i.settingKey === 'llm.embed.baseUrl')
    && settingsGet.json.result.items.some((i) => i.settingKey === 'llm.embed.apiKey'))
  const apiKeyItem = settingsGet.json.result.items.find((i) => i.settingKey === 'llm.apiKey')
  check('llm.apiKey 掩码或空（无明文）', !apiKeyItem.value || /\*\*\*$/.test(apiKeyItem.value))
  // 契约 1.14：配置项必须存在；内置默认是 0（关）——真实环境里管理员可以打开，所以只在没有表值时断言默认
  const dimSwitch = settingsGet.json.result.items.find((i) => i.settingKey === 'chat.dimValuePrompt')
  check('chat.dimValuePrompt 存在且取值为 0|1（未配置时默认 0）', dimSwitch && ['0', '1'].includes(dimSwitch.value)
    && (dimSwitch.source !== 'default' || dimSwitch.value === '0'), JSON.stringify(dimSwitch))
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

main().catch(async (e) => {
  console.error('test-metric-model crashed:', e.message, e.stack)
  // 崩了也要还原共享配置并清残留，否则生产 admin 会读到本套件的假模型名
  try { await cleanup() } catch (cleanupErr) { console.error('cleanup 也失败：', cleanupErr.message) }
  process.exit(1)
})
