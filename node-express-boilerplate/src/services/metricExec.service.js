/**
 * 指标执行服务（契约 1.12，M3）：把编译器产物经引擎 /sql/query 真实执行。
 * 联调口径 DB_DRIVER=mysql；memory 模式（假数据源）不发起真实执行，preview 只回 SQL。
 */
const config = require('../config/config');
const { datasourceExecFailed, paramInvalid } = require('../utils/bizError');
const dialect = require('../utils/dialect');
const engineClient = require('../utils/engineClient');
const datasourceRepository = require('../repositories/datasource.repository');
const metricCompilerService = require('./metricCompiler.service');

/** 数据源记录 -> 引擎 endpoint 快照（口令明文只在进程间传输，契约第 5 节） */
const endpointOf = (ds) => ({
  id: ds.id,
  type: ds.type,
  host: ds.host,
  port: ds.port,
  database: ds.database,
  username: ds.username,
  password: ds.password,
});

const runSql = async (datasourceId, sql, opts = {}) => {
  const ds = await datasourceRepository.getById(datasourceId);
  if (!ds || ds.status === 'disabled') throw paramInvalid(`数据源不存在或已禁用: ${datasourceId}`);
  if (!['mysql', 'oracle'].includes(ds.type)) {
    throw paramInvalid(`指标执行暂支持 mysql/oracle 数据源，当前: ${ds.type}`);
  }
  try {
    const data = await engineClient.sqlQuery(endpointOf(ds), sql, opts);
    return { ...data, datasourceId: ds.id, dialect: ds.type };
  } catch (err) {
    if (err.engineBizCode !== undefined) throw datasourceExecFailed(err.message);
    throw err; // 引擎不可达(50001)等保持原语义
  }
};

/**
 * 指标试跑：编译 + 真实执行。memory 驱动只回编译 SQL（executable:false），
 * 与「mysql 模式严禁 mock」一致——内存模式的假数据源不发真连接。
 */
const previewMetric = async (metricId, body = {}) => {
  const compiled = await metricCompilerService.compileMetric(metricId, body);
  if (config.db.driver !== 'mysql') {
    return { ...compiled, columns: null, rows: null, elapsedMs: null, executable: false };
  }
  const executed = await runSql(compiled.datasourceId, compiled.sql, { limit: body.limit || 1000 });
  return {
    ...compiled,
    executable: true,
    columns: executed.columns,
    rows: executed.rows,
    rowCount: executed.rowCount,
    elapsedMs: executed.elapsedMs,
  };
};

/** 模型数据预览：前 N 行真实数据（表名 M1 已按标识符白名单落库，这里再兜一次） */
const previewModel = async (model, { size = 20 } = {}) => {
  const table = String(model.tableName || '').replace(/[^A-Za-z0-9_.]/g, '');
  if (!table) throw paramInvalid('模型表名非法');
  const limit = Math.min(Math.max(parseInt(size, 10) || 20, 1), 1000);
  const dl = dialect.dialectOfSource(await datasourceRepository.getById(model.datasourceId));
  return runSql(model.datasourceId, dl.limit(`SELECT * FROM ${dl.table(table)}`, limit), { limit });
};

/** 白名单语句序列执行（M4 物化）：走 engine /sql/exec 同步模式 */
const runExec = async (ds, statements, opts = {}) => {
  if (ds.status === 'disabled') throw paramInvalid(`数据源已禁用: ${ds.id}`);
  if (!['mysql', 'oracle'].includes(ds.type)) throw paramInvalid(`执行暂支持 mysql/oracle，当前: ${ds.type}`);
  try {
    return await engineClient.sqlExec(endpointOf(ds), statements, opts);
  } catch (err) {
    if (err.engineBizCode !== undefined) throw datasourceExecFailed(err.message);
    throw err;
  }
};

module.exports = { endpointOf, runSql, runExec, previewMetric, previewModel };
