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
module.exports.dataApiService = require('./dataapi.service');
module.exports.dataApiRuntimeService = require('./dataApiRuntime.service');
// 1.9.4 Swagger 文档中心（OpenAPI 3.0 生成）
module.exports.swaggerService = require('./swagger.service');
module.exports.alertService = require('./alert.service');
module.exports.lineageService = require('./lineage.service');
module.exports.schedulerService = require('./scheduler.service');
// 指标中心（契约 1.12）
module.exports.metricDomainService = require('./metricdomain.service');
module.exports.metricModelService = require('./metricmodel.service');
// 建模分层树与分类（契约 1.16）
module.exports.metricModelCategoryService = require('./metricmodelcategory.service');
module.exports.metricSettingService = require('./metricsetting.service');
module.exports.metricDashboardService = require('./metricdashboard.service');
module.exports.metricService = require('./metric.service');
// 指标广场与批量生成（契约 1.14）
module.exports.metricPlazaService = require('./metricplaza.service');
// 维度取值档案与码值登记（契约 1.14）
module.exports.metricDimService = require('./metricdim.service');
module.exports.metricCompilerService = require('./metricCompiler.service');
module.exports.metricExecService = require('./metricExec.service');
module.exports.metricTaskService = require('./metrictask.service');
module.exports.metricChatService = require('./metricChat.service');
