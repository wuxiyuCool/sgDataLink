import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'

/** 平台用户（契约 1.11）——密码只出现在写入方向，任何响应都不回传 */

export interface PlatformUser {
  id: string
  username: string
  nickname?: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  mustChangePassword?: boolean
  lastLoginAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface PlatformUserPageParams {
  keyword?: string
  role?: string
  status?: string
  page?: number
  size?: number
}

enum Api {
  Users = '/users',
  LoginLogs = '/auth/login-logs',
}

export function getPlatformUsersApi(params: PlatformUserPageParams) {
  return databridgeHttp.get<DatabridgePageResult<PlatformUser>>({ url: Api.Users, params })
}

export function createPlatformUserApi(data: {
  username: string
  nickname?: string
  password: string
  role: string
}) {
  return databridgeHttp.post<PlatformUser>({ url: Api.Users, data })
}

export function updatePlatformUserApi(
  id: string,
  data: { nickname?: string; role?: string; status?: string },
) {
  return databridgeHttp.put<PlatformUser>({ url: `${Api.Users}/${id}`, data })
}

export function deletePlatformUserApi(id: string) {
  return databridgeHttp.delete<boolean>({ url: `${Api.Users}/${id}` })
}

export function resetPlatformUserPasswordApi(id: string, password: string) {
  return databridgeHttp.post<PlatformUser>({ url: `${Api.Users}/${id}/reset-password`, data: { password } })
}

/** 登录日志单项（契约 1.11 审计：成功与失败都记，不含任何口令信息） */
export interface LoginLogItem {
  id: string
  userId?: string | null
  username?: string | null
  ip?: string | null
  ok: boolean
  errorMsg?: string | null
  createdAt?: string | null
}

export interface LoginLogPageParams {
  keyword?: string
  result?: 'success' | 'error'
  startTime?: string
  endTime?: string
  page?: number
  size?: number
}

/** GET /auth/login-logs（JWT+admin，滚动保留 1 万条） */
export function getLoginLogsApi(params: LoginLogPageParams = {}) {
  return databridgeHttp.get<DatabridgePageResult<LoginLogItem>>({ url: Api.LoginLogs, params })
}

