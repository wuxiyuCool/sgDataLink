#!/usr/bin/env node
/**
 * 演示数据一次性清理脚本（docs/API.md 第 4.1 节）。
 *
 * 背景：`DB_DRIVER=mysql` 的早期版本会在 `databridge_datasource` 为空表时注入一份演示种子
 * （ds-1001..ds-1003 / task-2001.. / pipe-7001 / df-7501 / api-8001 / ar-9001，以及它们名下的
 * 实例、日志、点位、告警记录、调用明细）。现在 mysql 模式默认「空库起步」，历史库里残留的这批
 * 固定 ID 演示行需要清掉，且**只**清这批固定 ID 及其从属行 —— 用户自建数据一律不碰。
 *
 * 用法：
 *   node src/db/cleanup-demo.js                        # dry-run：只报将删行数，不写库
 *   yarn db:cleanup -- --yes                           # 真正执行
 *   yarn db:cleanup -- --yes --include-today           # 连「今天产生」的演示行一起删
 *   yarn db:cleanup -- --yes --force                   # 连被保留实体引用的演示数据源也删
 *
 * 安全设计：
 * 1. 只在 `DB_DRIVER=mysql` 下工作（memory 模式重启即回到干净状态，没有可清理的东西）；
 * 2. 从属行只按「外键 ID 指向演示实体」判定（task_id / pipeline_id / instance_id / api_id /
 *    rule_id / target_id），不按名称或时间范围模糊圈定，避免误删用户数据；
 * 3. 默认再加一层日期护栏：只删时间戳早于「今天 00:00（UTC）」的行，当天刚跑出来的先留着；
 *    要一并清除加 `--include-today`（父实体被删后这些从属行就是孤儿，故本次验收用了它）；
 * 4. 演示数据源若仍被「不在删除清单里的」用户实体引用（任务/管道/画布/数据服务），默认跳过删除
 *    并打印原因 —— 直接删会让用户的 DataAPI 查不到库；确认要删用 `--force`；
 * 5. 删除顺序自下而上：日志/点位 → 实例 → 告警记录/调用明细 → 配置实体 → 数据源。
 */
/* eslint-disable no-console */
const config = require('../config/config');
const db = require('./mysql');

/** 固定演示 ID 清单（与 src/repositories/seed.js 产出的 ID 一一对应） */
const DEMO_IDS = {
  datasource: ['ds-1001', 'ds-1002', 'ds-1003'],
  task: ['task-2001', 'task-2002'],
  pipeline: ['pipe-7001'],
  dataflow: ['df-7501'],
  dataApi: ['api-8001'],
  alertRule: ['ar-9001'],
};

/** dataflow 实例复用 task_id 列承载 dataflowId，所以「可运行体 ID」= 任务 + 画布 */
const DEMO_RUNNABLE_IDS = [...DEMO_IDS.task, ...DEMO_IDS.dataflow];
/** 告警记录的 target_id 可能是任务 / 画布 / 管道任一演示实体 */
const DEMO_ENTITY_IDS = [...DEMO_IDS.task, ...DEMO_IDS.dataflow, ...DEMO_IDS.pipeline];

/** 今天 00:00:00.000（UTC）—— 库内 DATETIME(3) 存的就是 UTC，可直接字符串比较 */
const todayUtcStart = () => `${new Date().toISOString().slice(0, 10)} 00:00:00.000`;

const printUsage = () => {
  console.log(`用法: node src/db/cleanup-demo.js [--yes] [--include-today] [--force]
  默认 dry-run（只报数不写库）
  --yes            真正执行删除
  --include-today  连今天产生的演示行一起删（默认只删时间戳早于今天 UTC 00:00 的）
  --force          连被保留实体引用着的演示数据源也删（默认跳过并打印原因）
  演示 ID 清单: ${JSON.stringify(DEMO_IDS)}`);
};

const parseArgs = (argv) => {
  const flags = argv.filter((item) => item.startsWith('--'));
  const known = ['--yes', '--include-today', '--force', '--help'];
  return {
    yes: flags.includes('--yes'),
    includeToday: flags.includes('--include-today'),
    force: flags.includes('--force'),
    help: flags.includes('--help'),
    unknown: flags.filter((flag) => !known.includes(flag)),
  };
};

/** `col IN (?, ?)` 片段；空清单给一个必定不命中的条件，避免拼出非法 SQL */
const inClause = (column, values) =>
  values.length
    ? { sql: `${column} IN (${values.map(() => '?').join(', ')})`, params: values.map(String) }
    : { sql: '1 = 0', params: [] };

