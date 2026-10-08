/**
 * 指标中心系统配置仓储（内存实现，契约 1.12）。
 * key-value 语义（无字符串 id 前缀）：settingKey 主键，upsert 覆盖。
 */
const { nowIso } = require('./memoryStore');

const data = new Map();

const list = () => [...data.values()].map((item) => ({ ...item }));

const getByKey = (settingKey) => {
  const found = data.get(String(settingKey));
  return found ? { ...found } : null;
};

const upsert = ({ settingKey, settingValue, secret = false, updatedBy = '' }) => {
  const record = {
    settingKey: String(settingKey),
    settingValue: String(settingValue),
    secret: Boolean(secret),
    updatedBy,
    updatedAt: nowIso(),
  };
  data.set(record.settingKey, record);
  return { ...record };
};

const remove = (settingKey) => data.delete(String(settingKey));

const clear = () => {
  data.clear();
  return true;
};

const memoryImpl = { list, getByKey, upsert, remove, clear };

module.exports = require('./facade').pickImpl('metricsetting', memoryImpl);
