/**
 * 数据模型服务（契约 1.12）：引用表 / 界面建表两种创建、字段维护、DDL 预览。
 * 元数据拉取复用 db/dataQuery（真实建连，联调口径=DB_DRIVER=mysql 直连内网库）。
 */
const crypto = require('crypto');
const { paramInvalid, notFound, metricTableConflict, metricReferenced } = require('../utils/bizError');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricRepository = require('../repositories/metric.repository');
const metricDomainRepository = require('../repositories/metricdomain.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const dataQuery = require('../db/dataQuery');

const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LAYERS = ['ODS', 'DIM', 'DWD', 'DWS', 'ADS'];
const ROLES = ['dimension', 'measure', 'time'];
const AGGS = ['sum', 'count', 'max', 'min', 'avg', 'count_distinct'];

const active = (items) => items.filter((item) => !item.delFlag);

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

const assertColumns = (columns) => {
  if (!Array.isArray(columns)) return columns;
  const seen = new Set();
  columns.forEach((column, index) => {
    if (!column || !IDENT_PATTERN.test(String(column.columnName || ''))) {
      throw paramInvalid(`columns[${index}].columnName 非法（标识符白名单）`);
    }
    if (seen.has(column.columnName.toLowerCase())) throw paramInvalid(`列重复: ${column.columnName}`);
    seen.add(column.columnName.toLowerCase());
    if (!ROLES.includes(column.role)) throw paramInvalid(`columns[${index}].role ∈ ${ROLES.join('|')}`);
    if (column.aggDefault && !AGGS.includes(column.aggDefault)) {
      throw paramInvalid(`columns[${index}].aggDefault ∈ ${AGGS.join('|')}`);
    }
  });
  return columns;
};

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

/** 由列定义生成目标库 CREATE TABLE（域前缀+分层+名称），仅回显/留档，不执行 */
const buildDdl = (domain, layer, tableName, columns) => {
  const typeOf = (column) => {
    const type = String(column.dataType || '').toUpperCase();
    if (/^(TINYINT|SMALLINT|INT|INTEGER|BIGINT|DATE|DATETIME|TIMESTAMP|TEXT)/.test(type)) return type;
    if (type.startsWith('DECIMAL') || type.startsWith('NUMBER'))
      return `DECIMAL${type.replace(/^(DECIMAL|NUMBER)/, '') || '(18,4)'}`;
    if (/^(VARCHAR|CHAR)/.test(type))
      return type.startsWith('VARCHAR') ? type : `VARCHAR(${(type.match(/\d+/) || [64])[0]})`;
    return 'VARCHAR(255)';
  };
  const lines = columns.map((column) => {
    const comment =
      column.bizName || column.remark ? ` COMMENT '${String(column.bizName || column.remark).replace(/'/g, "''")}'` : '';
    return `  \`${column.columnName}\` ${typeOf(column)} NOT NULL${comment}`;
  });
  const keys = columns.filter((column) => column.isKey).map((column) => `\`${column.columnName}\``);
  if (keys.length) lines.push(`  PRIMARY KEY (${keys.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n${lines.join(
    ',\n'
  )}\n) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '${layer} | domain=${domain.code}'`;
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

const queryModels = (filter = {}, options = {}) =>
  metricModelRepository.page({
    filters: { ...filter, delFlag: false },
    keyword: options.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

const getModel = async (id) => {
  const model = await metricModelRepository.getById(id);
  if (!model || model.delFlag) throw notFound(`模型不存在: ${id}`);
  return model;
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
  const tableName = String(data.tableName || '').trim();
  if (!IDENT_PATTERN.test(tableName)) throw paramInvalid('tableName 非法（标识符白名单）');

  const domain = await getDomainOrFail(data.domainId);
  const ds = await getDatasourceOrFail(data.datasourceId);
  await assertTableFree({ datasourceId: ds.id, tableName });

  let columns = Array.isArray(data.columns) ? assertColumns(data.columns) : null;
  let warnings = [];
  if (!columns) {
    if (createType === 'ddl') throw paramInvalid('ddl 模式必须提供 columns');
    if (['mysql', 'oracle'].includes(ds.type)) {
      const raw = await dataQuery.listColumns(ds, tableName);
      columns = raw.map(guessColumn);
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
    tableDdl: createType === 'ddl' ? buildDdl(domain, data.layer, tableName, columns) : null,
    timeColumn: data.timeColumn || (columns.find((c) => c.role === 'time') || {}).columnName || '',
    status: data.status || 'online',
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
  if (next.columns) next.columns = assertColumns(next.columns);
  if (next.tableName && (next.tableName !== existing.tableName || next.datasourceId !== existing.datasourceId)) {
    await assertTableFree({
      datasourceId: next.datasourceId || existing.datasourceId,
      tableName: next.tableName,
      excludeId: id,
    });
  }
  return metricModelRepository.update(
    id,
    ['name', 'layer', 'tableName', 'timeColumn', 'status', 'remark', 'columns']
      .filter((key) => next[key] !== undefined)
      .reduce((acc, key) => ({ ...acc, [key]: next[key] }), {})
  );
};

const replaceColumns = async (id, columns) => {
  await getModel(id);
  return metricModelRepository.replaceColumns(id, assertColumns(columns));
};

/** 软删；下有指标时按 40903 口径拦截（模型是指标的挂载点） */
const deleteModel = async (id) => {
  await getModel(id);
  const metricCount = active(await metricRepository.list()).filter((metric) => metric.modelId === id).length;
  if (metricCount) throw metricReferenced(`模型被 ${metricCount} 个指标引用，禁止删除`);
  await metricModelRepository.update(id, { delFlag: true });
  return { id, deleted: true };
};

/** POST /metric-models/preview-ddl：域+分层+列定义 → 表名与 CREATE TABLE 回显（不落库、不执行） */
const previewDdl = async ({ domainId, layer, name, tableName, columns }) => {
  const domain = await getDomainOrFail(domainId);
  if (!LAYERS.includes(layer)) throw paramInvalid(`layer ∈ ${LAYERS.join('|')}`);
  const finalTable = tableName ? String(tableName) : composeTableName(domain, layer, name);
  if (!IDENT_PATTERN.test(finalTable)) throw paramInvalid(`tableName 非法: ${finalTable}`);
  const cols = assertColumns(Array.isArray(columns) ? columns : []);
  if (!cols.length) throw paramInvalid('preview-ddl 需要至少一列');
  const models = active(await metricModelRepository.list());
  const conflict = models.some((model) => String(model.tableName).toLowerCase() === finalTable.toLowerCase());
  return { tableName: finalTable, conflict, ddl: buildDdl(domain, layer, finalTable, cols) };
};

module.exports = {
  LAYERS,
  ROLES,
  AGGS,
  guessColumn,
  assertColumns,
  queryModels,
  getModel,
  createModel,
  updateModel,
  replaceColumns,
  deleteModel,
  buildDdl,
  composeTableName,
  previewDdl,
};