/** 多个条件 OR 连接（丢掉空条件） */
const orWhere = (clauses) => {
  const usable = clauses.filter((clause) => clause.sql !== '1 = 0');
  if (!usable.length) return { sql: '1 = 0', params: [] };
  return {
    sql: usable.map((clause) => `(${clause.sql})`).join(' OR '),
    params: usable.reduce((acc, clause) => acc.concat(clause.params), []),
  };
};

/** 日期护栏：未开 includeToday 时给 WHERE 追加「时间戳 < 今天 00:00 UTC」 */
const withDateGuard = (where, column, includeToday) => {
  if (includeToday || where.sql === '1 = 0') return where;
  return { sql: `(${where.sql}) AND \`${column}\` < ?`, params: [...where.params, todayUtcStart()] };
};

/** JSON 列兼容：mysql2 已 parse 成对象，驱动行为变化时给字符串 */
const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (err) {
    return fallback;
  }
};

const placeholders = (values) => values.map(() => '?').join(', ');

/**
 * 演示数据源的引用保护：ds-1001 这类 ID 虽然在删除清单里，但用户可能已把它改成真实连接，
 * 并被自己建的实体引用（本次验收库里就是 api-8002 -> ds-1001）。删掉会让那个接口直接失效，
 * 所以默认跳过并打印，明确要删才用 --force。
 * @returns {Promise<Array<{id,name,referencedBy:Array<string>}>>} 需要保留的演示数据源
 */
const findReferencedDemoDatasources = async () => {
  const ids = DEMO_IDS.datasource;
  const references = new Map(ids.map((id) => [id, []]));
  const register = (dsId, label) => {
    if (references.has(dsId)) references.get(dsId).push(label);
  };

  const tasks = await db.query(
    `SELECT \`id\`, \`name\`, \`source_id\`, \`target_id\` FROM \`databridge_sync_task\`
      WHERE (\`source_id\` IN (${placeholders(ids)}) OR \`target_id\` IN (${placeholders(ids)}))
        AND \`id\` NOT IN (${placeholders(DEMO_RUNNABLE_IDS)})`,
    [...ids, ...ids, ...DEMO_RUNNABLE_IDS]
  );
  tasks.forEach((row) => {
    [row.source_id, row.target_id].forEach((dsId) => register(dsId, `同步任务 ${row.id}(${row.name})`));
  });

  const pipelines = await db.query(
    `SELECT \`id\`, \`name\`, \`source_id\`, \`target_id\` FROM \`databridge_pipeline\`
      WHERE (\`source_id\` IN (${placeholders(ids)}) OR \`target_id\` IN (${placeholders(ids)}))
        AND \`id\` NOT IN (${placeholders(DEMO_IDS.pipeline)})`,
    [...ids, ...ids, ...DEMO_IDS.pipeline]
  );
  pipelines.forEach((row) => {
    [row.source_id, row.target_id].forEach((dsId) => register(dsId, `数据管道 ${row.id}(${row.name})`));
  });

  const apis = await db.query(
    `SELECT \`id\`, \`name\`, \`datasource_id\` FROM \`databridge_data_api\`
      WHERE \`datasource_id\` IN (${placeholders(ids)}) AND \`id\` NOT IN (${placeholders(DEMO_IDS.dataApi)})`,
    [...ids, ...DEMO_IDS.dataApi]
  );
  apis.forEach((row) => register(row.datasource_id, `数据服务 ${row.id}(${row.name})`));

  // 画布的数据源藏在 nodes JSON 里（SQL 侧不做 JSON 匹配，取回非演示画布在 JS 里看）
  const dataflows = await db.query(
    `SELECT \`id\`, \`name\`, \`nodes\` FROM \`databridge_dataflow\` WHERE \`id\` NOT IN (${placeholders(
      DEMO_IDS.dataflow
    )})`,
    DEMO_IDS.dataflow
  );
  dataflows.forEach((row) => {
    const nodes = parseJson(row.nodes, []);
    (Array.isArray(nodes) ? nodes : []).forEach((node) => {
      register(((node || {}).config || {}).datasourceId, `数据开发 ${row.id}(${row.name})`);
    });
  });

  const kept = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const id of ids) {
    const referencedBy = references.get(id) || [];
    if (!referencedBy.length) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.query('SELECT `id`, `name` FROM `databridge_datasource` WHERE `id` = ?', [id]);
    kept.push({ id, name: (rows[0] || {}).name || '(已不存在)', referencedBy: [...new Set(referencedBy)] });
  }
  return kept;
};

