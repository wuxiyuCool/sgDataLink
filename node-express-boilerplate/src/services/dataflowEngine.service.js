/**
 * 数据开发内存流水线执行引擎（契约 1.8.1）。
 *
 * 画布含 pivot/script/json 新节点时，run 不再下发引擎快照模拟，而是：
 * input 经 /sql/query 读表 → 逐节点在 Node 内存加工 → output 经 /sql/exec 批量写表。
 * 一期口径：单 input 单 output 线性链；limitRows 默认 5 万（超限报错不截断）；
 * 旧节点（filter/transform/join/union/sql/json_parse/validate）透传并告警，不阻断。
 * script 节点在 worker_threads 沙箱执行（见 dataflowScriptWorker.js），超时线程级强杀。
 */
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config/config');
const metricExec = require('./metricExec.service');
const datasourceRepository = require('../repositories/datasource.repository');
const { paramInvalid } = require('../utils/bizError');

/** 触发流水线模式的节点类型（出现任一即真实执行，契约 1.8.1） */
const PIPELINE_NODE_TYPES = ['pivot', 'script', 'json'];

/** 流水线中透传并告警的旧节点类型（尚未真实执行） */
const PASSTHROUGH_TYPES = ['filter', 'transform', 'join', 'union', 'sql', 'json_parse', 'validate'];

const DEFAULT_LIMIT_ROWS = 50000;
const MAX_LIMIT_ROWS = 100000;
const INSERT_BATCH_ROWS = 500;
const SCRIPT_DEFAULT_TIMEOUT_MS = 30000;
const SCRIPT_MAX_TIMEOUT_MS = 120000;
const PREVIEW_SAMPLE_ROWS = 50;

const TABLE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/;

const hasPipelineNodes = (nodes = []) =>
  Array.isArray(nodes) && nodes.some((node) => node && PIPELINE_NODE_TYPES.includes(node.type));

const assertTableName = (table, label) => {
  const text = String(table || '');
  if (!text.split('.').every((part) => TABLE_IDENT.test(part))) {
    throw paramInvalid(`${label} 表名非法: ${text.slice(0, 100)}`);
  }
  return text;
};

/* ---------------- 拓扑：一期只认单 input 单 output 的线性链 ---------------- */

const topoChain = (nodes, edges) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Map();
  (edges || []).forEach((edge) => {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target]);
    incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge.source]);
  });
  const inputs = nodes.filter((node) => node.type === 'input');
  const outputs = nodes.filter((node) => node.type === 'output');
  if (inputs.length !== 1) throw paramInvalid(`流水线一期仅支持单 input，当前 ${inputs.length} 个`);
  if (outputs.length !== 1) throw paramInvalid(`流水线一期仅支持单 output，当前 ${outputs.length} 个`);
  Array.from(outgoing.values()).forEach((list) => {
    if (list.length > 1) throw paramInvalid('流水线一期不支持分支（一个节点多条出边）');
  });
  const chain = [];
  const seen = new Set();
  let cursor = inputs[0].id;
  while (cursor) {
    if (seen.has(cursor)) throw paramInvalid('画布存在环路，无法确定执行顺序');
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) throw paramInvalid(`edges 引用了不存在的节点: ${cursor}`);
    chain.push(node);
    if (node.type === 'output') break;
    if (chain.length > nodes.length) throw paramInvalid('画布连线异常（疑似环路）');
    const indeg = (incoming.get(cursor) || []).length;
    if (cursor !== inputs[0].id && indeg !== 1) throw paramInvalid(`节点 ${node.name || cursor} 入度异常，流水线要求线性链`);
    cursor = (outgoing.get(cursor) || [])[0];
  }
  if (chain.length !== nodes.length) {
    const orphan = nodes.filter((node) => !seen.has(node.id)).map((node) => node.id);
    throw paramInvalid(`存在未连线的孤立节点: ${orphan.join(', ')}（请先连线或删除）`);
  }
  if (chain[chain.length - 1].type !== 'output') throw paramInvalid('output 节点必须位于链路末端');
  return chain;
};

/* ---------------- script 节点：worker 沙箱（超时线程级强杀） ---------------- */

