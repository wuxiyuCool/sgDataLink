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
const loginlogRepository = require('../repositories/loginlog.repository');
const docaccesslogRepository = require('../repositories/docaccesslog.repository');
const { paramInvalid, notFound, loginFailed, accountDisabled, docKeyInvalid, docKeyStale } = require('../utils/bizError');

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
        /** 1.9.5 文档权限位（docKey 明文只在 /auth/doc-key* 回本人） */
        docAccess: Boolean(user.docAccess),
        /** 问数对外服务权限位（chatKey 明文只在 /auth/chat-key* 回本人） */
        chatAccess: Boolean(user.chatAccess),
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
 * 无论成败都写一条登录日志（契约 1.11，供 admin 审计）；日志写失败只告警，不影响登录结果。
 */
const login = async ({ username, password, ip }) => {
  const record = async (patch) => {
    try {
      await loginlogRepository.add({
        username: String(username || '').slice(0, 64),
        ip: ip || null,
        ...patch,
      });
    } catch (err) {
      logger.warn('login log write failed (ignored): %s', err.message);
    }
  };
  const user = await userRepository.getByUsername(username);
  const matched = await bcrypt.compare(String(password ?? ''), user ? user.passwordHash : DUMMY_HASH);
  if (!user || !matched) {
    await record({ ok: false, errorMsg: 'bad_credentials' });
    throw loginFailed('用户名或密码错误');
  }
  if (user.status === 'disabled') {
    await record({ userId: user.id, ok: false, errorMsg: 'account_disabled' });
    throw accountDisabled('账号已被禁用，请联系管理员');
  }
  const lastLoginAt = new Date().toISOString();
  await userRepository.update(user.id, { lastLoginAt });
  await record({ userId: user.id, ok: true });
  const expires = moment().add(config.jwt.accessExpirationMinutes, 'minutes');
  const token = jwt.sign(
    { sub: user.id, iat: moment().unix(), exp: expires.unix(), type: 'access' },
    config.jwt.secret,
  );
  return { token, expiresInSec: (expires.diff(moment()) / 1000) | 0, user: toSafeUser({ ...user, lastLoginAt }) };
};

/** 登录日志分页查询（仅 admin 路由暴露） */
const pageLoginLogs = (query = {}) => loginlogRepository.page(query);

/* ------------------------------------------------------------------ */
/* 1.9.5 docKey：文档中心免登录访问（key 绑定用户，禁用/关闭权限即失效） */
/* ------------------------------------------------------------------ */

const DOC_KEY_PREFIX = 'dok-';