/**
 * 逐表删除条件，顺序即执行顺序（先子表后配置实体）。
 * @param {Array<string>} demoInstanceIds 演示实体名下的实例 id（删实例前反查得到）
 * @param {Object} options 命令行选项
 * @param {Array<{id:string}>} keptDatasources 被引用保护下来的演示数据源
 */
const buildDeletionPlan = (demoInstanceIds, options, keptDatasources) => {
  const keepIds = keptDatasources.map((item) => item.id);
  const datasourceIds = DEMO_IDS.datasource.filter((id) => !keepIds.includes(id));
  const guard = (where, column) => withDateGuard(where, column, options.includeToday);

  return [
    {
      table: 'databridge_run_log',
      where: guard(
        orWhere([inClause('`task_id`', DEMO_RUNNABLE_IDS), inClause('`instance_id`', demoInstanceIds)]),
        'created_at'
      ),
      note: '演示任务/画布/管道实例的运行日志（含 task_id 为空、只挂 instance_id 的 cdc 日志）',
    },
    {
      table: 'databridge_offset',
      where: guard(
        orWhere([inClause('`task_id`', DEMO_RUNNABLE_IDS), inClause('`instance_id`', demoInstanceIds)]),
        'updated_at'
      ),
      note: '演示实体的同步点位',
    },
    {
      table: 'databridge_task_instance',
      where: guard(
        orWhere([inClause('`task_id`', DEMO_RUNNABLE_IDS), inClause('`pipeline_id`', DEMO_IDS.pipeline)]),
        'started_at'
      ),
      note: '演示任务 / 画布 / 管道名下的运行实例',
    },
    {
      table: 'databridge_alert_record',
      where: guard(
        orWhere([inClause('`target_id`', DEMO_ENTITY_IDS), inClause('`rule_id`', DEMO_IDS.alertRule)]),
        'created_at'
      ),
      note: '演示实体的告警记录 + 演示规则 ar-9001 名下记录',
    },
    {
      table: 'databridge_data_api_call',
      where: guard(inClause('`api_id`', DEMO_IDS.dataApi), 'created_at'),
      note: '演示服务 api-8001 的调用明细（api_id 为 NULL 的未知路径记录不动）',
    },
    {
      table: 'databridge_data_api_call_day',
      where: guard(inClause('`api_id`', DEMO_IDS.dataApi), 'date'),
      note: '演示服务 api-8001 的按天调用计数',
    },
    { table: 'databridge_pipeline', where: inClause('`id`', DEMO_IDS.pipeline), note: '演示管道 pipe-7001' },
    { table: 'databridge_dataflow', where: inClause('`id`', DEMO_IDS.dataflow), note: '演示画布 df-7501' },
    { table: 'databridge_sync_task', where: inClause('`id`', DEMO_IDS.task), note: '演示任务 task-2001 / task-2002' },
    { table: 'databridge_data_api', where: inClause('`id`', DEMO_IDS.dataApi), note: '演示数据服务 api-8001' },
    { table: 'databridge_alert_rule', where: inClause('`id`', DEMO_IDS.alertRule), note: '演示告警规则 ar-9001' },
    {
      table: 'databridge_datasource',
      where: inClause('`id`', datasourceIds),
      note: `演示数据源 ds-1001 / ds-1002 / ds-1003${
        keepIds.length ? `（保留 ${keepIds.join(' / ')}：被用户实体引用）` : ''
      }`,
    },
  ].filter((item) => item.where.sql !== '1 = 0');
};

