/* 契约 1.9.5 docKey 安全用例（:3001）
 * mysql 模式默认用临时管理员 swaggerdbg/DbgPass_123；
 * memory 模式跑：ADMIN_USER=admin ADMIN_PASS=testpass123 node test-dockey.js */
const BASE = 'http://127.0.0.1:3001/api/v1'
const ADMIN_USER = process.env.ADMIN_USER || 'swaggerdbg'
const ADMIN_PASS = process.env.ADMIN_PASS || 'DbgPass_123'
let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`) }
}
const req = async (path, { method = 'GET', token, key, body } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (key) headers['x-doc-key'] = key
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { /* spec 本体 */ }
  return { status: res.status, json, text }
}

const main = async () => {
  const adminLogin = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })
  check('admin(${ADMIN_USER}) 登录', adminLogin.status === 200 && adminLogin.json.result.token)
  const atoken = adminLogin.json.result.token

  const created = await req('/users', { method: 'POST', token: atoken, body: { username: 'dockeytest', password: 'InitPass_1', role: 'user', nickname: 'docKey测试' } })
  check('创建普通用户', created.status === 200 && created.json.result.id, JSON.stringify(created.json))
  const uid = created.json.result.id
  const ulogin = await req('/auth/login', { method: 'POST', body: { username: 'dockeytest', password: 'InitPass_1' } })
  const utoken = ulogin.json.result && ulogin.json.result.token
  check('普通用户登录', !!utoken)

  console.log('== 未开通状态 ==')
  const docKey0 = await req('/auth/doc-key', { token: utoken })
  check('GET doc-key docAccess=false 无 key', docKey0.status === 200 && docKey0.json.result.docAccess === false && !docKey0.json.result.docKey)
  const refresh0 = await req('/auth/doc-key/refresh', { method: 'POST', token: utoken })
  check('未开通刷新 → 40001', refresh0.status === 400 && refresh0.json.code === 40001)
  const noauth = await req('/data-apis/swagger.json')
  check('无 JWT 无 key → 401', noauth.status === 401)
  const badkey = await req('/data-apis/swagger.json', { key: 'dok-deadbeefdeadbeefdeadbeefdeadbeef' })
  check('错误 key → 401/40102', badkey.status === 401 && badkey.json.code === 40102, JSON.stringify(badkey.json))

  console.log('== admin 开通文档权限 ==')
  const grant = await req(`/users/${uid}`, { method: 'PUT', token: atoken, body: { docAccess: true } })
  check('PUT docAccess=true 成功', grant.status === 200 && grant.json.result.docAccess === true, JSON.stringify(grant.json))
  check('用户出参不含 key 明文', !JSON.stringify(grant.json).includes('dok-'))
  const docKey1 = await req('/auth/doc-key', { token: utoken })
  check('本人可见自动生成的 key', docKey1.json.result.docAccess === true && /^dok-[0-9a-f]{32}$/.test(docKey1.json.result.docKey || ''), JSON.stringify(docKey1.json.result))
  const key = docKey1.json.result.docKey

  console.log('== docKey 取文档 ==')
  const spec1 = await req('/data-apis/swagger.json', { key })
  check('X-DOC-KEY → 200 OpenAPI', spec1.status === 200 && spec1.json.openapi === '3.0.3')
  const spec2 = await req(`/data-apis/swagger.json?docKey=${key}`)
  check('docKey 查询参数 → 200', spec2.status === 200 && spec2.json.openapi === '3.0.3')
  const specAll = await req('/data-apis/swagger.json?status=all', { key })
  check('docKey status=all → 40001', specAll.status === 400 && specAll.json.code === 40001)
  const specKw = await req('/data-apis/swagger.json?keyword=zzz-none', { key })
  check('docKey 支持 keyword 过滤（业务条目；自述分组不受影响）', specKw.status === 200 && Object.keys(specKw.json.paths).filter((p) => p.startsWith('/ds/')).length === 0 && Object.keys(specKw.json.paths).some((p) => p.startsWith('/api/v1/')))

  console.log('== 刷新 key ==')
  const refreshed = await req('/auth/doc-key/refresh', { method: 'POST', token: utoken })
  check('刷新返回新 key', refreshed.status === 200 && /^dok-[0-9a-f]{32}$/.test(refreshed.json.result.docKey) && refreshed.json.result.docKey !== key)
  const newKey = refreshed.json.result.docKey
  const oldUse = await req('/data-apis/swagger.json', { key })
  check('旧 key 立即失效 40102', oldUse.status === 401 && oldUse.json.code === 40102)
  const newUse = await req('/data-apis/swagger.json', { key: newKey })
  check('新 key 可用', newUse.status === 200)

  console.log('== 访问日志审计 ==')
  const jwtProbe = await req('/data-apis/swagger.json', { token: atoken })
  check('admin JWT 取文档正常（并留痕）', jwtProbe.status === 200)
  const logs = await req('/data-apis/swagger-logs?page=1&size=50', { token: atoken })
  check('admin 查 swagger-logs 200', logs.status === 200 && Array.isArray(logs.json.result.items))
  const items = logs.json.result.items
  check('docKey 成功记录已落库', items.some((i) => i.ok === true && i.authType === 'docKey' && i.username === 'dockeytest'))
  check('失败记录已落库（错误 key）', items.some((i) => i.ok === false && i.bizCode === 40102))
  check('JWT 访问也记录', items.some((i) => i.authType === 'jwt' && i.ok === true))
  check('key 只存掩码（前 6 位+***）', items.filter((i) => i.keyMasked).every((i) => /^dok-..\*\*\*$/.test(i.keyMasked)) && items.some((i) => i.keyMasked))
  check('日志不含完整 key', !JSON.stringify(items).includes(newKey) && !JSON.stringify(items).includes(key))
  const logFilter = await req('/data-apis/swagger-logs?result=error&authType=docKey', { token: atoken })
  check('日志 result/authType 过滤', logFilter.status === 200 && logFilter.json.result.items.every((i) => i.ok === false && i.authType === 'docKey'))
  const uLogs = await req('/data-apis/swagger-logs', { token: utoken })
  check('普通用户查日志 → 403', uLogs.status === 403)

  console.log('== 禁用/收权即失效 ==')
  await req(`/users/${uid}`, { method: 'PUT', token: atoken, body: { status: 'disabled' } })
  const disabledUse = await req('/data-apis/swagger.json', { key: newKey })
  check('禁用后 key → 401/40105', disabledUse.status === 401 && disabledUse.json.code === 40105, JSON.stringify(disabledUse.json))
  await req(`/users/${uid}`, { method: 'PUT', token: atoken, body: { status: 'active' } })
  const revoke = await req(`/users/${uid}`, { method: 'PUT', token: atoken, body: { docAccess: false } })
  check('关闭权限', revoke.status === 200 && revoke.json.result.docAccess === false)
  const revokedUse = await req('/data-apis/swagger.json', { key: newKey })
  check('收权后 key 失效 40102', revokedUse.status === 401 && revokedUse.json.code === 40102)

  console.log('== JWT 原链路不回归 ==')
  const adminSpec = await req('/data-apis/swagger.json?status=all', { token: atoken })
  check('admin JWT status=all 正常', adminSpec.status === 200)
  const uSpec = await req('/data-apis/swagger.json', { token: utoken })
  check('普通用户 JWT 取 published 正常', uSpec.status === 200)

  await req(`/users/${uid}`, { method: 'DELETE', token: atoken })
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}
main().catch((err) => { console.error('FATAL', err); process.exit(2) })
