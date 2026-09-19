import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'
import type {
  TaskInstance,
  TaskInstancePageParams,
  TaskLog,
  TaskLogPageParams,
  TaskOffset,
  TaskOffsetPageParams,
} from './model/taskInstanceModel'

enum Api {
  TaskInstance = '/task-instances',
}

/**
 * @description: 实例分页列表，支持 taskId / status
 */
export function getTaskInstanceListApi(params: TaskInstancePageParams) {
  return databridgeHttp.get<DatabridgePageResult<TaskInstance>>({
    url: Api.TaskInstance,
    params,
  })
}

/**
 * @description: 实例详情
 */
export function getTaskInstanceApi(id: string) {
  return databridgeHttp.get<TaskInstance>({ url: `${Api.TaskInstance}/${id}` })
}

/**
 * @description: 实例日志分页，支持 level 筛选
 */
export function getTaskInstanceLogsApi(id: string, params: TaskLogPageParams) {
  return databridgeHttp.get<DatabridgePageResult<TaskLog>>({
    url: `${Api.TaskInstance}/${id}/logs`,
    params,
  })
}

/**
 * @description: 实例 offset 点位分页
 */
export function getTaskInstanceOffsetsApi(id: string, params: TaskOffsetPageParams) {
  return databridgeHttp.get<DatabridgePageResult<TaskOffset>>({
    url: `${Api.TaskInstance}/${id}/offsets`,
    params,
  })
}
