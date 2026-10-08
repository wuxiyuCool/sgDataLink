/* 1.9.4 swagger 文档中心 + 登录日志后端冒烟（memory 模式 :3011） */
const BASE = 'http://127.0.0.1:3001/api/v1'
let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) } else { fail += 1; console.log(`  FAIL ${name} ${extra}`) }
}
const req = async (path, { method = 'GET', token, body, raw } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { /* raw */ }
  return { status: res.status, json, text: raw ? text : undefined }
}

const main = async () => {
  console.log('== 未登录访问 ==')
  const noauth = await req('/data-apis/swagger.json')
  check('swagger.json 无 token → 401', noauth.status === 401 && noauth.json.code === 40101 || noauth.status === 401, JSON.stringify(noauth.json))
  const noauthDoc = await req('/data-apis/api-8001/doc')
  check(':id/doc 无 token → 401', noauthDoc.status === 401)
  const noauthLogs = await req('/auth/login-logs')
  check('login-logs 无 token → 401', noauthLogs.status === 401)

  console.log('== 登录（含失败日志） ==')
  const bad = await req('/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrongpass1' } })
  check('错误密码 → 40103', bad.status === 401 && bad.json.code === 40103)
  const login = await req('/auth/login', { method: 'POST', body: { username: 'admin', password: 'testpass123' } })
  check('登录成功', login.status === 200 && login.json.result.token)
  const token = login.json.result.token
  check('出参不含 passwordHash', !JSON.stringify(login.json).includes('passwordHash'))

  console.log('== swagger.json（JWT） ==')
  const spec = await req('/data-apis/swagger.json', { token })
  check('swagger.json 200 + openapi 3.0', spec.status === 200 && spec.json.openapi === '3.0.3', spec.text && spec.text.slice(0, 120))
  const s = spec.json
  check('默认包含已发布服务', spec.status === 200 && !!s.paths['/ds/order-query'], Object.keys(s.paths || {}).join(','))
  const op = s.paths['/ds/order-query'].get
  check('operationId=ds-{path}', op.operationId === 'ds-order-query', op.operationId)
  check('tags 为数据源名', Array.isArray(op.tags) && typeof op.tags[0] === 'string' && op.tags[0].length > 0, JSON.stringify(op.tags))
  check('x-databridge 扩展', op['x-databridge'] && op['x-databridge'].apiId && 'sqlMode' in op['x-databridge'])
  check('authEnabled → security ApiKeyAuth', JSON.stringify(op.security || []).includes('ApiKeyAuth'))
  check('参数含 page/size', (op.parameters || []).some((p) => p.name === 'page') && (op.parameters || []).some((p) => p.name === 'size'))
  const filtered = await req('/data-apis/swagger.json?keyword=zzz-not-exist', { token })
  check('keyword 过滤到空（业务条目，自述分组保留）', Object.keys(filtered.json.paths).filter((p) => p.startsWith('/ds/')).length === 0 && Object.keys(filtered.json.paths).some((p) => p.startsWith('/api/v1/')))
  check('自述分组：文档中心 tag + paths', (s.tags || []).some((t) => t.name === '文档中心') && s.paths['/api/v1/data-apis/swagger.json'] && s.paths['/api/v1/auth/login'])
  check('securitySchemes 齐（ApiKey/Bearer/DocKey）', !!(s.components?.securitySchemes?.ApiKeyAuth && s.components?.securitySchemes?.BearerAuth && s.components?.securitySchemes?.DocKeyAuth))
  const allAsUser = await req('/data-apis/swagger.json?status=all', { token })
  check('status=all admin 可用', allAsUser.status === 200)

  console.log('== apiDoc 模板自动生成 ==')
  const created = await req('/data-apis', {
    method: 'POST',
    body: {
      name: '冒烟服务', path: 'smoke-doc', sqlMode: 'builder', datasourceId: 'ds-1001', tableName: 'T_ORDER',
      fields: [{ name: 'ID', type: 'BIGINT' }, { name: 'ORDER_NO', type: 'VARCHAR(32)' }, { name: 'CREATED_AT', type: 'DATETIME' }],
      queryParams: [{ name: 'status', type: 'string', required: true, remark: '订单状态' }],
    },
  })
  check('创建成功', created.status === 200 && created.json.result.id, JSON.stringify(created.json))
  const doc = created.json.result.apiDoc
  check('自动生成 apiDoc.summary', doc && doc.summary.includes('smoke-doc'), JSON.stringify(doc))
  check('自动生成 2 行示例，类型正确', doc && doc.responseExample.rows.length === 2 && typeof doc.responseExample.rows[0][0] === 'number' && /\d{4}-\d{2}-\d{2}/.test(doc.responseExample.rows[0][2]))
  check('paramDocs 用 remark', doc && doc.paramDocs.status === '订单状态')
  const got = await req(`/data-apis/${created.json.result.id}/doc`, { token })
  check('GET doc 返回同一份', got.status === 200 && got.json.result.summary === doc.summary)
  const specPub = await req('/data-apis/swagger.json', { token })
  check('草稿不进默认文档', !specPub.json.paths['/ds/smoke-doc'])
  const put = await req(`/data-apis/${created.json.result.id}/doc`, {
    method: 'PUT', token,
    body: { summary: '手工摘要', description: '手工描述', paramDocs: { status: '状态(手工)' }, responseExample: { fields: ['ID'], rows: [[9]] } },
  })
  check('PUT doc（admin）成功', put.status === 200 && put.json.result.summary === '手工摘要', JSON.stringify(put.json))
  const specAll = await req('/data-apis/swagger.json?status=all', { token })
  const smokeOp = specAll.json.paths['/ds/smoke-doc'].get
  check('swagger 反映手工摘要', smokeOp.summary === '手工摘要')
  check('swagger list 含草稿+已发布', Object.keys(specAll.json.paths).length >= 2)

  console.log('== 普通用户边界 ==')
  const u = await req('/users', { method: 'POST', token, body: { username: 'smokeuser', password: 'Passw0rd_1', role: 'user', nickname: '冒烟' } })
  check('创建 user 角色', u.status === 200 && u.json.result.id, JSON.stringify(u.json))
  const ul = await req('/auth/login', { method: 'POST', body: { username: 'smokeuser', password: 'Passw0rd_1' } })
  check('user 登录', ul.status === 200 && ul.json.result.token)
  const utoken = ul.json.result.token
  const uSwagger = await req('/data-apis/swagger.json', { token: utoken })
  check('user 可看 published swagger', uSwagger.status === 200)
  const uAll = await req('/data-apis/swagger.json?status=all', { token: utoken })
  check('user status=all 被拒 40001', uAll.status === 400 && uAll.json.code === 40001, JSON.stringify(uAll.json))
  const uPut = await req(`/data-apis/${created.json.result.id}/doc`, { method: 'PUT', token: utoken, body: { summary: 'x' } })
  check('user PUT doc → 403', uPut.status === 403)
  const uLogs = await req('/auth/login-logs', { token: utoken })
  check('user login-logs → 403', uLogs.status === 403)

  console.log('== 登录日志审计 ==')
  const logs = await req('/auth/login-logs?page=1&size=50', { token })
  check('login-logs 分页 200', logs.status === 200 && Array.isArray(logs.json.result.items), JSON.stringify(logs.json).slice(0, 200))
  const items = logs.json.result.items
  check('失败尝试已记录 bad_credentials', items.some((i) => i.ok === false && i.errorMsg === 'bad_credentials' && i.username === 'admin'))
  check('成功登录已记录', items.some((i) => i.ok === true && i.username === 'admin' && i.userId))
  check('user 登录已记录', items.some((i) => i.username === 'smokeuser' && i.ok === true))
  check('日志不含密码字段', !JSON.stringify(items).toLowerCase().includes('password') || !/"password"/.test(JSON.stringify(items)))
  const flt = await req('/auth/login-logs?result=error', { token })
  check('result=error 过滤', flt.status === 200 && flt.json.result.items.every((i) => i.ok === false))
  const kw = await req('/auth/login-logs?keyword=smoke', { token })
  check('keyword 过滤', kw.status === 200 && kw.json.result.items.every((i) => i.username === 'smokeuser') && kw.json.result.items.length >= 1)

  console.log('== 清理 ==')
  const del = await req(`/data-apis/${created.json.result.id}`, { method: 'DELETE' })
  check('删除冒烟服务', del.status === 200)
  await req(`/users/${u.json.result.id}`, { method: 'DELETE', token })

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}
main().catch((err) => { console.error('FATAL', err); process.exit(2) })
