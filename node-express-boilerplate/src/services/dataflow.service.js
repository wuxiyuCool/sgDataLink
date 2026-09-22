/**
 * 数据开发（ETL 编排画布）业务层（docs/API.md 第 1.8 节，对标 FDL 数据开发）。
 *
 * Mock 阶段画布 JSON（nodes / edges）只保存与回显，run 时取「首个 input 节点 + 最后 output 节点」
 * 拼一份 full 模式引擎快照交给 Go 引擎模拟执行 —— 也就是说中间的 filter/join/validate 节点
 * 不参与真实计算，但节点定义会被严格校验（类型枚举、config 结构、edges 引用完整性、至少一进一出）。
 *
 * 运行链路与同步任务同构，因此复用 services/run.service.js：
 * 实例的 taskId 位置放 dataflowId（契约 1.8：progress 结构键名仍是 taskId），
 * scheduleCron 定时触发与失败自动重试的行为与任务完全一致。
 */
const pick = require('../utils/pick');
const dataflowRepository = require('../repositories/dataflow.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const { paramInvalid, notFound, runningForbidden } = require('../utils/bizError');
const runService = require('./run.service');

/** 画布组件清单（契约 1.8 节点 type 枚举） */
const NODE_TYPES = ['input', 'output', 'filter', 'transform', 'join', 'union', 'sql', 'json_parse', 'validate'];

const { DEFAULT_SCHEDULE } = runService;

const getOrThrow = async (id) => {
  const dataflow = await dataflowRepository.getById(id);
  if (!dataflow) {
    throw notFound(`数据开发流程不存在: ${id}`);
  }
  return dataflow;
};

const assertNotRunning = (dataflow, action) => {
  if (dataflow.lastStatus === 'running') {
    throw runningForbidden(`流程正在运行中，禁止${action}: ${dataflow.id}`);
  }
};

const assertDataSourceExists = async (id, label) => {
  if (!id) throw paramInvalid(`${label} 必填`);
  if (!(await datasourceRepository.getById(id))) {
    throw paramInvalid(`${label} 对应的数据源不存在: ${id}`);
  }
};

/**
 * 画布深校验（service 层兜底，Joi 层在 validations/dataflow.validation.js 先拦一轮）：
 * 1) 节点 id 唯一、type 在枚举内、config 是对象；
 * 2) edges 两端必须指向已存在的节点 id；
 * 3) 至少一个 input 与一个 output（run 时取首尾拼引擎快照）。
 */
const assertCanvas = (nodes = [], edges = []) => {
  if (!Array.isArray(nodes) || !nodes.length) throw paramInvalid('nodes 至少需要一个节点');
  const ids = new Set();
  nodes.forEach((node, index) => {
    if (!node || !node.id) throw paramInvalid(`nodes[${index}].id 必填`);
    if (!NODE_TYPES.includes(node.type)) {
      throw paramInvalid(`nodes[${index}].type 只能是 ${NODE_TYPES.join('|')}`);
    }
    if (!node.config || typeof node.config !== 'object' || Array.isArray(node.config)) {
      throw paramInvalid(`nodes[${index}].config 必须是对象`);
    }
    if (ids.has(node.id)) throw paramInvalid(`nodes 存在重复 id: ${node.id}`);
    ids.add(node.id);
  });

  (edges || []).forEach((edge, index) => {
    if (!edge || !ids.has(edge.source) || !ids.has(edge.target)) {
      throw paramInvalid(`edges[${index}] 引用了不存在的节点 id`);
    }
  });

  const inputs = nodes.filter((node) => node.type === 'input');
  const outputs = nodes.filter((node) => node.type === 'output');
  if (!inputs.length) throw paramInvalid('画布至少需要一个 input 节点');
  if (!outputs.length) throw paramInvalid('画布至少需要一个 output 节点');
  return { inputs, outputs };
};

/** input / output 节点必须带数据源与表名，否则 run 时拼不出引擎快照 */
const assertEndpointConfig = async (nodes) => {
  // eslint-disable-next-line no-restricted-syntax
  for (const node of nodes) {
    if (node.type !== 'input' && node.type !== 'output') continue;
    const config = node.config || {};
    if (!config.datasourceId) throw paramInvalid(`${node.type} 节点 ${node.id} 缺少 config.datasourceId`);
    if (!config.table) throw paramInvalid(`${node.type} 节点 ${node.id} 缺少 config.table`);
    // eslint-disable-next-line no-await-in-loop
    await assertDataSourceExists(config.datasourceId, `${node.type} 节点 ${node.id} 的 config.datasourceId`);
  }
};

const normalizeBody = (body = {}) => {
  const payload = pick(body, [
    'name',
    'nodes',
    'edges',
    'scheduleCron',
    'retryCount',
    'retryIntervalSec',
    'enabled',
    'remark',
    'totalRows',
    'failureRate',
  ]);
  if (payload.scheduleCron === '') payload.scheduleCron = null;
  return payload;
};

/** 分页列表：keyword / lastStatus / enabled / sort */
const queryDataflows = (filter = {}, options = {}) =>
  dataflowRepository.page({
    filters: { lastStatus: filter.lastStatus, enabled: filter.enabled },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

const getDataflowById = (id) => getOrThrow(id);

const createDataflow = async (body) => {
  const payload = normalizeBody(body);
  if (!payload.name) throw paramInvalid('name 必填');
  const { nodes } = payload;
  const edges = payload.edges || [];
  assertCanvas(nodes, edges);
  await assertEndpointConfig(nodes);
  return dataflowRepository.create({
    ...DEFAULT_SCHEDULE,
    ...payload,
    edges,
    enabled: payload.enabled === undefined ? true : Boolean(payload.enabled),
    lastStatus: 'idle',
    lastRunAt: null,
  });
};

const updateDataflowById = async (id, body) => {
  const existing = await getOrThrow(id);
  assertNotRunning(existing, '编辑');
  const payload = normalizeBody(body);
  if ('name' in payload && !payload.name) throw paramInvalid('name 必填');
  const nodes = payload.nodes || existing.nodes;
  const edges = payload.edges === undefined ? existing.edges : payload.edges;
  if (payload.nodes || payload.edges) {
    assertCanvas(nodes, edges);
    await assertEndpointConfig(nodes);
    payload.nodes = nodes;
    payload.edges = edges;
  }
  if (payload.enabled !== undefined) payload.enabled = Boolean(payload.enabled);
  return dataflowRepository.update(id, payload);
};

const deleteDataflowById = async (id) => {
  const existing = await getOrThrow(id);
  assertNotRunning(existing, '删除');
  await dataflowRepository.delete(existing.id);
  return existing;
};

/** 取 run 用的首尾节点：首个 input（读库）与最后一个 output（写库） */
const resolveEndpoints = (dataflow) => {
  const nodes = dataflow.nodes || [];
  const { inputs, outputs } = assertCanvas(nodes, dataflow.edges || []);
  assertEndpointConfig(nodes);
  return { input: inputs[0], output: outputs[outputs.length - 1] };
};

/**
 * 引擎快照：画布 run 复用 full 模式（契约 1.8「run 时由引擎按 full 模式模拟执行」）。
 * taskId 位置放 dataflowId —— 引擎不区分二者，回报时按实例的 taskId 反查归属。
 */
const buildEngineSnapshot = async (dataflow, instanceId, totalRows) => {
  const { input, output } = resolveEndpoints(dataflow);
  const [source, target] = await Promise.all([
    runService.endpointOf(input.config.datasourceId),
    runService.endpointOf(output.config.datasourceId),
  ]);
  return runService.baseSnapshot(
    {
      ...dataflow,
      batchSize: Number(dataflow.batchSize) || 1000,
      incrementalColumn: null,
    },
    instanceId,
    {
      syncMode: 'full',
      totalRows,
      source,
      target,
      extra: {
        sourceTable: input.config.table,
        targetTable: output.config.table,
        writeMode: output.config.writeMode || 'insert',
      },
    }
  );
};

/** dataflow 这一种「可运行体」的注册（定时调度 / 失败重试与任务共用同一套实现） */
const runApi = runService.registerRunner({
  kind: 'dataflow',
  label: '数据开发流程',
  repository: dataflowRepository,
  resultIdKey: 'dataflowId',
  resolveSyncMode: () => 'full',
  buildSnapshot: buildEngineSnapshot,
});

/**
 * POST /dataflows/:id/run —— 模拟运行（返回体用 dataflowId 键名，契约 1.8）
 * @param {Object} [options] { trigger, retryAttempt }
 */
const runDataflow = (id, options = {}) => runApi.start(id, options);

/** POST /dataflows/:id/stop */
const stopDataflow = (id) => runApi.stop(id);

/** GET /dataflows/:id/progress —— 结构与 /tasks/:id/progress 一致（键名仍 taskId，值为 dataflowId） */
const getProgress = (id) => runApi.getProgress(id);

module.exports = {
  NODE_TYPES,
  queryDataflows,
  getDataflowById,
  getDataflowOrThrow: getOrThrow,
  createDataflow,
  updateDataflowById,
  deleteDataflowById,
  runDataflow,
  stopDataflow,
  getProgress,
  buildEngineSnapshot,
  resolveEndpoints,
  assertCanvas,
};
