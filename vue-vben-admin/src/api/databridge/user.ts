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

