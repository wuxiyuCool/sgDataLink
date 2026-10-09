/* 契约 v1.12 M3 联调用例：engine /sql/query、/sql/exec 守卫 + X-Engine-Token 双向鉴权 + 指标 preview 真执行
 * 前置（本地调试口径，全部真库）：
 *   引擎:  cd databridge-engine && SERVER_PORT=8082 ENGINE_SHARED_SECRET=mt3-dev-secret NODE_REPORT_URL=http://127.0.0.1:3002/api/v1/engine go run ./cmd/server -conf config/local.yml
 *   admin: cd node-express-boilerplate && DB_DRIVER=mysql NODE_ENV=development PORT=3002 ENGINE_BASE_URL=http://127.0.0.1:8082 ENGINE_SHARED_SECRET=mt3-dev-secret node src/index.js
 *   数据源凭据来自 admin .env（MYSQL_* 键）；临时管理员 mtlint01（重建命令见 test-metric-model.js 头注）
 * 跑法：
 *   cd node-express-boilerplate && set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 ENGINE=http://127.0.0.1:8082/api/v1/engine BASE=http://127.0.0.1:3002/api/v1 \
 *   ENGINE_SECRET=mt3-dev-secret TEST_DS_HOST=$MYSQL_HOST TEST_DS_USER=$MYSQL_USER TEST_DS_PASS=$MYSQL_PASSWORD TEST_DS_DB=$MYSQL_DATABASE \
 *   node ../deploy/tests/test-metric-sql.js
 * 自建表 ${RUN}_exec 结束 DROP 清理。 */