const runScript = (node) =>
  new Promise((resolve, reject) => {
    const code = String(node.config.code || '');
    if (!code.trim()) {
      reject(paramInvalid(`script 节点 ${node.name || node.id} 缺少 config.code`));
      return;
    }
    const timeoutMs = Math.min(
      Math.max(Number(node.config.timeoutMs) || SCRIPT_DEFAULT_TIMEOUT_MS, 1000),
      SCRIPT_MAX_TIMEOUT_MS
    );
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'dataflowScriptWorker.js'), {
        workerData: { code, input: node.input || [], env: node.config.env || {} },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const logs = [];
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(arg);
    };
    const timer = setTimeout(
      () =>
        done(
          reject,
          paramInvalid(`script 节点 ${node.name || node.id} 执行超时（${timeoutMs}ms，上限 ${SCRIPT_MAX_TIMEOUT_MS}ms）`)
        ),
      timeoutMs
    );
    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'log') {
        logs.push(String(msg.text || '').slice(0, 2000));
        return;
      }
      if (msg.type === 'error') done(reject, paramInvalid(`script 节点 ${node.name || node.id} 执行失败: ${msg.message}`));
      else if (msg.type === 'result') done(resolve, { rows: msg.rows || [], logs });
    });
    worker.on('error', (err) => done(reject, paramInvalid(`script 节点 ${node.name || node.id} 崩溃: ${err.message}`)));
    worker.on('exit', (exitCode) => {
      if (exitCode !== 0) done(reject, paramInvalid(`script 节点 ${node.name || node.id} worker 异常退出(code=${exitCode})`));
    });
  });


/* ---------------- 行列变换（委托 dataflowTransform） ---------------- */

const transform = require('./dataflowTransform');

/* ---------------- input 读取 / output 写入 ---------------- */

/** 引擎 /sql/query 返回 {columns, rows(数组的数组)} → 对象行 */
const readInput = async (node, limitRows) => {
  const cfg = node.config || {};
  const table = assertTableName(cfg.table, `input 节点 ${node.name || node.id}`);
  if (!cfg.datasourceId) throw paramInvalid(`input 节点 ${node.name || node.id} 缺少 config.datasourceId`);
  const result = await metricExec.runSql(cfg.datasourceId, `SELECT * FROM ${table}`, {
    limit: limitRows + 1,
    timeoutSec: 120,
  });
  const columns = result.columns || [];
  const rawRows = result.rows || [];
  if (rawRows.length > limitRows) {
    throw paramInvalid(
      `input 节点 ${node.name || node.id} 数据量 ${rawRows.length}+ 行超过 limitRows=${limitRows}（流水线拒绝静默截断，请提高上限或加过滤）`
    );
  }
  return rawRows.map((values) => {
    const row = {};
    columns.forEach((col, index) => {
      row[String(col)] = values === null || values === undefined ? null : values[index];
    });
    return row;
  });
};

const sqlValue = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `'${text.replace(/\0/g, '').replace(/'/g, "''")}'`;
};

/** output 写表：overwrite 先 TRUNCATE；MySQL 多值批量 / Oracle 逐行（无多值 VALUES 语法） */
const writeOutput = async (node, rows) => {
  const cfg = node.config || {};
  const label = `output 节点 ${node.name || node.id}`;
  if (!cfg.datasourceId) throw paramInvalid(`${label} 缺少 config.datasourceId`);
  const table = assertTableName(cfg.table, label);
  const ds = await datasourceRepository.getById(cfg.datasourceId);
  if (!ds) throw paramInvalid(`${label} 数据源不存在: ${cfg.datasourceId}`);
  if (cfg.writeMode === 'upsert') throw paramInvalid(`${label} 流水线暂不支持 upsert 写入（用 overwrite 或 insert）`);
  if (!rows.length) return 0;
  const columns = Object.keys(rows[0]);
  if (!columns.length) throw paramInvalid(`${label} 上游数据无列，无法写入`);
  // 列名进 SQL 标识符位：白名单外字符直接拒绝（script 节点返回的键不可信）
  columns.forEach((c) => {
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(String(c))) throw paramInvalid(`${label} 上游列名含非法字符: ${String(c).slice(0, 40)}`);
  });
  const oracle = String(ds.type).toLowerCase() === 'oracle';
  const quoted = oracle ? columns.map((c) => c.toUpperCase()).join(', ') : columns.map((c) => '`' + c + '`').join(', ');
  const tableRef = oracle ? table.toUpperCase() : '`' + table + '`';
  const statements = [];
  if ((cfg.writeMode || 'insert') === 'overwrite') statements.push(oracle ? `TRUNCATE TABLE ${tableRef}` : `TRUNCATE TABLE ${tableRef}`);
  if (oracle) {
    rows.forEach((row) => {
      statements.push(`INSERT INTO ${tableRef} (${quoted}) VALUES (${columns.map((c) => sqlValue(row[c])).join(', ')})`);
    });
  } else {
    for (let start = 0; start < rows.length; start += INSERT_BATCH_ROWS) {
      const batch = rows.slice(start, start + INSERT_BATCH_ROWS);
      const tuples = batch.map((row) => `(${columns.map((c) => sqlValue(row[c])).join(', ')})`).join(', ');
      statements.push(`INSERT INTO ${tableRef} (${quoted}) VALUES ${tuples}`);
    }
  }
  await metricExec.runExec(ds, statements, { timeoutMs: Math.max(config.engine.sqlTimeoutMs, 600000) });
  return rows.length;
};

