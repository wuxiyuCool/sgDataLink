import type { TableColumn } from '../data'

export const STEP_BASIC = 0
export const STEP_DATASOURCE = 1
export const STEP_MAPPING = 2

export const STEP_TITLES = ['基本信息', '源/目标数据源', '字段映射']

/** 调度配置默认值（契约 1.2：scheduleCron 为 null 表示手动触发） */
export const DEFAULT_RETRY_COUNT = 0
export const DEFAULT_RETRY_INTERVAL_SEC = 60
/** 失败重试次数上限，与后端校验保持一致 */
export const MAX_RETRY_COUNT = 10
/** 重试间隔上限（秒） */
export const MAX_RETRY_INTERVAL_SEC = 86400

/**
 * 任务列表列定义
 * 说明：scheduleCron 为空即“手动触发”，对标 FDL 调度配置
 */
export const taskColumns: TableColumn[] = [
  { title: 'ID', dataIndex: 'id', key: 'id', width: 110 },
  { title: '任务名称', dataIndex: 'name', key: 'name', width: 180, ellipsis: true },
  { title: '同步模式', dataIndex: 'syncMode', key: 'syncMode', width: 110 },
  { title: '源表', dataIndex: 'sourceTable', key: 'sourceTable', width: 170, ellipsis: true },
  { title: '目标表', dataIndex: 'targetTable', key: 'targetTable', width: 170, ellipsis: true },
  { title: '增量列', dataIndex: 'incrementalColumn', key: 'incrementalColumn', width: 130 },
  { title: '批量/写入', key: 'batchWrite', width: 150 },
  { title: '调度', key: 'scheduleCron', width: 190 },
  { title: '最近状态', dataIndex: 'lastStatus', key: 'lastStatus', width: 100 },
  {
    // 契约 1.6：列表接口不返回 trigger，由前端用 GET /task-instances 聚合最近一次实例
    title: '触发方式',
    key: 'trigger',
    width: 100,
  },
  { title: '进度', key: 'progress', width: 160 },
  { title: '最近运行', dataIndex: 'lastRunAt', key: 'lastRunAt', width: 170 },
  { title: '操作', key: 'action', width: 300 },
]

/** 每个步骤需要校验的表单字段 */
export const STEP_FIELDS: string[][] = [
  ['name', 'syncMode', 'writeMode', 'batchSize'],
  ['sourceId', 'sourceTable', 'targetId', 'targetTable'],
  [],
]
