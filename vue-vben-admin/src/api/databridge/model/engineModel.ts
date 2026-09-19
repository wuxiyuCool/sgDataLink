import type { InstanceStatus, LogLevel } from './commonModel'

/** POST /engine/report 请求体（Go 引擎 -> Node，Mock 阶段不鉴权） */
export interface EngineProgressReport {
  instanceId: string
  taskId?: string
  status: InstanceStatus
  progress?: number
  totalRows?: number
  readRows?: number
  writeRows?: number
  currentOffset?: string | null
  rateRowsPerSec?: number
  message?: string | null
}

export interface EngineLogItem {
  level: LogLevel
  message: string
  createdAt?: string
}

/** POST /engine/logs 请求体 */
export interface EngineLogReport {
  instanceId: string
  logs: EngineLogItem[]
}

export interface EngineReportResult {
  accepted: boolean
}

export interface EngineLogReportResult {
  accepted: number
}
