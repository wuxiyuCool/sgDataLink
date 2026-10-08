/* 指标中心并发/性能压测（真库 mysql；bench-ds.js 同族）
 * 场景 A：查询/聚合端点并发（dashboard 全表聚合、指标/模型列表 SQL、域树、审计分页）
 * 场景 B：/metric-chat/ask 并发（LLM 秒级 + 编译+引擎执行链路的排队行为，控制成本跑固定题数）
 * 前置：admin 以 .env（DB_DRIVER=mysql）跑在 3001；引擎 8080 在线；真库里已有指标资产（否则 ask 全 clarify）
 * 跑法（cwd=node-express-boilerplate）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 BASE=http://127.0.0.1:3001/api/v1 \
 *   CONC=50 SECS=5 ASK_CONC=3 ASK_RUNS=6 node ../deploy/tests/bench-metric.js */
const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123';
const CONC = Number(process.env.CONC || 50);
const SECS = Number(process.env.SECS || 5);
const ASK_CONC = Number(process.env.ASK_CONC || 3);
const ASK_RUNS = Number(process.env.ASK_RUNS || 6);

const stats = (lat) => {
  if (!lat.length) return null;
  const sorted = lat.slice().sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    n: sorted.length,
    p50: Math.round(pct(0.5)),
    p95: Math.round(pct(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
    avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
};

/** 固定时长并发：SECS 秒内每个 worker 串行打请求，统计时延分布与合计 TPS */
const benchFor = async (label, token, path, opts = {}) => {
  const latencies = [];
  let errors = 0;
  const endAt = Date.now() + SECS * 1000;
  const worker = async () => {
    while (Date.now() < endAt) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          method: opts.method || 'GET',
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        await res.text();
        if (!res.ok && res.status !== 404) errors += 1;
        latencies.push(Date.now() - t0);
      } catch (e) {
        errors += 1;
      }
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  const elapsed = (Date.now() - started) / 1000;
  const s = stats(latencies);
  console.log(
    `  ${label.padEnd(28)} conc=${CONC} n=${s ? s.n : 0} tps=${s ? Math.round(s.n / elapsed) : 0} `
      + `p50=${s ? s.p50 : '-'}ms p95=${s ? s.p95 : '-'}ms max=${s ? s.max : '-'}ms avg=${s ? s.avg : '-'}ms err=${errors}`
  );
  return { tps: s ? s.n / elapsed : 0, p95: s ? s.p95 : 0, errors };
};

const main = async () => {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  }).then((r) => r.json());
  const token = login.result && login.result.token;
  if (!token) {
    console.error('登录失败：检查 ADMIN_USER/ADMIN_PASS');
    process.exit(1);
  }

  console.log(`== 场景 A：查询/聚合端点（conc=${CONC}, ${SECS}s）==`);
  await benchFor('GET /metric-dashboard', token, '/metric-dashboard');
  await benchFor('GET /metrics size=20', token, '/metrics?page=1&size=20');
  await benchFor('GET /metric-models size=20', token, '/metric-models?page=1&size=20');
  await benchFor('GET /metric-domains/tree', token, '/metric-domains/tree');
  await benchFor('GET /metric-logs size=20', token, '/metric-logs?page=1&size=20');
  await benchFor('GET /metric-terms size=20', token, '/metric-terms?page=1&size=20');

  console.log(`\n== 场景 B：/metric-chat/ask（conc=${ASK_CONC}, 共 ${ASK_RUNS} 问；真 LLM 计费按此控制）==`);
  const questions = ['昨天的订单额是多少', '按地区看昨天的订单额', '昨天的件单价', '最近30天订单数', '昨天华东的实收额', '昨天的订单额和订单数'];
  const askLat = [];
  const statuses = {};
  let askErrors = 0;
  let cursor = 0;
  const askWorker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= ASK_RUNS) return;
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE}/metric-chat/ask`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ question: questions[i % questions.length] }),
        });
        const json = await res.json();
        const st = (json.result && json.result.status) || `http${res.status}`;
        statuses[st] = (statuses[st] || 0) + 1;
        if (!json.result) askErrors += 1;
        askLat.push(Date.now() - t0);
      } catch (e) {
        askErrors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: ASK_CONC }, askWorker));
  const s = stats(askLat);
  console.log(
    `  ask n=${s ? s.n : 0} p50=${s ? s.p50 : '-'}ms p95=${s ? s.p95 : '-'}ms max=${s ? s.max : '-'}ms err=${askErrors} status=${JSON.stringify(statuses)}`
  );

  console.log('\nbench-metric 完成');
  process.exit(0);
};

main().catch((e) => {
  console.error('bench-metric crashed:', e.message);
  process.exit(1);
});
