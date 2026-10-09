/**
 * 代理出站支持（仅用 Node 内置 http/https/tls，零新依赖）。
 *
 * 为什么需要它：Node 18+ 的全局 fetch（undici）**不读 HTTP_PROXY/HTTPS_PROXY 环境变量**，
 * 所以内网容器里给 Deployment 配了代理变量、LLM 请求仍然直连外网域名并超时。
 * 本模块提供代理感知的 JSON HTTP 客户端：
 *  - https 目标 → 向代理发 CONNECT 建隧道，再在其上做 TLS（自定义 https.Agent.createConnection）
 *  - http 目标  → 按正向代理惯例请求代理端、path 用绝对 URI
 *  - 代理带认证 → CONNECT / 请求上带 Proxy-Authorization: Basic（取自代理 URL 的 user:pass）
 *  - NO_PROXY   → 命中则直连（内网下游、localhost 等）
 *
 * 环境变量（与 curl/squid 惯例一致，大小写均可）：
 *   HTTPS_PROXY / https_proxy   访问 https 目标时使用，如 http://user:pass@10.45.34.223:3128
 *   HTTP_PROXY  / http_proxy    访问 http 目标时使用
 *   NO_PROXY    / no_proxy      逗号分隔主机后缀（支持 * 与 .example.com 形式）
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const env = (...names) => {
  const hit = names.map((n) => process.env[n]).find((v) => v && String(v).trim());
  return hit ? String(hit).trim() : '';
};

/** NO_PROXY 命中判定：* 全放行；其余按主机名相等或以该项为后缀（忽略前导点、大小写不敏感） */
const shouldBypass = (hostname) => {
  const noProxy = env('NO_PROXY', 'no_proxy');
  if (!noProxy) return false;
  const host = String(hostname).toLowerCase();
  return noProxy
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((item) => {
      if (item === '*') return true;
      const bare = item.replace(/^\./, '');
      return host === bare || host.endsWith(`.${bare}`);
    });
};

/** 解析目标应走的代理；无代理或命中 NO_PROXY 返回 null */
const resolveProxy = (targetUrl) => {
  const target = new URL(targetUrl);
  const isHttps = target.protocol === 'https:';
  if (shouldBypass(target.hostname)) return null;
  const raw = isHttps
    ? env('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy')
    : env('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  if (!raw) return null;
  try {
    const proxy = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    // 代理 URL 本身不该再走代理
    if (shouldBypass(proxy.hostname)) return null;
    return { proxy, target, isHttps };
  } catch (err) {
    return null;
  }
};

const proxyAuthHeader = (proxy) => {
  if (!proxy.username) return null;
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password || '');
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
};

/**
 * https 目标的 CONNECT 隧道 agent：向代理 CONNECT host:443，
 * 成功后在返回的 socket 上做 TLS，后续 HTTP 帧由 Node https 客户端负责。
 */
class HttpsTunnelAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: false });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const host = options.servername || options.host;
    const port = options.port || 443;
    const headers = {};
    const auth = proxyAuthHeader(this.proxy);
    if (auth) headers['Proxy-Authorization'] = auth;

    const connectReq = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port || 3128,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
      timeout: options.timeout || 30000,
    });

    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const hint = res.statusCode === 407 ? '（代理需要认证：检查 HTTPS_PROXY 里的 user:pass）' : '';
        callback(new Error(`代理 CONNECT 被拒 ${res.statusCode}${hint}`));
        return;
      }
      let tlsSocket;
      try {
        tlsSocket = tls.connect({
          socket,
          servername: host,
          ALPNProtocols: ['http/1.1'],
          rejectUnauthorized: options.rejectUnauthorized !== false,
        });
      } catch (err) {
        callback(err);
        return;
      }
      tlsSocket.once('error', (err) => callback(err));
      callback(null, tlsSocket);
    });
    connectReq.once('timeout', () => {
      connectReq.destroy(new Error(`代理连接超时（${this.proxy.hostname}:${this.proxy.port || 3128} 不可达？）`));
    });
    connectReq.once('error', (err) => callback(err));
    connectReq.end();
  }
}

const agentCache = new Map();
const tunnelAgentFor = (proxy) => {
  // key 含认证信息：同一 host:port 下带/不带凭据是两个不同的 agent
  const key = proxy.href;
  if (!agentCache.has(key)) agentCache.set(key, new HttpsTunnelAgent(proxy));
  return agentCache.get(key);
};

/**
 * 发一个 JSON 请求，返回 { status, text }（不抛 HTTP 状态错误，交由调用方判读）。
 * 网络层失败（DNS/连接/代理/超时）才 reject。
 * @param {string} urlStr 目标地址
 * @param {{method?:string, headers?:Object, body?:string, timeoutMs?:number}} opts
 */
const requestJson = (urlStr, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs = Number(opts.timeoutMs) || 30000;
    const routed = resolveProxy(urlStr);
    const target = routed ? routed.target : new URL(urlStr);
    const headers = { accept: 'application/json', ...(opts.headers || {}) };
    const method = opts.method || 'GET';

    let lib;
    let reqOpts;
    if (routed && routed.isHttps) {
      // https 走 CONNECT 隧道：host/port/path 仍是目标的，socket 由 agent 提供
      lib = https;
      reqOpts = {
        protocol: 'https:',
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent: tunnelAgentFor(routed.proxy),
        timeout: timeoutMs,
      };
    } else if (routed && !routed.isHttps) {
      // http 走正向代理惯例：连到代理端，path 用绝对 URI，Host 头指向真实目标
      lib = http;
      headers.host = `${target.hostname}${target.port ? `:${target.port}` : ''}`;
      const auth = proxyAuthHeader(routed.proxy);
      if (auth) headers['Proxy-Authorization'] = auth;
      reqOpts = {
        protocol: 'http:',
        hostname: routed.proxy.hostname,
        port: routed.proxy.port || 3128,
        path: urlStr,
        method,
        headers,
        agent: false,
        timeout: timeoutMs,
      };
    } else {
      lib = target.protocol === 'https:' ? https : http;
      reqOpts = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent: false,
        timeout: timeoutMs,
      };
    }

    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => reject(err));
    });

    req.once('timeout', () => {
      req.destroy(new Error(`请求超时(${timeoutMs}ms)`));
    });
    req.once('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

/** 诊断用：当前目标会走哪个代理（不含密码） */
const describeRoute = (urlStr) => {
  const routed = resolveProxy(urlStr);
  if (!routed) return 'direct';
  const p = routed.proxy;
  return `${p.protocol}//${p.username ? `${p.username}:***@` : ''}${p.hostname}:${p.port || 3128}`;
};

module.exports = { requestJson, resolveProxy, shouldBypass, describeRoute };
