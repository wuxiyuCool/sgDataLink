import { databridgeHttp } from './http'

enum Api {
  Health = '/health',
}

export interface HealthResult {
  status: 'ok' | string
  service: string
  mock?: boolean
  version?: string
  uptime?: number
}

/**
 * @description: 管理后端健康检查 GET /api/v1/health
 */
export function getHealthApi() {
  return databridgeHttp.get<HealthResult>(
    { url: Api.Health },
    // 健康检查失败时不需要弹出全局错误提示，由调用方自行展示状态
    { errorMessageMode: 'none' },
  )
}
