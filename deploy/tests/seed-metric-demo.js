/* 指标中心常驻演示资产 seed（真库；压测/浏览器验收/问数演示共用）
 * 资产：域 dmtrade + 引用模型 dm_order_dwd（物理表 dm_order_src，刷近 45 天数据）
 *       指标 dm_amt 订单额 / dm_cnt 订单数 / dm_paid 实收额 / dm_unit 件单价(复合=amt/cnt)
 *       任务 dm_region_sum 按地区汇总(overwrite) / dm_region_daily 地区日汇总(upsert+定时)，并各执行一次留运行记录
 *       示例指标库 ex_*：15 条覆盖原子(MEASURE 四种聚合/FIELD 手写表达式/带 filterSql)、
 *         派生(继承基底+过滤、+时间预设)、复合(四则/比率/NULLIF 防除零/CASE 分档/跨方言函数)
 *         与 dataFormat 三种显示格式，caliber 字段即配置说明书，供界面抄作业
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
  // 层级演示：交易演示 → 支付域 → 渠道域（幂等，存在即复用）
  const mkDomain = async (code, name, parentId, remark) => {
    const list = await req(token, `/metric-domains?keyword=${encodeURIComponent(name)}`);
    const hit = (list.json.result.items || []).find((d) => d.code === code);
    if (hit) return hit;
    const created = await req(token, '/metric-domains', { method: 'POST', body: { name, code, parentId, remark } });
    return created.json.result;
  };
  const payDomain = await mkDomain('dm_pay', '支付域', domain.id, '层级演示：二级域');
  await mkDomain('dm_pay_channel', '渠道域', payDomain.id, '层级演示：三级域');

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
  await mkMetric({
    code: 'dm_paid_east',
    name: '华东实收额',
    alias: ['华东到手金额'],
    defineType: 'METRIC',
    defineParams: { baseMetricId: 'dm_paid', filterSql: "t.region='华东'", timeColumn: 'pay_date' },
    expr: '${dm_paid}',
    unit: '元',
    caliber: '派生示例：仅华东地区 PAID 订单金额（指标血缘页可见 华东实收额→实收额 依赖）',
  });
  console.log('指标就绪：', [amt, cnt, paid, unit].map((m) => `${m.code}(${m.id})`).join(' '), '+ dm_paid_east(派生)');

  // —— 示例指标库（ex_ 前缀）：覆盖全部定义方式与常见公式写法，供配置时抄作业 ——
  // 依赖顺序：原子 → 派生 → 复合（复合只能引用 online 指标）
  const exSpecs = [
    // 1-4 原子·度量聚合（MEASURE）：四种聚合方式各一例
    { code: 'ex_sum_amt', name: '示例·订单额合计', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', timeColumn: 'pay_date' }, unit: '元', dataFormat: 'THOUSANDTH', caliber: '【原子·度量聚合】最基础形态：模型+度量列+聚合(sum)。dataFormat=THOUSANDTH 让前端按千分位显示。' },
    { code: 'ex_cnt_orders', name: '示例·订单笔数', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'id', agg: 'count', timeColumn: 'pay_date' }, unit: '单', caliber: '【原子·度量聚合】计数用 count(主键列)；agg 可选 sum/count/avg/max/min/count_distinct。' },
    { code: 'ex_avg_ticket', name: '示例·平均单笔', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'avg', timeColumn: 'pay_date' }, unit: '元', dataFormat: 'DECIMAL', caliber: '【原子·度量聚合】avg 直接聚合度量列，不必写成复合除法；dataFormat=DECIMAL 显示两位小数。' },
    { code: 'ex_max_single', name: '示例·最大单笔', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'max', timeColumn: 'pay_date' }, unit: '元', caliber: '【原子·度量聚合】max/min 取极值，同样支持 filterSql。' },
    // 5 原子·字段表达式（FIELD）：手写聚合
    { code: 'ex_uv_region', name: '示例·覆盖区域数', defineType: 'FIELD', defineParams: { modelId, timeColumn: 'pay_date' }, expr: 'COUNT(DISTINCT t.region)', unit: '个', caliber: '【原子·字段表达式】手写聚合表达式（必须含聚合函数，否则 40001）；列名统一加 t. 前缀。' },
    // 6-7 原子 + 业务过滤（编译进 CASE WHEN）
    { code: 'ex_paid_amt', name: '示例·已支付金额', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'amt', agg: 'sum', filterSql: "t.status='PAID'", timeColumn: 'pay_date' }, unit: '元', dataFormat: 'THOUSANDTH', caliber: '【原子+业务过滤】filterSql 编译进聚合内 CASE WHEN（只影响本指标，不影响 WHERE 时间窗）。' },
    { code: 'ex_cancel_cnt', name: '示例·取消单数', defineType: 'MEASURE', defineParams: { modelId, measureColumn: 'id', agg: 'count', filterSql: "t.status='CANCEL'", timeColumn: 'pay_date' }, unit: '单', caliber: '【原子+业务过滤】同表不同过滤条件=不同口径指标，是派生/复合的基础构件。' },
    // 8-9 派生（DERIVED）：继承基底 + 过滤 / + 时间预设
    { code: 'ex_east_amt', name: '示例·华东订单额', defineType: 'METRIC', defineParams: { baseMetricId: 'ex_sum_amt', filterSql: "t.region='华东'", timeColumn: 'pay_date' }, expr: '${ex_sum_amt}', unit: '元', caliber: '【派生】defineType=METRIC 且 defineParams.baseMetricId 填基底 code 即自动判为 DERIVED；再叠加 filterSql 限定口径。' },
    { code: 'ex_recent7_paid', name: '示例·近7天实付额', defineType: 'METRIC', defineParams: { baseMetricId: 'ex_paid_amt', timePreset: { mode: 'RECENT', unit: 'DAY', period: 7 } }, expr: '${ex_paid_amt}', unit: '元', caliber: '【派生+时间预设】timePreset={mode:RECENT,unit:DAY,period:7} 固化默认窗口；mode 也可 BETWEEN 配 start/end。' },
    // 10-14 复合（COMPOSITE）：四则 / 防除零 / CASE / 百分比 / 跨方言函数
    { code: 'ex_paid_share', name: '示例·实收占比', defineType: 'METRIC', expr: '${ex_paid_amt} / ${ex_sum_amt}', dataFormat: 'PERCENT', caliber: '【复合·四则】${code} 引用其它在线指标；dataFormat=PERCENT 前端按百分比显示。' },
    { code: 'ex_unit_price', name: '示例·件单价(留2位)', defineType: 'METRIC', expr: 'ROUND(${ex_sum_amt} / NULLIF(${ex_cnt_orders}, 0), 2)', unit: '元', caliber: '【复合+标量函数】ROUND/NULLIF/ABS/FLOOR/CEIL/COALESCE 等白名单函数可用；NULLIF(x,0) 防除零。' },
    { code: 'ex_cancel_rate', name: '示例·取消率', defineType: 'METRIC', expr: '${ex_cancel_cnt} / NULLIF(${ex_cnt_orders}, 0)', dataFormat: 'PERCENT', caliber: '【复合·比率】两个原子相除得比率，配 PERCENT 显示；复合公式禁聚合、禁表名/子查询。' },
    { code: 'ex_big_flag', name: '示例·大额标记', defineType: 'METRIC', expr: 'CASE WHEN ${ex_sum_amt} > 10000 THEN 1 ELSE 0 END', caliber: '【复合·CASE WHEN】公式内支持 CASE WHEN 做分档/打标（仅引用指标，不引列名）。' },
    { code: 'ex_nvl_safe', name: '示例·NVL防NULL', defineType: 'METRIC', expr: 'NVL(${ex_sum_amt}, 0) / NULLIF(${ex_cnt_orders}, 0)', unit: '元', caliber: '【复合·跨方言函数】NVL(Oracle)/IFNULL(MySQL)/COALESCE(通用) 均在白名单内；语法探针对方言宽容互认，真正方言差异由编译器处理。' },
    { code: 'ex_greatest_amt', name: '示例·取较大金额', defineType: 'METRIC', expr: 'GREATEST(${ex_sum_amt}, ${ex_paid_amt})', unit: '元', caliber: '【复合·多指标比较】GREATEST/LEAST 对多个指标取极值；MOD/LENGTH/SUBSTR/CONCAT 等标量函数同样可用。' },
  ];
  const exCreated = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const spec of exSpecs) {
    // eslint-disable-next-line no-await-in-loop
    const m = await mkMetric(spec);
    exCreated.push(`${spec.code}(${m.type})`);
  }
  console.log('示例指标库就绪 15 条：', exCreated.join(' '));

  // —— 清洗汇总任务演示资产：两个任务各执行一次，任务页/运行记录弹窗有真数据 ——
  const detail = await req(token, `/metric-models/${modelId}`);
  const columns = (detail.json.result && detail.json.result.columns) || [];
  const dimRegion = columns.find((c) => c.columnName === 'region');
  if (!dimRegion || dimRegion.role !== 'dimension') {
    console.warn('region 列不是维度角色，跳过任务 seed（可在建模页字段管理中调整后重跑）');
  } else {
    const mkTask = async (body) => {
      const list = await req(token, `/metric-tasks?keyword=${encodeURIComponent(body.name)}`);
      const items = (list.json.result && list.json.result.items) || [];
      let task = items.find((t) => t.name === body.name);
      if (task) {
        const updated = await req(token, `/metric-tasks/${task.id}`, { method: 'PUT', body: { ...body, status: body.status } });
        task = (updated.json && updated.json.result) || task;
      } else {
        const created = await req(token, '/metric-tasks', { method: 'POST', body });
        if (created.status !== 200) throw new Error(`创建任务 ${body.name} 失败: ${JSON.stringify(created.json)}`);
        task = created.json.result;
      }
      const run = await req(token, `/metric-tasks/${task.id}/run`, { method: 'POST' });
      const runStatus = run.json && run.json.result ? run.json.result.status : '未知';
      console.log(`任务【${task.name}】(${task.id}) 已执行，状态 ${runStatus}`);
      return task;
    };
    await mkTask({
      name: '交易演示·地区总览（全量覆盖）',
      domainId: domain.id,
      sourceModelId: modelId,
      metricIds: [amt.id, cnt.id, paid.id],
      dimensionColumnIds: ['region'],
      writeMode: 'overwrite',
      targetTable: 'dm_region_sum',
      targetDatasourceId: mysqlDs.id,
      status: 'online',
      remark: 'seed 演示任务：全部订单按地区汇总订单额/订单数/实收额',
    });
    await mkTask({
      name: '交易演示·地区日汇总（upsert+定时）',
      domainId: domain.id,
      sourceModelId: modelId,
      metricIds: [amt.id, cnt.id],
      dimensionColumnIds: ['region', 'pay_date'],
      writeMode: 'upsert',
      upsertKeys: ['region', 'pay_date'],
      targetTable: 'dm_region_daily',
      targetDatasourceId: mysqlDs.id,
      scheduleCron: '0 30 2 * * ?',
      timePreset: { mode: 'BETWEEN', start: DAY(13), end: DAY(0) },
      cleanRules: [{ type: 'fill', column: 'region', value: '未知地区' }],
      status: 'online',
      remark: 'seed 演示任务：近 14 天固定区间（BETWEEN）按地区+日期 upsert，含补空清洗规则',
    });
  }

  console.log('\nseed-metric-demo 完成。问数示例：昨天的订单额 / 按地区看最近7天实收额 / 昨天的件单价');
  process.exit(0);
};

main().catch((e) => {
  console.error('seed-metric-demo crashed:', e.message);
  process.exit(1);
});
