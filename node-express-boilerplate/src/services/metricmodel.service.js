/**
 * 数据模型服务（契约 1.12）：引用表 / 界面建表两种创建、字段维护、DDL 预览。
 * 元数据拉取复用 db/dataQuery（真实建连，联调口径=DB_DRIVER=mysql 直连内网库）。
 */
const crypto = require('crypto');
const config = require('../config/config');
const { paramInvalid, notFound, metricTableConflict, metricReferenced } = require('../utils/bizError');
const dialect = require('../utils/dialect');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricRepository = require('../repositories/metric.repository');
const metricTaskRepository = require('../repositories/metrictask.repository');
// 只引仓储不引 metricdim.service：后者依赖本服务的 getModel，互相 require 会成环
const metricDimValueRepository = require('../repositories/metricdimvalue.repository');
const metricDomainRepository = require('../repositories/metricdomain.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const metricExecService = require('./metricExec.service');
const dataQuery = require('../db/dataQuery');

const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LAYERS = ['ODS', 'DIM', 'DWD', 'DWS', 'ADS'];
const ROLES = ['dimension', 'measure', 'time'];
const AGGS = ['sum', 'count', 'max', 'min', 'avg', 'count_distinct'];
/** 契约 1.13：draft 草稿（ddl 模型初始态，不可建表/被引用）| online 启用 | offline 停用 */
const STATUSES = ['draft', 'online', 'offline'];

const active = (items) => items.filter((item) => !item.delFlag);

/** buildDdl 对 Oracle 会输出 CREATE + 多条 COMMENT ON，执行前按分号换行拆回语句数组 */
const splitDdlStatements = (ddl) =>
  String(ddl || '')
    .split(/;\s*\n\s*/)
    .map((statement) => statement.replace(/;+$/, '').trim())
    .filter((statement) => statement.length > 10);

/** 列角色自动识别（借 qData 规则：日期→time，含 id/非数值→dimension，其余数值→measure） */
const guessColumn = (raw) => {
  const name = String(raw.name || '');
  const type = String(raw.type || '').toUpperCase();
  const isNumeric = /^(TINYINT|SMALLINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|NUMBER)/.test(type);
  const isDate = /^(DATE|DATETIME|TIMESTAMP|TIME)/.test(type);
  const lower = name.toLowerCase();
  let role = 'dimension';
  let aggDefault = '';
  if (isDate) role = 'time';
  else if (isNumeric && !/(_id$|^id$|_no$|_code$)/.test(lower)) {
    role = 'measure';
    aggDefault = /(_cnt$|_num$|count|数量|次数)/.test(lower) ? 'count' : 'sum';
  }
  return {
    columnName: name,
    bizName: raw.comment ? String(raw.comment) : '',
    dataType: type,
    role,
    aggDefault,
    isKey: Boolean(raw.key),
    unit: '',
    remark: '',
  };
};

const assertColumns = (columns, dialectType = 'mysql') => {
  if (!Array.isArray(columns)) return columns;
  const seen = new Set();
  return columns.map((column, index) => {
    if (!column || !IDENT_PATTERN.test(String(column.columnName || ''))) {
      throw paramInvalid(`columns[${index}].columnName 非法（标识符白名单）`);
    }
    if (seen.has(column.columnName.toLowerCase())) throw paramInvalid(`列重复: ${column.columnName}`);
    seen.add(column.columnName.toLowerCase());
    if (!ROLES.includes(column.role)) throw paramInvalid(`columns[${index}].role ∈ ${ROLES.join('|')}`);
    if (column.aggDefault && !AGGS.includes(column.aggDefault)) {
      throw paramInvalid(`columns[${index}].aggDefault ∈ ${AGGS.join('|')}`);
    }
    // 类型归一：手打 varchar / NUMBER(24,6) / timestamp(6) 一律收成规范串（VARCHAR(64) 等），
    // 否则 DDL 里会出现 MySQL/Oracle 都不接受的无长度类型名；不在目录内的写法兜底成字符串列
    return { ...column, dataType: dialect.composeColumnType(column.dataType, dialectType) };
  });
};

/** 字段类型目录（界面下拉的唯一来源，按方言给出真实类型名与长度上限） */
const columnTypes = () => ({
  mysql: dialect.columnFamilyCatalog('mysql'),
  oracle: dialect.columnFamilyCatalog('oracle'),
});

const getDomainOrFail = async (domainId) => {
  const domain = await metricDomainRepository.getById(domainId);
  if (!domain || domain.delFlag) throw paramInvalid(`指标域不存在: ${domainId}`);
  return domain;
};

const getDatasourceOrFail = async (datasourceId) => {
  const ds = await datasourceRepository.getById(datasourceId);
  if (!ds || ds.status === 'disabled') throw paramInvalid(`数据源不存在或已禁用: ${datasourceId}`);
  return ds;
};

/** 同数据源下表名不得重复登记（未删除的模型间比较），冲突 40904 */
const assertTableFree = async ({ datasourceId, tableName, excludeId }) => {
  const models = active(await metricModelRepository.list());
  const hit = models.find(
    (model) =>
      model.datasourceId === datasourceId &&
      String(model.tableName).toLowerCase() === String(tableName).toLowerCase() &&
      model.id !== excludeId
  );
  if (hit) throw metricTableConflict(`数据源 ${datasourceId} 下表 ${tableName} 已被模型「${hit.name}(${hit.id})」登记`);
};

/**
 * 界面建表（createType=ddl）的 DDL 文本，按目标数据源方言生成（方言层 §6.4）。
 * 只用于留档与前端回显，不自动执行；Oracle 没有内联 COMMENT，注释拆成 COMMENT ON 语句。
 * @param {Object} [source] 数据源对象或类型字符串，缺省按 mysql
 */
const buildDdl = (domain, layer, tableName, columns, source) => {
  const dl = dialect.dialectOfSource(source || 'mysql');
  const esc = (text) => String(text).replace(/'/g, "''");
  const lines = columns.map((column) => {
    const comment = column.bizName || column.remark ? String(column.bizName || column.remark) : '';
    const inline = dl.type === 'mysql' && comment ? ` COMMENT '${esc(comment)}'` : '';
    return `  ${dl.ident(column.columnName)} ${dl.columnType(column.dataType)} NOT NULL${inline}`;
  });
  const keys = columns.filter((column) => column.isKey).map((column) => dl.ident(column.columnName));
  if (keys.length) lines.push(`  PRIMARY KEY (${keys.join(', ')})`);
  const tableComment = `${layer} | domain=${domain.code}`;
  if (dl.type === 'mysql') {
    return `${dl.createTable({ table: tableName, defs: lines })} COMMENT '${esc(tableComment)}'`;
  }
  const comments = [
    `COMMENT ON TABLE ${dl.table(tableName)} IS '${esc(tableComment)}'`,
    ...columns
      .filter((column) => column.bizName || column.remark)
      .map(
        (column) =>
          `COMMENT ON COLUMN ${dl.table(tableName)}.${dl.ident(column.columnName)} IS '${esc(
            String(column.bizName || column.remark)
          )}'`
      ),
  ];
  return `${dl.createTable({ table: tableName, defs: lines })};\n${comments.join(';\n')}`;
};

/** 组合物理表名：{域前缀}_{layer小写}_{name 清洗}；中文名清洗为空时用名称哈希兜底（确定性、可重复） */
const composeTableName = (domain, layer, name) => {
  const prefix = (domain.tablePrefix || domain.code).toLowerCase();
  const raw = String(name || '');
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const body = cleaned || crypto.createHash('md5').update(raw).digest('hex').slice(0, 8);
  if (!body) throw paramInvalid('表名主体需包含字母/数字');
  const tableName = `${prefix}_${layer.toLowerCase()}_${body}`;
  if (!IDENT_PATTERN.test(tableName)) throw paramInvalid(`组合表名非法: ${tableName}`);
  return tableName;
};

/**
 * 读取归一：`table_status` 是 1.13 补的可空列，补列前建的模型为 NULL。
 * 引用表本就存在于源库 → exists；界面建表未走过生成表 → none。
 */
const normalizeTableStatus = (model) => {
  if (!model) return model;
  return {
    ...model,
    tableStatus: model.tableStatus || (model.createType === 'ddl' ? 'none' : 'exists'),
    tableMsg: model.tableMsg || '',
  };
};

const queryModels = async (filter = {}, options = {}) => {
  const page = await metricModelRepository.page({
    filters: { ...filter, delFlag: false },
    keyword: options.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });
  return { ...page, items: (page.items || []).map(normalizeTableStatus) };
};

const getModel = async (id) => {
  const model = await metricModelRepository.getById(id);
  if (!model || model.delFlag) throw notFound(`模型不存在: ${id}`);
  return normalizeTableStatus(model);
};

/**
 * POST /metric-models
 * createType=reference：可传 columns 手工给；缺省时对 mysql/oracle 数据源真实拉列 + 角色识别。
 * createType=ddl：必须带 columns；只登记 + 生成 DDL 留档，物理建表由指标任务/引擎接口执行（M3/M4）。
 */
const createModel = async (data, operator = '') => {
  const name = String(data.name || '').trim();
  if (!name) throw paramInvalid('name 必填');
  const createType = data.createType || 'reference';
  if (!['reference', 'ddl'].includes(createType)) throw paramInvalid('createType ∈ reference|ddl');
  if (!LAYERS.includes(data.layer)) throw paramInvalid(`layer ∈ ${LAYERS.join('|')}`);
  const domain = await getDomainOrFail(data.domainId);
  const ds = await getDatasourceOrFail(data.datasourceId);
  // 引用表必须指名已有物理表；界面建表可留空，按「域前缀_分层_名称」自动命名（与 preview-ddl 同口径）
  const rawTable = String(data.tableName || '').trim();
  if (!rawTable && createType === 'reference') throw paramInvalid('reference 模式必须指定已有物理表 tableName');
  const tableName = rawTable || composeTableName(domain, data.layer, name);
  if (!IDENT_PATTERN.test(tableName)) throw paramInvalid(`tableName 非法（标识符白名单）: ${tableName}`);
  await assertTableFree({ datasourceId: ds.id, tableName });

  let columns = Array.isArray(data.columns) ? assertColumns(data.columns, ds.type) : null;

  let warnings = [];
  if (!columns) {
    if (createType === 'ddl') throw paramInvalid('ddl 模式必须提供 columns');
    if (['mysql', 'oracle'].includes(ds.type)) {
      const raw = await dataQuery.listColumns(ds, tableName);
      columns = assertColumns(raw.map(guessColumn), ds.type);
    } else {
      columns = [];
      warnings = [`数据源类型 ${ds.type} 暂不支持自动拉列，请手工维护 columns`];
    }
  }
  if (data.timeColumn && !columns.some((c) => c.columnName === data.timeColumn)) {
    throw paramInvalid(`timeColumn 不在列清单中: ${data.timeColumn}`);
  }

  const record = await metricModelRepository.create({
    name,
    datasourceId: ds.id,
    domainId: domain.id,
    layer: data.layer,
    tableName,
    createType,
    // 界面建表默认落草稿：确认字段无误并「启用」后才允许生成物理表（契约 1.13）
    status: data.status || (createType === 'ddl' ? 'draft' : 'online'),
    tableDdl: createType === 'ddl' ? buildDdl(domain, data.layer, tableName, columns, ds) : null,
    // 引用表本来就存在于源库，平台既不建也不删；ddl 模型建表前是 none
    tableStatus: createType === 'ddl' ? 'none' : 'exists',
    tableMsg: '',
    tableAt: null,
    timeColumn: data.timeColumn || (columns.find((c) => c.role === 'time') || {}).columnName || '',
    remark: String(data.remark || ''),
    createBy: operator,
    columns,
  });
  return { ...record, warnings };
};

const updateModel = async (id, patch) => {
  const existing = await getModel(id);
  const next = { ...patch };
  if (next.layer && !LAYERS.includes(next.layer)) throw paramInvalid(`layer ∈ ${LAYERS.join('|')}`);
  if (next.status && !STATUSES.includes(next.status)) throw paramInvalid(`status ∈ ${STATUSES.join('|')}`);
  if (next.columns) {
    const ds = await datasourceRepository.getById(existing.datasourceId);
    next.columns = assertColumns(next.columns, ds && ds.type);
  }
  // 草稿 → 启用：字段是建表的唯一依据，空字段模型启用后点生成表会得到一条没有列的 DDL
  if (next.status === 'online' && existing.status === 'draft') {
    const columns = next.columns || (await metricModelRepository.getById(id)).columns || [];
    if (!columns.length) throw paramInvalid('草稿模型至少需要 1 个字段才能启用');
  }

  if (next.tableName && (next.tableName !== existing.tableName || next.datasourceId !== existing.datasourceId)) {
    await assertTableFree({
      datasourceId: next.datasourceId || existing.datasourceId,
      tableName: next.tableName,
      excludeId: id,
    });
  }
  // 界面建表的留档 DDL 跟着字段走，否则改完字段详情里还是旧语句
  if (next.columns && existing.createType === 'ddl') {
    const [ds, domain] = await Promise.all([
      datasourceRepository.getById(existing.datasourceId),
      metricDomainRepository.getById(existing.domainId),
    ]);
    next.tableDdl = buildDdl(
      domain || { code: '' },
      next.layer || existing.layer,
      next.tableName || existing.tableName,
      next.columns,
      ds
    );
    // 物理表已存在时平台不自动 ALTER（表结构权威在建模，变更走显式动作），只把不一致写清楚
    if (existing.tableStatus === 'created') {
      next.tableMsg = '字段已变更，物理表未同步：平台不自动 ALTER，请按新 DDL 手工加列或重建后再启用任务';
    }
  }
  const updated = await metricModelRepository.update(
    id,
    ['name', 'layer', 'tableName', 'timeColumn', 'status', 'remark', 'columns', 'tableDdl', 'tableMsg']
      .filter((key) => next[key] !== undefined)
      .reduce((acc, key) => ({ ...acc, [key]: next[key] }), {})
  );
  return normalizeTableStatus(updated);
};

/**
 * 生成表（契约 1.13）：把建模登记的字段结构在目标库真建出来。
 * 只有「界面建表」的模型能走这里，且必须先启用；幂等（MySQL IF NOT EXISTS / Oracle 探数据字典）。
 * 失败不抛错而是落 tableStatus=failed + 原始报错，界面据此展示与重试（避免弹窗与状态两轨）。
 */
const createTableModel = async (id) => {
  if (config.db.driver !== 'mysql') throw paramInvalid('生成表需要 DB_DRIVER=mysql 真实执行（内存模式不建物理表）');
  const model = await getModel(id);
  if (model.createType !== 'ddl') {
    throw paramInvalid('只有「界面建表」的模型可由平台创建物理表；引用表本就存在于源库，平台不建也不删');
  }
  if (model.status !== 'online') throw paramInvalid(`模型状态 ${model.status}：草稿/停用模型不能生成表，请先启用`);
  if (!(model.columns || []).length) throw paramInvalid('模型没有字段，无法建表');
  const ds = await getDatasourceOrFail(model.datasourceId);
  const domain = await getDomainOrFail(model.domainId);
  const dl = dialect.dialectOfSource(ds);
  const ddl = buildDdl(domain, model.layer, model.tableName, model.columns, ds);
  const statements = splitDdlStatements(ddl);
  const result = { ddl, tableStatus: 'created', tableMsg: '', tableAt: new Date().toISOString(), executed: true };
  try {
    let toRun = statements;
    const probe = dl.tableExistsProbe(model.tableName);
    if (probe) {
      const hit = await metricExecService.runSql(model.datasourceId, probe);
      if (Number(((hit.rows || [])[0] || [])[0]) > 0) toRun = statements.filter((s) => !/^CREATE TABLE/i.test(s));
    }
    if (toRun.length) {
      await metricExecService.runExec(ds, toRun, { instanceId: `mdl-${model.id}`, timeoutMs: 120000 });
    } else {
      result.executed = false;
    }
  } catch (err) {
    result.tableStatus = 'failed';
    result.tableMsg = String(err.message || err).slice(0, 500);
    result.executed = false;
  }
  await metricModelRepository.update(model.id, {
    tableStatus: result.tableStatus,
    tableMsg: result.tableMsg,
    tableAt: result.tableAt,
  });
  return result;
};

/** PUT /metric-models/:id/columns：整组替换字段（同样按目标方言归一，ddl 模型同步重算留档 DDL） */
const replaceColumns = async (id, columns) => {
  const model = await getModel(id);
  const ds = await datasourceRepository.getById(model.datasourceId);
  const normalized = assertColumns(columns, ds && ds.type);
  if (model.createType === 'ddl') {
    const domain = await metricDomainRepository.getById(model.domainId);
    await metricModelRepository.update(id, {
      tableDdl: buildDdl(domain || { code: '' }, model.layer, model.tableName, normalized, ds),
    });
  }
  return normalizeTableStatus(await metricModelRepository.replaceColumns(id, normalized));
};

/**
 * 软删模型；下有指标/任务时按 40903 拦截（模型是指标的挂载点、是任务的源表与目标表）。
 * dropTable=true 才连带删除物理表（契约 1.13），且只允许删「平台自己建出来的表」：
 * 引用表归源系统所有，平台永不 DROP —— 这条闸门在服务端，不靠前端隐藏按钮。
 */
const deleteModel = async (id, options = {}) => {
  const model = await getModel(id);
  const metricCount = active(await metricRepository.list()).filter((metric) => metric.modelId === id).length;
  if (metricCount) throw metricReferenced(`模型被 ${metricCount} 个指标引用，禁止删除`);
  const tasks = active(await metricTaskRepository.list());
  const taskCount = tasks.filter((task) => task.sourceModelId === id || task.targetModelId === id).length;
  if (taskCount) throw metricReferenced(`模型被 ${taskCount} 个清洗汇总任务引用（源表或目标表），禁止删除`);
  const dropTable = options.dropTable === true || options.dropTable === 'true';
  if (dropTable && model.createType !== 'ddl') {
    throw paramInvalid('引用表由源系统维护，平台不执行 DROP；只有「界面建表」的模型可以连带删除物理表');
  }
  if (dropTable && model.tableStatus !== 'created') {
    throw paramInvalid(`该模型的物理表状态是 ${model.tableStatus || 'none'}，平台并未创建过它，拒绝 DROP`);
  }
  await metricModelRepository.update(id, { delFlag: true });
  // 取值档案跟着模型走：模型没了，词典里的值就没有归属（内存/库里都清，避免脏映射复活到新模型上）
  await metricDimValueRepository.removeModel(id).catch(() => false);
  if (!dropTable) return { id, deleted: true, dropped: false };
  if (config.db.driver !== 'mysql') {
    return { id, deleted: true, dropped: false, dropMsg: '内存模式不执行 DROP，物理表需手工清理' };
  }
  try {
    const ds = await getDatasourceOrFail(model.datasourceId);
    const dl = dialect.dialectOfSource(ds);
    await metricExecService.runExec(ds, [`DROP TABLE ${dl.table(model.tableName)}`], {
      instanceId: `mdl-${model.id}`,
      timeoutMs: 120000,
      allowDrop: true,
    });
    await metricModelRepository.update(id, { tableStatus: 'none', tableMsg: '' });
    return { id, deleted: true, dropped: true };
  } catch (err) {
    // 模型已软删，表还在：把报错原样回给界面，避免出现无人知晓的孤儿表
    return { id, deleted: true, dropped: false, dropMsg: String(err.message || err).slice(0, 300) };
  }
};

/** POST /metric-models/preview-ddl：域+分层+列定义（+目标数据源，决定方言）→ 表名与 CREATE TABLE 回显（不落库、不执行） */
const previewDdl = async ({ domainId, layer, name, tableName, columns, datasourceId }) => {
  const domain = await getDomainOrFail(domainId);
  if (!LAYERS.includes(layer)) throw paramInvalid(`layer ∈ ${LAYERS.join('|')}`);
  const finalTable = tableName ? String(tableName) : composeTableName(domain, layer, name);
  if (!IDENT_PATTERN.test(finalTable)) throw paramInvalid(`tableName 非法: ${finalTable}`);
  const source = datasourceId ? await getDatasourceOrFail(datasourceId) : 'mysql';
  const cols = assertColumns(Array.isArray(columns) ? columns : [], source.type || source);
  if (!cols.length) throw paramInvalid('preview-ddl 需要至少一列');
  const models = active(await metricModelRepository.list());
  const conflict = models.some((model) => String(model.tableName).toLowerCase() === finalTable.toLowerCase());
  return {
    tableName: finalTable,
    conflict,
    dialect: dialect.dialectOfSource(source).type,
    ddl: buildDdl(domain, layer, finalTable, cols, source),
  };
};

module.exports = {
  LAYERS,
  ROLES,
  STATUSES,
  splitDdlStatements,
  AGGS,
  guessColumn,
  assertColumns,
  queryModels,
  getModel,
  createModel,
  updateModel,
  createTableModel,
  replaceColumns,
  deleteModel,
  buildDdl,
  columnTypes,
  composeTableName,
  previewDdl,
};
