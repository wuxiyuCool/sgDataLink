import type { TableColumn } from '../data'

/** 多行文本（每行一个表名）→ 去重去空后的同步对象数组 */
export function parseSyncObjects(text?: string): string[] {
  const list = String(text ?? '')
    .split(/[\n,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return Array.from(new Set(list))
}

/** 同步对象数组 → 多行文本（编辑回显） */
export function stringifySyncObjects(objects?: string[]): string {
  return (objects ?? []).join('\n')
}

/** 表名样例，作为 tags 输入的候选项，减少手输成本 */
export const SYNC_OBJECT_SAMPLES = [
  'APP_USER.T_ORDER',
  'APP_USER.T_ORDER_ITEM',
  'APP_USER.T_PRODUCT',
  'PUBLIC.T_USER',
]

/* ------------------------------------------------------------------ */
/* 增量轮询配置（契约 4.1 / 5：真实模式按 cdcPollColumn 每 N 秒拉一轮） */
/* ------------------------------------------------------------------ */

/** 轮询间隔默认值（秒），与后端 pollIntervalSec 默认一致 */
export const DEFAULT_POLL_INTERVAL_SEC = 5

export const MIN_POLL_INTERVAL_SEC = 1

export const MAX_POLL_INTERVAL_SEC = 3600

/** 归一到 1~3600 的整数秒，InputNumber 允许清空时回落到默认值 */
export function clampPollInterval(value?: number | null) {
  const num = Number(value ?? DEFAULT_POLL_INTERVAL_SEC)
  if (!Number.isFinite(num)) return DEFAULT_POLL_INTERVAL_SEC
  const int = Math.round(num)
  return Math.min(Math.max(int, MIN_POLL_INTERVAL_SEC), MAX_POLL_INTERVAL_SEC)
}

/** 轮询配置摘要：未配置轮询列时提示该管道按模拟执行 */
export function getPollConfigSummary(pollColumn?: string | null, intervalSec?: number) {
  const column = String(pollColumn ?? '').trim()
  if (!column) return '未配置轮询列（模拟执行）'
  return `${column} · ${Number(intervalSec ?? DEFAULT_POLL_INTERVAL_SEC)}s`
}

/**
 * 数据管道列表列定义（契约 1.7）
 * QPS / 延迟 / 变更行数 / CDC 位点 由 GET /pipelines/:id/status 轮询补充
 */
export const pipelineColumns: TableColumn[] = [
  { title: 'ID', dataIndex: 'id', key: 'id', width: 110 },
  { title: '管道名称', dataIndex: 'name', key: 'name', width: 170, ellipsis: true },
  { title: '源 → 目标', key: 'endpoints', width: 210, ellipsis: true },
  { title: '同步对象', key: 'syncObjects', width: 200, ellipsis: true },
  { title: 'DDL 策略', dataIndex: 'ddlPolicy', key: 'ddlPolicy', width: 130 },
  { title: '增量轮询', key: 'pollConfig', width: 160, ellipsis: true },
  { title: '状态', dataIndex: 'status', key: 'status', width: 90 },
  { title: 'QPS', key: 'currentQps', width: 90, align: 'right' },
  { title: '同步延迟', key: 'lagMs', width: 110, align: 'right' },
  { title: '变更行数', key: 'changeRows', width: 110, align: 'right' },
  { title: 'CDC 位点', key: 'cdcPosition', width: 190, ellipsis: true },
  { title: '最近异常', key: 'lastError', width: 190, ellipsis: true },
  { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 170 },
  { title: '操作', key: 'action', width: 230 },
]
