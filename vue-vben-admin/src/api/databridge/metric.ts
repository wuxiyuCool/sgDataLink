import { databridgeHttp } from './http'

/**
 * 指标中心接口（契约 1.12）。当前页面按里程碑逐步接入，本文件先覆盖系统配置。
 */

/** 单项配置的生效值（value 对 secret 项只回掩码 sk-xx***） */
export interface MetricSettingItem {
  settingKey: string
  source: 'table' | 'env' | 'default'
  hasValue: boolean
  value: string | null
}

export interface MetricSettingsResult {
  items: MetricSettingItem[]
}

/** PUT 为嵌套形态（全局 mongo-sanitize 拆点分键，契约 1.12 定案） */
export interface MetricSettingsPayload {
  settings: {
    llm: {
      baseUrl?: string
      model?: string
      apiKey?: string
      timeoutMs?: string
      embedModel?: string
      embed?: { enabled?: string; baseUrl?: string; apiKey?: string }
    }
  }
}

export function getMetricSettingsApi() {
  return databridgeHttp.get<MetricSettingsResult>({ url: '/metric-settings' })
}

export function updateMetricSettingsApi(data: MetricSettingsPayload) {
  return databridgeHttp.put<{ updated: string[] }>({ url: '/metric-settings', data })
}
