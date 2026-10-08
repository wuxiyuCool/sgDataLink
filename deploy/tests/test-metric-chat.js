/* 契约 v1.12 M5 联调用例：ChatBI 智能问数（真库 + 真 DeepSeek）
 * 前置：
 *   引擎:  databridge-engine 已启动（默认 http://127.0.0.1:8080，/sql/query 可用）
 *   admin: node-express-boilerplate 以 .env（DB_DRIVER=mysql）启动在 3001，
 *          metric_setting 已配置 llm.*（DeepSeek key，界面已录入）
 * 跑法（cwd=node-express-boilerplate，凭据来自 .env）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 BASE=http://127.0.0.1:3001/api/v1 \
 *   TEST_DS_HOST=$MYSQL_HOST TEST_DS_USER=$MYSQL_USER TEST_DS_PASS=$MYSQL_PASSWORD TEST_DS_DB=$MYSQL_DATABASE \
 *   node ../deploy/tests/test-metric-chat.js
 * LLM 非确定性：10 问按预期逐题判定，≥7 判整体通过（acceptance 阈值写死在脚本尾）。
 * 自建源表 fixture（相对「今天」造数），指标/域/模型/术语/示例/日志 SQL 清理。 */
process.env.DB_DRIVER = 'mysql';
const db = require('../../node-express-boilerplate/src/db/mysql');

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123';
const DS = {
  host: process.env.TEST_DS_HOST || '10.45.34.222',
  port: Number(process.env.TEST_DS_PORT || 3306),
  user: process.env.TEST_DS_USER || 'root',
  pass: process.env.TEST_DS_PASS || '',
  db: process.env.TEST_DS_DB || 'dataLink',
};
const RUN = `m5c${Date.now().toString(36)}`;
const SRC = `${RUN}_ord`;
const DAY = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

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
const req = async (path, { method = 'GET', token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let json = null;
  try {
    json = JSON.parse(t);
  } catch (e) {
    /* ignore */
  }
  return { status: res.status, json, text: t };
};

const cleanup = async () => {
  const stmts = [
    [`DROP TABLE IF EXISTS \`${SRC}\``],
    ['DELETE v FROM databridge_metric_version v JOIN databridge_metric_metric m ON v.metric_id=m.id WHERE m.code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_metric_metric WHERE code LIKE ?', [`${RUN}_%`]],
    ['DELETE c FROM databridge_metric_model_column c JOIN databridge_metric_model m ON c.model_id=m.id WHERE m.name LIKE ?', ['M5联调问数模型%']],
    ['DELETE FROM databridge_metric_model WHERE name LIKE ?', ['M5联调问数模型%']],
    ['DELETE FROM databridge_metric_domain WHERE code LIKE ?', [`${RUN}_%`]],
    ['DELETE FROM databridge_datasource WHERE name LIKE ?', [`M5数据源-${RUN}%`]],
    ['DELETE FROM databridge_metric_term WHERE name LIKE ?', ['联调术语%']],
    ['DELETE FROM databridge_metric_example WHERE question LIKE ?', ['联调示例%']],
    ['DELETE FROM databridge_metric_query_log WHERE question LIKE ?', ['%订单额%'] ],
    ['DELETE FROM databridge_metric_query_log WHERE question LIKE ?', ['%件单价%']],
    ['DELETE FROM databridge_metric_query_log WHERE question LIKE ?', ['%实收额%']],
    ['DELETE FROM databridge_metric_query_log WHERE question LIKE ?', ['%订单数%']],
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

  console.log('== 源数据准备（相对今天的造数）==');
  await db.run(
    `CREATE TABLE \`${SRC}\` (id BIGINT AUTO_INCREMENT PRIMARY KEY, region VARCHAR(32), amt DECIMAL(18,2), status VARCHAR(16), pay_date DATE) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  );
  await db.run(
    `INSERT INTO \`${SRC}\` (region, amt, status, pay_date) VALUES
     ('华东',100.50,'PAID','${DAY(1)}'),('华东',50.00,'CANCEL','${DAY(1)}'),
     ('华南',80.00,'PAID','${DAY(2)}'),('华东',30.00,'PAID','${DAY(60)}')`
  );
  const dom = await req('/metric-domains', { method: 'POST', token, body: { name: `M5域-${RUN}`, code: RUN } });
  const ds = await req('/datasources', {
    method: 'POST',
    token,
    body: { name: `M5数据源-${RUN}`, type: 'mysql', host: DS.host, port: DS.port, database: DS.db, username: DS.user, password: DS.pass },
  });
  const model = await req('/metric-models', {
    method: 'POST',
    token,
    body: {
      name: 'M5联调问数模型',
      datasourceId: ds.json.result.id,
      domainId: dom.json.result.id,
      layer: 'DWD',
      tableName: SRC,
      createType: 'reference',
      timeColumn: 'pay_date',
      columns: [
        { columnName: 'id', role: 'dimension', bizName: '主键', dataType: 'bigint' },
        { columnName: 'region', role: 'dimension', bizName: '地区', dataType: 'varchar' },
        { columnName: 'amt', role: 'measure', bizName: '金额', aggDefault: 'sum', dataType: 'decimal' },
        { columnName: 'status', role: 'dimension', bizName: '状态', dataType: 'varchar' },
        { columnName: 'pay_date', role: 'time', bizName: '支付日期', dataType: 'date' },
      ],
    },
  });
  check('模型手工列登记（bizName 中文）', model.status === 200 && (model.json.result.columns || []).length === 5, model.text.slice(0, 200));
  const modelId = model.json.result.id;

  const mkMetric = async (body, name) => {
    // eslint-disable-next-line no-await-in-loop
    const r = await req('/metrics', { method: 'POST', token, body: { domainId: dom.json.result.id, status: 'online', ...body } });
    check(name, r.status === 200, r.text.slice(0, 200));
    return r.json && r.json.result;
  };
  const orderAmt = await mkMetric({ code: `${RUN}_amt`, name: '订单额', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' } }, 'ATOMIC 订单额');
  const orderCnt = await mkMetric({ code: `${RUN}_cnt`, name: '订单数', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'id', agg: 'count', timeColumn: 'pay_date' } }, 'ATOMIC 订单数');
  const paidAmt = await mkMetric({ code: `${RUN}_paid`, name: '实收额', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', filterSql: "t.status='PAID'", timeColumn: 'pay_date' } }, 'ATOMIC 实收额');
  const unitPrice = await mkMetric({ code: `${RUN}_unit`, name: '件单价', defineType: 'METRIC', expr: `\${${RUN}_amt} / \${${RUN}_cnt}` }, 'COMPOSITE 件单价');

  const term = await req('/metric-terms', { method: 'POST', token, body: { name: '联调术语GMV', alias: ['GMV'], description: 'GMV 即订单额' } });
  check('术语创建', term.status === 200 && term.json.result.id, term.text.slice(0, 160));
  const termUpd = await req(`/metric-terms/${term.json.result.id}`, { method: 'PUT', token, body: { description: 'GMV=订单额（联调）' } });
  check('术语更新', termUpd.status === 200 && /联调/.test(termUpd.json.result.description), termUpd.text.slice(0, 160));
  const example = await req('/metric-examples', { method: 'POST', token, body: { question: '联调示例：昨天华东订单额', m2sql: 'SELECT `订单额` FROM `M5联调问数模型` WHERE `数据日期` = \'2026-01-01\' AND `地区` = \'华东\'' } });
  check('示例创建', example.status === 200 && example.json.result.id, example.text.slice(0, 160));

  console.log('== 10 问测评（真 LLM + 真库执行）==');
  const askQ = async (question) => {
    const r = await req('/metric-chat/ask', { method: 'POST', token, body: { question } });
    return r.json && r.json.result ? r.json.result : { status: 'httperror', answer: r.text.slice(0, 120) };
  };
  const num = (v) => Number(v);
  const near = (v, t) => v !== undefined && v !== null && Math.abs(num(v) - t) < 0.01;
  const cases = [
    {
      q: '昨天的订单额是多少',
      name: 'Q1 单指标+相对时间(昨天)',
      ok: (a) => ['success', 'corrected'].includes(a.status) && near(a.value, 150.5),
    },
    {
      q: '昨天实收额是多少',
      name: 'Q2 带过滤口径指标(PAID)',
      ok: (a) => ['success', 'corrected'].includes(a.status) && near(a.value, 100.5),
    },
    {
      q: '昨天的订单数',
      name: 'Q3 count 指标',
      ok: (a) => ['success', 'corrected'].includes(a.status) && near(a.value, 2),
    },
    {
      q: '按地区看昨天的订单额',
      name: 'Q4 维度分组',
      ok: (a) => ['success', 'corrected'].includes(a.status) && a.rows && a.rows.length >= 1 && a.rows.some((r) => r.includes('华东')),
    },
    {
      q: '华东昨天的订单额',
      name: 'Q5 维度过滤',
      ok: (a) => ['success', 'corrected'].includes(a.status) && near(a.value, 150.5),
    },
    {
      q: '昨天的件单价',
      name: 'Q6 复合指标(公式展开)',
      ok: (a) => ['success', 'corrected'].includes(a.status) && near(a.value, 75.25),
    },
    {
      q: '昨天的订单额和订单数分别是多少',
      name: 'Q7 多指标同查',
      ok: (a) => ['success', 'corrected'].includes(a.status) && a.rows && a.rows.length === 1 && a.rows[0].length >= 2,
    },
    {
      q: '最近30天的订单额',
      name: 'Q8 时间窗(30天，剔除60天前)',
      ok: (a) => ['success', 'corrected'].includes(a.status) && near(a.value, 230.5),
    },
    {
      q: '联调不存在的指标XYZ是多少',
      name: 'Q9 无法召回 → clarify/failed 友好返回',
      ok: (a) => ['clarify', 'failed'].includes(a.status),
    },
    {
      q: '昨天华东的实收额按地区',
      name: 'Q10 过滤+分组组合',
      ok: (a) => ['success', 'corrected'].includes(a.status) && a.rows && a.rows.length >= 1,
    },
  ];
  let hits = 0;
  const details = [];
  for (const c of cases) {
    // eslint-disable-next-line no-await-in-loop
    const a = await askQ(c.q);
    const ok = c.ok(a);
    if (ok) hits += 1;
    else details.push(`${c.name}: status=${a.status} value=${a.value} answer=${String(a.answer).slice(0, 60)} err=${a.error || ''} m2=${String(a.m2sql).replace(/\s+/g, ' ').slice(0, 160)} sql=${String(a.physicalSql).slice(0, 120)}`);
    console.log(`  ${ok ? 'ok ' : 'MISS'} ${c.name} [${a.status}] ${a.value !== undefined ? a.value : ''} ${String(a.answer || '').slice(0, 50)}`);
  }
  check(`10 问命中 ≥7（实际 ${hits}）`, hits >= 7, details.join('\n      '));

  console.log('== 需求5：metricTree 子指标回填 ==');
  const treeAns = await askQ('昨天的件单价');
  const walkHasValue = (node) => Boolean(node && (node.value !== undefined && node.value !== null)) || (node && (node.children || []).some(walkHasValue));
  check(
    '件单价树含订单额/订单数子指标且回填 value',
    ['success', 'corrected'].includes(treeAns.status) && treeAns.metricTree && (treeAns.metricTree.children || []).length >= 2 && walkHasValue(treeAns.metricTree),
    JSON.stringify(treeAns.metricTree || {}).slice(0, 300)
  );

  console.log('== 会话多轮（内存态）==');
  const sid = `${RUN}-s1`;
  const s1 = await req('/metric-chat/ask', { method: 'POST', token, body: { question: '昨天的订单额', sessionId: sid } });
  const s2 = await req('/metric-chat/ask', { method: 'POST', token, body: { question: '那订单数呢', sessionId: sid } });
  check('第二轮问答返回有效状态', s2.json && s2.json.result && ['success', 'corrected', 'clarify', 'failed'].includes(s2.json.result.status), JSON.stringify(s2.json && s2.json.result && s2.json.result.status));
  const hist = await req(`/metric-chat/sessions/${sid}/history`, { token });
  check('history 有 2 轮', hist.status === 200 && hist.json.result.length === 2, hist.text.slice(0, 200));
  await req(`/metric-chat/sessions/${sid}/history`, { method: 'POST', token, body: {} });
  const hist2 = await req(`/metric-chat/sessions/${sid}/history`, { token });
  check('清空后 history 为空', hist2.status === 200 && hist2.json.result.length === 0, hist2.text.slice(0, 120));
  void s1;

  console.log('== 问数日志与转示例 ==');
  const logs = await req('/metric-logs?size=50', { token });
  check('日志列表落库', logs.status === 200 && logs.json.result.total >= 11, logs.text.slice(0, 160));
  const logFilter = await req(`/metric-logs?keyword=${encodeURIComponent('件单价')}`, { token });
  check('日志关键字筛选', logFilter.status === 200 && logFilter.json.result.items.every((l) => l.question.includes('件单价')));
  const okLog = (logs.json.result.items || []).find((l) => l.status !== 'failed' && l.m2sql);
  if (okLog) {
    const toEx = await req(`/metric-logs/${okLog.id}/to-example`, { method: 'POST', token, body: {} });
    check('转示例成功', toEx.status === 200 && toEx.json.result.id, toEx.text.slice(0, 160));
  } else {
    check('转示例成功（无可用日志，跳过）', true);
  }

  console.log('== 清理 ==');
  const exDel = await req(`/metric-examples/${example.json.result.id}`, { method: 'DELETE', token });
  check('示例删除', exDel.status === 200);
  const termDel = await req(`/metric-terms/${term.json.result.id}`, { method: 'DELETE', token });
  check('术语删除', termDel.status === 200);
  await cleanup();
  console.log('  联调资产已清理');
  console.log(`\ntest-metric-chat: ${pass} pass, ${fail} fail (hits=${hits}/10)`);
  process.exit(fail ? 1 : 0);
};

main().catch(async (e) => {
  console.error('test-metric-chat crashed:', e.message, e.stack);
  await cleanup().catch(() => {});
  process.exit(1);
});
