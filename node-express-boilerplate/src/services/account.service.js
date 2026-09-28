/**
 * 平台账号与用户管理（docs/API.md 第 1.11 节）。
 *
 * 安全要点（信息安全红线，全部服务端强制）：
 * - 密码只存 bcryptjs(cost 10) 哈希；toSafeUser 之外任何路径不得带出 passwordHash；
 * - 登录失败统一 40103「用户名或密码错误」，不区分账号不存在/密码错，防枚举；
 *   即便账号不存在也执行一次 bcrypt.compare（假哈希），抹平响应时间差；
 * - 禁用账号 40104 拒登；JWT 里只放 {sub,type,exp}，角色每次由仓储实时读取（禁用即失效）；
 * - 越权防线在路由层（auth('manageUsers')），本服务再兜业务底线：
 *   不能禁用/降级/删除自己，系统必须保留至少一个可用 admin。
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const moment = require('moment');
const config = require('../config/config');
const logger = require('../config/logger');
const userRepository = require('../repositories/user.repository');
const { paramInvalid, notFound, loginFailed, accountDisabled } = require('../utils/bizError');

const BCRYPT_COST = 10;
const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
/** 密码强度：8~64 位，至少 1 字母 + 1 数字（契约 1.11） */
const PASSWORD_RULES = [
  { re: /.{8,64}/, msg: '密码长度需为 8~64 位' },
  { re: /[a-zA-Z]/, msg: '密码需包含至少 1 个字母' },
  { re: /\d/, msg: '密码需包含至少 1 个数字' },
];
/** 不存在的账号也拿它跑一次 compare，避免用响应时间探测账号是否存在 */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

const assertPasswordStrength = (password) => {
  const text = String(password ?? '');
  for (const rule of PASSWORD_RULES) {
    if (!rule.re.test(text)) throw paramInvalid(rule.msg);
  }
};

/** 出参收口：永远不带 passwordHash */
const toSafeUser = (user) =>
  user
    ? {
        id: user.id,
        username: user.username,
        nickname: user.nickname || user.username,
        role: user.role,
        status: user.status,
        mustChangePassword: Boolean(user.mustChangePassword),
        lastLoginAt: user.lastLoginAt || null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      }
    : null;

const getOrThrow = async (id) => {
  const user = await userRepository.getById(id);
  if (!user) throw notFound(`用户不存在: ${id}`);
  return user;
};

/** 统计可用 admin 数（禁用 admin 不算），用于「最后一个 admin」防线 */
const countActiveAdmins = async () => {
  const admins = await userRepository.find({ filters: { role: 'admin', status: 'active' } });
  return admins.length;
};

/**
 * 登录：查用户（CI 由仓储保证）→ bcrypt.compare → 状态检查 → 签发 JWT。
 * 任何一步失败都收敛到 40103/40104，message 不含「用户存在与否」的信息量。
 */
const login = async ({ username, password }) => {
  const user = await userRepository.getByUsername(username);
  const matched = await bcrypt.compare(String(password ?? ''), user ? user.passwordHash : DUMMY_HASH);
  if (!user || !matched) throw loginFailed('用户名或密码错误');
  if (user.status === 'disabled') throw accountDisabled('账号已被禁用，请联系管理员');
  await userRepository.update(user.id, { lastLoginAt: new Date().toISOString() });
  const expires = moment().add(config.jwt.accessExpirationMinutes, 'minutes');
  const token = jwt.sign(
    { sub: user.id, iat: moment().unix(), exp: expires.unix(), type: 'access' },
    config.jwt.secret,
  );
  return { token, expiresInSec: (expires.diff(moment()) / 1000) | 0, user: toSafeUser({ ...user, lastLoginAt: expires.toISOString() }) };
};

/** passport-jwt 回调：token 有效 ≠ 账号有效，实时查库并拒绝 disabled */
const loadUserForToken = async (id) => {
  const user = await userRepository.getById(id);
  if (!user || user.status === 'disabled') return null;
  return user;
};

const listUsers = (query = {}) => userRepository.page({ ...query, sort: query.sort || 'createdAt:desc' });

const assertUsernameFree = async (username) => {
  if (await userRepository.getByUsername(username)) {
    throw paramInvalid(`用户名已被占用: ${username}`);
  }
};

