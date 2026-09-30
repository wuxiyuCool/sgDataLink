import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'
import type {
  ApiDoc,
  DataApi,
  DataApiCallItem,
  DataApiCallPageParams,
  DataApiInvokeParams,
  DataApiInvokeResult,
  DataApiMetaColumnsParams,
  DataApiMetaTablesParams,
  DataApiPageParams,
  DataApiPayload,
  DataApiPublishResult,
  DataApiStats,
  MetaColumn,
  MetaTable,
  SwaggerDocParams,
  SwaggerSpec,
} from './model/dataapiModel'

enum Api {
  DataApi = '/data-apis',
  Calls = '/data-apis/calls',
  Swagger = '/data-apis/swagger.json',
  MetaTables = '/data-apis/meta/tables',
  MetaColumns = '/data-apis/meta/columns',
}

/**
 * @description: 数据服务分页列表（契约 1.9），支持 keyword / status
 */
export function getDataApiListApi(params: DataApiPageParams) {
  return databridgeHttp.get<DatabridgePageResult<DataApi>>({ url: Api.DataApi, params })
}

/**
 * @description: 调用明细日志分页（契约 1.9，审计查询页）：GET /data-apis/calls
 * 支持 apiId / result(success|error) / apiName(服务名或路径模糊) / content(调用内容模糊) /
 * startTime|endTime(ISO 闭区间)；返回 { items, total }；
 * 后端滚动保留最近 5000 条，query 中的 apiKey 已脱敏。
 */
export function getApiCallsApi(params: DataApiCallPageParams = {}) {
  return databridgeHttp.get<DatabridgePageResult<DataApiCallItem>>({ url: Api.Calls, params })
}

/**
 * @description: 数据服务详情
 */
export function getDataApiItemApi(id: string) {
  return databridgeHttp.get<DataApi>({ url: `${Api.DataApi}/${id}` })
}

/**
 * @description: 新增数据服务
 */
export function createDataApiItemApi(data: DataApiPayload) {
  return databridgeHttp.post<DataApi>({ url: Api.DataApi, data })
}

/**
 * @description: 编辑数据服务（已发布对象编辑后仍为 published，是否需重新发布由后端决定）
 */
export function updateDataApiItemApi(id: string, data: DataApiPayload) {
  return databridgeHttp.put<DataApi>({ url: `${Api.DataApi}/${id}`, data })
}

/**
 * @description: 删除数据服务
 */
export function deleteDataApiItemApi(id: string) {
  return databridgeHttp.delete<boolean>({ url: `${Api.DataApi}/${id}` })
}

/**
 * @description: 发布（生成 apiKey，状态 published）。
 * Mock 阶段后端列表接口不脱敏，这里返回的是新生成（或沿用）的完整 apiKey；
 * 已发布时后端按幂等处理，沿用原 key，不会打断已接入的调用方。
 */
export function publishDataApiApi(id: string) {
  return databridgeHttp.post<DataApiPublishResult>({ url: `${Api.DataApi}/${id}/publish` })
}

/**
 * @description: 下线（状态回到 draft，运行时端点返回 404/40404）
 */
export function unpublishDataApiApi(id: string) {
  return databridgeHttp.post<DataApiPublishResult>({ url: `${Api.DataApi}/${id}/unpublish` })
}

/**
 * @description: 前端「调试」按钮的代理调用。
 * 运行时端点 GET /ds/{path} 不在管理前缀内且需 X-API-Key，
 * 因此浏览器侧统一走管理端代理，由后端带上鉴权与限流计数。
 */
export function invokeDataApiApi(id: string, data: DataApiInvokeParams) {
  return databridgeHttp.post<DataApiInvokeResult>({ url: `${Api.DataApi}/${id}/invoke`, data })
}

/**
 * @description: 调用统计（invokeCount / errorCount / avgLatencyMs / recentTrend 最近 7 天）
 */
export function getDataApiStatsApi(id: string) {
  return databridgeHttp.get<DataApiStats>({ url: `${Api.DataApi}/${id}/stats` })
}

/**
 * @description: 元数据浏览：列出数据源可查表（契约 1.9.1）。
 * 真实模式查 information_schema / ALL_TABLES，memory 模式返回内置演示表；
 * 数据源不存在 40401，元数据查询失败 50003（透传真实库错误）。
 */
export function getMetaTablesApi(params: DataApiMetaTablesParams) {
  return databridgeHttp.get<MetaTable[]>({ url: Api.MetaTables, params })
}

/**
 * @description: 元数据浏览：列出表字段（契约 1.9.1），tableName 需过标识符白名单（后端强制）。
 */
export function getMetaColumnsApi(params: DataApiMetaColumnsParams) {
  return databridgeHttp.get<MetaColumn[]>({ url: Api.MetaColumns, params })
}

/**
 * @description: 1.9.4 Swagger 文档中心：GET /data-apis/swagger.json（JWT）。
 * 响应是 OpenAPI 3.0 spec 本体、不套统一信封，因此关闭 transform；
 * status=all（含草稿）仅 admin，keyword 按 path/名称模糊过滤（服务端执行）。
 */
export function getSwaggerDocApi(params: SwaggerDocParams = {}) {
  return databridgeHttp.get<SwaggerSpec>(
    { url: Api.Swagger, params },
    { isTransformResponse: false },
  )
}

/**
 * @description: 1.9.4 取单个服务的文档配置（GET /data-apis/:id/doc，JWT）。
 * 未填过时后端按当前定义返回模板（不落库）。
 */
export function getDataApiDocApi(id: string) {
  return databridgeHttp.get<ApiDoc>({ url: `${Api.DataApi}/${id}/doc` })
}

/**
 * @description: 1.9.4 保存文档配置（PUT /data-apis/:id/doc，仅 admin）。
 */
export function updateDataApiDocApi(id: string, data: ApiDoc) {
  return databridgeHttp.put<ApiDoc>({ url: `${Api.DataApi}/${id}/doc`, data })
}
