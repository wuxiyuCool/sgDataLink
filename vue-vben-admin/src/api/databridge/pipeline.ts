import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'
import type {
  Pipeline,
  PipelineActionResult,
  PipelinePageParams,
  PipelinePayload,
  PipelineStatusResult,
} from './model/pipelineModel'

enum Api {
  Pipeline = '/pipelines',
}

/**
 * @description: 管道分页列表（契约 1.7），支持 keyword / status
 */
export function getPipelineListApi(params: PipelinePageParams) {
  return databridgeHttp.get<DatabridgePageResult<Pipeline>>({ url: Api.Pipeline, params })
}

/**
 * @description: 管道详情
 */
export function getPipelineApi(id: string) {
  return databridgeHttp.get<Pipeline>({ url: `${Api.Pipeline}/${id}` })
}

/**
 * @description: 供血缘 / 下拉使用的一次性拉取
 */
export function getAllPipelinesApi(keyword?: string) {
  return databridgeHttp
    .get<DatabridgePageResult<Pipeline>>({
      url: Api.Pipeline,
      params: { page: 1, size: 500, keyword },
    })
    .then((res) => res?.items ?? [])
}

/**
 * @description: 新增管道（status 由后端默认置为 stopped，不随请求体提交）
 */
export function createPipelineApi(data: PipelinePayload) {
  return databridgeHttp.post<Pipeline>({ url: Api.Pipeline, data })
}

/**
 * @description: 编辑管道（running 中后端返回 40003）
 */
export function updatePipelineApi(id: string, data: PipelinePayload) {
  return databridgeHttp.put<Pipeline>({ url: `${Api.Pipeline}/${id}`, data })
}

/**
 * @description: 删除管道（running 中后端返回 40003）
 */
export function deletePipelineApi(id: string) {
  return databridgeHttp.delete<boolean>({ url: `${Api.Pipeline}/${id}` })
}

/**
 * @description: 启动管道 → 引擎 cdc 模式
 */
export function startPipelineApi(id: string) {
  return databridgeHttp.post<PipelineActionResult>({ url: `${Api.Pipeline}/${id}/start` })
}

/**
 * @description: 停止管道
 */
export function stopPipelineApi(id: string) {
  return databridgeHttp.post<PipelineActionResult>({ url: `${Api.Pipeline}/${id}/stop` })
}

/**
 * @description: 管道实时状态（QPS / 延迟 / 位点），列表页对 running 行 3 秒轮询
 */
export function getPipelineStatusApi(id: string) {
  return databridgeHttp.get<PipelineStatusResult>({ url: `${Api.Pipeline}/${id}/status` })
}
