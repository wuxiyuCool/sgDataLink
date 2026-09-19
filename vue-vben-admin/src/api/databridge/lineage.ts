import { databridgeHttp } from './http'
import type { LineageGraph, LineageGraphParams } from './model/lineageModel'

enum Api {
  LineageGraph = '/lineage/graph',
}

/**
 * @description: 表级血缘图（契约 1.10）：
 * 由数据源 + 任务 + 管道 + 数据开发 + 数据服务聚合生成，
 * nodes 为 { id, type, name }，edges 方向 source → target 表示数据流向。
 */
export function getLineageGraphApi(params?: LineageGraphParams) {
  return databridgeHttp.get<LineageGraph>({ url: Api.LineageGraph, params })
}