const createUser = async (body) => {
  const username = String(body.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw paramInvalid('用户名需为 3~32 位小写字母/数字/._-');
  await assertUsernameFree(username);
  assertPasswordStrength(body.password);
  if (!['admin', 'user'].includes(body.role)) throw paramInvalid('role 仅支持 admin|user');
  const user = await userRepository.create({
    username,
    nickname: String(body.nickname || '').trim() || username,
    passwordHash: await bcrypt.hash(String(body.password), BCRYPT_COST),
    role: body.role || 'user',
    status: 'active',
    mustChangePassword: true,
  });
  return toSafeUser(user);
};

/**
 * 修改资料/角色/状态（仅 admin 路由可达）。
 * 自保护：不能对自己做「降级或禁用」；系统必须保留至少一个可用 admin。
 */
const updateUser = async (id, body, operator) => {
  const target = await getOrThrow(id);
  const patch = {};
  if (body.nickname !== undefined) patch.nickname = String(body.nickname).trim() || target.username;
  if (body.role !== undefined) {
    if (!['admin', 'user'].includes(body.role)) throw paramInvalid('role 仅支持 admin|user');
    if (target.id === operator.id && body.role !== 'admin') throw paramInvalid('不能降级自己的角色');
    if (target.role === 'admin' && body.role !== 'admin' && (await countActiveAdmins()) <= 1) {
      throw paramInvalid('系统必须保留至少一个可用的 admin');
    }
    patch.role = body.role;
  }
  if (body.status !== undefined) {
    if (!['active', 'disabled'].includes(body.status)) throw paramInvalid('status 仅支持 active|disabled');
    if (target.id === operator.id && body.status === 'disabled') throw paramInvalid('不能禁用当前登录账号');
    if (target.role === 'admin' && body.status === 'disabled' && (await countActiveAdmins()) <= 1) {
      throw paramInvalid('系统必须保留至少一个可用的 admin');
    }
    patch.status = body.status;
  }
  if (!Object.keys(patch).length) throw paramInvalid('没有需要更新的字段');
  return toSafeUser(await userRepository.update(target.id, patch));
};

const deleteUser = async (id, operator) => {
  const target = await getOrThrow(id);
  if (target.id === operator.id) throw paramInvalid('不能删除当前登录账号');
  if (target.role === 'admin' && (await countActiveAdmins()) <= 1) {
    throw paramInvalid('系统必须保留至少一个可用的 admin');
  }
  await userRepository.remove(target.id);
  return target;
};

/** 管理员重置他人密码：置 mustChangePassword，下次登录前端强制改密 */
const resetPassword = async (id, { password }) => {
  const target = await getOrThrow(id);
  assertPasswordStrength(password);
  await userRepository.update(target.id, {
    passwordHash: await bcrypt.hash(String(password), BCRYPT_COST),
    mustChangePassword: true,
  });
  return toSafeUser(await userRepository.getById(target.id));
};

/** 本人改密（/auth/change-password）：必须验证旧密码；成功后清 mustChangePassword */
const changeOwnPassword = async (operator, { oldPassword, newPassword }) => {
  const matched = await bcrypt.compare(String(oldPassword ?? ''), operator.passwordHash);
  if (!matched) throw paramInvalid('旧密码不正确');
  assertPasswordStrength(newPassword);
  if (oldPassword === newPassword) throw paramInvalid('新密码不能与旧密码相同');
  await userRepository.update(operator.id, {
    passwordHash: await bcrypt.hash(String(newPassword), BCRYPT_COST),
    mustChangePassword: false,
  });
  return true;
};

/**
 * 空表启动播种唯一 admin（mysql 与 memory 同逻辑）：
 * 密码取 ADMIN_INIT_PASSWORD 环境变量，未配置则随机生成并打 WARN 日志（只出现一次）。
 */
const ensureSeedAdmin = async () => {
  const total = await userRepository.count();
  if (total > 0) return null;
  const fromEnv = String(config.adminInitPassword || '').trim();
  const generated = fromEnv || crypto.randomBytes(9).toString('base64url');
  assertPasswordStrength(generated);
  const user = await userRepository.create({
    username: 'admin',
    nickname: '系统管理员',
    passwordHash: await bcrypt.hash(generated, BCRYPT_COST),
    role: 'admin',
    mustChangePassword: true,
  });
  logger.warn(
    'seeded initial admin user: username=admin password=%s (首次登录后请立即修改，本日志打印后不再返回该密码)',
    generated,
  );
  return toSafeUser(user);
};

module.exports = {
  USERNAME_RE,
  toSafeUser,
  assertPasswordStrength,
  login,
  loadUserForToken,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  resetPassword,
  changeOwnPassword,
  ensureSeedAdmin,
  repository: userRepository,
};
