/* 指标中心常驻演示资产 seed（真库；压测/浏览器验收/问数演示共用）
 * 资产：域 dmtrade + 引用模型 dm_order_dwd（物理表 dm_order_src，刷近 45 天数据）
 *       指标 dm_amt 订单额 / dm_cnt 订单数 / dm_paid 实收额 / dm_unit 件单价(复合=amt/cnt)
 * 幂等：重复执行=刷新数据 + 复用已有对象；数据源复用库里第一个启用的 mysql 数据源。
 * 跑法（cwd=node-express-boilerplate）：
 *   set -a; source .env; set +a
 *   ADMIN_USER=mtlint01 ADMIN_PASS=MtLint_2026 BASE=http://127.0.0.1:3001/api/v1 node ../deploy/tests/seed-metric-demo.js */
process.env.DB_DRIVER = 'mysql';
const db = require('../../node-express-boilerplate/src/db/mysql');

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api/v1';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'testpass123';
const DAY = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const req = async (token, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

const main = async () => {
  const login = await req(null, '/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  const token = login.json.result && login.json.result.token;
  if (!token) throw new Error('登录失败');

  await db.run(
    `CREATE TABLE IF NOT EXISTS dm_order_src (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      region VARCHAR(32), amt DECIMAL(18,2), status VARCHAR(16), pay_date DATE
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`
  );
  await db.run('DELETE FROM dm_order_src');
  const regions = ['华东', '华南', '华北', '西南'];
  const rows = [];
  for (let d = 0; d < 45; d += 1) {
    for (let i = 0; i < 6; i += 1) {
      const region = regions[(d + i) % regions.length];
      const amt = (50 + ((d * 7 + i * 13) % 160) + (i % 2 ? 0.5 : 0.25)).toFixed(2);
      const status = i % 5 === 0 ? 'CANCEL' : 'PAID';
      rows.push(`('${region}',${amt},'${status}','${DAY(d)}')`);
    }
  }
  await db.run(`INSERT INTO dm_order_src (region, amt, status, pay_date) VALUES ${rows.join(',')}`);
  console.log(`dm_order_src 写入 ${rows.length} 行（近 45 天）`);

  const dsList = await req(token, '/datasources?page=1&size=100');
  const mysqlDs = (dsList.json.result.items || []).find((d) => d.type === 'mysql' && d.status !== 'disabled');
  if (!mysqlDs) throw new Error('真库里没有可用的 mysql 数据源');

  const doms = await req(token, '/metric-domains?keyword=交易演示');
  let domain = (doms.json.result.items || []).find((d) => d.code === 'dmtrade');
  if (!domain) {
    const created = await req(token, '/metric-domains', { method: 'POST', body: { name: '交易演示', code: 'dmtrade', remark: '指标中心演示/压测常驻域' } });
    domain = created.json.result;
  }

  const models = await req(token, '/metric-models?keyword=dm_order_src');
  let model = (models.json.result.items || []).find((m) => m.tableName === 'dm_order_src');
  if (!model) {
    const created = await req(token, '/metric-models', {
      method: 'POST',
      body: {
        name: '订单明细(DWD)',
        datasourceId: mysqlDs.id,
        domainId: domain.id,
        layer: 'DWD',
        tableName: 'dm_order_src',
        createType: 'reference',
        remark: 'seed-metric-demo 常驻演示模型',
      },
    });
    model = created.json.result;
  }
  const modelId = model.id;

  const mkMetric = async (body) => {
    const list = await req(token, `/metrics?keyword=${encodeURIComponent(body.code)}`);
    const existing = (list.json.result.items || []).find((m) => m.code === body.code);
    if (existing) return existing;
    const created = await req(token, '/metrics', { method: 'POST', body: { domainId: domain.id, status: 'online', ...body } });
    if (created.status !== 200) throw new Error(`创建指标 ${body.code} 失败: ${JSON.stringify(created.json)}`);
    return created.json.result;
  };
  const amt = await mkMetric({ code: 'dm_amt', name: '订单额', alias: ['成交额', 'GMV'], defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' }, unit: '元', caliber: '全部订单金额合计' });
  const cnt = await mkMetric({ code: 'dm_cnt', name: '订单数', alias: ['单量'], defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'id', agg: 'count', timeColumn: 'pay_date' }, unit: '单' });
  const paid = await mkMetric({ code: 'dm_paid', name: '实收额', alias: ['到手金额'], defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', filterSql: "t.status='PAID'", timeColumn: 'pay_date' }, unit: '元', caliber: '仅 PAID 订单金额' });
  const unit = await mkMetric({ code: 'dm_unit', name: '件单价', defineType: 'METRIC', expr: '${dm_amt} / ${dm_cnt}' });
  console.log('指标就绪：', [amt, cnt, paid, unit].map((m) => `${m.code}(${m.id})`).join(' '));

  console.log('\nseed-metric-demo 完成。问数示例：昨天的订单额 / 按地区看最近7天实收额 / 昨天的件单价');
  process.exit(0);
};

main().catch((e) => {
  console.error('seed-metric-demo crashed:', e.message);
  process.exit(1);
});
