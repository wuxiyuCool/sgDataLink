const esbuild = require('D:/code/code/go/dataLink/vue-vben-admin/node_modules/.pnpm/esbuild@0.14.54/node_modules/esbuild');
const fs = require('fs');
let src = fs.readFileSync('D:/code/code/go/dataLink/vue-vben-admin/src/views/databridge/dataapi/dataapi.data.ts', 'utf8');
src = src.replace(/import\.meta\.env/g, '({DEV:true})');
const out = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
const m = { exports: {} };
new Function('module', 'exports', 'require', out)(m, m.exports, require);
const p = m.exports.parseCurlCommand;

const multiline = "curl 'http://10.1.2.3:8080/api/bill?orgId=3' \\\n  -H 'Content-Type: application/json' \\\n  -H 'token: tk-abc' --compressed";
const r1 = p(multiline);
console.log('case1', JSON.stringify(r1));
console.assert(r1.url === 'http://10.1.2.3:8080/api/bill?orgId=3' && r1.headers.length === 2 && r1.warnings.length === 0, 'CASE1 FAIL');

const r2 = p('curl -X POST "http://h/api" -u admin:pass123 -d \'{"a":1}\' -H "X-Tenant: t1"');
console.log('case2', JSON.stringify(r2));
console.assert(r2.method === 'POST' && r2.headers[0].value.startsWith('Basic ') && r2.headers[1].value === 't1' && r2.body === '{"a":1}', 'CASE2 FAIL');

const r3 = p('curl -b "sid=9" --url https://x.cn/ok --bogus');
console.log('case3', JSON.stringify(r3));
console.assert(r3.url === 'https://x.cn/ok' && r3.headers[0].name === 'Cookie' && r3.warnings.length === 1, 'CASE3 FAIL');

const r4 = p('');
console.assert(r4.url === '' && r4.warnings[0].includes('未解析到'), 'CASE4 FAIL');
console.log('ALL PASS');
