/**
 * 建模分层树服务（契约 1.16 / V11 四期）。
 *
 * 树 = 5 个固定分层根（LAYERS 常量虚拟化生成，不落库、不可增删改名）→ 下面挂「分类」节点。
 * 为什么分层不落库：layer 是承重字段（参与物理表命名「域前缀_分层_名称」、DDL 表注释、
 * 首页看板分组、批量建指标默认值），开放成用户可编辑节点会让命名规则漂移。
 *
 * 分类是全局按层的实体，不隶属指标域：与 domain_id 那条业务轴正交，建模页两轴叠加筛选。
 * 红线：任何分类操作（增删改、归类、降级）只动元数据，不产一句 DDL、不碰物理表。
 */
const { paramInvalid, notFound } = require('../utils/bizError');
const { LAYERS } = require('./metricmodel.service');
const metricModelCategoryRepository = require('../repositories/metricmodelcategory.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');

/**
 * 分层根节点的中文标签（与前端 views/metric/data.ts 的 LAYER_OPTIONS 对齐）。
 * 后端自己维护一份：树接口是界面唯一的 label 来源，前端不再本地兜底，避免两处漂移。
 */
const LAYER_LABELS = {
  ODS: '贴源层',
  DIM: '维度层',
  DWD: '明细层',
  DWS: '汇总层',
  ADS: '应用层',
};

const NAME_MAX = 64;
const DESCRIPTION_MAX = 512;

const active = (items) => items.filter((item) => !item.delFlag);

/** 未分类：空串（新建/移出后的值）与旧库补列出来的 NULL 同口径 */
const isUncategorized = (model) => !model || !model.categoryId;

const assertLayer = (layer) => {
  if (!LAYERS.includes(layer)) throw paramInvalid(`layer ∈ ${LAYERS.join('|')}`);
};

const trimName = (name) => {
  const text = String(name === undefined || name === null ? '' : name).trim();
  if (!text) throw paramInvalid('name 必填');
  if (text.length > NAME_MAX) throw paramInvalid(`name 长度需 ≤${NAME_MAX}`);
  return text;
};

const normalizeDescription = (description) => {
  const text = String(description === undefined || description === null ? '' : description);
  if (text.length > DESCRIPTION_MAX) throw paramInvalid(`description 长度需 ≤${DESCRIPTION_MAX}`);
  return text;
};

/** 树上的分类节点需要稳定可比：把仓储里可能为 NULL/缺失的列归一成契约形态 */
const toNode = (category) => ({
  id: category.id,
  name: category.name,
  layer: category.layer,
  description: category.description || '',
  sort: Number(category.sort) || 0,
  createdAt: category.createdAt || '',
});

/** children 排序口径：sort asc 再 createdAt asc（Array#sort 稳定，两级各排一次即可） */
const sortNodes = (nodes) =>
  nodes
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .sort((a, b) => a.sort - b.sort);

/**
 * GET /metric-model-categories/tree
 * 5 个分层根恒定出现（一个分类都没有也回 children:[]、modelCount:0）；
 * 计数口径＝全量未删除模型，不随右侧筛选变化（避免「点了节点计数还在跳」的理解成本）。
 */
const getTree = async () => {
  const [categories, models] = await Promise.all([
    metricModelCategoryRepository.list().then(active),
    metricModelRepository.list().then(active),
  ]);
  const nodes = sortNodes(categories.map(toNode));
  const countOf = (predicate) => models.filter(predicate).length;
  const layers = LAYERS.map((layer) => ({
    layer,
    label: LAYER_LABELS[layer],
    modelCount: countOf((model) => model.layer === layer),
    uncategorized: countOf((model) => model.layer === layer && isUncategorized(model)),
    children: nodes
      .filter((node) => node.layer === layer)
      .map((node) => ({
        id: node.id,
        name: node.name,
        layer: node.layer,
        description: node.description,
        sort: node.sort,
        modelCount: countOf((model) => model.categoryId === node.id),
      })),
  }));
  return { total: layers.reduce((sum, layer) => sum + layer.children.length, 0), layers };
};

const getCategoryOrFail = async (id) => {
  const category = await metricModelCategoryRepository.getById(id);
  if (!category || category.delFlag) throw notFound(`分类不存在: ${id}`);
  return category;
};

/** 同层内名称大小写不敏感唯一（跨层同名允许——它们挂在不同的分层根下，不构成歧义） */
const assertNameFree = async ({ layer, name, excludeId }) => {
  const needle = String(name).toLowerCase();
  const categories = active(await metricModelCategoryRepository.list());
  const hit = categories.find(
    (item) => item.layer === layer && String(item.name).toLowerCase() === needle && item.id !== excludeId
  );
  if (hit) throw paramInvalid(`分层 ${layer} 下已有同名分类「${hit.name}」(${hit.id})，请换个名字`);
};