process.env.DB_DRIVER = 'mysql'
const db = require('../../node-express-boilerplate/src/db/mysql')

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1'
const ENGINE = process.env.ENGINE || 'http://127.0.0.1:8080/api/v1/engine'
const SECRET = process.env.ENGINE_SECRET || ''
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123'
const DS = {
  host: process.env.TEST_DS_HOST || '10.45.34.222',
  port: Number(process.env.TEST_DS_PORT || 3306),
  user: process.env.TEST_DS_USER || 'root',
  pass: process.env.TEST_DS_PASS || '',
  db: process.env.TEST_DS_DB || 'dataLink',
}
const RUN = `msq${Date.now().toString(36)}`
const EXEC_TABLE = `${RUN}_exec`

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`) }
}
const call = async (url, { method = 'POST', token, engineToken, body } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (engineToken) headers['X-Engine-Token'] = engineToken
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { /* ignore */ }
  return { status: res.status, json, text }
}

const endpoint = {
  id: 'ds-test', type: 'mysql', host: DS.host, port: DS.port,
  database: DS.db, username: DS.user, password: DS.pass,
}

const main = async () => {
  console.log(`== 引擎入站鉴权（${ENGINE}，secret=${SECRET ? '已配置' : '未配置'}）==`)
  const noToken = await call(`${ENGINE}/sql/query`, { body: { endpoint, sql: 'SELECT 1' } })
  const badToken = await call(`${ENGINE}/sql/query`, { engineToken: 'wrong-secret', body: { endpoint, sql: 'SELECT 1' } })
  const goodToken = await call(`${ENGINE}/sql/query`, { engineToken: SECRET, body: { endpoint, sql: "SELECT 1 AS one, 'x' AS s" } })
  if (SECRET) {
    check('无 token → 401/40101', noToken.status === 401 && noToken.json.code === 40101, noToken.text.slice(0, 120))
    check('错 token → 401/40101', badToken.status === 401 && badToken.json.code === 40101)
  } else {
    check('空 secret 过渡态放行（WARN 模式）', noToken.status === 200)
  }
  check('sql/query SELECT 1 真执行', goodToken.status === 200 && goodToken.json.code === 0
    && JSON.stringify(goodToken.json.data.rows) === '[[1,"x"]]', goodToken.text.slice(0, 200))

  console.log('== SQL 守卫 ==')
  const drop = await call(`${ENGINE}/sql/query`, { engineToken: SECRET, body: { endpoint, sql: 'DROP TABLE x' } })
  check('query 拒绝非 SELECT', drop.status === 400 && drop.json.code === 40001, drop.text.slice(0, 140))
  const multi = await call(`${ENGINE}/sql/query`, { engineToken: SECRET, body: { endpoint, sql: 'SELECT 1; SELECT 2' } })
  check('query 拒绝多语句', multi.status === 400 && /多语句/.test(multi.text), multi.text.slice(0, 140))
  // 守卫用例的语句目标一律用「不存在的表」：白名单一旦回退成放行，也不会真删到任何业务表
  // （历史上这里写过 DROP TABLE databridge_datasource，白名单放开 DROP 后它真的执行了，务必别再那么写）
  const badExec = await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { instanceId: 'mtr-guard', endpoint, statements: ['DELETE FROM __guard_missing_table__'] },
  })
  check('exec 拒绝 DELETE', badExec.status === 400 && /白名单/.test(badExec.text), badExec.text.slice(0, 160))
  const dropUser = await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { instanceId: 'mtr-guard', endpoint, statements: ['DROP USER guard_probe'] },
  })
  check('exec 拒绝 DROP USER', dropUser.status === 400 && /白名单/.test(dropUser.text), dropUser.text.slice(0, 160))
  const dropMulti = await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { instanceId: 'mtr-guard', endpoint, statements: ['DROP TABLE __guard_missing_a__, __guard_missing_b__'] },
  })
  check('exec 拒绝多表 DROP', dropMulti.status === 400 && /白名单/.test(dropMulti.text), dropMulti.text.slice(0, 160))
  const dropPurge = await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { instanceId: 'mtr-guard', endpoint, statements: ['DROP TABLE __guard_missing__ PURGE'] },
  })
  check('exec 拒绝带尾巴的 DROP', dropPurge.status === 400 && /白名单/.test(dropPurge.text), dropPurge.text.slice(0, 160))
  const dropNoGate = await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { instanceId: 'mtr-guard', endpoint, statements: ['DROP TABLE __guard_missing__'] },
  })
  check('DROP 未带 allowDrop 被拒（破坏性动词需显式开闸）', dropNoGate.status === 400 && /allowDrop/.test(dropNoGate.text), dropNoGate.text.slice(0, 160))

  const pwLeak = await call(`${ENGINE}/sql/query`, { engineToken: SECRET, body: { endpoint: { ...endpoint, password: 'Sup3rSecret!' }, sql: 'SELECT * FROM __no_such_table__' } })
  check('执行失败错误已去密码', pwLeak.status === 502 && pwLeak.json.code === 50002 && !pwLeak.text.includes('Sup3rSecret!'), pwLeak.text.slice(0, 200))

  console.log('== exec 白名单正路径（真建表/写入/清空）==')
  const execOk = await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: {
      instanceId: 'mtr-exec',
      endpoint,
      statements: [
        `CREATE TABLE IF NOT EXISTS \`${EXEC_TABLE}\` (id BIGINT PRIMARY KEY, name VARCHAR(32)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`,
        `INSERT INTO \`${EXEC_TABLE}\` (id, name) VALUES (1, 'a')`,
      ],
    },
  })
  check('exec 建表+插入成功', execOk.status === 200 && execOk.json.code === 0
    && execOk.json.data.results.length === 2 && execOk.json.data.results[1].affectedRows === 1, execOk.text.slice(0, 200))
  const truncate = await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { endpoint, instanceId: 'mtr-trunc', statements: [`TRUNCATE TABLE \`${EXEC_TABLE}\``] },
  })
  check('exec TRUNCATE 成功', truncate.status === 200 && truncate.json.code === 0)
  const verify = await call(`${ENGINE}/sql/query`, { engineToken: SECRET, body: { endpoint, sql: `SELECT COUNT(*) AS c FROM ${EXEC_TABLE}` } })
  check('TRUNCATE 后行数为 0', JSON.stringify(verify.json.data.rows) === '[[0]]', verify.text.slice(0, 140))

  // DROP 正路径：只针对本用例自己建的临时表，验完即删（绝不拿业务表做样本）
  const dropTable = `${EXEC_TABLE}_drop`
  await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { endpoint, instanceId: 'mtr-drop', statements: [`CREATE TABLE IF NOT EXISTS \`${dropTable}\` (id INT)`] },
  })
  const dropOk = await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { endpoint, instanceId: 'mtr-drop', statements: [`DROP TABLE \`${dropTable}\``], allowDrop: true },
  })
  check('exec DROP 单表在 allowDrop 下放行', dropOk.status === 200 && dropOk.json.code === 0, dropOk.text.slice(0, 160))
  const dropGone = await call(`${ENGINE}/sql/query`, { engineToken: SECRET, body: { endpoint, sql: `SELECT COUNT(*) AS c FROM ${dropTable}` } })
  check('DROP 后表确实不存在（查询报错）', dropGone.status === 502 && dropGone.json.code === 50002, dropGone.text.slice(0, 140))

  console.log('== admin → engine 全链路：回报鉴权 + 指标 preview 真执行 ==')
  const reportNoToken = await call(`${BASE}/engine/report`, { body: { instanceId: 'inst-x', status: 'running' } })
  if (SECRET) {
    check('回报无 token → 401/40101', reportNoToken.status === 401 && reportNoToken.json.code === 40101, reportNoToken.text.slice(0, 120))
  } else {
    // 空 secret 过渡态：不被 401 挡下，直达业务层（未知实例按既有语义 40401）
    check('回报空 secret 过渡态放行（直达业务层）', reportNoToken.status === 404 && reportNoToken.json.code === 40401, reportNoToken.text.slice(0, 120))
  }
  const reportOk = await call(`${BASE}/engine/report`, { engineToken: SECRET, body: { instanceId: 'inst-x', status: 'running' } })
  // 过了 token 校验进入业务层：未知实例按既有语义 404/40401（401 才是被密钥挡下）
  check('回报 token 通过后进入业务层（未知实例 40401）', reportOk.status === 404 && reportOk.json.code === 40401, reportOk.text.slice(0, 140))

  const login = await call(`${BASE}/auth/login`, { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('管理员登录', login.status === 200 && login.json.result.token)
  const token = login.json.result.token

  const dsRes = await call(`${BASE}/datasources`, {
    method: 'POST', token,
    body: { name: `联调SQL数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  })
  check('注册数据源', dsRes.status === 200, dsRes.text.slice(0, 140))
  const dom = await call(`${BASE}/metric-domains`, { method: 'POST', token, body: { name: 'SQL联调域', code: RUN } })
  const mdl = await call(`${BASE}/metric-models`, {
    method: 'POST', token,
    body: {
      name: 'SQL联调模型', datasourceId: dsRes.json.result.id, domainId: dom.json.result.id, layer: 'DWD', tableName: EXEC_TABLE,
      columns: [
        { columnName: 'id', dataType: 'BIGINT', role: 'dimension', isKey: true },
        { columnName: 'name', dataType: 'VARCHAR', role: 'dimension' },
      ],
    },
  })
  check('建域+模型（引用刚建的 exec 表）', mdl.status === 200, mdl.text.slice(0, 200))

  const modelPreviewUrl = `${BASE}/metric-models/${mdl.json.result && mdl.json.result.id}/preview?size=5`
  const modelPreview = await call(modelPreviewUrl, { method: 'GET', token })
  check('模型预览 0 行真执行', modelPreview.status === 200 && modelPreview.json.result.executable === true
    && modelPreview.json.result.rows.length === 0, `${modelPreviewUrl} -> ${modelPreview.text.slice(0, 200)}`)

  const met = await call(`${BASE}/metrics`, {
    method: 'POST', token,
    body: {
      code: `${RUN}_cnt`, name: '行数', defineType: 'MEASURE', domainId: dom.json.result.id, status: 'online',
      defineParams: { modelId: mdl.json.result.id, measureColumn: 'id', agg: 'count' },
    },
  })
  check('建 ATOMIC 指标', met.status === 200, met.text.slice(0, 200))
  const pv = await call(`${BASE}/metrics/${met.json.result.id}/preview`, { method: 'POST', token, body: {} })
  check('指标 preview executable=true', pv.status === 200 && pv.json.result.executable === true
    && pv.json.result.rows[0][0] === 0, pv.text.slice(0, 240))
  // 往 exec 表插 3 行再 preview：证明查的是真库现值而非缓存/假数据
  await call(`${ENGINE}/sql/exec`, {
    engineToken: SECRET,
    body: { endpoint, instanceId: 'mtr-seed', statements: [`INSERT INTO \`${EXEC_TABLE}\` (id, name) VALUES (1,'a'),(2,'b'),(3,'c')`] },
  })
  const pv2 = await call(`${BASE}/metrics/${met.json.result.id}/preview`, { method: 'POST', token, body: {} })
  check('插 3 行后 preview 返回 COUNT=3', pv2.json.result.rows[0][0] === 3, pv2.text.slice(0, 240))

  console.log('== 清理 ==')
  await db.run(`DROP TABLE IF EXISTS \`${EXEC_TABLE}\``)
  await db.run('DELETE c FROM databridge_metric_model_column c JOIN databridge_metric_model m ON c.model_id=m.id WHERE m.name LIKE ?', ['SQL联调%'])
  await db.run('DELETE FROM databridge_metric_model WHERE name LIKE ?', ['SQL联调%'])
  await db.run('DELETE FROM databridge_metric_version WHERE metric_id IN (SELECT id FROM databridge_metric_metric WHERE code LIKE ?)', [`${RUN}_%`])
  await db.run('DELETE FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`])
  await db.run('DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}%`])
  await db.run("DELETE FROM databridge_datasource WHERE name LIKE '联调SQL数据源-%'")
  console.log('  联调资产已清理')

  console.log(`\ntest-metric-sql: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test-metric-sql crashed:', e.message, e.stack)
  process.exit(1)
})
