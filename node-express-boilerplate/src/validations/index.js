module.exports.authValidation = require('./auth.validation');
module.exports.userValidation = require('./user.validation');
// DataBridge 管理后端（内存 mock）
module.exports.datasourceValidation = require('./datasource.validation');
module.exports.taskValidation = require('./task.validation');
module.exports.taskInstanceValidation = require('./taskInstance.validation');
module.exports.engineValidation = require('./engine.validation');
// FineDataLink 对标的四个新模块（docs/API.md 1.7~1.10）
module.exports.pipelineValidation = require('./pipeline.validation');
module.exports.dataflowValidation = require('./dataflow.validation');
module.exports.dataapiValidation = require('./dataapi.validation');
module.exports.alertruleValidation = require('./alertrule.validation');
module.exports.alertrecordValidation = require('./alertrecord.validation');
