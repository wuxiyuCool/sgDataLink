module.exports.authController = require('./auth.controller');
module.exports.userController = require('./user.controller');
// DataBridge 管理后端（内存 mock）
module.exports.healthController = require('./health.controller');
module.exports.datasourceController = require('./datasource.controller');
module.exports.taskController = require('./task.controller');
module.exports.taskInstanceController = require('./taskInstance.controller');
module.exports.statisticsController = require('./statistics.controller');
module.exports.engineController = require('./engine.controller');
// FineDataLink 对标的四个新模块（docs/API.md 1.7~1.10）
module.exports.pipelineController = require('./pipeline.controller');
module.exports.dataflowController = require('./dataflow.controller');
module.exports.dataapiController = require('./dataapi.controller');
module.exports.dsController = require('./ds.controller');
module.exports.alertruleController = require('./alertrule.controller');
module.exports.alertrecordController = require('./alertrecord.controller');
module.exports.lineageController = require('./lineage.controller');
