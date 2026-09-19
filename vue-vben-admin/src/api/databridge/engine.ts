import { databridgeHttp } from './http'
import type {
  EngineLogReport,
  EngineLogReportResult,
  EngineProgressReport,
  EngineReportResult,
} from './model/engineModel'

enum Api {
  Report = '/engine/report',
  Logs = '/engine/logs',
}

/**
 * @description: 引擎进度回报接口（正常由 Go 引擎调用，前端仅用于联调自测/补偿上报）
 */
export function reportEngineProgressApi(data: EngineProgressReport) {
  return databridgeHttp.post<EngineReportResult>({ url: Api.Report, data })
}

/**
 * @description: 引擎日志批量回报接口（同上，主要由 Go 引擎调用）
 */
export function reportEngineLogsApi(data: EngineLogReport) {
  return databridgeHttp.post<EngineLogReportResult>({ url: Api.Logs, data })
}
