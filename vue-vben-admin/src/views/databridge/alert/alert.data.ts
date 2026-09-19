import type { TableColumn } from '../data'
import type { AlertChannel, AlertCondition, AlertRecord, AlertRule } from '/@/api/databridge/model/alertModel'
import { getAlertChannelLabel, getAlertConditionLabel } from '../data'

/** 告警规则列表列定义（契约 1.10） */
export const alertRuleColumns: TableColumn[] = [
  { title: 'ID', dataIndex: 'id', key: 'id', width: 110 },
  { title: '规则名称', dataIndex: 'name', key: 'name', width: 190, ellipsis: true },
  { title: '生效范围', dataIndex: 'scope', key: 'scope', width: 110 },
  { title: '触发条件', key: 'conditions', width: 260, ellipsis: true },
  { title: '延迟阈值', key: 'thresholdLagMs', width: 120 },
  { title: '通知渠道', key: 'channels', width: 260, ellipsis: true },
  { title: '启用', key: 'enabled', width: 90, align: 'center' },
  { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 170 },
  { title: '操作', key: 'action', width: 150 },
]

/** 告警记录列表列定义（契约 1.10） */
export const alertRecordColumns: TableColumn[] = [
  { title: 'ID', dataIndex: 'id', key: 'id', width: 120 },
  { title: '级别', dataIndex: 'level', key: 'level', width: 90 },
  { title: '规则', dataIndex: 'ruleName', key: 'ruleName', width: 170, ellipsis: true },
  { title: '对象', key: 'targetName', width: 200, ellipsis: true },
  { title: '告警内容', dataIndex: 'message', key: 'message', width: 320, ellipsis: true },
  { title: '渠道', key: 'channel', width: 110 },
  { title: '发送结果', dataIndex: 'channelResult', key: 'channelResult', width: 120 },
  { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 170 },
  { title: '状态', key: 'read', width: 90, align: 'center' },
  { title: '操作', key: 'action', width: 110 },
]

/** 渠道行编辑表格列（弹窗内用） */
export const channelTableColumns: TableColumn[] = [
  { title: '类型', key: 'type', width: 150 },
  { title: 'Webhook / 收件人', key: 'webhook' },
  { title: '操作', key: 'action', width: 70, align: 'center' },
]

export function getConditionsText(conditions?: AlertCondition[]) {
  const list = conditions ?? []
  if (!list.length) return '-'
  return list.map((item) => getAlertConditionLabel(item)).join('、')
}

export function getChannelsText(channels?: AlertChannel[]) {
  const list = channels ?? []
  if (!list.length) return '未配置'
  return list.map((item) => `${getAlertChannelLabel(item.type)}：${item.webhook || '-'}`).join('；')
}

export function getTargetText(record: AlertRecord) {
  if (!record.targetName && !record.targetId) return '-'
  const type = record.targetType ? `[${record.targetType}] ` : ''
  return `${type}${record.targetName || record.targetId}`
}

/** 未读记录整行加粗 */
export function getRecordRowClass(record: AlertRecord) {
  return record.read ? '' : 'alert-row-unread'
}

/** 规则表格行摘要（复制/提示场景用） */
export function getRuleSummary(rule: AlertRule) {
  return `${rule.name}（${getConditionsText(rule.conditions)}）`
}
