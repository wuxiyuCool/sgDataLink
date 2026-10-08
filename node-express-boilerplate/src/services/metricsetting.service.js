/**
 * 指标中心系统配置服务（契约 1.12）：
 * 读优先级 metric_setting 表 > env（LLM_*）；apiKey 掩码回显（仿 docKey 做法）。
 * M5 的 ChatBI 通过 getLlmConfig() 拿生效配置。
 */
const { paramInvalid } = require('../utils/bizError');
const metricSettingRepository = require('../repositories/metricsetting.repository');
const logger = require('../config/logger');

/** 配置白名单：secret=true 的项接口只回掩码 */
const SETTING_DEFS = [
  { key: 'llm.baseUrl', env: 'LLM_BASE_URL', secret: false, default: '' },
  { key: 'llm.apiKey', env: 'LLM_API_KEY', secret: true, default: '' },
  { key: 'llm.model', env: 'LLM_MODEL', secret: false, default: 'deepseek-chat' },
  { key: 'llm.timeoutMs', env: 'LLM_TIMEOUT_MS', secret: false, default: '30000' },
  { key: 'llm.embed.enabled', env: 'LLM_EMBED_ENABLED', secret: false, default: '0' },
  { key: 'llm.embedModel', env: 'LLM_EMBED_MODEL', secret: false, default: '' },
];

const KNOWN_KEYS = new Set(SETTING_DEFS.map((def) => def.key));
const SECRET_KEYS = new Set(SETTING_DEFS.filter((def) => def.secret).map((def) => def.key));

const mask = (value) => {
  const text = String(value || '');
  if (!text) return null;
  return `${text.slice(0, Math.min(6, text.length))}***`;
};

/** 单项配置的生效值与来源：表 > env > 默认（避免嵌套三元） */
const effectiveOf = (def, storeMap) => {
  const stored = storeMap.get(def.key);
  if (stored && stored.settingValue !== '') {
    return { value: stored.settingValue, source: 'table' };
  }
  const envValue = process.env[def.env];
  if (envValue) return { value: envValue, source: 'env' };
  return { value: def.default, source: 'default' };
};

/** GET /metric-settings：合并表值与 env 回落，secret 项只回掩码 */
const getSettings = async () => {
  const stored = await metricSettingRepository.list();
  const storeMap = new Map(stored.map((item) => [item.settingKey, item]));
  const items = SETTING_DEFS.map((def) => {
    const effective = effectiveOf(def, storeMap);
    return {
      settingKey: def.key,
      source: effective.source,
      hasValue: Boolean(effective.value),
      value: SECRET_KEYS.has(def.key) ? mask(effective.value) : effective.value,
    };
  });
  return { items };
};

/** 嵌套 {llm:{model}} -> 点分 {'llm.model'}；mongo-sanitize 全局拆点键，契约按嵌套定义 */
const flattenSettings = (obj, base = '') =>
  Object.entries(obj).reduce((acc, [key, value]) => {
    const path = base ? `${base}.${key}` : key;
    if (value !== null && typeof value === 'object') return acc.concat(flattenSettings(value, path));
    return acc.concat([[path, value]]);
  }, []);

/**
 * PUT /metric-settings：{ settings: { llm: { model: 'xxx', embed: { enabled: '0' } } } }
 * 值传空串 = 保持不变（契约 1.12）；扁平化后未识别 key 40001。
 */
const updateSettings = async (settings = {}, operator = '') => {
  const entries = flattenSettings(settings);
  if (!entries.length) throw paramInvalid('settings 不能为空');
  const unknown = entries.filter(([key]) => !KNOWN_KEYS.has(key)).map(([key]) => key);
  if (unknown.length) throw paramInvalid(`未识别的配置项: ${unknown.join(', ')}`);
  const writable = entries.filter(([key, rawValue]) => {
    const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
    if (value === '') return false;
    if (SECRET_KEYS.has(key) && /\*\*\*$/.test(value)) {
      // 掩码回填（前端把回显值原样 PUT 回来）：视为未修改
      logger.warn('metric setting %s 提交的是掩码值，已忽略', key);
      return false;
    }
    return true;
  });
  await Promise.all(
    writable.map(([key, rawValue]) =>
      metricSettingRepository.upsert({
        settingKey: key,
        settingValue: String(rawValue),
        secret: SECRET_KEYS.has(key),
        updatedBy: operator,
      })
    )
  );
  return { updated: writable.map(([key]) => key) };
};

/** 生效配置读取（ChatBI / 建模 LLM 辅助用）：表 > env > 默认 */
const getLlmConfig = async () => {
  const stored = await metricSettingRepository.list();
  const storeMap = new Map(stored.map((item) => [item.settingKey, item.settingValue]));
  const valueOf = (def) => {
    const tableValue = storeMap.get(def.key);
    if (tableValue !== undefined && tableValue !== '') return tableValue;
    return process.env[def.env] || def.default;
  };
  const reduceOf = (key) => Number(valueOf(SETTING_DEFS.find((def) => def.key === key))) || 30000;
  const result = {
    baseUrl: valueOf(SETTING_DEFS[0]).replace(/\/+$/, ''),
    apiKey: valueOf(SETTING_DEFS[1]),
    model: valueOf(SETTING_DEFS[2]),
    timeoutMs: reduceOf('llm.timeoutMs'),
    embedEnabled: valueOf(SETTING_DEFS[4]) === '1' || valueOf(SETTING_DEFS[4]) === 'true',
    embedModel: valueOf(SETTING_DEFS[5]),
  };
  return result;
};

module.exports = { SETTING_DEFS, getSettings, updateSettings, getLlmConfig };
