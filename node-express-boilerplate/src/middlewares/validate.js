const Joi = require('joi');
const pick = require('../utils/pick');
const { paramInvalid } = require('../utils/bizError');

const validate = (schema) => (req, res, next) => {
  const validSchema = pick(schema, ['params', 'query', 'body']);
  const object = pick(req, Object.keys(validSchema));
  const { value, error } = Joi.compile(validSchema)
    .prefs({ errors: { label: 'key' }, abortEarly: false })
    .validate(object);

  if (error) {
    const errorMessage = error.details.map((details) => details.message).join(', ');
    // 契约：参数校验失败 → HTTP 400 + 业务码 40001，message 带「参数校验失败: 」前缀
    return next(paramInvalid(errorMessage));
  }
  Object.assign(req, value);
  return next();
};

module.exports = validate;
