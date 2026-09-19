import type { DatabridgePageParams, LogLevel } from './commonModel'

/** 告警触发条件（契约 1.10） */
export type AlertCondition = 'task_failed' | 'pipeline_error' | 'lag_over_threshold'

/** 告警通道类型（契约 0 枚举 channel） */
export type AlertChannelType = 'dingtalk' | 'wecom' | 'email'

/** 告警对象类型，与血缘节点 type 保持同一套取值 */
export type AlertTargetType = 'task' | 'pipeline' | 'dataflow'

export interface AlertChannel {
  type: AlertChannelType
  /** 钉钉/企微机器人地址；email 通道填收件人地址（契约 channels 仅有 webhook 字段） */
  webhook: string
}

export interface AlertRule {
  id?: string
  name: string
  /** 生效范围：all 表示全部任务/管道（契约示例为 "all"） */
  scope?: string
  conditions: AlertCondition[]
  /** lag_over_threshold 条件生效的延迟阈值（毫秒） */
  thresholdLagMs?: number | null
  channels: AlertChannel[]
  enabled?: boolean
  createdAt?: string | null
}

/** 创建 / 编辑告警规则的请求体（契约 1.10） */
export interface AlertRulePayload {
  name: string
  scope?: string
  conditions: AlertCondition[]
  thresholdLagMs?: number | null
  channels: AlertChannel[]
  enabled?: boolean
}

export interface AlertRulePageParams extends DatabridgePageParams {
  enabled?: boolean
}

export interface AlertRecord {
  id: string
  ruleId: string
  ruleName?: string
  level: LogLevel
  targetType?: AlertTargetType
  targetId?: string
  targetName?: string
  message?: string
  channel?: AlertChannelType
  /** Mock 阶段固定为 "mock-sent"，第二阶段接真实 webhook */
  channelResult?: string
  createdAt?: string | null
  read?: boolean
}

/** GET /alert-records 查询条件（契约 1.10 支持 level / read 筛选） */
export interface AlertRecordPageParams extends DatabridgePageParams {
  level?: LogLevel
  read?: boolean
}
