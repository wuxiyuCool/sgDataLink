import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'
import type {
  AlertRecord,
  AlertRecordPageParams,
  AlertRule,
  AlertRulePageParams,
  AlertRulePayload,
} from './model/alertModel'

enum Api {
  AlertRule = '/alert-rules',
  AlertRecord = '/alert-records',
}

/**
 * @description: 告警规则分页列表（契约 1.10），支持 keyword / enabled
 */
export function getAlertRuleListApi(params: AlertRulePageParams) {
  return databridgeHttp.get<DatabridgePageResult<AlertRule>>({ url: Api.AlertRule, params })
}

/**
 * @description: 告警规则详情
 */
export function getAlertRuleApi(id: string) {
  return databridgeHttp.get<AlertRule>({ url: `${Api.AlertRule}/${id}` })
}

/**
 * @description: 新增告警规则
 */
export function createAlertRuleApi(data: AlertRulePayload) {
  return databridgeHttp.post<AlertRule>({ url: Api.AlertRule, data })
}

/**
 * @description: 编辑告警规则
 */
export function updateAlertRuleApi(id: string, data: AlertRulePayload) {
  return databridgeHttp.put<AlertRule>({ url: `${Api.AlertRule}/${id}`, data })
}

/**
 * @description: 删除告警规则
 */
export function deleteAlertRuleApi(id: string) {
  return databridgeHttp.delete<boolean>({ url: `${Api.AlertRule}/${id}` })
}

/**
 * @description: 告警记录分页列表，支持 level / read 筛选
 */
export function getAlertRecordListApi(params: AlertRecordPageParams) {
  return databridgeHttp.get<DatabridgePageResult<AlertRecord>>({ url: Api.AlertRecord, params })
}

/**
 * @description: 标记告警记录已读（PATCH /alert-records/:id/read）。
 * VAxios 未内置 patch 方法，这里直接用 request 指定 method。
 */
export function markAlertRecordReadApi(id: string) {
  return databridgeHttp.request<AlertRecord>({
    url: `${Api.AlertRecord}/${id}/read`,
    method: 'PATCH',
    data: {},
  })
}
