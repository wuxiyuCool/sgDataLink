import type { TableColumn } from '../data'

export const logColumns: TableColumn[] = [
  { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 180 },
  { title: '级别', dataIndex: 'level', key: 'level', width: 90 },
  { title: '日志内容', dataIndex: 'message', key: 'message', ellipsis: false },
  { title: '实例 ID', dataIndex: 'instanceId', key: 'instanceId', width: 120 },
  { title: '任务 ID', dataIndex: 'taskId', key: 'taskId', width: 120 },
]

export const offsetColumns: TableColumn[] = [
  { title: 'ID', dataIndex: 'id', key: 'id', width: 110 },
  { title: '分片', dataIndex: 'shardKey', key: 'shardKey', width: 120 },
  { title: '位点值', dataIndex: 'offsetValue', key: 'offsetValue' },
  { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 180 },
]
