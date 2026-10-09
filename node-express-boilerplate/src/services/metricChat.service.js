/**
 * ChatBI 问数编排（契约 1.12 §7.4，需求 5）。链路：
 *   召回(Mapping) → LLM 生成 M2SQL(Parsing) → 两步解析+一次纠错(Correcting)
 *   → 复用编译/物化计划(Translating) → engine /sql/query 执行 → 回答 + metricTree 回填
 * 一期边界：单模型问题；跨模型指标组合返回 clarify 提示拆分；LIKE/指标值过滤不承接。
 */
const { Parser } = require('node-sql-parser');
const { fixMojibake } = require('../utils/mojibake');
const config = require('../config/config');
const logger = require('../config/logger');
const { paramInvalid } = require('../utils/bizError');
const metricKnowledge = require('./metricKnowledge.service');
const llmClient = require('./llmClient.service');
const metricExampleRepository = require('../repositories/metricexample.repository');
const metricQueryLogRepository = require('../repositories/metricquerylog.repository');
const metricCompilerService = require('./metricCompiler.service');
const metricTaskService = require('./metrictask.service');
const metricService = require('./metric.service');
const metricExecService = require('./metricExec.service');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricTermRepository = require('../repositories/metricterm.repository');

const TOKEN_RE = /@(MET|COL|DATE|DOM|MDL)\(([^)]+)\)@/g;
const TOKEN_ONE = /@(MET|COL|DATE|DOM|MDL)\(([^)]+)\)@/;

/** token 文本（如 MET(0)）→ 真实 kind/ref；无注册表时按字面 ref 兜底 */
const resolveToken = (m, refs) => {
  const key = `${m[1]}(${m[2]})`;
  if (refs && refs.has(key)) {
    const hit = refs.get(key);
    return { kind: hit.kind, ref: hit.ref };
  }
  return { kind: m[1], ref: m[2] };
};

const esc = (value) => `'${String(value).replace(/'/g, "''")}'`;

const systemPrompt = () => `你是企业指标平台的问数助手，把用户问题翻译成一条 M2SQL（指标语义 SQL）。
规则：
1) 只能使用「可用指标/维度/域」清单里的名字作为列名和表名，中文原样书写并用反引号包裹；
2) 时间条件必须显式写出，时间列固定用「数据日期」；相对时间基于「当前日期」换算为 BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'；
3) 禁止聚合函数、子查询、JOIN、表别名；禁止发明清单外的名字；
4) 无法确定用户指的是哪个指标时，只输出一行：CLARIFY:候选指标名1、候选指标名2
5) 只输出 SQL 本身或 CLARIFY 行，不要解释。`;

const userPrompt = ({ question, schema, examples, today }) => `### 当前日期
${today}
### 可用指标
${schema.metrics || '(无)'}
### 可用维度
${[schema.columns, '- 数据日期(时间列)'].filter(Boolean).join('\n')}
### 可用域
${schema.domains || '(无)'}
${schema.terms ? `### 业务术语\n${schema.terms}\n` : ''}${
  examples.length ? `### 示例\n${examples.map((e) => `Q: ${e.question}\nA: ${e.m2sql}`).join('\n')}\n` : ''
}### 问题
${question}`;

const extractSql = (content) => {
  const text = String(content || '')
    .replace(/```sql/gi, '```')
    .split('```')
    .filter((seg) => seg.trim())
    .join('\n')
    .trim();
  if (/^CLARIFY[:：]/i.test(text)) return { clarify: text.replace(/^CLARIFY[:：]\s*/i, '') };
  const match = text.match(/(SELECT[\s\S]*)/i);
  if (!match) return { error: '未找到 SQL 语句' };
  return { sql: match[1].trim().replace(/;+$/, '') };
};

/**
 * 第一步：业务名 → 规范占位 token（最长优先；先替换反引号包裹名，再兜底裸名）。
 * token 只携带注册表序号（@COL(3)@），真名 ref 存进 refs —— 避免 token 文本
 * 内嵌原始列名（如 region）被后续裸名替换二次污染。
 */
