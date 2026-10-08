/**
 * 指标依赖边仓储（MySQL 实现，契约 1.12）。
 * 表无字符串 id（seq+parent/child 自然键），bespoke SQL 直读写，与内存版同名同返回结构。
 */
const db = require('../../db/mysql');

const TABLE = 'databridge_metric_dep';

const rebuildForParent = async (parentId, list = []) => {
  await db.run(`DELETE FROM \`${TABLE}\` WHERE parent_id = ?`, [String(parentId)]);
  if (!list.length) return true;
  const values = list.map(() => '(?, ?, ?)').join(', ');
  const args = list.reduce(
    (acc, edge) => acc.concat([String(parentId), String(edge.childId), String(edge.refExpr || '')]),
    []
  );
  await db.run(`INSERT INTO \`${TABLE}\` (parent_id, child_id, ref_expr) VALUES ${values}`, args);
  return true;
};

const removeByParent = async (parentId) => {
  await db.run(`DELETE FROM \`${TABLE}\` WHERE parent_id = ?`, [String(parentId)]);
};

const removeInvolving = async (metricId) => {
  await db.run(`DELETE FROM \`${TABLE}\` WHERE parent_id = ? OR child_id = ?`, [String(metricId), String(metricId)]);
};

const listAll = async () => {
  const rows = await db.query(
    `SELECT parent_id AS parentId, child_id AS childId, ref_expr AS refExpr FROM \`${TABLE}\` ORDER BY seq ASC`
  );
  return rows.map((row) => ({ parentId: row.parentId, childId: row.childId, refExpr: row.refExpr || '' }));
};

const childrenOf = async (parentId) => {
  const rows = await listAll();
  return rows.filter((edge) => edge.parentId === String(parentId));
};

const parentsOf = async (childId) => {
  const rows = await listAll();
  return rows.filter((edge) => edge.childId === String(childId));
};

const clear = async () => {
  await db.run(`DELETE FROM \`${TABLE}\``);
  return true;
};

module.exports = { rebuildForParent, removeByParent, removeInvolving, listAll, childrenOf, parentsOf, clear };