/* ---------------- 流水线执行入口 ---------------- */

const resolveLimitRows = (nodes) => {
  const input = nodes.find((node) => node.type === 'input') || {};
  const configured = Number((input.config || {}).limitRows);
  const limitRows = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LIMIT_ROWS;
  return Math.min(limitRows, MAX_LIMIT_ROWS);
};

/**
 * 执行画布流水线。
 * @param {Object} canvas { nodes, edges }
 * @param {Object} options { write=true 时真实写 output；onLog 回调收集 script console 输出 }
 * @returns {Promise<{stages, rowCount, sample, warnings, logs}>} stages 逐节点行数；sample 仅预览给前 50 行
 */
const executePipeline = async (canvas = {}, options = {}) => {
  const { write = true, onLog } = options;
  if (!config.db.isMysql()) throw paramInvalid('流水线执行需要 DB_DRIVER=mysql（内存模式不真实加工数据）');
  const nodes = canvas.nodes || [];
  const edges = canvas.edges || [];
  const chain = topoChain(nodes, edges);
  const limitRows = resolveLimitRows(nodes);
  const stages = [];
  const warnings = [];
  const logs = [];
  let rows = null;
  for (const node of chain) {
    const label = `${node.type} ${node.name || node.id}`;
    if (node.type === 'input') {
      rows = await readInput(node, limitRows);
    } else if (node.type === 'pivot') {
      rows = transform.pivotRows(node, rows || []);
    } else if (node.type === 'json') {
      rows = transform.jsonRows(node, rows || []);
    } else if (node.type === 'script') {
      const result = await runScript({ ...node, input: rows || [] });
      rows = result.rows;
      result.logs.forEach((line) => {
        logs.push(`[${label}] ${line}`);
        if (onLog) onLog(line);
      });
    } else if (node.type === 'output') {
      if (write) {
        const written = await writeOutput(node, rows || []);
        stages.push({ nodeId: node.id, name: node.name, type: node.type, rows: written });
        continue;
      }
      stages.push({ nodeId: node.id, name: node.name, type: node.type, rows: (rows || []).length, skippedWrite: true });
      continue;
    } else {
      warnings.push(`节点「${node.name || node.id}」(${node.type}) 尚未支持真实执行，流水线中透传不处理`);
    }
    stages.push({ nodeId: node.id, name: node.name, type: node.type, rows: (rows || []).length });
  }
  return {
    stages,
    rowCount: (rows || []).length,
    sample: write ? undefined : (rows || []).slice(0, PREVIEW_SAMPLE_ROWS),
    warnings,
    logs,
  };
};

/** POST /dataflows/preview：跑到 output 前截断，不落库不写表 */
const previewPipeline = (canvas) => executePipeline(canvas, { write: false });

const summarize = (result) =>
  `${result.stages.map((s) => `${s.name || s.nodeId}:${s.rows}${s.skippedWrite ? '(未写)' : ''}`).join(' → ')}${
    result.warnings.length ? `；告警 ${result.warnings.length} 条` : ''
  }`;

module.exports = {
  PIPELINE_NODE_TYPES,
  PASSTHROUGH_TYPES,
  DEFAULT_LIMIT_ROWS,
  SCRIPT_MAX_TIMEOUT_MS,
  hasPipelineNodes,
  topoChain,
  executePipeline,
  previewPipeline,
  summarize,
};