const toTokens = (sqlText, index) => {
  let text = String(sqlText || '');
  const refs = new Map();
  const register = (kind, ref) => {
    const key = `${kind}(${refs.size})`;
    refs.set(key, { kind, ref });
    return `\`@${key}@\``;
  };
  const entries = [...index].sort((a, b) => b.labelLen - a.labelLen);
  entries.forEach((entry) => {
    if (entry.labelLen < 2) return;
    let token = null;
    if (entry.kind === 'metric') token = register('MET', entry.id);
    else if (entry.kind === 'column') token = register('COL', `${entry.modelId}.${entry.columnName}`);
    else if (entry.kind === 'date') token = register('DATE', `${entry.modelId}.${entry.columnName}`);
    else if (entry.kind === 'domain') token = register('DOM', entry.id);
    else if (entry.kind === 'model') token = register('MDL', entry.id);
    if (!token) return;
    text = text.split(`\`${entry.rawLabel}\``).join(token);
    // 裸名兜底（LLM 忘加反引号时）
    if (text.includes(entry.rawLabel)) text = text.split(entry.rawLabel).join(token);
  });
  return { text, refs };
};

const flattenConditions = (expr, out = []) => {
  if (!expr) return out;
  if (expr.type === 'binary_expr' && String(expr.operator).toUpperCase() === 'AND') {
    flattenConditions(expr.left, out);
    flattenConditions(expr.right, out);
    return out;
  }
  out.push(expr);
  return out;
};

/** column_ref 节点 → 列名文本（数组点分合并，其余转字符串） */
const colNameOf = (node) => {
  if (!node || node.column === undefined || node.column === null) return '';
  return Array.isArray(node.column) ? node.column.join('.') : String(node.column);
};

const colToken = (node, refs) => {
  if (!node || node.type !== 'column_ref') return null;
  const m = colNameOf(node).replace(/^`|`$/g, '').match(TOKEN_ONE);
  return m ? resolveToken(m, refs) : null;
};

const literalOf = (node) => {
  if (!node) return null;
  if (node.type === 'single_quote_string' || node.type === 'string') return node.value;
  if (node.type === 'number') return node.value;
  if (node.type === 'null') return null;
  return undefined;
};

