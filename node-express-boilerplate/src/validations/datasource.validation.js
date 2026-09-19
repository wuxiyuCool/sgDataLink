const Joi = require('joi');

/**
 * 数据源校验（docs/API.md 第 1.1 节）。
 * 校验失败由 middlewares/validate.js 统一转成 400 + 业务码 40001。
 */

const TYPES = ['oracle', 'mysql', 'postgresql'];
const STATUSES = ['enabled', 'disabled'];

const id = Joi.string().trim().max(64).required();

const baseKeys = {
  name: Joi.string().trim().min(1).max(64),
  type: Joi.string().valid(...TYPES),
  host: Joi.string().trim().min(1).max(128),
  port: Joi.number().integer().min(1).max(65535),
  database: Joi.string().trim().min(1).max(128),
  username: Joi.string().trim().min(1).max(64),
  // 响应里 password 永远是脱敏值 "***"，请求体允许明文或脱敏值（脱敏表示「不修改」）
  password: Joi.string().max(256).allow(''),
  remark: Joi.string().trim().max(255).allow('', null),
  status: Joi.string().valid(...STATUSES),
};

/**
 * 请求体允许的键 = baseKeys + 可选 id。
 * 契约 1.1 的数据源对象本身含 id，前端编辑与「连通测试」会把整行回传，
 * 所以 body 统一接受 id（services/datasource.service.js 的 create/update 里会 delete payload.id，
 * 真正落库的 id 只取路径参数）。
 */
const bodyKeys = { ...baseKeys, id: Joi.string().trim().max(64).allow('') };

const listDataSources = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      type: Joi.string().valid(...TYPES),
      status: Joi.string().valid(...STATUSES),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getDataSource = {
  params: Joi.object().keys({ id }),
};

const createDataSource = {
  body: Joi.object()
    .keys({
      ...bodyKeys,
      name: baseKeys.name.required(),
      type: baseKeys.type.required(),
      host: baseKeys.host.required(),
      port: baseKeys.port.required(),
      database: baseKeys.database.required(),
      username: baseKeys.username.required(),
      password: baseKeys.password.required(),
    })
    .required(),
};

const updateDataSource = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys(bodyKeys).min(1),
};

const deleteDataSource = {
  params: Joi.object().keys({ id }),
};

/** POST /datasources/test：可传未保存的完整配置（id 可选，用于取回已存明文密码） */
const testDataSource = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      id: Joi.string().trim().max(64).allow(''),
    })
    .or('name', 'id')
    .required(),
};

const testDataSourceById = {
  params: Joi.object().keys({ id }),
};

module.exports = {
  listDataSources,
  getDataSource,
  createDataSource,
  updateDataSource,
  deleteDataSource,
  testDataSource,
  testDataSourceById,
};