/** 清理后把「留下了什么」打印出来，便于对照保留清单 */
const printRemaining = async () => {
  const [datasources, tasks, pipelines, dataflows, apis, rules, instances, logs] = await Promise.all([
    db.query('SELECT `id`, `name`, `type` FROM `databridge_datasource` ORDER BY `seq`'),
    db.query('SELECT `id`, `name` FROM `databridge_sync_task` ORDER BY `seq`'),
    db.query('SELECT `id`, `name` FROM `databridge_pipeline` ORDER BY `seq`'),
    db.query('SELECT `id`, `name` FROM `databridge_dataflow` ORDER BY `seq`'),
    db.query('SELECT `id`, `name` FROM `databridge_data_api` ORDER BY `seq`'),
    db.query('SELECT `id`, `name` FROM `databridge_alert_rule` ORDER BY `seq`'),
    db.query('SELECT COUNT(*) AS total FROM `databridge_task_instance`'),
    db.query('SELECT COUNT(*) AS total FROM `databridge_run_log`'),
  ]);
  const brief = (rows) => rows.map((row) => `${row.id}(${row.name})`).join(', ') || '无';
  console.log(`  数据源    ${datasources.length}: ${brief(datasources)}`);
  console.log(`  同步任务  ${tasks.length}: ${brief(tasks)}`);
  console.log(`  管道      ${pipelines.length}: ${brief(pipelines)}`);
  console.log(`  画布      ${dataflows.length}: ${brief(dataflows)}`);
  console.log(`  数据服务  ${apis.length}: ${brief(apis)}`);
  console.log(`  告警规则  ${rules.length}: ${brief(rules)}`);
  console.log(`  实例存量  ${instances[0].total} 条 / 日志存量 ${logs[0].total} 条`);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (options.unknown.length) {
    console.error(`未知参数: ${options.unknown.join(' ')}`);
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!config.db.isMysql()) {
    console.error(
      `本脚本只在 DB_DRIVER=mysql 下工作（当前=${config.db.driver}）。memory 模式重启即回到干净状态，无需清理。`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`目标库: ${config.db.mysql.user}@${config.db.mysql.host}:${config.db.mysql.port}/${config.db.mysql.database}`);
  console.log(
    `执行方式: ${options.yes ? '删除（--yes）' : 'dry-run（不加 --yes 不写库）'} | 日期护栏: ${
      options.includeToday ? '关闭（--include-today）' : `${todayUtcStart()} 之前`
    } | 引用保护: ${options.force ? '关闭（--force）' : '开启'}`
  );
  console.log('');

  // 演示实体名下的实例：必须在删实例之前算出来（日志 / 点位靠 instance_id 归属）
  const instanceWhere = orWhere([inClause('`task_id`', DEMO_RUNNABLE_IDS), inClause('`pipeline_id`', DEMO_IDS.pipeline)]);
  const demoInstances = await db.query(
    `SELECT \`id\` FROM \`databridge_task_instance\` WHERE ${instanceWhere.sql}`,
    instanceWhere.params
  );
  const demoInstanceIds = demoInstances.map((row) => row.id);
  console.log(`反查到演示实体名下实例 ${demoInstanceIds.length} 个: ${demoInstanceIds.join(', ') || '无'}`);

  const keptDatasources = options.force ? [] : await findReferencedDemoDatasources();
  keptDatasources.forEach((item) => {
    console.log(`[保留] ${item.id} ${item.name} 仍被用户实体引用: ${item.referencedBy.join('、')}（要删请加 --force）`);
  });

  const plan = buildDeletionPlan(demoInstanceIds, options, keptDatasources);
  let plannedTotal = 0;
  let deletedTotal = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const item of plan) {
    /* eslint-disable no-await-in-loop */
    const countRows = await db.query(
      `SELECT COUNT(*) AS total FROM \`${item.table}\` WHERE ${item.where.sql}`,
      item.where.params
    );
    const planned = Number(countRows[0] ? countRows[0].total : 0);
    plannedTotal += planned;
    const line = `${item.table.padEnd(28)} ${String(planned).padStart(5)} 行  ${item.note}`;
    if (!options.yes) {
      console.log(`[dry-run] ${line}`);
      // eslint-disable-next-line no-continue
      continue;
    }
    let deleted = 0;
    if (planned) {
      const result = await db.run(`DELETE FROM \`${item.table}\` WHERE ${item.where.sql}`, item.where.params);
      deleted = Number(result.affectedRows || 0);
      deletedTotal += deleted;
    }
    console.log(`[已删除] ${item.table.padEnd(27)} ${String(deleted).padStart(5)} 行  ${item.note}`);
  }

  console.log('');
  if (!options.yes) {
    console.log(`dry-run 结束：合计将删除 ${plannedTotal} 行，未写入任何变更。核对无误后加 --yes 执行。`);
    return;
  }
  console.log(`清理完成：合计删除 ${deletedTotal} 行。留存清单：`);
  await printRemaining();
};

main()
  .catch((err) => {
    console.error('清理失败:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.closeMysqlPool().catch(() => {});
  });
