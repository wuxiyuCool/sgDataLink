import type { DatabridgePageParams, TaskLastStatus, WriteMode } from './commonModel'
import type { FieldMapping, TaskProgress } from './taskModel'

/**
 * 画布节点类型（契约 1.8 组件清单）
 * Mock 阶段仅保存 / 回显，run 时取首尾 input/output 拼引擎快照
 */
export type DataflowNodeType =
  | 'input'
  | 'output'
  | 'filter'
  | 'transform'
  | 'join'
  | 'union'
  | 'sql'
  | 'json_parse'
  | 'validate'

/**
 * 节点配置：不同 type 使用不同子集，后端只校验 config 为对象，
 * 因此画布坐标也放在 config 内（__x / __y），见 views/databridge/dataflow/flowGraph.ts
 */
export interface DataflowNodeConfig {
  /** input / output：数据源与表 */
  datasourceId?: string
  table?: string
  /** output：写入策略 */
  writeMode?: WriteMode
  /** filter：过滤条件表达式 */
  condition?: string
  /** union：合并的上游节点 id（多个用逗号分隔） */
  sources?: string
  /** sql：自定义 SQL */
  sql?: string
  /** json_parse：待解析字段 */
  field?: string
  /** json_parse：JSONPath 表达式 */
  path?: string
  /** validate：质量规则，每行一条 */
  rules?: string[]
  /** join：关联方式与关联键 */
  joinType?: 'left' | 'right' | 'inner' | 'full'
  on?: string
  /** transform：复用字段映射编辑器 */
  mappings?: FieldMapping[]
  /** 画布坐标（前端扩展键，随 nodes 一并保存，回显时恢复布局） */
  __x?: number
  __y?: number
}

export interface DataflowNode {
  id: string
  type: DataflowNodeType
  name: string
  config: DataflowNodeConfig
}

export interface DataflowEdge {
  source: string
  target: string
}

export interface Dataflow {
  id?: string
  name: string
  nodes: DataflowNode[]
  edges: DataflowEdge[]
  /** Quartz 风格 6 位 cron，null 表示仅手动触发 */
  scheduleCron?: string | null
  retryCount?: number
  retryIntervalSec?: number
  enabled?: boolean
  lastStatus?: TaskLastStatus
  createdAt?: string | null
  updatedAt?: string | null
  /** 列表页通过 /dataflows/:id/progress 聚合补充，后端对象不含该字段 */
  progress?: number
  runningInstanceId?: string
  /** 节点数量摘要，列表页展示用（前端计算） */
  nodeCount?: number
}

/**
 * 创建 / 编辑数据开发的请求体（契约 1.8）。
 * 后端与任务同风格做严格校验，id / lastStatus / createdAt 等响应侧字段不回传。
 */
export interface DataflowPayload {
  name: string
  nodes: DataflowNode[]
  edges: DataflowEdge[]
  scheduleCron?: string | null
  retryCount?: number
  retryIntervalSec?: number
  enabled?: boolean
}

export interface DataflowPageParams extends DatabridgePageParams {
  lastStatus?: TaskLastStatus
}

/** POST /dataflows/:id/run、/:id/stop 的返回（契约 1.8） */
export interface DataflowRunResult {
  dataflowId: string
  instanceId: string
  status: TaskLastStatus | 'running'
}

/** GET /dataflows/:id/progress：结构同任务 progress，taskId 换成 dataflowId */
export interface DataflowProgress extends Omit<TaskProgress, 'taskId'> {
  dataflowId: string
}
