/**
 * /ds 网关并发压测（memory 驱动，测网关自身开销 + 转发上限）。
 * 场景 A：builder mock 出数（鉴权开，走完整 4 步网关链路）
 * 场景 B：forward 转调本地假下游 :4100
 * 场景 C：缺 Key 拒绝路径（网关最轻负载）
 */
const BASE = 'http://127.0.0.1:3001/api/v1';
const RUNTIME = 'http://127.0.0.1:3001/ds';
const CONCURRENCY = Number(process.env.CONC || 100);
const DURATION_MS = Number(process.env.SECS || 8) * 1000;

const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};

async function setup() {
  const a = await post(`${BASE}/data-apis`, {
    name: '压测-mock', path: 'load-mock', sqlMode: 'builder', datasourceId: 'ds-1001',
    tableName: 'T_ORDER', fields: [{ name: 'ID', type: 'BIGINT' }, { name: 'AMOUNT', type: 'DECIMAL' }],
    authEnabled: true, rateLimitQps: 100000,
  });
  const b = await post(`${BASE}/data-apis`, {
    name: '压测-转发', path: 'load-fwd', sqlMode: 'forward',
    forwardUrl: 'http://127.0.0.1:4100/echo/load', forwardMethod: 'GET',
    authEnabled: false, rateLimitQps: 100000,
  });
  await post(`${BASE}/data-apis/${a.result.id}/publish`, {});
  await post(`${BASE}/data-apis/${b.result.id}/publish`, {});
  return { mockKey: a.result.apiKey || (await (await fetch(`${BASE}/data-apis/${a.result.id}`)).json()).result.apiKey };
}

async function runScenario(name, url, options) {
  const lat = [];
  let okCount = 0;
  let errCount = 0;
  const deadline = Date.now() + DURATION_MS;
  const worker = async () => {
    while (Date.now() < deadline) {
      const t0 = performance.now();
      try {
        const res = await fetch(url, options);
        await res.arrayBuffer();
        if (res.status < 400) okCount += 1;
        else errCount += 1;
        lat.push(performance.now() - t0);
      } catch (e) {
        errCount += 1;
      }
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - started) / 1000;
  lat.sort((x, y) => x - y);
  const pct = (p) => (lat.length ? lat[Math.floor(lat.length * p)].toFixed(1) : '-');
  console.log(
    `${name}: 并发=${CONCURRENCY} 总请求=${okCount + errCount} 成功=${okCount} 失败=${errCount} ` +
    `吞吐=${((okCount + errCount) / elapsed).toFixed(0)} req/s | P50=${pct(0.5)}ms P95=${pct(0.95)}ms P99=${pct(0.99)}ms`
  );
}

(async () => {
  const { mockKey } = await setup();
  console.log(`准备完成，mockKey=${String(mockKey).slice(0, 11)}...`);
  await runScenario('A builder-mock(带鉴权)', `${RUNTIME}/load-mock?page=1&size=20`, { headers: { 'X-API-Key': mockKey } });
  await runScenario('B forward 转发(:4100)', `${RUNTIME}/load-fwd`);
  await runScenario('C 缺Key拒绝(网关最轻)', `${RUNTIME}/load-mock`);
  // 清理压测对象
  const list = await (await fetch(`${BASE}/data-apis?keyword=压测&size=50`)).json();
  for (const item of list.result.items) {
    await fetch(`${BASE}/data-apis/${item.id}`, { method: 'DELETE' });
  }
  console.log('压测对象已清理');
})().catch((e) => { console.error(e); process.exit(1); });
