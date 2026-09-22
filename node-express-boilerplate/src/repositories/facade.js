/**
 * 仓储门面（双驱动装配点）。
 *
 * 每个 `<name>.repository.js` 保留内存实现，然后在出口处调一次 pickImpl()：
 *   module.exports = pickImpl('<name>', memoryImpl);
 * 于是 service 层 require 到的对象在 DB_DRIVER=memory 时是内存实现、
 * 在 DB_DRIVER=mysql 时是 src/repositories/mysql/<name>.store.js，
 * 两边方法名一一对应、返回结构一一对应，唯一差别是这里统一包成 Promise
 * （内存实现本来同步返回对象，包装后 await 一样能拿到同样的克隆对象）。
 *
 * 为什么统一返回 Promise 而不是「memory 同步 / mysql 异步」：
 * 后者会让 service 里出现两套写法，异步化只能做一次，所以门面层把差异吃掉。
 */
const config = require('../config/config');

/**
 * 驱动名 -> mysql store 的懒加载器。
 * 用字面量 require 写死，既避免 import/no-dynamic-require，
 * 也保证 memory 模式下不会把 mysql2 与 10 个 store 拉进模块图（global-require 在这里是有意为之）。
 */
/* eslint-disable global-require */
const MYSQL_STORES = {
  datasource: () => require('./mysql/datasource.store'),
  task: () => require('./mysql/task.store'),
  instance: () => require('./mysql/instance.store'),
  log: () => require('./mysql/log.store'),
  offset: () => require('./mysql/offset.store'),
  pipeline: () => require('./mysql/pipeline.store'),
  dataflow: () => require('./mysql/dataflow.store'),
  dataapi: () => require('./mysql/dataapi.store'),
  alertrule: () => require('./mysql/alertrule.store'),
  alertrecord: () => require('./mysql/alertrecord.store'),
};

/** 把实现对象的函数全部包一层，保证签名统一返回 Promise（非函数属性原样保留） */
const asyncify = (impl) => {
  const wrapped = {};
  Object.keys(impl).forEach((key) => {
    const value = impl[key];
    if (typeof value === 'function') {
      wrapped[key] = async (...args) => value(...args);
    } else {
      wrapped[key] = value;
    }
  });
  return wrapped;
};

/**
 * 按 config.db.driver 选实现。
 * @param {string} name 仓储名（同时是 mysql/<name>.store.js 的文件名）
 * @param {Object} memoryImpl 内存实现
 * @returns {Object} 方法签名统一返回 Promise 的门面对象
 */
const pickImpl = (name, memoryImpl) => {
  if (config.db.driver === 'mysql' && MYSQL_STORES[name]) {
    return asyncify(MYSQL_STORES[name]());
  }
  return asyncify(memoryImpl);
};

module.exports = {
  MYSQL_STORES,
  asyncify,
  pickImpl,
};
