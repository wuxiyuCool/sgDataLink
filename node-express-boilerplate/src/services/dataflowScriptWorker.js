/**
 * 数据开发 script 节点 worker（契约 1.8.1，worker_threads + node:vm）。
 *
 * 隔离设计：
 * - 独立线程跑用户脚本，父线程按 timeoutMs terminate() 硬杀（vm 的 timeout 管不住 await，
 *   爬虫脚本必然异步，所以超时控制只能靠线程级 terminate）；
 * - vm context 只注入 $input/$env/fetch/console，无 require/process/globalThis 逃逸口
 *   （vm 默认 realm 自带 JS 内建对象，但拿不到宿主 API）；
 * - fetch 包装：仅 http/https、单响应 2MB、SSRF 红线（云元址/链路本地，同契约 1.9.3）、
 *   15s 网络超时；console 输出以 log 消息回传父线程并入运行日志。
 * 消息协议：{type:'log'|'result'|'error'}。
 */
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const http = require('http');
const https = require('https');

const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;

const formatArg = (value) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
};

const makeConsole = () => ({
  log: (...args) => parentPort.postMessage({ type: 'log', text: args.map(formatArg).join(' ') }),
  info: (...args) => parentPort.postMessage({ type: 'log', text: args.map(formatArg).join(' ') }),
  warn: (...args) => parentPort.postMessage({ type: 'log', text: `[warn] ${args.map(formatArg).join(' ')}` }),
  error: (...args) => parentPort.postMessage({ type: 'log', text: `[error] ${args.map(formatArg).join(' ')}` }),
});

/** SSRF 红线（与 services/dataApiRuntime.service.js 的 assertForwardConfig 同口径） */
const assertUrlAllowed = (rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (err) {
    throw new Error(`script fetch: URL 不合法: ${String(rawUrl).slice(0, 120)}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('script fetch: 仅支持 http/https');
  const host = String(url.hostname || '').toLowerCase();
  if (!host) throw new Error('script fetch: host 为空');
  if (host === '0.0.0.0' || /^169\.254\./.test(host) || host.startsWith('fe80')) {
    throw new Error(`script fetch: 目标地址被 SSRF 红线拒绝: ${host}`);
  }
  return url;
};

/** 受限 fetch：http/https 模块直连（不跟随重定向），响应体上限 2MB */
const limitedFetch = (rawUrl, init = {}) => {
  const url = assertUrlAllowed(rawUrl);
  const lib = url.protocol === 'https:' ? https : http;
  const method = String(init.method || (init.body ? 'POST' : 'GET')).toUpperCase();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(new Error(`script fetch 失败: ${message}`));
    };
    const req = lib.request(
      url,
      {
        method,
        headers: { 'user-agent': 'databridge-dataflow-script/1.0', ...(init.headers || {}) },
        timeout: FETCH_TIMEOUT_MS,
        redirect: 'manual',
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > FETCH_MAX_BYTES) {
            req.destroy();
            fail(`响应体超过 ${Math.floor(FETCH_MAX_BYTES / 1024 / 1024)}MB 上限`);
          } else {
            chunks.push(chunk);
          }
        });
        res.on('error', (err) => fail(err.message));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          const headers = {};
          Object.entries(res.headers).forEach(([key, value]) => {
            headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
          });
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers,
            text,
            json: () => JSON.parse(text),
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`超时(${FETCH_TIMEOUT_MS}ms)`)));
    req.on('error', (err) => fail(err.message));
    if (init.body) req.write(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
    req.end();
  });
};

const main = async () => {
  const { code, input, env } = workerData;
  const sandbox = {
    $input: input,
    $env: env || {},
    fetch: limitedFetch,
    console: makeConsole(),
  };
  const context = vm.createContext(sandbox);
  // async 包裹：脚本里直接写 return xxx 即为下游数据
  const script = new vm.Script(`(async () => {\n${String(code || '')}\n})()`, { filename: 'dataflow-script.js' });
  const result = await script.runInContext(context);
  if (result === undefined || result === null) {
    parentPort.postMessage({ type: 'result', rows: [] });
  } else if (Array.isArray(result)) {
    parentPort.postMessage({ type: 'result', rows: JSON.parse(JSON.stringify(result)) });
  } else {
    parentPort.postMessage({ type: 'result', rows: [JSON.parse(JSON.stringify(result))] });
  }
};

main().catch((err) => {
  parentPort.postMessage({ type: 'error', message: String((err && err.message) || err).slice(0, 500) });
});
