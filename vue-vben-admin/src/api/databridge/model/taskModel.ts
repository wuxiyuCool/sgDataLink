import type {
  DatabridgePageParams,
  EnabledStatus,
  InstanceTrigger,
  SyncMode,
  TaskLastStatus,
  WriteMode,
} from './commonModel'

/** 字段转换类型（契约 1.2）：none 与 transform = null 等价，Mock 阶段仅保存回显 */
export type FieldTransformType = 'none' | 'upper' | 'lower' | 'trim' | 'constant' | 'expression'

export interface FieldTransform {
  /** type 允许为 null，语义等同于整个 transform 为 null */
  type: FieldTransformType | null
  /** constant：常量值；expression：表达式；其余类型为 null */
  value?: string | null
}

/**
 * 字段映射项，sourceField / targetField 为必填，其余用于展示与主键勾选
 */
export interface FieldMapping {
  sourceField: string
  targetField: string
  sourceType?: string
  targetType?: string
  primaryKey?: boolean
  /** 对标 FDL 转换组件占位：null 或 { type, value } */
  transform?: FieldTransform | null
}

export interface Task {
  id?: string
  name: string
  syncMode: SyncMode
  sourceId: string
  sourceTable: string
  targetId: string
  targetTable: string
  writeMode?: WriteMode
  batchSize?: number
  /** incremental 模式必填，例如 UPDATE_TIME */
  incrementalColumn?: string | null
  /** Quartz 风格 6 位 cron，null 表示仅手动触发；Mock 阶段仅保存与展示，不触发调度 */
  scheduleCron?: string | null
  /** 失败重试次数 0~10 */
  retryCount?: number
  /** 重试间隔（秒） */
  retryIntervalSec?: number
  fieldMappings?: FieldMapping[]
  enabled?: boolean
  lastStatus?: TaskLastStatus
  lastRunAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  /** 数据源 id 对应的名称，列表页前端聚合展示用，后端不返回 */
  sourceName?: string
  targetName?: string
  /** 列表页通过 /tasks/:id/progress 聚合补充，后端任务对象不含该字段 */
  progress?: number
  runningInstanceId?: string
  /**
   * 列表页通过 GET /task-instances 聚合补充「触发方式」列（契约 1.6），
   * 取该任务最近一次运行实例的 trigger，后端任务对象不含该字段
   */
  latestTrigger?: InstanceTrigger
  /** 任务状态，部分后端版本会返回，缺失时以 lastStatus 兜底 */
  status?: TaskLastStatus | EnabledStatus
}

export interface TaskPageParams extends DatabridgePageParams {
  syncMode?: SyncMode
  lastStatus?: TaskLastStatus
}

/**
 * 创建 / 编辑任务的请求体（契约 1.2）
 * 与 Task 同构：编辑时前端会携带后端返回的完整任务对象，因此除定位字段外均可选。
 * 调度相关字段 scheduleCron / retryCount / retryIntervalSec 与 transform 一并随该结构提交。
 */
export interface TaskPayload extends Partial<Task> {
  name: string
  syncMode: SyncMode
  sourceId: string
  sourceTable: string
  targetId: string
  targetTable: string
}

export interface TaskStartResult {
  taskId: string
  instanceId: string
  status: TaskLastStatus | 'running'
}

export interface TaskProgress {
  taskId: string
  instanceId: string | null
  status: Task['lastStatus']
  progress: number
  totalRows: number
  readRows: number
  writeRows: number
  currentOffset: string | null
  rateRowsPerSec: number
  startedAt: string | null
  finishedAt: string | null
  message: string | null
}
