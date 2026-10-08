/**
 * 端到端测试用假下游系统（:4100）。
 * GET/POST /echo/:billNr -> 回显收到的 method/headers/query/body（验证转发行为）
 * GET /slow -> 延迟 2s 才响应（测转发超时）
 * GET /redirect -> 302（验证不跟随、原样透传）
 * GET /notfound -> 404 + JSON body（验证下游错误码透传）
 */
const http = require('http');

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:4100');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname.startsWith('/redirect')) {
        res.writeHead(302, { location: 'http://example.invalid/hop' });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/notfound')) {
        send(404, { error: 'bill not found', path: url.pathname });
        return;
      }
      if (url.pathname.startsWith('/slow')) {
        setTimeout(() => send(200, { slow: true }), 2000);
        return;
      }
      if (url.pathname.startsWith('/big')) {
        send(200, { blob: 'x'.repeat(6 * 1024 * 1024) });
        return;
      }
      send(200, {
        echo: url.pathname,
        method: req.method,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8') || null,
      });
    });
  })
  .listen(4100, '127.0.0.1', () => console.log('fake downstream on :4100'));