/** 第二步：token 化文本交给 node-sql-parser，抽取指标/维度/时间/过滤（refs 来自 toTokens） */
const parseM2Sql = (tokenSql, refs) => {
  const ast = new Parser().astify(tokenSql, 'mysql');
  const tree = Array.isArray(ast) ? ast[0] : ast;
  if (!tree || tree.type !== 'select') throw new Error('不是合法的 SELECT 语句');
  const metrics = [];
  const dims = [];
  const unknown = [];
  (tree.columns || []).forEach((col) => {
    const expr = col.expr || col;
    const raw = expr && expr.type === 'column_ref' ? colNameOf(expr) : '';
    const m = raw.match(TOKEN_ONE);
    if (!m) {
      if (raw && raw !== '*') unknown.push(raw);
      return;
    }
    const hit = resolveToken(m, refs);
    if (hit.kind === 'MET') metrics.push(hit.ref);
    else if (hit.kind === 'COL' || hit.kind === 'DATE') dims.push({ kind: hit.kind, ref: hit.ref });
  });
  const from = (tree.from || []).map((f) => {
    const name = String(f.table || '');
    const m = name.match(/@(DOM|MDL)\(([^)]+)\)@/);
    return m ? { kind: m[1], id: m[2] } : { raw: name };
  });
  const dateRange = { start: null, end: null };
  const filters = [];
  const unsupported = [];
  flattenConditions(tree.where).forEach((cond) => {
    if (!cond || cond.type !== 'binary_expr') {
      unsupported.push('非条件表达式');
      return;
    }
    const op = String(cond.operator).toUpperCase();
    const left = colToken(cond.left, refs);
    const { right } = cond;
    if (!left) {
      // 左侧不是列引用：字面量条件（如 1=1）直接忽略；真实名字则报未知字段
      const rawName = cond.left && cond.left.column ? String(cond.left.column) : '';
      const isLiteral = cond.left && ['number', 'string', 'single_quote_string', 'null'].includes(cond.left.type);
      if (rawName && !isLiteral) unsupported.push(`未知过滤字段 ${rawName}`);
      return;
    }
    if (left.kind === 'DATE') {
      if (op === 'BETWEEN' && right.type === 'expr_list' && Array.isArray(right.value)) {
        dateRange.start = literalOf(right.value[0]);
        dateRange.end = literalOf(right.value[1]);
      } else if (op === 'NOT' || String(cond.operator).toUpperCase().startsWith('NOT')) {
        unsupported.push('不支持 NOT 条件');
      } else if (['>=', '>', '<=', '<', '='].includes(op)) {
        const v = literalOf(right);
        // '=' 是单日闭区间；严格比较向外推一天（BETWEEN 语义按天粒度）
        if (op === '=') {
          dateRange.start = v;
          dateRange.end = v;
        } else if (op === '>=' || op === '>') dateRange.start = v;
        else dateRange.end = v;
      } else unsupported.push(`时间列不支持 ${op}`);
      return;
    }
    if (left.kind === 'MET') {
      unsupported.push('一期不支持按指标值过滤（HAVING 语义）');
      return;
    }
    // COL 过滤
    const colRef = left.ref;
    if (op === '=' || op === '!=') {
      filters.push({ ref: colRef, sql: `t.${colRef.split('.')[1]} ${op} ${esc(literalOf(right))}` });
    } else if (op === 'IN' && right.type === 'expr_list') {
      const values = right.value.map((v) => esc(literalOf(v))).join(', ');
      filters.push({ ref: colRef, sql: `t.${colRef.split('.')[1]} IN (${values})` });
    } else if (['>=', '>', '<=', '<'].includes(op)) {
      filters.push({ ref: colRef, sql: `t.${colRef.split('.')[1]} ${op} ${esc(literalOf(right))}` });
    } else unsupported.push(`维度过滤不支持 ${op}`);
  });
  return { metrics, dims, from, dateRange, filters, unknown, unsupported };
};

const hasDate = (range) => Boolean(range && (range.start || range.end));

/**
 * 问数落地的物理 SQL：别名引用、日期字面量、行数限制、源表大小写一律问方言层。
 * 这里曾硬编码 MySQL 方言（反引号 + 裸日期 + LIMIT），Oracle 数据源上必然 ORA-00933/ORA-01861。
 */
const assembleSelect = (plan, limit, dl) => {
  const selectItems = [
    ...plan.dims.map((d) => `${dl.normalize(d.sql)} AS ${dl.ident(d.target)}`),
    ...plan.metrics.map((m) => `${dl.normalize(m.sql)} AS ${dl.ident(m.target)}`),
  ];
  const whereParts = [...plan.filters.map((f) => `(${dl.normalize(f)})`)];
  const timePart = dl.timeFilter(plan.timeColumn, plan.dateRange);
  if (timePart) whereParts.push(timePart);
  const groupBy = plan.dims.length ? ` GROUP BY ${plan.dims.map((d) => dl.normalize(d.sql)).join(', ')}` : '';
  const body = `SELECT ${selectItems.join(', ')} FROM ${dl.sourceTable(plan.fromTable)} t${
    whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''
  }${groupBy}`;
  return dl.limit(body, limit);
};

const writeLog = async (entry) => {
  try {
    await metricQueryLogRepository.create(entry);
  } catch (err) {
    logger.warn('metric query log write failed: %s', err.message);
  }
};

/** 多轮上下文（契约 1.12：内存态，重启即失），每会话滚动保留最近 10 轮 */
const sessions = new Map();
const SESSION_MAX_TURNS = 10;

const pushTurn = (sessionId, turn) => {
  if (!sessionId) return;
  const list = sessions.get(sessionId) || [];
  list.push(turn);
  if (list.length > SESSION_MAX_TURNS) list.splice(0, list.length - SESSION_MAX_TURNS);
  sessions.set(sessionId, list);
};

