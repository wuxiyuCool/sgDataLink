import { databridgeHttp } from './http'

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

/**
 * 运维统计总览（契约 1.5），对标 FineDataLink 运维监控大盘
 */
export interface StatisticsOverview {
  datasourceTotal: number
  taskTotal: number
  runningInstances: number
  todayTotal: number
  todaySuccess: number
  todayFailed: number
  todayStopped: number
  /** 固定返回最近 7 天（含当天） */
  recentTrend: StatisticsTrendItem[]
}

/**
 * @description: GET /statistics/overview —— 统计卡与近 7 天趋势图统一取数入口
 */
export function getStatisticsOverviewApi() {
  return databridgeHttp.get<StatisticsOverview>({ url: Api.Overview })
}
