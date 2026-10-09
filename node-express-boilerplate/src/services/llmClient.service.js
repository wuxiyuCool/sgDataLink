/**
 * LLM 客户端（契约 1.12 M5）：只实现 OpenAI 兼容协议一套客户端，
 * baseUrl+model+key 三元组切供应商（DeepSeek/通义/GLM/硅基流动/Ollama）。
 * 配置来源 metric_setting 表 > env（metricsetting.getLlmConfig）。
 *
 * 注意：deepseek-flash 等推理模型把 token 花在 reasoning_content 上，
 * max_tokens 必须给足预算（默认 2048），答案只读 message.content。
 *
 * 出站走 utils/proxyAgent 而不是全局 fetch：Node 18 的 fetch(undici) 不读
 * HTTPS_PROXY，内网容器经 squid 出口访问外网 LLM API 时会直连超时。
 */
const config = require('../config/config');
const { bizError } = require('../utils/bizError');
const { requestJson } = require('../utils/proxyAgent');
const metricSettingService = require('./metricsetting.service');

const llmError = (message) => bizError(50000, message);

/**
 * @param {Array} messages OpenAI messages 数组
 * @param {Object} [opts] { maxTokens, temperature }
 * @returns {Promise<{content:string, finishReason:string, usage:Object}>}
 */
const chatCompletion = async (messages, opts = {}) => {
  const conf = await metricSettingService.getLlmConfig();
  if (!conf.baseUrl || !conf.apiKey || !conf.model) {
    throw llmError('LLM 未配置：请到「指标中心→系统配置」填写 Base URL / 模型 / API Key');
  }
  const base = String(conf.baseUrl).replace(/\/+$/, '');
  const target = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const timeoutMs = conf.timeoutMs || 30000;
  let response;
  try {
    response = await requestJson(target, {
      method: 'POST',
      timeoutMs,
      headers: { authorization: `Bearer ${conf.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: conf.model,
        messages,
        temperature: opts.temperature === undefined ? 0.1 : opts.temperature,
        max_tokens: opts.maxTokens || 2048,
      }),
    });
  } catch (err) {
    throw llmError(`LLM 服务不可达: ${err.message}（${base}）`);
  }
  const { status: httpStatus, text } = response;
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    /* 非 JSON 错误页 */
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    const detail = body.error && body.error.message ? body.error.message : String(text || '').slice(0, 200);
    throw llmError(`LLM 返回 ${httpStatus}: ${detail}`);
  }
  const choice = (body.choices || [])[0] || {};
  return {
    content: String((choice.message && choice.message.content) || '').trim(),
    finishReason: choice.finish_reason || null,
    usage: body.usage || {},
    model: conf.model,
    env: config.env,
  };
};

module.exports = { chatCompletion };