const getSessionHistory = async (sessionId) => sessions.get(String(sessionId)) || [];

const clearSession = async (sessionId) => sessions.delete(String(sessionId)) || true;

/**
 * 问数入口。
 * @returns {status, answer, value?|columns/rows, m2sql, physicalSql, metricTree, candidates?, warnings}
 */
const ask = async ({ question, sessionId, dateRange: forcedRange, source }, user = {}) => {
  const startedAt = Date.now();
  const q = fixMojibake(question).trim();
  if (!q) throw paramInvalid('question 必填');
  if (config.db.driver !== 'mysql') throw paramInvalid('智能问数需要 DB_DRIVER=mysql 真实执行');
  const today = new Date().toISOString().slice(0, 10);
  // 问数以当前元数据为准：库小重建成本低（且曾有多轮问答被 30s 旧索引误导的联调现场）
  const freshIndex = await metricKnowledge.buildIndex({ force: true });
  const recallResult = await metricKnowledge.recallWith(freshIndex, q);
  const schema = metricKnowledge.buildSchemaSection(recallResult);
  const examples = (await metricExampleRepository.find({ filters: { enabled: true } })).slice(0, 5);

  const history = sessionId ? sessions.get(sessionId) || [] : [];
  const contextMessages = [];
  history.slice(-2).forEach((turn) => {
    contextMessages.push({ role: 'user', content: turn.question });
    if (turn.m2sql) contextMessages.push({ role: 'assistant', content: turn.m2sql });
  });
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...contextMessages,
    { role: 'user', content: userPrompt({ question: q, schema, examples, today }) },
  ];

  const finish = async (payload) => {
    pushTurn(sessionId, { question: q, m2sql: payload.m2sql || null, status: payload.status });
    await writeLog({
      userName: user.userName || user.username || '',
      question: q.slice(0, 1000),
      matched: {
        metrics: recallResult.metrics.map((m) => m.name),
        columns: recallResult.columns.map((c) => c.name),
        source: source || 'jwt',
      },
      metricIds: (payload.metricIds || []).join(','),
      m2sql: payload.m2sql || null,
      physicalSql: payload.physicalSql || null,
      status: payload.status,
      error: payload.error || null,
      elapsedMs: Date.now() - startedAt,
      resultPreview: payload.preview || null,
    });
    return payload;
  };

  let content = '';
  let parsed = null;
  let status = 'success';
  try {
    const first = await llmClient.chatCompletion(messages);
    content = first.content;
    let extracted = extractSql(content);
    if (extracted.clarify) {
      const candidates = (recallResult.metrics || []).map((m) => ({ id: m.id, name: m.name, code: m.code }));
      return finish({
        status: 'clarify',
        answer: `请明确指标：${extracted.clarify}`,
        candidates,
        m2sql: content,
        metricIds: [],
      });
    }
    if (extracted.error) throw new Error(extracted.error);
    try {
      const tokenized = toTokens(extracted.sql, freshIndex);
      parsed = parseM2Sql(tokenized.text, tokenized.refs);
    } catch (err) {
      // 纠错重试一次：带上失败原因让 LLM 修正
      status = 'corrected';
      const retryMessages = messages.concat([
        { role: 'assistant', content },
        { role: 'user', content: `上面的 M2SQL 有问题：${err.message}。请按规则修正后只输出修正的 SQL。` },
      ]);
      const second = await llmClient.chatCompletion(retryMessages);
      content = second.content;
      extracted = extractSql(content);
      if (extracted.clarify) {
        const candidates = (recallResult.metrics || []).map((m) => ({ id: m.id, name: m.name, code: m.code }));
        return finish({
          status: 'clarify',
          answer: `请明确指标：${extracted.clarify}`,
          candidates,
          m2sql: content,
          metricIds: [],
        });
      }
      const tokenized = toTokens(extracted.sql, freshIndex);
      parsed = parseM2Sql(tokenized.text, tokenized.refs);
    }
  } catch (err) {
    return finish({
      status: 'failed',
      error: String(err.message || err).slice(0, 500),
      answer: '未能生成有效查询',
      m2sql: content,
      metricIds: [],
    });
  }

  const warnings = [...(parsed.unsupported || []), ...(parsed.unknown || []).map((n) => `忽略未知列 ${n}`)];
  if (!parsed.metrics.length) {
    const candidates = (recallResult.metrics || []).slice(0, 8).map((m) => ({ id: m.id, name: m.name, code: m.code }));
    return finish({
      status: 'clarify',
      answer: '未能确定要查询的指标，请补充或选择',
      candidates,
      m2sql: content,
      metricIds: [],
    });
  }

  // 全部指标折叠到同一模型（一期单模型问题）
  const metricIds = [...new Set(parsed.metrics)];
  const compiled = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const id of metricIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      compiled.push({ id, ...(await metricCompilerService.compileMetricExpr(id)) });
    } catch (err) {
      return finish({
        status: 'failed',
        error: `指标 ${id} 编译失败: ${err.message}`,
        answer: '指标编译失败',
        m2sql: content,
        metricIds,
      });
    }
  }
  const modelIds = new Set(compiled.map((c) => c.modelId));
  if (modelIds.size > 1) {
    return finish({
      status: 'clarify',
      answer: '问题涉及多个模型的指标，一期请拆分提问（同模型指标可合并查询）',
      m2sql: content,
      metricIds,
      warnings,
    });
  }
  const { modelId } = compiled[0];
  const model = await metricModelRepository.getById(modelId);

  // 需求 5：主指标的 metricTree 先取出，树内同模型子指标并入同一次查询回填 value
  let tree = null;
  try {
    tree = await metricService.getTree(compiled[0].id);
    const treeIds = [];
    const walk = (node) => {
      treeIds.push(String(node.id));
      (node.children || []).forEach(walk);
    };
    walk(tree);
    const extraIds = treeIds.filter((id) => !compiled.some((c) => String(c.id) === id));
    // eslint-disable-next-line no-restricted-syntax
    for (const id of extraIds) {
      // eslint-disable-next-line no-await-in-loop
      const expr = await metricCompilerService.compileMetricExpr(id).catch(() => null);
      if (expr && String(expr.modelId) === String(modelId)) compiled.push({ id, ...expr });
    }
  } catch (err) {
    tree = null;
    warnings.push(`metricTree 构建失败: ${err.message}`);
  }

  const dims = parsed.dims
    .filter((d) => d.kind === 'COL' && String(d.ref).startsWith(`${modelId}.`))
    .map((d) => d.ref.split('.')[1]);
  const filters = parsed.filters.filter((f) => f.ref && String(f.ref).startsWith(`${modelId}.`)).map((f) => f.sql);
  if (parsed.filters.some((f) => f.ref && !String(f.ref).startsWith(`${modelId}.`))) {
    warnings.push('部分过滤条件不属于本模型，已忽略');
  }

  const dateRange = forcedRange || (hasDate(parsed.dateRange) ? parsed.dateRange : null);
  const planTask = {
    sourceModelId: modelId,
    metricIds: compiled.map((c) => c.id),
    dimensionColumnIds: dims,
    cleanRules: filters.map((sql) => ({ type: 'filter', sql })),
    timePreset: dateRange ? { mode: 'BETWEEN', start: dateRange.start || '1970-01-01', end: dateRange.end || today } : null,
    targetDatasourceId: compiled[0].datasourceId,
  };
  let plan = null;
  try {
    plan = await metricTaskService.buildPlan(planTask, new Date());
  } catch (err) {
    return finish({
      status: 'failed',
      error: `计划生成失败: ${err.message}`,
      answer: '查询计划生成失败',
      m2sql: content,
      metricIds,
      warnings,
    });
  }
  const dl = await metricCompilerService.dialectOfDatasource(plan.datasourceId);
  const sql = assembleSelect(plan, 1000, dl);

  const executed = await metricExecService.runSql(plan.datasourceId, sql, { limit: 1000 });
  const columns = executed.columns || [];
  const rows = executed.rows || [];
  const single = dims.length === 0 && rows.length === 1 ? rows[0] : null;

  // 标量场景：把查询结果按指标 id 回填整棵树（含子指标）
  if (tree && single) {
    const values = {};
    compiled.forEach((c, i) => {
      values[String(c.id)] = single[plan.dims.length + i];
    });
    /* eslint-disable no-param-reassign */
    const fill = (node) => {
      const v = values[String(node.id)];
      if (v !== undefined) node.value = v;
      (node.children || []).forEach(fill);
    };
    /* eslint-enable no-param-reassign */
    fill(tree);
  }

  let answer = '查询无数据';
  if (single) answer = `${compiled[0].code} = ${String(single[0])}${compiled[0].unit ? ` ${compiled[0].unit}` : ''}`;
  else if (rows.length) answer = `共 ${rows.length} 行`;
  return finish({
    status,
    answer,
    value: single ? single[0] : undefined,
    columns,
    rows,
    m2sql: content,
    physicalSql: sql,
    metricIds,
    metricTree: tree,
    warnings,
    preview: JSON.stringify(rows.slice(0, 3)).slice(0, 900),
    modelName: model.name,
  });
};

