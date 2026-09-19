import type { LineageEdge, LineageGraph, LineageNode } from '/@/api/databridge/model/lineageModel'
import { LINEAGE_NODE_META, LINEAGE_NODE_TYPE_ORDER, getLineageNodeColor } from '../data'

/** ECharts graph 需要的分类（legend 与配色都按 category 取） */
export function buildLineageCategories() {
  return LINEAGE_NODE_TYPE_ORDER.map((type) => ({
    name: LINEAGE_NODE_META[type].label,
    itemStyle: { color: getLineageNodeColor(type) },
  }))
}

/** 节点大小：数据源/任务类对象更醒目，表节点稍小 */
function getSymbolSize(type: LineageNode['type']) {
  switch (type) {
    case 'datasource':
      return 40
    case 'table':
      return 24
    case 'dataapi':
      return 34
    default:
      return 32
  }
}

export interface LineageChartData {
  nodes: any[]
  edges: any[]
  categories: any[]
  /** 同名节点数量（同名时会自动追加工厂 id 后缀，避免连线错挂） */
  duplicatedNames: number
}

/**
 * 血缘图 → ECharts graph series 数据
 * 节点 id 原样保留（边按 id 关联），name 做去重：后端会出现两张同名表
 * （如不同库的 T_ORDER），ECharts 在部分版本按 name 关联边，重名会挂错线。
 */
export function buildLineageChartData(graph: LineageGraph): LineageChartData {
  const nodes: any[] = []
  const usedNames = new Map<string, number>()
  const categoryIndex = new Map<string, number>()
  LINEAGE_NODE_TYPE_ORDER.forEach((type, index) => categoryIndex.set(type, index))

  ;(graph?.nodes ?? []).forEach((node) => {
    const baseName = String(node.name ?? node.id)
    const times = (usedNames.get(baseName) ?? 0) + 1
    usedNames.set(baseName, times)
    const name = times === 1 ? baseName : `${baseName} #${times}`
    nodes.push({
      id: node.id,
      name,
      rawName: baseName,
      value: node.name,
      category: categoryIndex.get(node.type) ?? -1,
      symbolSize: getSymbolSize(node.type),
      type: node.type,
      tooltip: {
        formatter: () => `${LINEAGE_NODE_META[node.type]?.label ?? node.type}：${baseName}<br/>ID：${node.id}`,
      },
    })
  })

  const edges: LineageEdge[] = (graph?.edges ?? []).map((edge) => ({
    source: edge.source,
    target: edge.target,
  }))

  const duplicated = Array.from(usedNames.values()).filter((count) => count > 1).length

  return {
    nodes,
    edges,
    categories: buildLineageCategories(),
    duplicatedNames: duplicated,
  }
}

/** 图上方的摘要文案 */
export function getLineageSummary(graph: LineageGraph) {
  const nodes = graph?.nodes ?? []
  const counter = new Map<string, number>()
  nodes.forEach((node) => counter.set(node.type, (counter.get(node.type) ?? 0) + 1))
  const detail = LINEAGE_NODE_TYPE_ORDER.filter((type) => counter.get(type))
    .map((type) => `${LINEAGE_NODE_META[type].label} ${counter.get(type) ?? 0}`)
    .join('、')
  return `节点 ${nodes.length} 个 / 关系 ${(graph?.edges ?? []).length} 条${
    detail ? `（${detail}）` : ''
  }`
}