/** POST /metric-model-categories */
const createCategory = async (data, operator = '') => {
  const name = trimName(data.name);
  const description = normalizeDescription(data.description);
  assertLayer(data.layer);
  await assertNameFree({ layer: data.layer, name });
  return metricModelCategoryRepository.create({
    name,
    layer: data.layer,
    description,
    sort: Number(data.sort) || 0,
    createBy: operator,
  });
};

/** PUT /metric-model-categories/:id —— 只收 name/description/sort，layer 是树上的挂载位置，创建后不可改 */
const updateCategory = async (id, patch) => {
  const existing = await getCategoryOrFail(id);
  if (patch.layer !== undefined) {
    throw paramInvalid('分类的 layer 创建后不可修改（layer 就是它在树上的挂载位置）；需要换层请新建分类再批量归类');
  }
  const next = {};
  if (patch.name !== undefined) {
    const name = trimName(patch.name);
    if (name.toLowerCase() !== String(existing.name).toLowerCase()) {
      await assertNameFree({ layer: existing.layer, name, excludeId: existing.id });
    }
    next.name = name;
  }
  if (patch.description !== undefined) next.description = normalizeDescription(patch.description);
  if (patch.sort !== undefined) next.sort = Number(patch.sort) || 0;
  return metricModelCategoryRepository.update(id, next);
};

/** 把名下模型退回「未分类」桶（只改元数据列，不碰物理表）；返回搬走的模型数 */
const clearModelsOfCategory = async (categoryId) => {
  const models = active(await metricModelRepository.list());
  const owned = models.filter((model) => model.categoryId === categoryId);
  // eslint-disable-next-line no-restricted-syntax
  for (const model of owned) {
    // eslint-disable-next-line no-await-in-loop
    await metricModelRepository.update(model.id, { categoryId: '' });
  }
  return owned.length;
};

/**
 * DELETE /metric-model-categories/:id —— 软删 + 名下模型自动降级为未分类。
 * 不做 40902 式禁删闸门（那条是指标域专属：域是资产容器，分类只是定位用的归组节点）。
 */
const deleteCategory = async (id) => {
  const existing = await getCategoryOrFail(id);
  const movedModels = await clearModelsOfCategory(existing.id);
  await metricModelCategoryRepository.update(existing.id, { delFlag: true });
  return { id: existing.id, deleted: true, movedModels };
};

/**
 * POST /metric-model-categories/assign —— 批量归类，categoryId 空串＝移出回未分类。
 * 逐条校验「模型存在未删 / 分类存在未删 / 分类.layer === 模型.layer」，
 * 跨层的几条不整批失败：明确点名到 results.message，HTTP 恒 200（与 v1.14 /metrics/batch 同形）。
 */
const ASSIGN_MAX = 500;

const assign = async ({ categoryId = '', modelIds = [] } = {}) => {
  const ids = (Array.isArray(modelIds) ? modelIds : []).map((item) => String(item || '').trim()).filter(Boolean);
  if (ids.length > ASSIGN_MAX) throw paramInvalid(`单次批量归类上限 ${ASSIGN_MAX} 条，请分批提交`);
  const wanted = String(categoryId || '').trim();
  const models = new Map(active(await metricModelRepository.list()).map((model) => [String(model.id), model]));

  let category = null;
  let categoryError = '';
  if (wanted) {
    category = await metricModelCategoryRepository.getById(wanted);
    if (!category || category.delFlag) {
      category = null;
      categoryError = `分类不存在: ${wanted}`;
    }
  }

  const results = ids.map((id) => {
    const model = models.get(id);
    if (!model) return { id, ok: false, message: '模型不存在或已删除' };
    if (!wanted) return { id, ok: true }; // 移出回未分类：只要求模型存在
    if (categoryError) return { id, ok: false, message: categoryError };
    if (category.layer !== model.layer) {
      return {
        id,
        ok: false,
        message: `跨层归类被拒：分类「${category.name}」属 ${category.layer}，模型属 ${model.layer}（分类只装同层模型）`,
      };
    }
    return { id, ok: true };
  });

  const passed = results.filter((item) => item.ok);
  // eslint-disable-next-line no-restricted-syntax
  for (const item of passed) {
    // eslint-disable-next-line no-await-in-loop
    await metricModelRepository.update(item.id, { categoryId: wanted });
  }
  return { results, assigned: passed.length, failed: results.length - passed.length };
};

module.exports = {
  LAYERS,
  LAYER_LABELS,
  getTree,
  createCategory,
  updateCategory,
  deleteCategory,
  assign,
};
