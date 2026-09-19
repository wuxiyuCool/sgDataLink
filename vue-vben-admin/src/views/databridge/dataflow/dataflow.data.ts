import type { TableColumn } from '../data'
import type { DataflowNode } from '/@/api/databridge/model/dataflowModel'
import { getDataflowNodeTypeLabel } from '../data'

/**
 * 数据开发列表列定义（契约 1.8）
 * 进度列由 GET /dataflows/:id/progress 聚合补充
 */
export const dataflowColumns: TableColumn[] = [
  { title: 'ID', dataIndex: 'id', key: 'id', width: 110 },
  { title: '画布名称', dataIndex: 'name', key: 'name', width: 180, ellipsis: true },
  { title: '节点数 / 连线数', key: 'graphSummary', width: 130 },
  { title: '数据链路（输入 → 输出）', key: 'lineage', width: 280, ellipsis: true },
  { title: '组件清单', key: 'nodeTypes', width: 220, ellipsis: true },
  { title: '调度', key: 'scheduleCron', width: 170 },
  { title: '最近状态', dataIndex: 'lastStatus', key: 'lastStatus', width: 100 },
  { title: '进度', key: 'progress', width: 150 },
  { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 170 },
  { title: '操作', key: 'action', width: 250 },
]

/** 输入/输出节点的表名摘要：T_ORDER、T_ITEM → T_ORDER_WIDE */
export function getFlowLineageText(nodes: DataflowNode[] = []): string {
  const pick = (type: 'input' | 'output') =>
    nodes
      .filter((node) => node.type === type)
      .map((node) => node.config?.table || node.name)
      .filter(Boolean)
  const inputs = pick('input')
  const outputs = pick('output')
  if (!inputs.length && !outputs.length) return '-'
  return `${inputs.join('、') || '（无输入）'} → ${outputs.join('、') || '（无输出）'}`
}

/** 组件清单摘要，如「数据输入 ×1、过滤 ×2」 */
export function getFlowNodeTypeSummary(nodes: DataflowNode[] = []): string {
  if (!nodes.length) return '-'
  const counter = new Map<string, number>()
  nodes.forEach((node) => {
    const label = getDataflowNodeTypeLabel(node.type)
    counter.set(label, (counter.get(label) ?? 0) + 1)
  })
  return Array.from(counter.entries())
    .map(([label, count]) => `${label} ×${count}`)
    .join('、')
}
