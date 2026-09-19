import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'
import type {
  Dataflow,
  DataflowPageParams,
  DataflowPayload,
  DataflowProgress,
  DataflowRunResult,
} from './model/dataflowModel'

enum Api {
  Dataflow = '/dataflows',
}

/**
 * @description: 数据开发分页列表（契约 1.8），支持 keyword / lastStatus
 */
export function getDataflowListApi(params: DataflowPageParams) {
  return databridgeHttp.get<DatabridgePageResult<Dataflow>>({ url: Api.Dataflow, params })
}

/**
 * @description: 数据开发详情（含画布 nodes / edges）
 */
export function getDataflowApi(id: string) {
  return databridgeHttp.get<Dataflow>({ url: `${Api.Dataflow}/${id}` })
}

/**
 * @description: 供下拉选择使用的一次性拉取
 */
export function getAllDataflowsApi(keyword?: string) {
  return databridgeHttp
    .get<DatabridgePageResult<Dataflow>>({
      url: Api.Dataflow,
      params: { page: 1, size: 500, keyword },
    })
    .then((res) => res?.items ?? [])
}

/**
 * @description: 新增数据开发（保存画布 JSON）
 */
export function createDataflowApi(data: DataflowPayload) {
  return databridgeHttp.post<Dataflow>({ url: Api.Dataflow, data })
}

/**
 * @description: 编辑数据开发（running 中后端返回 40003）
 */
export function updateDataflowApi(id: string, data: DataflowPayload) {
  return databridgeHttp.put<Dataflow>({ url: `${Api.Dataflow}/${id}`, data })
}

/**
 * @description: 删除数据开发（running 中后端返回 40003）
 */
export function deleteDataflowApi(id: string) {
  return databridgeHttp.delete<boolean>({ url: `${Api.Dataflow}/${id}` })
}

/**
 * @description: 模拟运行 → 创建实例，返回 { dataflowId, instanceId, status }
 */
export function runDataflowApi(id: string) {
  return databridgeHttp.post<DataflowRunResult>({ url: `${Api.Dataflow}/${id}/run` })
}

/**
 * @description: 停止运行中的画布
 */
export function stopDataflowApi(id: string) {
  return databridgeHttp.post<DataflowRunResult>({ url: `${Api.Dataflow}/${id}/stop` })
}

/**
 * @description: 运行进度（结构同任务 progress，taskId 换 dataflowId）
 */
export function getDataflowProgressApi(id: string) {
  return databridgeHttp.get<DataflowProgress>({ url: `${Api.Dataflow}/${id}/progress` })
}
