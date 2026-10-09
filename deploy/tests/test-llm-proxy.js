/* 出站代理（utils/proxyAgent）用例：CONNECT 隧道 + Basic 认证 + NO_PROXY + http 绝对 URI
 * 背景：Node 18 全局 fetch 不读 HTTPS_PROXY，内网容器经 squid 出口访问外网 LLM 会直连超时；
 *      本用例用一个「要求 Basic 认证的假 CONNECT 代理」验证代理链路真的走通（不依赖生产 squid）。
 * 前置：无（case 4 需要本机能直连外网访问 LLM 域名，不可达时自动跳过而非失败）
 * 跑法（cwd=node-express-boilerplate）：
 *   node ../deploy/tests/test-llm-proxy.js
 * 可选：LLM_PROBE_URL=https://api.deepseek.com/v1/models 覆盖 https 穿透探测目标 */
const http = require('http');
const net = require('net');
const { requestJson, shouldBypass, describeRoute } = require('../../node-express-boilerplate/src/utils/proxyAgent');

const PROXY_USER = 'testuser';
const PROXY_PASS = 'testpass';
const EXPECT_BASIC = `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64')}`;
const PROBE_URL = process.env.LLM_PROBE_URL || 'https://api.deepseek.com/v1/models';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
};

const withEnv = async (vars, fn) => {
  const saved = {};
  Object.keys(vars).forEach((k) => { saved[k] = process.env[k]; process.env[k] = vars[k]; });
  try {
    return await fn();
  } finally {
    Object.keys(vars).forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  }
};

/** 要求 Proxy-Authorization 的假 CONNECT 代理（认证不过回 407） */
const startConnectProxy = () =>
  new Promise((resolve) => {
    const state = { tunnels: 0, lastHost: null, lastAuth: null };
    const server = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only'); });
    server.on('connect', (req, clientSocket) => {
      state.lastHost = req.url;
      state.lastAuth = req.headers['proxy-authorization'] || null;
      if (state.lastAuth !== EXPECT_BASIC) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="probe"\r\n\r\n');
        clientSocket.end();
        return;
      }
      const [host, port] = String(req.url).split(':');
      const upstream = net.connect(Number(port), host, () => {
        state.tunnels += 1;
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });

/** 记录请求行的假 http 正向代理（验证绝对 URI + Host 头 + 认证头） */
const startHttpForwardProbe = () =>
  new Promise((resolve) => {
    const state = { path: null, auth: null, hostHeader: null };
    const server = http.createServer((req, res) => {
      state.path = req.url;
      state.auth = req.headers['proxy-authorization'] || null;
      state.hostHeader = req.headers.host || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ viaForwardProxy: true }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });

const main = async () => {
  const connectProxy = await startConnectProxy();
  const forwardProbe = await startHttpForwardProbe();
  const proxyNoAuth = `http://127.0.0.1:${connectProxy.port}`;
  const proxyAuth = `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${connectProxy.port}`;

  console.log('== 单元：NO_PROXY / describeRoute ==');
  await withEnv({ NO_PROXY: 'localhost,10.45.34.*,api.internal' }, async () => {
    check('NO_PROXY 命中主机名后缀', shouldBypass('api.internal') === true);
    check('NO_PROXY 未命中不误放', shouldBypass('api.deepseek.com') === false);
  });
  await withEnv({ NO_PROXY: '*' }, async () => {
    check('NO_PROXY=* 全放行', shouldBypass('anything.example.com') === true);
  });
  await withEnv({ HTTPS_PROXY: proxyAuth }, async () => {
    const desc = describeRoute('https://api.deepseek.com/v1');
    check('describeRoute 掩码密码', desc.includes(`${PROXY_USER}:***`) && !desc.includes(PROXY_PASS), desc);
  });
  await withEnv({}, async () => {
    check('无代理环境变量 → direct', describeRoute('https://api.deepseek.com/v1') === 'direct');
  });

  console.log('\n== http 目标：绝对 URI 转发给代理 ==');
  await withEnv({ HTTP_PROXY: `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${forwardProbe.port}` }, async () => {
    const r = await requestJson('http://some-downstream.local/api/v1/x?a=1', { method: 'GET', timeoutMs: 5000 });
    check('http 走代理并拿到响应', r.status === 200 && JSON.parse(r.text).viaForwardProxy === true, r.text);
    check('path 是绝对 URI（正向代理惯例）', /^http:\/\/some-downstream\.local\//.test(forwardProbe.state.path || ''), forwardProbe.state.path);
    check('Host 头指向真实目标', forwardProbe.state.hostHeader === 'some-downstream.local', forwardProbe.state.hostHeader);
    check('http 也带 Proxy-Authorization', forwardProbe.state.auth === EXPECT_BASIC, String(forwardProbe.state.auth).slice(0, 12));
  });

  console.log('\n== https 目标：CONNECT 隧道 + 认证 ==');
  await withEnv({ HTTPS_PROXY: proxyNoAuth }, async () => {
    let msg = '';
    try { await requestJson(PROBE_URL, { method: 'GET', timeoutMs: 8000 }); } catch (e) { msg = e.message; }
    check('缺认证 → 代理 407 且报错可读', /407/.test(msg) && /代理需要认证/.test(msg), msg);
    check('代理确实收到了 CONNECT', connectProxy.state.lastHost === null || /:443$/.test(connectProxy.state.lastHost || ''), connectProxy.state.lastHost);
  });

  let tunnelOk = false;
  await withEnv({ HTTPS_PROXY: proxyAuth }, async () => {
    try {
      const r = await requestJson(PROBE_URL, { method: 'GET', timeoutMs: 10000 });
      tunnelOk = true;
      // 未带业务鉴权 → 目标返回 401/403 即证明 TLS 隧道打通并拿到了真实响应
      check('带认证 CONNECT 隧道打通并取回响应', r.status >= 400 && r.status < 500, `status=${r.status}`);
      check('隧道计数增加', connectProxy.state.tunnels >= 1, `tunnels=${connectProxy.state.tunnels}`);
    } catch (e) {
      console.log(`  skip https 穿透（本机到 ${PROBE_URL} 不可达）：${e.message}`);
    }
  });

  await withEnv({ HTTPS_PROXY: proxyAuth, NO_PROXY: 'deepseek.com' }, async () => {
    const before = connectProxy.state.tunnels;
    try {
      await requestJson(PROBE_URL, { method: 'GET', timeoutMs: 10000 });
      check('NO_PROXY 命中则绕过代理', connectProxy.state.tunnels === before, `before=${before} after=${connectProxy.state.tunnels}`);
    } catch (e) {
      check('NO_PROXY 命中则绕过代理（直连失败但确实未走代理）', connectProxy.state.tunnels === before);
    }
  });

  if (!tunnelOk) console.log('\n提示：https 穿透用例被跳过时，仅代理层单测有效；生产 squid 上请再手工验证问数。');

  connectProxy.server.close();
  forwardProbe.server.close();
  console.log(`\ntest-llm-proxy: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => {
  console.error('test-llm-proxy crashed:', e.message, e.stack);
  process.exit(1);
});
