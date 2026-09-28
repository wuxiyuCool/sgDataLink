// 平台账号与用户管理（契约 1.11，替代脚手架 mongoose auth 链）
module.exports.accountService = require('./account.service');
// DataBridge 管理后端（内存 mock）
module.exports.datasourceService = require('./datasource.service');
module.exports.syncTaskService = require('./syncTask.service');
module.exports.taskInstanceService = require('./taskInstance.service');
module.exports.engineReportService = require('./engineReport.service');
// 「可运行体」公共编排（start/stop/progress + cron 触发 + 失败重试），被下面几个 service 复用
module.exports.runService = require('./run.service');
module.exports.pipelineService = require('./pipeline.service');
module.exports.dataflowService = require('./dataflow.service');
module.exports.dataApiService = require('./dataApi.service');
module.exports.dataApiRuntimeService = require('./dataApiRuntime.service');
module.exports.alertService = require('./alert.service');
module.exports.lineageService = require('./lineage.service');
module.exports.schedulerService = require('./scheduler.service');
