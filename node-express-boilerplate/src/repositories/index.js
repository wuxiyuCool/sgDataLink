/**
 * DataBridge 内存仓储聚合入口（对应脚手架 models/index.js 的角色）。
 *
 * 【第二阶段替换点】这里换成 pg 实现的仓储导出，名称保持一致即可，
 * service 层 `require('../repositories')` 不需要改动。
 */
module.exports.datasourceRepository = require('./datasource.repository');
module.exports.taskRepository = require('./task.repository');
module.exports.instanceRepository = require('./instance.repository');
module.exports.offsetRepository = require('./offset.repository');
module.exports.logRepository = require('./log.repository');
// FineDataLink 对标的四个新模块（docs/API.md 1.7~1.10）
module.exports.pipelineRepository = require('./pipeline.repository');
module.exports.dataflowRepository = require('./dataflow.repository');
module.exports.dataapiRepository = require('./dataapi.repository');
module.exports.alertruleRepository = require('./alertrule.repository');
module.exports.alertrecordRepository = require('./alertrecord.repository');
module.exports.memoryStore = require('./memoryStore');
module.exports.seed = require('./seed').seedMockData;
