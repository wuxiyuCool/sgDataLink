/**
 * 1.9.3 API 转发端到端测试（假下游 :4100，见 fake-downstream.js）。
 * 覆盖：创建/发布、缺 Key 40101、成功转发（头隔离 + forwardHeaders + query 透传 + 占位符）、
 * 下游 404 透传、超时 502/50003、限流 42901、SSRF 拒绝、调试代理透传、调用明细。
 */
const BASE = 'http://127.0.0.1:3001/api/v1';
const RUNTIME = 'http://127.0.0.1:3001/ds';
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
};

const json = async (url, options) => {
  const res = await fetch(url, options);
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { status: res.status, body };
};

(async () => {
  // 0. 幂等预清理：上一轮中途退出会残留 fwd-echo，先删再建
  const pre = await json(`${BASE}/data-apis?keyword=fwd-echo&size=50`);
  for (const item of (pre.body.result && pre.body.result.items) || []) {
    if (item.path === 'fwd-echo') await json(`${BASE}/data-apis/${item.id}`, { method: 'DELETE' });
  }

  // 1. 创建 + 发布
  const created = await json(`${BASE}/data-apis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '转发-假下游回显',
      path: 'fwd-echo',
      method: 'GET',
      sqlMode: 'forward',
      forwardUrl: 'http://127.0.0.1:4100/echo/:billNr',
      forwardMethod: 'GET',
      forwardHeaders: [{ name: 'Authorization', value: 'Bearer :token' }],
      forwardTimeoutMs: 1000,
      forwardPassthroughQuery: true,
      queryParams: [
        { name: 'billNr', type: 'string', required: true },
        { name: 'token', type: 'string', required: false },
      ],
      authEnabled: true,
      rateLimitQps: 2,
      ipWhitelist: [],
    }),
  });
  check('创建 forward API', created.status === 200 && created.body.code === 0, JSON.stringify(created.body).slice(0, 160));
  const id = created.body.result && created.body.result.id;
  if (!id) {
    console.log('创建失败，终止');
    process.exit(1);
  }
  const pub = await json(`${BASE}/data-apis/${id}/publish`, { method: 'POST' });
  const apiKey = pub.body.result && pub.body.result.apiKey;
  check('发布拿到 apiKey', pub.status === 200 && !!apiKey, apiKey);

  // 2. 缺 Key → 401/40101
  const noKey = await json(`${RUNTIME}/fwd-echo?billNr=B1`);
  check('缺 Key 401/40101', noKey.status === 401 && noKey.body.code === 40101, `status=${noKey.status}`);

  // 3. 成功转发：占位符替换、query 透传（extra=1 到达下游）、forwardHeaders 生效、调用方 X-API-Key 不下传
  const ok = await json(`${RUNTIME}/fwd-echo?billNr=B1&extra=1&token=TK9`, {
    headers: { 'X-API-Key': apiKey, cookie: 'session=hijack-me' },
  });
  const echo = ok.status === 200 ? ok.body : null;
  check('成功转发 200 透传（无信封）', ok.status === 200 && echo && echo.echo === '/echo/B1', `echo=${echo && echo.echo}`);
  check('query 透传 extra=1', echo && echo.query && echo.query.extra === '1', JSON.stringify(echo && echo.query));
  check('forwardHeaders 生效', echo && echo.headers && echo.headers.authorization === 'Bearer TK9', echo && echo.headers && echo.headers.authorization);
  check('调用方 X-API-Key 未下传', echo && echo.headers['x-api-key'] === undefined, String(echo && echo.headers['x-api-key']));
  check('调用方 cookie 未下传', echo && echo.headers.cookie === undefined, String(echo && echo.headers.cookie));

  // 4. 限流：rateLimitQps=2，第 4 次（含前面已放行 3 次）应 429/42901 —— 同 1s 窗口连打 3 次
  let limited = null;
  for (let i = 0; i < 4; i += 1) {
    const r = await json(`${RUNTIME}/fwd-echo?billNr=B1&token=TK9`, { headers: { 'X-API-Key': apiKey } });
    if (r.status === 429) { limited = r.body; break; }
  }
  check('限流 429/42901', limited && limited.code === 42901, limited && limited.message);

  // 5. 下游 404 原样透传（改配置指向 /notfound/:billNr）
  const upd404 = await json(`${BASE}/data-apis/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forwardUrl: 'http://127.0.0.1:4100/notfound/:billNr' }),
  });
  check('PUT 更新 forwardUrl', upd404.status === 200, JSON.stringify(upd404.body).slice(0, 120));
  await new Promise((r) => setTimeout(r, 1100)); // 等限流窗口滑走
  const nf = await json(`${RUNTIME}/fwd-echo?billNr=NOPE`, { headers: { 'X-API-Key': apiKey } });
  check('下游 404 透传', nf.status === 404 && nf.body && nf.body.error === 'bill not found', `status=${nf.status} body=${JSON.stringify(nf.body).slice(0, 80)}`);

  // 6. 超时 → 502/50003（指向 /slow，forwardTimeoutMs=1000 < 下游 2s）
  await json(`${BASE}/data-apis/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forwardUrl: 'http://127.0.0.1:4100/slow' }),
  });
  await new Promise((r) => setTimeout(r, 1100));
  const slow = await json(`${RUNTIME}/fwd-echo?billNr=S1`, { headers: { 'X-API-Key': apiKey } });
  check('超时 502/50003', slow.status === 502 && slow.body.code === 50003, `status=${slow.status} ${slow.body && slow.body.message}`);

  // 7. SSRF 红线：云元址被拒
  const ssrf = await json(`${BASE}/data-apis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ssrf-test', path: 'ssrf-test', sqlMode: 'forward',
      forwardUrl: 'http://169.254.169.254/latest/meta-data', authEnabled: false, rateLimitQps: 5,
    }),
  });
  check('SSRF 云元址拒绝 40001', ssrf.status === 400 && ssrf.body.code === 40001, ssrf.body && ssrf.body.message);

  // 8. 未声明占位符被拒
  const badPh = await json(`${BASE}/data-apis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ph-test', path: 'ph-test', sqlMode: 'forward',
      forwardUrl: 'http://127.0.0.1:4100/echo/:unknownParam', authEnabled: false, rateLimitQps: 5,
    }),
  });
  check('未声明占位符拒绝 40001', badPh.status === 400 && badPh.body.code === 40001, badPh.body && badPh.body.message);

  // 9. 调试代理透传（invoke 走 /slow 超时 → httpStatus 502 信封）
  const inv = await json(`${BASE}/data-apis/${id}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, queryParams: { billNr: 'S1' } }),
  });
  check('调试代理透传 502', inv.status === 200 && inv.body.result && inv.body.result.httpStatus === 502, JSON.stringify(inv.body.result).slice(0, 120));

  // 10. 调用明细含 forward 记录（成功 + 下游 404 + 502）
  const calls = await json(`${BASE}/data-apis/calls?apiId=${id}&size=20`);
  const items = (calls.body.result && calls.body.result.items) || [];
  check('明细有记录', items.length >= 5, `count=${items.length}`);
  check('明细含下游 404', items.some((it) => it.httpStatus === 404 && !it.ok), items.filter((it) => it.httpStatus === 404).map((it) => it.errorMsg).join('|'));
  check('明细含网关 502/50003', items.some((it) => it.httpStatus === 502 && it.bizCode === 50003), '');
  check('明细 query 不含 apiKey 明文', items.every((it) => !/dk-/.test(String(it.queryMasked))), '');

  // 11. 清理：恢复 URL 便于 UI 复测，然后删除测试产生的 ssrf/ph 残留（本来就没建出来）
  await json(`${BASE}/data-apis/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forwardUrl: 'http://127.0.0.1:4100/echo/:billNr' }),
  });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('测试脚本异常:', err);
  process.exit(2);
});
