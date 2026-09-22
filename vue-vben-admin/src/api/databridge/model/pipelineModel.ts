import type { DatabridgePageParams } from './commonModel'

/** 数据管道状态（契约 0 枚举 pipeline.status） */
export type PipelineStatus = 'running' | 'stopped'

/**
 * DDL 变更策略（契约 1.7）：ignore 忽略、report 仅记录，
 * Mock 阶段后端只存储与回显，不做真实 DDL 处理
 */
export type PipelineDdlPolicy = 'ignore' | 'report'

export interface Pipeline {
  id?: string
  name: string
  sourceId: string
  targetId: string
  /** 同步对象：形如 APP_USER.T_ORDER 的表名数组 */
  syncObjects: string[]
  ddlPolicy?: PipelineDdlPolicy
  /**
   * 增量轮询列（契约 4.1 / 5）：真实模式下引擎按该列每 pollIntervalSec 秒拉一轮增量。
   * 留空表示该管道无法按轮询做真实读写，实例会以 simulate 模式执行。
   */
  cdcPollColumn?: string | null
  /** 轮询间隔（秒），取值 1~3600，缺省 5 */
  pollIntervalSec?: number
  status?: PipelineStatus
  /** running 时对应的运行实例，stop 后为 null */
  runningInstanceId?: string | null
  /** 管道最近一次异常（契约 1.10 告警链路会用到） */
  lastError?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  /**
   * 以下字段后端管道对象不返回，由列表页轮询 GET /pipelines/:id/status 聚合补充
   */
  currentQps?: number | null
  lagMs?: number | null
  changeRows?: number | null
  cdcPosition?: string | null
  /** 该行最近一次状态轮询时间（本地时间戳，仅用于提示刷新） */
  statusAt?: number
  /** 源/目标数据源名称，前端用 /datasources 聚合展示 */
  sourceName?: string
  targetName?: string
}

/** 创建 / 编辑管道的请求体（契约 1.7；status 等响应侧字段不回传） */
export interface PipelinePayload {
  name: string
  sourceId: string
  targetId: string
  syncObjects: string[]
  ddlPolicy?: PipelineDdlPolicy
  /** 增量轮询列，null / 空串表示未配置（该管道按模拟执行） */
  cdcPollColumn?: string | null
  /** 轮询间隔（秒），1~3600 */
  pollIntervalSec?: number
}

export interface PipelinePageParams extends DatabridgePageParams {
  status?: PipelineStatus
}

/** POST /pipelines/:id/start、/:id/stop 的返回 */
export interface PipelineActionResult {
  pipelineId: string
  instanceId: string | null
  status: PipelineStatus
}

/** GET /pipelines/:id/status（契约 1.7），前端 3 秒轮询 */
export interface PipelineStatusResult {
  pipelineId: string
  instanceId: string | null
  status: PipelineStatus
  /** 累计捕获的变更行数 */
  changeRows: number
  currentQps: number
  /** 同步延迟（毫秒），超过 5000ms 页面标红 */
  lagMs: number
  cdcPosition: string | null
  startedAt: string | null
}