/* ===== 术语 / 示例 / 问数日志管理（契约 1.12 §7.4 附属 CRUD） ===== */

const listTerms = async (query = {}) => metricTermRepository.page(query);

const saveTerm = async (body) => {
  if (!String(body.name || '').trim()) throw paramInvalid('name 必填');
  return metricTermRepository.create({
    name: String(body.name).trim(),
    alias: body.alias || [],
    description: body.description || '',
    relatedMetricIds: body.relatedMetricIds || [],
    relatedModelIds: body.relatedModelIds || [],
  });
};

const updateTerm = async (id, patch) => {
  const existing = await metricTermRepository.getById(id);
  if (!existing) throw paramInvalid('术语不存在');
  return metricTermRepository.update(id, patch);
};

const deleteTerm = async (id) => {
  const existing = await metricTermRepository.getById(id);
  if (!existing) throw paramInvalid('术语不存在');
  return metricTermRepository.delete(id);
};

const listExamples = async (query = {}) => metricExampleRepository.page(query);

const saveExample = async (body) => {
  if (!String(body.question || '').trim()) throw paramInvalid('question 必填');
  if (!String(body.m2sql || '').trim()) throw paramInvalid('m2sql 必填');
  return metricExampleRepository.create({
    question: String(body.question).trim(),
    m2sql: String(body.m2sql).trim(),
    enabled: body.enabled !== false,
    note: body.note || '',
  });
};

