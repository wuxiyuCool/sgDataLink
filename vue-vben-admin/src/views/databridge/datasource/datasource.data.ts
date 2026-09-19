import type { TableColumn } from '../data'

export const datasourceColumns: TableColumn[] = [
  { title: 'ID', dataIndex: 'id', key: 'id', width: 110 },
  { title: '名称', dataIndex: 'name', key: 'name', width: 160 },
  { title: '类型', dataIndex: 'type', key: 'type', width: 110 },
  { title: '主机', dataIndex: 'host', key: 'host', width: 140 },
  { title: '端口', dataIndex: 'port', key: 'port', width: 80 },
  { title: '数据库/服务名', dataIndex: 'database', key: 'database', width: 150, ellipsis: true },
  { title: '用户名', dataIndex: 'username', key: 'username', width: 120 },
  { title: '备注', dataIndex: 'remark', key: 'remark', width: 140, ellipsis: true },
  { title: '状态', dataIndex: 'status', key: 'status', width: 90 },
  { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 170 },
  { title: '操作', key: 'action', width: 220 },
]
