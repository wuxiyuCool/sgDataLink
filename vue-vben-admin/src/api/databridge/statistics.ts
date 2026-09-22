import { databridgeHttp } from './http'
import type { DatasourceType } from './model/datasourceModel'
import type { LogLevel } from './model/commonModel'

enum Api {
  Overview = '/statistics/overview',
}

/**
 * 最近 7 天趋势中的单个日期聚合项（按实例 startedAt 日期聚合）
 */
export interface StatisticsTrendItem {
  /** YYYY-MM-DD */
  date: string
  success: number
  failed: number
}

/** 数据源类型分布项（契约 1.5 datasourceTypes，oracle/mysql/postgresql 恒定输出） */
export interface DatasourceTypeCount {
  type: DatasourceType
  count: number
}

/**
 * 任务模式分布取值：full / incremental 来自同步任务，
 * cdc = 数据管道，dataflow = 数据开发（契约 1.5 taskModeDistribution）
 */
export type TaskModeCountMode = 'full' | 'incremental' | 'cdc' | 'dataflow'

export interface TaskModeCount {
  mode: TaskModeCountMode
  count: number
}

/** 运行中管道汇总（契约 1.5）：无运行管道时 maxLagMs 为 null */
export interface RunningPipelineSummary {
  count: number
  maxLagMs: number | null
}

/** 数据服务调用 TOP 项（契约 1.5 topDataApis，仅 published） */
export interface TopDataApiItem {
  id: string
  name: string
  path: string
  invokeCount: number
  errorCount: number
  avgLatencyMs: number
}

/** 最新告警项（契约 1.5 recentAlerts，为 1.10 alert-record 的子集字段） */
export interface RecentAlertItem {
  id: string
  level: LogLevel
  targetName?: string | null
  message?: string | null
  createdAt?: string | null
  read: boolean
}

/** 最新运行日志项（契约 1.5 recentLogs；taskName 为后端可选补充的实例归属名） */
export interface RecentLogItem {
  id: string
  level: LogLevel
  message: string
  instanceId?: string | null
  taskId?: string | null
  createdAt?: string | null
  taskName?: string | null
}

/** 数据服务调用统计按日聚合项（契约 1.5 dataApiCallStats.dayTrend，最近 7 天） */
export interface DataApiCallTrendItem {
  /** YYYY-MM-DD */
  date: string
  success: number
  error: number
}

/**
 * 数据服务调用统计（契约 1.5 dataApiCallStats，按调用明细日志聚合，供「服务监控」大屏用）。
 * 该字段由后端与 /data-apis/calls 同批交付，未上线时 overview 不返回它，
 * 因此全部字段按「可能缺失」处理，页面缺失即显示 '-'，不做前端兜底估算。
 */
export interface DataApiCallStats {
  total?: number | null
  success?: number | null
  error?: number | null
  /** 错误率 0-100（保留 1 位小数） */
  errorRate?: number | null
  avgLatencyMs?: number | null
  todaySuccess?: number | null
  todayError?: number | null
  dayTrend?: DataApiCallTrendItem[]
}

/**
 * 运维统计总览（契约 1.5），对标 FineDataLink 运维监控大盘。
 * 一次请求即可喂满大盘的 KPI / 趋势 / 分布 / TOP / 告警 / 日志各区，
 * 新增字段由后端各子聚合独立容错，失败时为 [] 或 null。
 */
export interface StatisticsOverview {
  datasourceTotal: number
  /** 同步任务数（不含管道与数据开发） */
  taskTotal: number
  runningInstances: number
  todayTotal: number
  todaySuccess: number
  todayFailed: number
  todayStopped: number
  /** 固定返回最近 7 天（含当天） */
  recentTrend: StatisticsTrendItem[]
  datasourceTypes: DatasourceTypeCount[]
  taskModeDistribution: TaskModeCount[]
  runningPipelines: RunningPipelineSummary
  topDataApis: TopDataApiItem[]
  dataApiTotal: number
  publishedDataApis: number
  recentAlerts: RecentAlertItem[]
  recentLogs: RecentLogItem[]
  /** 当前 running 实例数（含管道实例） */
  todayRunning: number
  /** 近 7 日成功率 0-100（保留 1 位小数），无 success/failed 实例时 null */
  weekSuccessRate: number | null
  /**
   * 数据服务调用统计（服务监控大屏用）。后端按调用明细日志聚合，
   * 未交付或聚合失败时不下发该键，故按可选处理。
   */
  dataApiCallStats?: DataApiCallStats | null
}

/**
 * @description: GET /statistics/overview —— 大盘 KPI、趋势、分布、TOP、告警、日志统一取数入口
 */
export function getStatisticsOverviewApi() {
  return databridgeHttp.get<StatisticsOverview>({ url: Api.Overview })
}
