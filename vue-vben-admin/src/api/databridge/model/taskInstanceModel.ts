import type {
  DatabridgePageParams,
  InstanceStatus,
  InstanceTrigger,
  LogLevel,
  SyncMode,
  TaskLastStatus,
} from './commonModel'

export interface TaskInstance {
  id: string
  /** cdc 管道实例无任务归属，taskId 为 null（契约 1.4 / 1.7） */
  taskId: string | null
  pipelineId?: string | null
  taskName?: string
  syncMode?: SyncMode
  status: InstanceStatus | TaskLastStatus
  /** 触发方式（契约 1.6）：manual | cron | retry */
  trigger?: InstanceTrigger
  progress?: number
  totalRows?: number
  readRows?: number
  writeRows?: number
  rateRowsPerSec?: number
  currentOffset?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  message?: string | null
  createdAt?: string | null
}

export interface TaskInstancePageParams extends DatabridgePageParams {
  taskId?: string
  status?: InstanceStatus
}

export interface TaskLog {
  id: string
  instanceId: string
  taskId: string
  level: LogLevel
  message: string
  createdAt?: string
}

export interface TaskLogPageParams extends DatabridgePageParams {
  instanceId?: string
  taskId?: string
  level?: LogLevel
}

export interface TaskOffset {
  id: string
  taskId: string
  instanceId: string
  shardKey: string
  offsetValue: string
  updatedAt?: string
}

export interface TaskOffsetPageParams extends DatabridgePageParams {
  taskId?: string
  instanceId?: string
}
