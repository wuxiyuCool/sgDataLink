/**
 * 数据源业务层（docs/API.md 第 1.1 节）。
 *
 * 只依赖 repository，不碰 express；password 在响应里永远脱敏为 "***"，
 * 仓储里保留明文（连通测试与真实建连都要用）。
 * 仓储层已双驱动化（memory / mysql），所以本文件所有仓储调用一律 await，
 * 对外函数统一 async（controller 侧本来就是 catchAsync + await，无需改动）。
 */
const datasourceRepository = require('../repositories/datasource.repository');
const taskRepository = require('../repositories/task.repository');
// 引用关系扩展到新增的三类配置（1.7 / 1.8 / 1.9），删除保护统一走 40002
const pipelineRepository = require('../repositories/pipeline.repository');
const dataflowRepository = require('../repositories/dataflow.repository');
const dataApiRepository = require('../repositories/dataapi.repository');
const config = require('../config/config');
const netProbe = require('../db/netProbe');
const mysql = require('../db/mysql');
const { paramInvalid, notFound, datasourceReferenced } = require('../utils/bizError');

/** 契约：响应中 password 永远脱敏 */
const MASKED_PASSWORD = '***';

/** 各类型的默认端口（仅在请求未提供时使用） */
const DEFAULT_PORTS = { oracle: 1521, mysql: 3306, postgresql: 5432 };

/** mock 连通测试规则：host 以 10. 开头，或名称含 fail，判定为失败 */
const UNREACHABLE_HOST_PREFIX = '10.';
const FAIL_NAME_KEYWORD = 'fail';

const isMaskedPassword = (value) => !value || /^\*+$/.test(String(value));

/** 出参脱敏 */
const toSafe = (dataSource) => (dataSource ? { ...dataSource, password: MASKED_PASSWORD } : dataSource);

const getDataSourceOrThrow = async (id) => {
  const dataSource = await datasourceRepository.getById(id);
  if (!dataSource) {
    throw notFound(`数据源不存在: ${id}`);
  }
  return dataSource;
};

/** 分页列表：keyword / type / status / sort */
const queryDataSources = async (filter = {}, options = {}) => {
  const result = await datasourceRepository.page({
    filters: { type: filter.type, status: filter.status },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });
  return { ...result, items: result.items.map(toSafe) };
};

/** 详情（脱敏） */
const getDataSourceById = async (id) => toSafe(await getDataSourceOrThrow(id));

/** 全量列表（不分页），供任务表单的数据源下拉使用 */
const getAllDataSources = async () => (await datasourceRepository.find({})).map(toSafe);

const createDataSource = async (body) => {
  if (!body || !body.name) {
    throw paramInvalid('name 必填');
  }
  const payload = {
    ...body,
    port: body.port || DEFAULT_PORTS[body.type] || 0,
    status: body.status || 'enabled',
    password: body.password === undefined ? '' : String(body.password),
    remark: body.remark || '',
  };
  delete payload.id;
  delete payload.createdAt;
  delete payload.updatedAt;
  return toSafe(await datasourceRepository.create(payload));
};

const updateDataSourceById = async (id, body = {}) => {
  const existing = await getDataSourceOrThrow(id);
  const patch = { ...body };
  delete patch.id;
  delete patch.createdAt;
  delete patch.updatedAt;
  // 前端回填的是脱敏值，此时保持库里明文密码不变
  if (isMaskedPassword(patch.password)) {
    delete patch.password;
  }
  if (patch.port !== undefined && patch.port !== null && patch.port !== '') {
    patch.port = Number(patch.port);
  } else if ('port' in patch) {
    delete patch.port;
  }
  const updated = await datasourceRepository.update(id, { ...existing, ...patch });
  return toSafe(updated);
};

