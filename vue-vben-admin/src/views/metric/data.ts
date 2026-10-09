/** 指标中心前端共享常量/格式化（契约 1.12） */

export const LAYER_OPTIONS = [
  { label: 'ODS 贴源层', value: 'ODS' },
  { label: 'DIM 维度层', value: 'DIM' },
  { label: 'DWD 明细层', value: 'DWD' },
  { label: 'DWS 汇总层', value: 'DWS' },
  { label: 'ADS 应用层', value: 'ADS' },
]

export const LAYER_TAG_COLORS: Record<string, string> = {
  ODS: 'default',
  DIM: 'purple',
  DWD: 'blue',
  DWS: 'orange',
  ADS: 'green',
}

/** 建模状态机（契约 1.13）：draft 草稿不可被引用，online 才可生成表/建指标 */
export const MODEL_STATUS_OPTIONS = [
  { label: '草稿', value: 'draft' },
  { label: '已启用', value: 'online' },
  { label: '已停用', value: 'offline' },
]

export const MODEL_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  online: '已启用',
  offline: '已停用',
}

export const MODEL_STATUS_TAG_COLORS: Record<string, string> = {
  draft: 'default',
  online: 'success',
  offline: 'warning',
}

/** 物理表留痕：reference 恒为 exists（表本就存在源库，平台不建不删） */
export const TABLE_STATUS_LABELS: Record<string, string> = {
  none: '未建表',
  created: '已建表',
  exists: '引用表',
  failed: '建表失败',
}

export const TABLE_STATUS_TAG_COLORS: Record<string, string> = {
  none: 'default',
  created: 'success',
  exists: 'blue',
  failed: 'error',
}

export const METRIC_TYPE_OPTIONS = [
  { label: '原子指标', value: 'ATOMIC' },
  { label: '派生指标', value: 'DERIVED' },
  { label: '复合指标', value: 'COMPOSITE' },
]

export const METRIC_TYPE_LABELS: Record<string, string> = {
  ATOMIC: '原子',
  DERIVED: '派生',
  COMPOSITE: '复合',
}

export const METRIC_TYPE_TAG_COLORS: Record<string, string> = {
  ATOMIC: 'blue',
  DERIVED: 'orange',
  COMPOSITE: 'purple',
}

export const METRIC_STATUS_OPTIONS = [
  { label: '草稿', value: 'draft' },
  { label: '已上线', value: 'online' },
  { label: '已下线', value: 'offline' },
]

export const METRIC_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  online: '已上线',
  offline: '已下线',
}

export const METRIC_STATUS_TAG_COLORS: Record<string, string> = {
  draft: 'default',
  online: 'success',
  offline: 'warning',
}

export const AGG_OPTIONS = [
  { label: 'SUM 求和', value: 'sum' },
  { label: 'COUNT 计数', value: 'count' },
  { label: 'COUNT(DISTINCT) 去重计数', value: 'count_distinct' },
  { label: 'AVG 平均', value: 'avg' },
  { label: 'MAX 最大', value: 'max' },
  { label: 'MIN 最小', value: 'min' },
]

export const COLUMN_ROLE_OPTIONS = [
  { label: '维度', value: 'dimension' },
  { label: '时间', value: 'time' },
  { label: '度量', value: 'measure' },
]

export const CHAT_STATUS_LABELS: Record<string, string> = {
  success: '成功',
  corrected: '纠错后成功',
  clarify: '待澄清',
  failed: '失败',
}

export const CHAT_STATUS_TAG_COLORS: Record<string, string> = {
  success: 'success',
  corrected: 'processing',
  clarify: 'warning',
  failed: 'error',
}

export function formatTime(value?: string | null): string {
  if (!value) return '-'
  const text = String(value)
  return text.includes('T') ? text.replace('T', ' ').slice(0, 19) : text.slice(0, 19)
}
