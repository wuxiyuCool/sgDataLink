import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'
import type {
  Task,
  TaskPageParams,
  TaskPayload,
  TaskProgress,
  TaskStartResult,
} from './model/taskModel'
import type { TaskInstancePageParams, TaskInstance } from './model/taskInstanceModel'

enum Api {
  Task = '/tasks',
}

/**
 * @description: 任务分页列表，支持 keyword / syncMode / lastStatus
 */
export function getTaskListApi(params: TaskPageParams) {
  return databridgeHttp.get<DatabridgePageResult<Task>>({ url: Api.Task, params })
}

/**
 * @description: 任务详情（含 fieldMappings）
 */
export function getTaskApi(id: string) {
  return databridgeHttp.get<Task>({ url: `${Api.Task}/${id}` })
}

/**
 * @description: 供下拉选择使用的一次性拉取
 */
export function getAllTasksApi(keyword?: string) {
  return databridgeHttp
    .get<DatabridgePageResult<Task>>({
      url: Api.Task,
      params: { page: 1, size: 500, keyword },
    })
    .then((res) => res?.items ?? [])
}

/**
 * @description: 创建全量/增量任务（incremental 缺少 incrementalColumn 时后端返回 40001）
 * 调度字段 scheduleCron / retryCount / retryIntervalSec 与 fieldMappings[].transform 随请求体一并提交
 */
export function createTaskApi(data: TaskPayload) {
  return databridgeHttp.post<Task>({ url: Api.Task, data })
}

/**
 * @description: 编辑任务（running 中后端返回 40003）
 */
export function updateTaskApi(id: string, data: TaskPayload) {
  return databridgeHttp.put<Task>({ url: `${Api.Task}/${id}`, data })
}

/**
 * @description: 删除任务（running 中后端返回 40003）
 */
export function deleteTaskApi(id: string) {
  return databridgeHttp.delete<boolean>({ url: `${Api.Task}/${id}` })
}

/**
 * @description: 下发启动指令，成功后返回 instanceId
 */
export function startTaskApi(id: string) {
  return databridgeHttp.post<TaskStartResult>({ url: `${Api.Task}/${id}/start` })
}

/**
 * @description: 下发停止指令
 */
export function stopTaskApi(id: string) {
  return databridgeHttp.post<TaskStartResult>({ url: `${Api.Task}/${id}/stop` })
}

/**
 * @description: 聚合视图：状态 + 进度 + 读写行数 + 当前 offset
 */
export function getTaskProgressApi(id: string) {
  return databridgeHttp.get<TaskProgress>({ url: `${Api.Task}/${id}/progress` })
}

/**
 * @description: 某任务的运行实例分页列表
 */
export function getTaskInstancesOfTaskApi(id: string, params: TaskInstancePageParams) {
  return databridgeHttp.get<DatabridgePageResult<TaskInstance>>({
    url: `${Api.Task}/${id}/instances`,
    params,
  })
}