/** 删除：被任务 / 管道 / 数据开发 / 数据服务任一引用时 40002 */
const deleteDataSourceById = async (id) => {
  const existing = await getDataSourceOrThrow(id);
  const [tasks, pipelines, dataflows, dataApis] = await Promise.all([
    taskRepository.findByDataSource(existing.id),
    pipelineRepository.findByDataSource(existing.id),
    dataflowRepository.findByDataSource(existing.id),
    dataApiRepository.findByDataSource(existing.id),
  ]);
  const referenced = tasks
    .map((task) => `同步任务 ${task.id}(${task.name})`)
    .concat(pipelines.map((item) => `数据管道 ${item.id}(${item.name})`))
    .concat(dataflows.map((item) => `数据开发 ${item.id}(${item.name})`))
    .concat(dataApis.map((item) => `数据服务 ${item.id}(${item.name})`));
  if (referenced.length) {
    throw datasourceReferenced(`数据源被其它配置引用，无法删除: ${referenced.join('、')}`);
  }
  await datasourceRepository.delete(existing.id);
  return existing;
};

const randomLatency = (min, max) => Math.floor(min + Math.random() * (max - min));

/** mock 连通测试实现（DB_DRIVER=memory 时所有类型都走这里；mysql 模式下非 mysql 类型也走这里） */
const mockConnect = (connConfig) => {
  const host = String(connConfig.host || '');
  const name = String(connConfig.name || '');
  const target = `${connConfig.type || 'unknown'}://${host}:${connConfig.port || 0}/${connConfig.database || ''}`;
  if (host.startsWith(UNREACHABLE_HOST_PREFIX)) {
    return {
      success: false,
      latencyMs: randomLatency(3000, 3200),
      message: `mock 连接失败: connect timed out ${target}（host 属 ${UNREACHABLE_HOST_PREFIX}x 模拟内网段）`,
    };
  }
  if (name.toLowerCase().includes(FAIL_NAME_KEYWORD)) {
    return {
      success: false,
      latencyMs: randomLatency(50, 400),
      message: `mock 连接失败: connection refused ${target}（数据源名称含 ${FAIL_NAME_KEYWORD}）`,
    };
  }
  return {
    success: true,
    latencyMs: randomLatency(20, 200),
    message: `mock 连接成功: ${target}`,
  };
};

/**
 * 连通测试分发：
 * - DB_DRIVER=mysql（真实模式）：mysql 类型 → mysql2 真实建连握手；oracle / postgresql → 真实 TCP 探测
 *   （账号校验待二阶段接驱动）。不再使用 mock 规则，真实内网库可正常配置。
 * - DB_DRIVER=memory（演示模式）：所有类型走 mock 规则（10. 网段 / fail 名必定失败），仅供前端演示。
 */
const connect = async (connConfig) => {
  if (config.db.driver === 'mysql') {
    if (connConfig.type === 'mysql') {
      return mysql.probeMysqlConnection(connConfig);
    }
    return netProbe.probeTcp({ host: connConfig.host, port: connConfig.port, timeoutMs: 5000 });
  }
  return mockConnect(connConfig);
};

/**
 * POST /datasources/test —— 传入未保存的配置做连通测试。
 * 若携带了已存在的 id 且 password 为脱敏值，则用库里的明文补齐。
 */
const testConnection = async (body = {}) => {
  const connConfig = { ...body };
  if (connConfig.id) {
    const stored = await datasourceRepository.getById(connConfig.id);
    if (stored) {
      connConfig.name = connConfig.name || stored.name;
      connConfig.type = connConfig.type || stored.type;
      connConfig.host = connConfig.host || stored.host;
      connConfig.port = connConfig.port || stored.port;
      connConfig.database = connConfig.database || stored.database;
      connConfig.username = connConfig.username || stored.username;
      if (isMaskedPassword(connConfig.password)) connConfig.password = stored.password;
    }
  }
  if (!connConfig.name) throw paramInvalid('name 必填');
  if (!connConfig.type) throw paramInvalid('type 必填');
  if (!connConfig.host) throw paramInvalid('host 必填');
  return connect(connConfig);
};

/** POST /datasources/:id/test —— 用已保存配置做连通测试 */
const testConnectionById = async (id) => {
  const stored = await getDataSourceOrThrow(id);
  return connect(stored);
};

module.exports = {
  MASKED_PASSWORD,
  queryDataSources,
  getAllDataSources,
  getDataSourceById,
  getDataSourceOrThrow,
  createDataSource,
  updateDataSourceById,
  deleteDataSourceById,
  testConnection,
  testConnectionById,
};