const updateExample = async (id, patch) => {
  const existing = await metricExampleRepository.getById(id);
  if (!existing) throw paramInvalid('示例不存在');
  return metricExampleRepository.update(id, patch);
};

const deleteExample = async (id) => {
  const existing = await metricExampleRepository.getById(id);
  if (!existing) throw paramInvalid('示例不存在');
  return metricExampleRepository.delete(id);
};

const listQueryLogs = async (query = {}) =>
  metricQueryLogRepository.page({ ...query, status: query.status || query.result });

/** 审计转示例（admin）：把一条成功问数日志固化为 few-shot 示例 */
const logToExample = async (id) => {
  const log = await metricQueryLogRepository.getById(id);
  if (!log) throw paramInvalid('问数日志不存在');
  if (!log.m2sql) throw paramInvalid('该日志没有可复用的 M2SQL，无法转示例');
  const example = await metricExampleRepository.create({
    question: log.question,
    m2sql: log.m2sql,
    enabled: true,
    note: `来自问数日志 ${log.id}`,
  });
  await metricQueryLogRepository.update(id, { reviewed: true });
  return example;
};

module.exports = {
  ask,
  getSessionHistory,
  clearSession,
  extractSql,
  toTokens,
  parseM2Sql,
  assembleSelect,
  TOKEN_RE,
  listTerms,
  saveTerm,
  updateTerm,
  deleteTerm,
  listExamples,
  saveExample,
  updateExample,
  deleteExample,
  listQueryLogs,
  logToExample,
};
