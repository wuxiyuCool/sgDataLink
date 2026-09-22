/**
 * 分页查询通用参数
 * 契约：/api/v1 统一使用 page + size（见 docs/API.md 第 0 节）
 */
export interface DatabridgePageParams {
  page?: number
  size?: number
  keyword?: string
  /** 排序：field:asc|desc */
  sort?: string
}

/**
 * 分页响应 result 结构
 * 注意：与 /@/api/model/baseModel.ts 的 BasicPageParams(pageSize) 不同，
 * DataBridge 后端使用 size 作为分页大小字段。
 */
export interface DatabridgePageResult<T> {
  items: T[]
  total: number
  page?: number
  size?: number
  pages?: number
}

export type EnabledStatus = 'enabled' | 'disabled'

/**
 * 同步模式：full / incremental 属于「同步任务」，cdc 属于「数据管道」（契约 0 枚举、1.7），
 * 管道由 /pipelines 维护，因此任务表单的模式单选仍只提供 full / incremental。
 */
export type SyncMode = 'full' | 'incremental' | 'cdc'

/** 任务最近一次状态 */
export type TaskLastStatus = 'idle' | 'running' | 'success' | 'failed' | 'stopped'

/** 实例运行状态 */
export type InstanceStatus = 'running' | 'success' | 'failed' | 'stopped'

/** 实例触发方式（契约 1.6）：手动 / 定时调度 / 失败重试 */
export type InstanceTrigger = 'manual' | 'cron' | 'retry'

/**
 * 执行模式（契约 4.1 / 5）：Node 下发引擎快照时判定并写入实例。
 * real 为真实读写，simulate 为模拟执行（DB_DRIVER=memory 或端点类型/驱动不支持真实读写）。
 */
export type ExecMode = 'real' | 'simulate'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/** 写入冲突策略 */
export type WriteMode = 'insert' | 'upsert' | 'overwrite'
