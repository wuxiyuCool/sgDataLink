/* 契约 1.12 指标中心 M0 底座用例：直连元库校验 12 张 metric 表结构与 9 个 ID 序列。
 * 跑法（cwd 必须在 node-express-boilerplate，依赖其 .env/config）：
 *   cd node-express-boilerplate && node ../deploy/tests/test-metric-base.js
 * HTTP 信封/401 用例待 M1 路由落地后追加。 */
process.env.DB_DRIVER = 'mysql'
const db = require('../../node-express-boilerplate/src/db/mysql')

const TABLES = {
  databridge_metric_domain: ['id', 'name', 'code', 'parent_id', 'table_prefix', 'del_flag'],
  databridge_metric_model: ['id', 'datasource_id', 'domain_id', 'layer', 'table_name', 'create_type', 'table_ddl', 'time_column', 'status', 'del_flag'],
  databridge_metric_model_column: ['model_id', 'column_name', 'biz_name', 'data_type', 'role', 'agg_default', 'is_key'],
  databridge_metric_metric: ['id', 'code', 'name', 'alias', 'type', 'define_type', 'model_id', 'domain_id', 'expr', 'define_params', 'data_format', 'caliber', 'status', 'version', 'del_flag'],
  databridge_metric_dep: ['parent_id', 'child_id'],
  databridge_metric_version: ['id', 'metric_id', 'version', 'snapshot', 'change_note'],
  databridge_metric_task: ['id', 'domain_id', 'source_model_id', 'metric_ids', 'dimension_column_ids', 'clean_rules', 'time_preset', 'target_datasource_id', 'target_table', 'write_mode', 'schedule_cron', 'last_status', 'del_flag'],
  databridge_metric_task_run: ['id', 'task_id', 'trigger', 'status', 'sql_text', 'read_rows', 'write_rows', 'elapsed_ms'],
  databridge_metric_term: ['id', 'name', 'alias', 'description', 'related_metric_ids', 'del_flag'],
  databridge_metric_example: ['id', 'question', 'm2sql', 'enabled'],
  databridge_metric_query_log: ['id', 'user_name', 'question', 'matched', 'metric_ids', 'm2sql', 'physical_sql', 'status', 'reviewed'],
  databridge_metric_setting: ['setting_key', 'setting_value', 'secret', 'updated_by'],
}

const SEQUENCES = ['dom-', 'mdl-', 'met-', 'mver-', 'mtk-', 'mtr-', 'mterm-', 'mex-', 'mlg-']

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`) }
}

const main = async () => {
  console.log('== 表存在性与字符集 ==')
  const rows = await db.query(
    "SELECT TABLE_NAME AS t, TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'databridge\\_metric%'"
  )
  const present = new Map(rows.map((r) => [String(r.t).toLowerCase(), String(r.c)]))
  check('12 张表齐全', present.size >= 12, `实际 ${present.size}`)
  Object.keys(TABLES).forEach((t) => check(`表存在 ${t}`, present.has(t.toLowerCase())))
  const badCollation = rows.filter((r) => !String(r.c).startsWith('utf8mb4'))
  check('全部 utf8mb4 排序规则', badCollation.length === 0, badCollation.map((r) => r.t).join(','))

  console.log('== 关键列 ==')
  const colRows = await db.query(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'databridge\\_metric%'"
  )
  const cols = new Map()
  colRows.forEach((r) => {
    const key = String(r.t).toLowerCase()
    if (!cols.has(key)) cols.set(key, [])
    cols.get(key).push(String(r.c).toLowerCase())
  })
  Object.entries(TABLES).forEach(([t, expected]) => {
    const actual = cols.get(t.toLowerCase()) || []
    const missing = expected.filter((c) => !actual.includes(c))
    check(`列完整 ${t}`, missing.length === 0, `缺 ${missing.join(',')}`)
  })

  console.log('== 索引红线 ==')
  const idx = await db.query(
    "SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('databridge_metric_metric','databridge_metric_domain','databridge_metric_dep','databridge_metric_setting') GROUP BY t, i, nu"
  )
  const hasUnique = (t, i) => idx.some((r) => String(r.t) === t && String(r.i) === i && Number(r.nu) === 0)
  check('metric.code 全库唯一', hasUnique('databridge_metric_metric', 'uk_metricmetric_code'))
  check('metric 依赖边 (parent,child) 唯一', hasUnique('databridge_metric_dep', 'uk_metricdep'))
  check('domain.code 唯一', hasUnique('databridge_metric_domain', 'uk_metricdomain_code'))
  check('setting_key 唯一', hasUnique('databridge_metric_setting', 'uk_metricsetting_key'))

  console.log('== ID 序列 ==')
  const seq = await db.query(
    "SELECT id_prefix AS p, next_val AS v FROM databridge_id_seq WHERE id_prefix IN ('dom-','mdl-','met-','mver-','mtk-','mtr-','mterm-','mex-','mlg-')"
  )
  const seqMap = new Map(seq.map((r) => [r.p, Number(r.v)]))
  SEQUENCES.forEach((p) => check(`序列存在 ${p}`, seqMap.has(p)))
  check('met- 序列起始 13000', seqMap.get('met-') >= 13000, `实际 ${seqMap.get('met-')}`)

  console.log(`\ntest-metric-base: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test-metric-base crashed:', e.message)
  process.exit(1)
})
