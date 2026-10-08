/**
 * 契约 1.11 用户与鉴权安全用例（memory 模式，ADMIN_INIT_PASSWORD=testpass123 启动）。
 */
const BASE = 'http://127.0.0.1:3001/api/v1';
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
};
const call = async (path, { method = 'GET', token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, code: json && json.code, message: json && json.message, result: json && json.result };
};

(async () => {
  // 1. 错误密码 → 40103，且 message 不泄露账号是否存在
  const bad = await call('/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong123' } });
  check('错误密码 401/40103', bad.status === 401 && bad.code === 40103, bad.message);
  const noUser = await call('/auth/login', { method: 'POST', body: { username: 'nobody_xyz', password: 'whatever1' } });
  check('不存在的账号同文案(防枚举)', noUser.code === 40103 && noUser.message === bad.message);

  // 2. 正确登录
  const login = await call('/auth/login', { method: 'POST', body: { username: 'admin', password: 'testpass123' } });
  const token = login.result && login.result.token;
  check('admin 登录成功', !!token && login.result.user.mustChangePassword === true);

  // 3. 无 token / 坏 token 访问 /users → 401
  const noToken = await call('/users');
  check('无 token 访问 /users 401', noToken.status === 401);
  const badToken = await call('/users', { token: 'abc.def.ghi' });
  check('坏 token 401', badToken.status === 401);

  // 4. admin 列表（不含任何 password 字段）
  const list = await call('/users', { token });
  check('admin 可查列表', list.code === 0 && list.result.items.length >= 1);
  check('列表不回显密码字段', !JSON.stringify(list.result).includes('passwordHash') && !JSON.stringify(list.result).includes('testpass123'));

  // 5. 建用户：弱密码拒绝 + 正常创建 + 重复名拒绝
  const weak = await call('/users', { method: 'POST', token, body: { username: 'tester1', password: 'short' } });
  check('弱密码 40001', weak.code === 40001, weak.message);
  const nodigit = await call('/users', { method: 'POST', token, body: { username: 'tester1', password: 'abcdefghij' } });
  check('无数字密码 40001', nodigit.code === 40001);
  const created = await call('/users', { method: 'POST', token, body: { username: 'Tester1', nickname: '测试员', password: 'test1234', role: 'user' } });
  const testerId = created.result && created.result.id;
  check('创建用户成功(用户名归一小写)', created.code === 0 && created.result.username === 'tester1' && created.result.mustChangePassword === true);
  const dup = await call('/users', { method: 'POST', token, body: { username: 'tester1', password: 'test1234' } });
  check('重复用户名 40001', dup.code === 40001, dup.message);

  // 6. 普通用户越权面
  const tLogin = await call('/auth/login', { method: 'POST', body: { username: 'tester1', password: 'test1234' } });
  const tToken = tLogin.result && tLogin.result.token;
  check('tester1 可登录', !!tToken);
  const tList = await call('/users', { token: tToken });
  check('普通用户查用户列表 403', tList.status === 403);
  const tCreate = await call('/users', { method: 'POST', token: tToken, body: { username: 'x1', password: 'test1234' } });
  check('普通用户建用户 403', tCreate.status === 403);
  const adminId = list.result.items[0].id;
  const tHack = await call(`/users/${adminId}`, { method: 'PUT', token: tToken, body: { role: 'user' } });
  check('普通用户改他人 403(IDOR)', tHack.status === 403);
  const tSelfUp = await call(`/users/${testerId}`, { method: 'PUT', token: tToken, body: { role: 'admin' } });
  check('普通用户给自己提权也 403', tSelfUp.status === 403);

  // 7. 本人改密链路
  const wrongOld = await call('/auth/change-password', { method: 'POST', token: tToken, body: { oldPassword: 'bad12345', newPassword: 'newpass123' } });
  check('旧密码不符 40001', wrongOld.code === 40001, wrongOld.message);
  const samePw = await call('/auth/change-password', { method: 'POST', token: tToken, body: { oldPassword: 'test1234', newPassword: 'test1234' } });
  check('新旧相同 40001', samePw.code === 40001);
  const changed = await call('/auth/change-password', { method: 'POST', token: tToken, body: { oldPassword: 'test1234', newPassword: 'newpass123' } });
  check('改密成功', changed.code === 0);
  const oldLogin = await call('/auth/login', { method: 'POST', body: { username: 'tester1', password: 'test1234' } });
  check('旧密码失效', oldLogin.code === 40103);
  const newLogin = await call('/auth/login', { method: 'POST', body: { username: 'tester1', password: 'newpass123' } });
  check('新密码可登录且 mustChange 清除', newLogin.code === 0 && newLogin.result.user.mustChangePassword === false);

  // 8. 自保护与最后 admin
  const selfDelete = await call(`/users/${adminId}`, { method: 'DELETE', token });
  check('admin 删自己 40001', selfDelete.code === 40001, selfDelete.message);
  const selfDisable = await call(`/users/${adminId}`, { method: 'PUT', token, body: { status: 'disabled' } });
  check('admin 禁自己 40001', selfDisable.code === 40001);
  const selfDemote = await call(`/users/${adminId}`, { method: 'PUT', token, body: { role: 'user' } });
  check('admin 降级自己 40001', selfDemote.code === 40001);

  // 9. 禁用 + 登录 40104 + token 实时失效
  await call(`/users/${testerId}`, { method: 'PUT', token, body: { status: 'disabled' } });
  const disLogin = await call('/auth/login', { method: 'POST', body: { username: 'tester1', password: 'newpass123' } });
  check('禁用账号登录 40104', disLogin.code === 40104, disLogin.message);
  const liveToken = await call('/auth/me', { token: newLogin.result.token });
  check('禁用后旧 token 立刻失效 401', liveToken.status === 401);

  // 10. 管理员重置密码
  const reset = await call(`/users/${testerId}/reset-password`, { method: 'POST', token, body: { password: 'reset9999' } });
  check('admin 重置密码', reset.code === 0 && reset.result.mustChangePassword === true);
  const resetLogin = await call('/auth/login', { method: 'POST', body: { username: 'tester1', password: 'reset9999' } });
  check('重置后可登录(解禁由 status 决定→先恢复)', resetLogin.code === 40104);
  await call(`/users/${testerId}`, { method: 'PUT', token, body: { status: 'active' } });
  const reLogin = await call('/auth/login', { method: 'POST', body: { username: 'tester1', password: 'reset9999' } });
  check('恢复启用+重置密码登录 ok', reLogin.code === 0);
  const del = await call(`/users/${testerId}`, { method: 'DELETE', token });
  check('删除用户', del.code === 0);
  const afterDel = await call('/auth/login', { method: 'POST', body: { username: 'tester1', password: 'reset9999' } });
  check('删除后不能登录', afterDel.code === 40103);

  // 11. 既有匿名接口不受影响（本期边界）
  const ds = await call('/datasources?page=1&size=5');
  check('业务接口(未鉴权)仍正常', ds.code === 0);
  const health = await call('/health');
  check('health 正常', health.code === 0);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
