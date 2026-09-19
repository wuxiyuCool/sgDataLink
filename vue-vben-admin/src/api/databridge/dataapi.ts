import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'
import type {
  DataApi,
  DataApiInvokeParams,
  DataApiInvokeResult,
  DataApiPageParams,
  DataApiPayload,
  DataApiPublishResult,
  DataApiStats,
} from './model/dataapiModel'

enum Api {
  DataApi = '/data-apis',
}

/**
 * @description: 数据服务分页列表（契约 1.9），支持 keyword / status
 */
export function getDataApiListApi(params: DataApiPageParams) {
  return databridgeHttp.get<DatabridgePageResult<DataApi>>({ url: Api.DataApi, params })
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