const generateDocKey = () => `${DOC_KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;

/** 日志用掩码：只保留前 6 位（dok- 前缀 + 2 位随机），完整 key 绝不落日志 */
const maskDocKey = (key) => (key ? `${String(key).slice(0, 6)}***` : null);

/** GET /auth/doc-key：本人查看权限位与 key 明文 */
const getDocKey = async (operator) => {
  const user = await userRepository.getById(operator.id);
  return {
    docAccess: Boolean(user && user.docAccess),
    docKey: user && user.docAccess ? user.docKey || null : null,
    updatedAt: (user && user.docKeyUpdatedAt) || null,
  };
};

/** POST /auth/doc-key/refresh：本人刷新 key（旧 key 立即失效；未开通直接拒绝） */
const refreshDocKey = async (operator) => {
  const user = await userRepository.getById(operator.id);
  if (!user || !user.docAccess) throw paramInvalid('尚未开通文档权限，请联系管理员开通');
  const docKey = generateDocKey();
  const updatedAt = new Date().toISOString();
  await userRepository.update(user.id, { docKey, docKeyUpdatedAt: updatedAt });
  return { docAccess: true, docKey, updatedAt };
};

/**
 * docKey 认证入口（swagger.json 免登录分支）。
 * 缺 key / key 错 / 权限未开通 → 统一 401/40102（不区分，防枚举）；
 * 账号禁用 → 401/40105（实时查库，key 无法先于账号状态存活）。
 */
const resolveDocKey = async (rawKey) => {
  const key = String(rawKey || '').trim();
  if (!key) throw docKeyInvalid('未提供文档 Key（用 X-DOC-KEY 头或 docKey 查询参数）');
  const user = await userRepository.getByDocKey(key);
  if (!user || !user.docAccess) throw docKeyInvalid('文档 Key 无效');
  if (user.status === 'disabled') throw docKeyStale('文档 Key 已失效（账号被禁用）');
  return { user, keyMasked: maskDocKey(key) };
};

/** 文档访问日志：写侧吞异常（审计是旁路，不能影响文档响应），读侧仅 admin 路由暴露 */
const recordDocAccess = async (record = {}) => {
  try {
    await docaccesslogRepository.add(record);
  } catch (err) {
    logger.warn('doc access log write failed (ignored): %s', err.message);
  }
};

/* ------------------------------------------------------------------ */
/* 问数对外服务（契约 1.12 增补）：chatKey 绑定用户，权限位开通即生成   */
/* ------------------------------------------------------------------ */

const CHAT_KEY_PREFIX = 'chk-';

const generateChatKey = () => `${CHAT_KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;

const maskChatKey = (key) => (key ? `${String(key).slice(0, 6)}***` : null);

/** GET /auth/chat-key：本人查看问数权限位与 key 明文 */
const getChatKey = async (operator) => {
  const user = await userRepository.getById(operator.id);
  return {
    chatAccess: Boolean(user && user.chatAccess),
    chatKey: user && user.chatAccess ? user.chatKey || null : null,
    updatedAt: (user && user.chatKeyUpdatedAt) || null,
  };
};

/** POST /auth/chat-key/refresh：本人刷新（旧 key 立即失效；未开通拒绝） */
const refreshChatKey = async (operator) => {
  const user = await userRepository.getById(operator.id);
  if (!user || !user.chatAccess) throw paramInvalid('尚未开通问数权限，请联系管理员开通');
  const chatKey = generateChatKey();
  const updatedAt = new Date().toISOString();
  await userRepository.update(user.id, { chatKey, chatKeyUpdatedAt: updatedAt });
  return { chatAccess: true, chatKey, updatedAt };
};

/**
 * chatKey 认证入口（POST /chat/ask）。
 * 缺 key / key 错 / 权限未开通 → 统一 401/40102（防枚举，与 docKey 同码族）；
 * 账号禁用 → 401/40105。
 */
const resolveChatKey = async (rawKey) => {
  const key = String(rawKey || '').trim();
  if (!key) throw docKeyInvalid('未提供问数 Key（用 X-CHAT-KEY 头或 chatKey 查询参数）');
  const user = await userRepository.getByChatKey(key);
  if (!user || !user.chatAccess) throw docKeyInvalid('问数 Key 无效');
  if (user.status === 'disabled') throw docKeyStale('问数 Key 已失效（账号被禁用）');
  return { user, keyMasked: maskChatKey(key) };
};

const pageDocAccessLogs = (query = {}) => docaccesslogRepository.page(query);

/** passport-jwt 回调：token 有效 ≠ 账号有效，实时查库并拒绝 disabled */
const loadUserForToken = async (id) => {
  const user = await userRepository.getById(id);
  if (!user || user.status === 'disabled') return null;
  return user;
};

/**
 * 仓储的 page() 只认 `filters`（等值条件）+ 平铺的 `keyword/page/size/sort`，
 * 所以 role/status 必须收进 filters 再传——直接 spread 平铺会被静默丢掉（列表筛不出角色/状态）。
 */
const listUsers = (query = {}) => {
  const { keyword, role, status, page, size, sort } = query;
  return userRepository.page({
    keyword,
    page,
    size,
    filters: { role, status },
    sort: sort || 'createdAt:desc',
  });
};

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
  // 1.9.5 文档权限：开通即自动生成 key（已有则保留），关闭立即清空——key 生命周期绑定权限位
  if (body.docAccess !== undefined) {
    if (typeof body.docAccess !== 'boolean') throw paramInvalid('docAccess 仅支持 true|false');
    if (body.docAccess) {
      patch.docAccess = true;
      if (!target.docKey) {
        patch.docKey = generateDocKey();
        patch.docKeyUpdatedAt = new Date().toISOString();
      }
    } else {
      patch.docAccess = false;
      patch.docKey = null;
      patch.docKeyUpdatedAt = null;
    }
  }
  // 问数对外服务（契约 1.12 增补）：与 docAccess 同构，key 绑定权限位
  if (body.chatAccess !== undefined) {
    if (typeof body.chatAccess !== 'boolean') throw paramInvalid('chatAccess 仅支持 true|false');
    if (body.chatAccess) {
      patch.chatAccess = true;
      if (!target.chatKey) {
        patch.chatKey = generateChatKey();
        patch.chatKeyUpdatedAt = new Date().toISOString();
      }
    } else {
      patch.chatAccess = false;
      patch.chatKey = null;
      patch.chatKeyUpdatedAt = null;
    }
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
  pageLoginLogs,
  DOC_KEY_PREFIX,
  CHAT_KEY_PREFIX,
  maskChatKey,
  getChatKey,
  refreshChatKey,
  resolveChatKey,
  maskDocKey,
  getDocKey,
  refreshDocKey,
  resolveDocKey,
  recordDocAccess,
  pageDocAccessLogs,
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
