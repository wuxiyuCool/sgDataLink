const allRoles = {
  user: [],
  // manageMetrics：契约 1.12 中仅 admin 的操作（/metric-settings、审核转示例）
  admin: ['getUsers', 'manageUsers', 'manageMetrics'],
};

const roles = Object.keys(allRoles);
const roleRights = new Map(Object.entries(allRoles));

module.exports = {
  roles,
  roleRights,
};
