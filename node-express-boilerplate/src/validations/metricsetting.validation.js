const Joi = require('joi');

/** 系统配置（契约 1.12）：key 白名单，值空串=保持不变 */

const SETTING_KEYS = ['llm.baseUrl', 'llm.apiKey', 'llm.model', 'llm.timeoutMs', 'llm.embed.enabled', 'llm.embedModel'];

const updateSettings = {
  body: Joi.object()
    .keys({
      // 契约 1.12：嵌套形态提交（全局 mongo-sanitize 会拆点分键），服务端扁平化后按 SETTING_KEYS 白名单校验
      settings: Joi.object().unknown(true).min(1).required(),
    })
    .required(),
};

const getSettings = { query: Joi.object().unknown(true) };

module.exports = { getSettings, updateSettings, SETTING_KEYS };
