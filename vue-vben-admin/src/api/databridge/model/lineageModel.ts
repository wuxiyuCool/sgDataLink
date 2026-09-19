/**
 * 数据血缘（契约 1.10 /lineage/graph）
 * 由数据源 + 任务 + 管道 + 数据开发 + 数据服务聚合生成的表级血缘图。
 */
export type LineageNodeType = 'datasource' | 'table' | 'task' | 'pipeline' | 'dataflow' | 'dataapi'

export interface LineageNode {
  /** 数据源为 ds-xxxx，表为 ds-xxxx:TABLE，其余为各自对象 id */
  id: string
  type: LineageNodeType
  name: string
}

export interface LineageEdge {
  source: string
  target: string
  /** 后端可能不带 label，前端按节点类型推导 */
  label?: string
}

export interface LineageGraph {
  nodes: LineageNode[]
  edges: LineageEdge[]
}

/** 查询参数：契约未定义筛选条件，keyword 作为可选的服务端过滤预留 */
export interface LineageGraphParams {
  keyword?: string
}
