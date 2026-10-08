/**
 * 指标域服务（契约 1.12）：树形 CRUD + 删除资产保护（40902）。
 */
const { paramInvalid, notFound, metricDomainHasAssets } = require('../utils/bizError');
const metricDomainRepository = require('../repositories/metricdomain.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricRepository = require('../repositories/metric.repository');

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

const active = (domains) => domains.filter((domain) => !domain.delFlag);

const listDomains = async (filter = {}) =>
  active(
    filter.keyword ? await metricDomainRepository.find({ keyword: filter.keyword }) : await metricDomainRepository.list()
  );

/**
 * GET /metric-domains/tree：整树 + 域内资产计数（前端域管理页左树用）。
 */
const getTree = async () => {
  const domains = await listDomains();
  const models = active(await metricModelRepository.list());
  const metrics = active(await metricRepository.list());
  const countBy = (items, domainId) => items.filter((item) => item.domainId === domainId).length;
  const nodeOf = (domain) => ({
    ...domain,
    modelCount: countBy(models, domain.id),
    metricCount: countBy(metrics, domain.id),
    children: domains
      .filter((item) => item.parentId === domain.id)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(nodeOf),
  });
  const roots = domains
    .filter((domain) => !domain.parentId || domain.parentId === '0')
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map(nodeOf);
  // 父被软删的孤儿节点不静默吞掉：挂到根层显示，避免资产不可达
  const rootIds = new Set(domains.map((domain) => domain.id));
  const orphans = domains
    .filter((domain) => domain.parentId && domain.parentId !== '0' && !rootIds.has(domain.parentId))
    .map(nodeOf);
  return { items: [...roots, ...orphans] };
};

const createDomain = async (data, operator = '') => {
  const code = String(data.code || '').trim();
  if (!code || !CODE_PATTERN.test(code)) {
    throw paramInvalid('code 必填，且需匹配 ^[a-z][a-z0-9_]{1,30}$');
  }
  if (!String(data.name || '').trim()) throw paramInvalid('name 必填');
  const exists = (await listDomains()).some((domain) => domain.code === code);
  if (exists) throw paramInvalid(`域编码 ${code} 已存在`);
  const parentId = data.parentId || '0';
  if (parentId !== '0') {
    const parent = await metricDomainRepository.getById(parentId);
    if (!parent || parent.delFlag) throw paramInvalid(`父域不存在: ${parentId}`);
  }
  return metricDomainRepository.create({
    name: String(data.name).trim(),
    code,
    parentId,
    tablePrefix: String(data.tablePrefix || '').trim(),
    owner: String(data.owner || '').trim(),
    sort: Number(data.sort) || 0,
    remark: String(data.remark || ''),
    createBy: operator,
  });
};

const updateDomain = async (id, patch) => {
  const existing = await metricDomainRepository.getById(id);
  if (!existing || existing.delFlag) throw notFound(`指标域不存在: ${id}`);
  if (patch.code && patch.code !== existing.code) {
    throw paramInvalid('域编码 code 是建表前缀锚点，创建后不可修改');
  }
  if (patch.parentId && patch.parentId !== existing.parentId) {
    if (patch.parentId === id) throw paramInvalid('父域不能是自己');
    // 预取整树后在内存里闭包展开，父域不得落在自己的子孙集合里
    const all = await listDomains();
    const descendants = new Set([id]);
    let grew = true;
    while (grew) {
      const before = descendants.size;
      all
        .filter((domain) => descendants.has(domain.parentId) && !descendants.has(domain.id))
        .forEach((domain) => descendants.add(domain.id));
      grew = descendants.size !== before;
    }
    if (descendants.has(patch.parentId)) throw paramInvalid('父域不能是自己的子孙域');
  }
  return metricDomainRepository.update(
    id,
    ['name', 'parentId', 'tablePrefix', 'owner', 'sort', 'remark']
      .filter((key) => patch[key] !== undefined)
      .reduce((acc, key) => ({ ...acc, [key]: patch[key] }), {})
  );
};

/** 软删；下有子域 / 模型 / 指标时 40902 */
const deleteDomain = async (id) => {
  const existing = await metricDomainRepository.getById(id);
  if (!existing || existing.delFlag) throw notFound(`指标域不存在: ${id}`);
  const domains = await listDomains();
  const childCount = domains.filter((domain) => domain.parentId === id).length;
  const modelCount = active(await metricModelRepository.list()).filter((model) => model.domainId === id).length;
  const metricCount = active(await metricRepository.list()).filter((metric) => metric.domainId === id).length;
  if (childCount || modelCount || metricCount) {
    throw metricDomainHasAssets(`域下有资产禁删：子域 ${childCount}、模型 ${modelCount}、指标 ${metricCount}`);
  }
  await metricDomainRepository.update(id, { delFlag: true });
  return { id, deleted: true };
};

module.exports = { listDomains, getTree, createDomain, updateDomain, deleteDomain };
