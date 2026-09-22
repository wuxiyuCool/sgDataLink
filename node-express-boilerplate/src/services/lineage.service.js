/**
 * 数据血缘图聚合（docs/API.md 第 1.10 节 GET /lineage/graph）。
 *
 * 没有独立血缘表：整张图由数据源 / 同步任务 / 数据管道 / 数据开发 / 数据服务
 * 五类定义实时推导（表节点用 `{datasourceId}:{table}` 作为稳定 id，便于去重与前端高亮）。
 * 仓储双驱动后这里是 5 类定义的并发读取 + 内存聚合（mysql 驱动下按 id 反查数据源名称）。
 *
 * 方向约定：数据源 → 表 → 运行体 → 目标表 →（下游）数据服务。
 */
const datasourceRepository = require('../repositories/datasource.repository');
const taskRepository = require('../repositories/task.repository');
const pipelineRepository = require('../repositories/pipeline.repository');
const dataflowRepository = require('../repositories/dataflow.repository');
const dataApiRepository = require('../repositories/dataapi.repository');

/** 表节点 id：同一个库里的同名表在全图唯一（契约示例 ds-1001:T_ORDER） */
const tableNodeId = (datasourceId, table) => `${datasourceId}:${table}`;

const createGraph = () => {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeKeys = new Set();

  const addNode = (id, type, name) => {
    if (!id || nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({ id, type, name: name || id });
  };

  const addEdge = (source, target) => {
    if (!source || !target || source === target) return;
    const key = `${source}->${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target });
  };

  /** 数据源 + 它下面的一张表（幂等，重复调用只补链不重复建点） */
  const addTable = async (datasourceId, table) => {
    if (!datasourceId || !table) return null;
    const datasource = await datasourceRepository.getById(datasourceId);
    addNode(datasourceId, 'datasource', datasource ? datasource.name : datasourceId);
    const id = tableNodeId(datasourceId, table);
    addNode(id, 'table', table);
    addEdge(datasourceId, id);
    return id;
  };

  return { nodes, edges, addNode, addEdge, addTable };
};

/** 'APP_USER.T_ORDER' -> 'T_ORDER'（管道 syncObjects 带 schema，表节点名只留表名） */
const bareTableName = (object) => {
  const text = String(object || '');
  const index = text.lastIndexOf('.');
  return index >= 0 ? text.slice(index + 1) : text;
};

/**
 * 生成全图 { nodes, edges }。
 * @returns {Promise<{ nodes: Array, edges: Array }>}
 */
const buildLineageGraph = async () => {
  const graph = createGraph();
  const { addNode, addEdge, addTable } = graph;

  const [datasources, tasks, pipelines, dataflows, dataApis] = await Promise.all([
    datasourceRepository.list(),
    taskRepository.find({}),
    pipelineRepository.find({}),
    dataflowRepository.find({}),
    dataApiRepository.find({}),
  ]);

  // 没有任何任务/管道引用也要露出数据源，方便前端画布展示「孤岛源」
  datasources.forEach((datasource) => addNode(datasource.id, 'datasource', datasource.name));

  // ---- 同步任务：源表 → 任务 → 目标表 ----
  // eslint-disable-next-line no-restricted-syntax
  for (const task of tasks) {
    // eslint-disable-next-line no-await-in-loop
    const source = await addTable(task.sourceId, task.sourceTable);
    addNode(task.id, 'task', task.name);
    // eslint-disable-next-line no-await-in-loop
    const target = await addTable(task.targetId, task.targetTable);
    if (source) addEdge(source, task.id);
    if (target) addEdge(task.id, target);
  }

  // ---- 数据管道：整库镜像的每个对象都是 源表 → 管道 → 同名目标表 ----
  // eslint-disable-next-line no-restricted-syntax
  for (const pipeline of pipelines) {
    addNode(pipeline.id, 'pipeline', pipeline.name);
    // eslint-disable-next-line no-restricted-syntax
    for (const object of pipeline.syncObjects || []) {
      const tableName = bareTableName(object);
      // eslint-disable-next-line no-await-in-loop
      const source = await addTable(pipeline.sourceId, object);
      // eslint-disable-next-line no-await-in-loop
      const target = await addTable(pipeline.targetId, tableName);
      if (source) addEdge(source, pipeline.id);
      if (target) addEdge(pipeline.id, target);
    }
  }

  // ---- 数据开发：按画布 nodes 里的 input / output 生成链（中间转换节点不进血缘） ----
  // eslint-disable-next-line no-restricted-syntax
  for (const dataflow of dataflows) {
    addNode(dataflow.id, 'dataflow', dataflow.name);
    const nodes = dataflow.nodes || [];
    // eslint-disable-next-line no-restricted-syntax
    for (const node of nodes) {
      const config = (node && node.config) || {};
      if (!config.datasourceId || !config.table) continue;
      // eslint-disable-next-line no-await-in-loop
      const table = await addTable(config.datasourceId, config.table);
      if (!table) continue;
      if (node.type === 'input') addEdge(table, dataflow.id);
      else if (node.type === 'output') addEdge(dataflow.id, table);
    }
  }

  // ---- 数据服务：读哪张表就挂在该表节点下游 ----
  // eslint-disable-next-line no-restricted-syntax
  for (const api of dataApis) {
    addNode(api.id, 'dataapi', api.name);
    // eslint-disable-next-line no-await-in-loop
    const table = await addTable(api.datasourceId, api.tableName);
    if (table) addEdge(table, api.id);
  }

  return { nodes: graph.nodes, edges: graph.edges };
};

module.exports = {
  tableNodeId,
  bareTableName,
  buildLineageGraph,
};
