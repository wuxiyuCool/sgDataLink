/**
 * 指标依赖边仓储（内存实现，契约 1.12）。
 * 复合/派生指标保存时整体重建自己的出边；tree/lineage/循环检测/影响分析的共同数据源。
 * 无字符串 id（parent+child 自然键），facade 两侧同名方法返回 Promise。
 */
const edges = new Set(); // 'parentId|childId'
const edgeDetail = new Map(); // `${parentId}|${childId}` -> {parentId, childId, refExpr}

const key = (parentId, childId) => `${parentId}|${childId}`;

const removeByParent = (parentId) => {
  [...edgeDetail.keys()]
    .filter((k) => k.startsWith(`${parentId}|`))
    .forEach((k) => {
      edges.delete(k);
      edgeDetail.delete(k);
    });
};

const rebuildForParent = (parentId, list = []) => {
  removeByParent(parentId);
  list.forEach(({ childId, refExpr = '' }) => {
    edges.add(key(parentId, childId));
    edgeDetail.set(key(parentId, childId), { parentId, childId, refExpr });
  });
  return true;
};

const removeInvolving = (metricId) => {
  [...edgeDetail.keys()]
    .filter((k) => k.split('|').includes(metricId))
    .forEach((k) => {
      edges.delete(k);
      edgeDetail.delete(k);
    });
};

const listAll = () => [...edgeDetail.values()].map((edge) => ({ ...edge }));

const childrenOf = (parentId) =>
  [...edgeDetail.values()].filter((edge) => edge.parentId === parentId).map((edge) => ({ ...edge }));

const parentsOf = (childId) =>
  [...edgeDetail.values()].filter((edge) => edge.childId === childId).map((edge) => ({ ...edge }));

const memoryImpl = {
  rebuildForParent,
  removeByParent,
  removeInvolving,
  listAll,
  childrenOf,
  parentsOf,
  clear: () => {
    edges.clear();
    edgeDetail.clear();
    return true;
  },
};

module.exports = require('./facade').pickImpl('metricdep', memoryImpl);
