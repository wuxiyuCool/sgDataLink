/* 契约 1.8.1 数据开发流水线引擎用例：pivot/script/json 预览与真实 run 落表、沙箱红线、护栏。
 * 前置：admin mysql 模式 :3001（ENGINE_BASE_URL 可达、引擎在线）；真库需存在指向它的 mysql 数据源。
 * 跑法（cwd=node-express-boilerplate，凭据来自 .env）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026a TEST_DS_PASS=$MYSQL_PASSWORD node ../deploy/tests/test-dataflow-engine.js
 * 自建 ${RUN}_src / ${RUN}_dst 表，结束 DROP + 删除测试画布。 */
process.env.DB_DRIVER = 'mysql'
const db = require('../../node-express-boilerplate/src/db/mysql')

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123'
const RUN = `dfe${Date.now().toString(36)}`
const SRC = `${RUN}_src`
const DST = `${RUN}_dst`

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
  try { json = JSON.parse(text) } catch (e) { /* ignore */ }
  return { status: res.status, json }
}
const node = (id, type, name, config) => ({ id, type, name, config })
const chain = (...ids) => ids.slice(0, -1).map((id, i) => ({ source: id, target: ids[i + 1] }))

const main = async () => {
  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  const token = login.json?.result?.token
  if (!token) throw new Error(`登录失败：${JSON.stringify(login.json).slice(0, 120)}`)

  // 找指向真库 dataLink 的 mysql 数据源
  const dsList = await req('/datasources?size=100')
  const ds = (dsList.json?.result?.items || []).find((i) => i.type === 'mysql' && i.database === 'dataLink')
  if (!ds) throw new Error('未找到 database=dataLink 的 mysql 数据源，无法跑流水线用例')

  // 夹具表：宽表（pivot 用）+ JSON 载荷列
  await db.run(`CREATE TABLE \`${SRC}\` (
    ID INT NOT NULL, ORG_ID INT NOT NULL, METRIC_NAME VARCHAR(32) NOT NULL, METRIC_VALUE DECIMAL(12,2) NOT NULL,
    QTY INT NULL, AMOUNT DECIMAL(12,2) NULL, PAYLOAD VARCHAR(1000) NULL, PRIMARY KEY (ID)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await db.run(`CREATE TABLE \`${DST}\` (
    ID INT NOT NULL, TAG VARCHAR(64) NOT NULL, VAL VARCHAR(200) NULL, A_VAL INT NULL, BC_VAL VARCHAR(64) NULL,
    ORG_ID INT NULL, M_A DECIMAL(14,2) NULL, M_B DECIMAL(14,2) NULL, _ETL_TIME DATETIME NULL,
    PRIMARY KEY (ID)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await db.run(`INSERT INTO \`${SRC}\` (ID, ORG_ID, METRIC_NAME, METRIC_VALUE, QTY, AMOUNT, PAYLOAD) VALUES
    (1, 10, 'A', 10.5, 2, 20.0, '{"a":1,"b":{"c":"x1"}}'),
    (2, 10, 'B', 5.25, 3, 30.0, '{"a":2,"b":{"c":"x2"}}'),
    (3, 20, 'A', 7.0, 1, 7.0, 'NOT_JSON')`)
  console.log(`夹具就绪 ds=${ds.id} src=${SRC} dst=${DST}`)

  const preview = async (name, nodes, edges) => {
    const r = await req('/dataflows/preview', { method: 'POST', token, body: { nodes, edges } })
    if (r.json?.code !== 0) return { err: r.json }
    return { ok: true, result: r.json.result, name }
  }
  const inputNode = node('n1', 'input', 'src', { datasourceId: ds.id, table: SRC })
  const outputNode = node('n9', 'output', 'dst', { datasourceId: ds.id, table: DST, writeMode: 'insert' })

  console.log('== 预览：script / pivot / json ==')
  const mapScript = "const out = $input.map(r => ({ ID: r.ID, TAG: 't' + r.ID, VAL: String(r.METRIC_NAME), A_VAL: r.QTY, BC_VAL: null, ORG_ID: r.ORG_ID, M_A: null, M_B: null, _ETL_TIME: new Date().toISOString().replace('T', ' ').slice(0, 19) })); console.log('n=' + out.length); return out"
  let p = await preview('script', [inputNode, node('n2', 'script', 'map', { code: mapScript }), outputNode], chain('n1', 'n2', 'n9'))
  check('script 预览 3→3 行', p.ok && p.result.stages.find((s) => s.nodeId === 'n2').rows === 3 && p.result.sample.length === 3 && p.result.sample[0].TAG === 't1', JSON.stringify(p.err || p.result.stages))
  check('script console 进 logs', p.ok && p.result.logs.join('|').includes('n=3'))

  p = await preview('pivot-columns', [inputNode, node('n2', 'pivot', 'p', { mode: 'to_columns', groupBy: ['ORG_ID'], pivotColumn: 'METRIC_NAME', valueColumn: 'METRIC_VALUE', agg: 'sum' }), outputNode], chain('n1', 'n2', 'n9'))
  const pvRow = p.ok && p.result.sample.find((r) => r.ORG_ID === 10)
  check('行转列 org10 A=10.5 B=5.25', pvRow && Number(pvRow.A) === 10.5 && Number(pvRow.B) === 5.25, JSON.stringify(p.err || p.result.sample))
  check('行转列输出 2 组', p.ok && p.result.rowCount === 2)

  p = await preview('pivot-rows', [inputNode, node('n2', 'pivot', 'p', { mode: 'to_rows', unpivotColumns: ['QTY', 'AMOUNT'], nameColumn: 'K', valueColumn: 'V' }), outputNode], chain('n1', 'n2', 'n9'))
  check('列转行 3→6 且含 K/V', p.ok && p.result.rowCount === 6 && p.result.sample[0].K === 'QTY')

  p = await preview('json-parse', [inputNode, node('n2', 'json', 'j', { mode: 'parse', column: 'PAYLOAD', keys: ['a', 'b.c'], onError: 'null' }), outputNode], chain('n1', 'n2', 'n9'))
  check('json parse 抽 a/b.c，坏数据置空不丢行', p.ok && p.result.rowCount === 3 && p.result.sample[0].a === 1 && p.result.sample[0].b_c === 'x1' && p.result.sample[2].a === null, JSON.stringify(p.err || p.result.sample))
  p = await preview('json-fail', [inputNode, node('n2', 'json', 'j', { mode: 'parse', column: 'PAYLOAD', keys: ['a'], onError: 'fail' }), outputNode], chain('n1', 'n2', 'n9'))
  check('json onError=fail 报 40001', p.err && p.err.code === 40001, JSON.stringify(p.err))
  p = await preview('json-stringify', [inputNode, node('n2', 'json', 'j', { mode: 'parse', column: 'PAYLOAD', onError: 'null' }), node('n3', 'json', 's', { mode: 'stringify', column: 'PAYLOAD', pretty: false }), outputNode], chain('n1', 'n2', 'n3', 'n9'))
  check('parse→stringify 回字符串', p.ok && typeof p.result.sample[0].PAYLOAD === 'string' && p.result.sample[0].PAYLOAD.includes('"a":1'), JSON.stringify(p.err))

  console.log('== 沙箱与护栏 ==')
  p = await preview('sandbox', [inputNode, node('n2', 'script', 'probe', { code: "return [{ ID: 1, TAG: typeof require + '/' + typeof process + '/' + typeof globalThis.process, VAL: 'x', A_VAL: null, BC_VAL: null, ORG_ID: null, M_A: null, M_B: null }]" }), outputNode], chain('n1', 'n2', 'n9'))
  check('沙箱无 require/process', p.ok && p.result.sample[0].TAG === 'undefined/undefined/undefined', JSON.stringify(p.err || p.result.sample))
  p = await preview('timeout', [inputNode, node('n2', 'script', 'loop', { code: 'while (true) {}', timeoutMs: 2000 }), outputNode], chain('n1', 'n2', 'n9'))
  check('死循环脚本 2s 超时被杀', p.err && p.err.code === 40001 && p.err.message.includes('超时'), JSON.stringify(p.err))
  p = await preview('ssrf', [inputNode, node('n2', 'script', 'fetch', { code: "await fetch('http://169.254.169.254/latest/meta-data'); return []" }), outputNode], chain('n1', 'n2', 'n9'))
  check('脚本 fetch 禁云元址', p.err && p.err.code === 40001 && p.err.message.includes('SSRF'), JSON.stringify(p.err))
  p = await preview('limit', [{ id: 'n1', type: 'input', name: 'src', config: { datasourceId: ds.id, table: SRC, limitRows: 2 } }, node('n2', 'script', 'p', { code: 'return $input' }), outputNode], chain('n1', 'n2', 'n9'))
  check('limitRows 超限报错不截断', p.err && p.err.code === 40001 && p.err.message.includes('limitRows'), JSON.stringify(p.err))

  console.log('== 真实 run 落表 ==')
  const created = await req('/dataflows', { method: 'POST', token, body: {
    name: `${RUN}-pipe`,
    nodes: [inputNode, node('n2', 'script', 'map', { code: mapScript }), node('n9', 'output', 'dst', { datasourceId: ds.id, table: DST, writeMode: 'overwrite' })],
    edges: chain('n1', 'n2', 'n9'),
  } })
  const dfId = created.json?.result?.id
  check('创建流水线画布', !!dfId, JSON.stringify(created.json).slice(0, 160))
  const poll = async (id) => {
    for (let i = 0; i < 60; i += 1) {
      const r = await req(`/dataflows/${id}/progress`)
      const st = r.json?.result?.status
      if (st === 'success' || st === 'failed' || st === 'stopped') return r.json.result
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return { status: 'timeout' }
  }
  await req(`/dataflows/${dfId}/run`, { method: 'POST', token, body: {} })
  let prog = await poll(dfId)
  check('run 成功 execMode=real writeRows=3', prog.status === 'success' && prog.execMode === 'real' && Number(prog.writeRows) === 3, JSON.stringify(prog).slice(0, 200))
  const dstRows = await db.query(`SELECT COUNT(*) AS c, SUM(_ETL_TIME IS NOT NULL) AS ts FROM \`${DST}\``)
  check('目标表真实落 3 行且带 _ETL_TIME', Number(dstRows[0].c) === 3 && Number(dstRows[0].ts) === 3, JSON.stringify(dstRows[0]))
  const logRows = await db.query(`SELECT message FROM databridge_run_log WHERE task_id = ? AND message LIKE 'n=%'`, [dfId]).catch(() => [])
  check('script console 输出进运行日志', logRows.length >= 1 || String(prog.message || '').includes('→'), JSON.stringify(logRows).slice(0, 120))

  await req(`/dataflows/${dfId}/run`, { method: 'POST', token, body: {} })
  prog = await poll(dfId)
  const dstAgain = await db.query(`SELECT COUNT(*) AS c FROM \`${DST}\``)
  check('overwrite 重跑幂等仍 3 行', prog.status === 'success' && Number(dstAgain[0].c) === 3)

  console.log('== 失败路径与旧画布回归 ==')
  const badDf = await req('/dataflows', { method: 'POST', token, body: {
    name: `${RUN}-bad`,
    nodes: [inputNode, node('n2', 'script', 'p', { code: 'return $input' }), node('n9', 'output', 'dst', { datasourceId: ds.id, table: DST, writeMode: 'upsert' })],
    edges: chain('n1', 'n2', 'n9'),
  } })
  const badRun = await req(`/dataflows/${badDf.json.result.id}/run`, { method: 'POST', token, body: {} })
  check('upsert 画布可下发（失败在实例侧体现）', badRun.json?.code === 0, JSON.stringify(badRun.json).slice(0, 140))
  const badProg = await poll(badDf.json.result.id)
  check('output upsert 被拒且实例 failed', badProg.status === 'failed' && String(badProg.message).includes('upsert'), JSON.stringify(badProg).slice(0, 160))

  // 旧画布回归：real mysql→mysql 本就需要 fieldMappings（存量约束，非本次改动），
  // 用 postgresql 假数据源触发 simulate 路径验证「旧链路不受流水线钩子影响」
  const fakeDs = await req('/datasources', { method: 'POST', token, body: {
    name: `${RUN}-pgfake`, type: 'postgresql', host: '127.0.0.1', port: 5432, database: `fake${RUN}`, username: 'x', password: 'x',
  } })
  const fakeId = fakeDs.json?.result?.id
  const legacy = await req('/dataflows', { method: 'POST', token, body: {
    name: `${RUN}-legacy`,
    nodes: [inputNode, node('n2', 'filter', 'f', { condition: 'ID > 0' }), node('n9', 'output', 'dst', { datasourceId: fakeId, table: 'T_NONE', writeMode: 'insert' })],
    edges: chain('n1', 'n2', 'n9'),
  } })
  const legacyRun = await req(`/dataflows/${legacy.json.result.id}/run`, { method: 'POST', token, body: {} })
  check('旧画布 run 下发成功（simulate）', legacyRun.json?.code === 0, JSON.stringify(legacyRun.json).slice(0, 200))
  const legacyProg = await req(`/dataflows/${legacy.json.result.id}/progress`).then((r) => r.json.result)
  check('旧画布走引擎链路且 execMode=simulate', ['running', 'success', 'failed'].includes(legacyProg.status) && legacyProg.execMode === 'simulate', JSON.stringify(legacyProg).slice(0, 140))
  await req(`/dataflows/${legacy.json.result.id}/stop`, { method: 'POST', token, body: {} }).catch(() => {})
  if (fakeId) await req(`/datasources/${fakeId}`, { method: 'DELETE', token }).catch(() => {})

  for (const id of [dfId, badDf.json.result.id, legacy.json.result.id]) {
    await req(`/dataflows/${id}`, { method: 'DELETE', token })
  }
  await db.run(`DROP TABLE IF EXISTS \`${SRC}\``)
  await db.run(`DROP TABLE IF EXISTS \`${DST}\``)
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(async (err) => {
  console.error('FATAL', err.message)
  await db.run(`DROP TABLE IF EXISTS \`${SRC}\``).catch(() => {})
  await db.run(`DROP TABLE IF EXISTS \`${DST}\``).catch(() => {})
  process.exit(2)
})
