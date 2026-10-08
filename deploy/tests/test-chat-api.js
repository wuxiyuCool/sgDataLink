/* 契约 v1.12 问数对外服务联调用例（真库）：chatKey 生命周期 + /chat/ask 鉴权矩阵 + 审计权限
 * 前置：admin .env（DB_DRIVER=mysql）跑 3001；真库已有 dmtrade 演示指标（seed-metric-demo.js）
 * 跑法（cwd=node-express-boilerplate）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 BASE=http://127.0.0.1:3001/api/v1 \
 *   node ../deploy/tests/test-chat-api.js
 * 结束清理测试用户与问数日志。 */
process.env.DB_DRIVER = 'mysql';
const db = require('../../node-express-boilerplate/src/db/mysql');

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123';
const RUN = `cta${Date.now().toString(36)}`;
const USERNAME = `chat_${RUN}`;
const PASS = 'ChatTest_2026';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};
const req = async (path, { method = 'GET', token, chatKey, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (chatKey) headers['x-chat-key'] = chatKey;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let json = null;
  try {
    json = JSON.parse(t);
  } catch (e) {
    /* ignore */
  }
  return { status: res.status, json, text: t };
};
// 中文问题用 Buffer 直发 UTF-8，绕开 Windows 控制台编码
const askUtf8 = (chatKey, questionObj) =>
  fetch(`${BASE}/chat/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-key': chatKey },
    body: Buffer.from(JSON.stringify(questionObj), 'utf8'),
  }).then((r) => r.json());

const cleanup = async () => {
  const stmts = [
    ['DELETE FROM databridge_metric_query_log WHERE user_name LIKE ?', [`${USERNAME}%`]],
    ['DELETE FROM databridge_user WHERE username LIKE ?', ['chat_cta%']],
  ];
  for (const [sql, args] of stmts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await db.run(sql, args);
    } catch (e) {
      /* 忽略单条 */
    }
  }
};

const main = async () => {
  const login = await req('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  check('管理员登录', login.status === 200 && login.json.result.token);
  const token = login.json.result.token;

  console.log('== 权限开通与 key 生命周期 ==');
  const created = await req('/users', { method: 'POST', token, body: { username: USERNAME, password: PASS, role: 'user' } });
  check('建测试用户', created.status === 200 && created.json.result.id, created.text.slice(0, 160));
  const userId = created.json.result.id;
  check('初始 chatAccess=false', created.json.result.chatAccess === false);

  const userLogin = await req('/auth/login', { method: 'POST', body: { username: USERNAME, password: PASS } });
  const utoken = userLogin.json.result.token;
  const keyBefore = await req('/auth/chat-key', { token: utoken });
  check('未开通时 chatAccess=false、无 key', keyBefore.json.result.chatAccess === false && !keyBefore.json.result.chatKey);

  const utf8Ask = (chatKey, question) =>
    fetch(`${BASE}/chat/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(chatKey ? { 'x-chat-key': chatKey } : {}) },
      body: Buffer.from(JSON.stringify({ question }), 'utf8'),
    }).then((r) => r.json());
  await utf8Ask(null, '昨天的订单额');
  const askNoAccess = await req('/chat/ask', { method: 'POST', body: { question: 'x' } });
  check('无 key → 401/40102', askNoAccess.status === 401 && askNoAccess.json.code === 40102, askNoAccess.text.slice(0, 120));

  const grant = await req(`/users/${userId}`, { method: 'PUT', token, body: { chatAccess: true } });
  check('admin 开通 chatAccess → 自动发 chk- key', grant.status === 200 && grant.json.result.chatAccess === true);
  const keyAfter = await req('/auth/chat-key', { token: utoken });
  const chatKey = keyAfter.json.result.chatKey;
  check('本人可见明文 key（chk-+32hex）', keyAfter.json.result.chatAccess === true && /^chk-[0-9a-f]{32}$/.test(chatKey || ''), chatKey);
  const keyMaskAbsent = JSON.stringify(grant.json.result);
  check('用户接口不回显 chatKey 明文', !keyMaskAbsent.includes(chatKey));

  console.log('== /chat/ask 鉴权矩阵 ==');
  const badKey = await req('/chat/ask', { method: 'POST', chatKey: 'chk-deadbeef', body: { question: '昨天的订单额' } });
  check('错误 key → 401/40102（防枚举）', badKey.status === 401 && badKey.json.code === 40102, badKey.text.slice(0, 120));

  const okAsk = await askUtf8(chatKey, { question: '昨天的订单额是多少' });
  check(
    '正确 key 问数成功（真实 LLM+引擎）',
    ['success', 'corrected', 'clarify'].includes(okAsk.result && okAsk.result.status),
    JSON.stringify(okAsk.result || okAsk).slice(0, 200)
  );

  console.log('== 禁用即失效 ==');
  const disable = await req(`/users/${userId}`, { method: 'PUT', token, body: { chatAccess: false } });
  check('关闭 chatAccess', disable.status === 200 && disable.json.result.chatAccess === false);
  const revoked = await utf8Ask(chatKey, '昨天的订单额');
  check('旧 key 立即失效 → 401/40102', revoked.code === 40102, JSON.stringify(revoked).slice(0, 120));

  console.log('== 审计权限 ==');
  const regrant = await req(`/users/${userId}`, { method: 'PUT', token, body: { chatAccess: true } });
  check('重开通生成新 key（旧 key 保留规则：已有则不重置）', regrant.status === 200);
  await askUtf8(chatKey, { question: '昨天的订单数' });
  const logsAdmin = await req('/metric-logs?page=1&size=10', { token });
  check('admin 查审计 200', logsAdmin.status === 200);
  const hit = (logsAdmin.json.result.items || []).find((l) => l.userName === `${USERNAME} (apikey)`);
  check('apikey 调用落日志（userName 带 (apikey) 后缀、matched.source=chatKey）', Boolean(hit) && hit.matched && hit.matched.source === 'chatKey', JSON.stringify(hit || null).slice(0, 200));
  const u2 = await req('/auth/login', { method: 'POST', body: { username: USERNAME, password: PASS } });
  const logsUser = await req('/metric-logs?page=1&size=5', { token: u2.json.result.token });
  check('普通用户查审计 → 403', logsUser.status === 403);

  console.log('== 文档中心自描述 ==');
  const spec = await req('/data-apis/swagger.json', { token });
  const chatPath = spec.json.paths && spec.json.paths['/api/v1/chat/ask'];
  check('swagger 含 /api/v1/chat/ask + ChatKeyAuth + curl 模板', Boolean(chatPath) && chatPath.post.security[0].ChatKeyAuth !== undefined
    && chatPath.post.description.includes('curl') && spec.json.components.securitySchemes.ChatKeyAuth.in === 'header'
    && spec.json.components.securitySchemes.ChatKeyAuth.name === 'X-CHAT-KEY', JSON.stringify(chatPath || {}).slice(0, 160));
  const refresh = await req('/auth/chat-key/refresh', { method: 'POST', token: u2.json.result.token, body: {} });
  check('本人刷新 key 成功且为新值', refresh.status === 200 && refresh.json.result.chatKey && refresh.json.result.chatKey !== chatKey);
  const oldDead = await utf8Ask(chatKey, '昨天的订单额');
  check('刷新后旧 key 立即失效', oldDead.code === 40102, JSON.stringify(oldDead).slice(0,120));

  console.log('== 清理 ==');
  await cleanup();
  console.log('  测试用户与日志已清理');
  console.log(`\ntest-chat-api: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
};

main().catch(async (e) => {
  console.error('test-chat-api crashed:', e.message, e.stack);
  await cleanup().catch(() => {});
  process.exit(1);
});
