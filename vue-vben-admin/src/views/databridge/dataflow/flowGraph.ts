import type {
  DataflowEdge,
  DataflowNode,
  DataflowNodeConfig,
  DataflowNodeType,
} from '/@/api/databridge/model/dataflowModel'
import { DATAFLOW_NODE_TYPE_MAP, getDataflowNodeTypeLabel } from '../data'

/**
 * 画布与契约结构的双向转换。
 *
 * 契约 1.8 的 nodes 项只允许 { id, type, name, config }，后端做深校验时
 * 不接受节点对象上的额外键；而 LogicFlow 的图数据里坐标是节点顶层的 x / y。
 * 因此这里统一把坐标塞进 config.__x / config.__y（config 只校验为对象，
 * 内容按 type 自定义），回显时再从 config 里取出来恢复布局。
 */

/** 全部节点都用 LogicFlow 内置 rect 类型，不做自定义注册，逻辑最简、运行时风险最低 */
export const LF_NODE_TYPE = 'rect'

/** 折线连线：比直线更直观，且是 LogicFlow 内置边类型 */
export const LF_EDGE_TYPE = 'polyline'

/** 自动布局参数：无坐标时按 4 列网格铺开 */
const LAYOUT_START_X = 180
const LAYOUT_START_Y = 120
const LAYOUT_GAP_X = 260
const LAYOUT_GAP_Y = 150
const LAYOUT_COLUMN = 4

export interface LogicFlowNodeData {
  id: string
  type: string
  x: number
  y: number
  text: string
  properties: {
    dataType: DataflowNodeType
    name: string
    config: DataflowNodeConfig
  }
}

export interface LogicFlowEdgeData {
  type: string
  sourceNodeId: string
  targetNodeId: string
}

export interface LogicFlowGraphData {
  nodes: LogicFlowNodeData[]
  edges: LogicFlowEdgeData[]
}

export function isKnownNodeType(type?: string): type is DataflowNodeType {
  return !!type && Object.prototype.hasOwnProperty.call(DATAFLOW_NODE_TYPE_MAP, type)
}

/** 节点画布文案：「类型：名称」，与任务要求的默认 rect 展示方式一致 */
export function getNodeText(name: string, type: DataflowNodeType) {
  return `${getDataflowNodeTypeLabel(type)}：${name || '未命名节点'}`
}

/** 从 rect 节点文案里反解类型与名称（仅在没有 properties 时兜底） */
function parseText(text: any): { type?: string; name?: string } {
  const value = typeof text === 'string' ? text : String(text?.value ?? '')
  const index = value.indexOf('：')
  if (index < 0) return { name: value }
  const typeLabel = value.slice(0, index)
  const matched = Object.values(DATAFLOW_NODE_TYPE_MAP).find((item) => item.label === typeLabel)
  return { type: matched?.type, name: value.slice(index + 1) }
}

/** 去掉坐标键，得到契约里干净的 config（提交后端用） */
export function omitCoordinates(config?: DataflowNodeConfig | null): DataflowNodeConfig {
  const source = { ...(config ?? {}) }
  delete source.__x
  delete source.__y
  return source
}

/** 读取节点坐标，缺省时按网格自动布局 */
export function getNodeCoordinate(node: DataflowNode, index = 0) {
  const x = Number(node.config?.__x)
  const y = Number(node.config?.__y)
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }
  return autoLayoutPosition(index)
}

export function autoLayoutPosition(index: number) {
  return {
    x: LAYOUT_START_X + (index % LAYOUT_COLUMN) * LAYOUT_GAP_X,
    y: LAYOUT_START_Y + Math.floor(index / LAYOUT_COLUMN) * LAYOUT_GAP_Y,
  }
}

/** 节点 id：与契约示例保持 n1 / n2 风格 */
export function createNodeId(existingIds: (string | undefined)[] = []) {
  const used = new Set(existingIds.filter(Boolean) as string[])
  let seq = 1
  while (used.has(`n${seq}`)) seq += 1
  return `n${seq}`
}

/** 各类型节点的默认 config，保证 Drawer 表单有初始结构 */
export function createDefaultConfig(type: DataflowNodeType): DataflowNodeConfig {
  switch (type) {
    case 'input':
      return { datasourceId: '', table: '' }
    case 'output':
      return { datasourceId: '', table: '', writeMode: 'upsert' }
    case 'filter':
      return { condition: '' }
    case 'transform':
      return { mappings: [] }
    case 'join':
      return { joinType: 'left', on: '' }
    case 'union':
      return { sources: '' }
    case 'sql':
      return { sql: '' }
    case 'json_parse':
      return { field: '', path: '$.data' }
    case 'validate':
      return { rules: [] }
    default:
      return {}
  }
}

/** 新建画布时的骨架：数据输入 → 数据输出，坐标按自动布局写入 config */
export function createSeedGraph(): { nodes: DataflowNode[]; edges: DataflowEdge[] } {
  const nodes: DataflowNode[] = (['input', 'output'] as DataflowNodeType[]).map((type, index) => {
    const position = autoLayoutPosition(index)
    return {
      id: `n${index + 1}`,
      type,
      name: getDataflowNodeTypeLabel(type),
      config: { ...createDefaultConfig(type), __x: position.x, __y: position.y },
    }
  })
  return {
    nodes,
    edges: [{ source: nodes[0].id, target: nodes[1].id }],
  }
}

/**
 * LogicFlow 图数据 → 契约结构
 * 入参形状兼容 1.1 / 1.2 两版：节点 x/y 在顶层，边字段为 sourceNodeId|source
 */
export function serializeGraph(graphData: any): { nodes: DataflowNode[]; edges: DataflowEdge[] } {
  const rawNodes: any[] = Array.isArray(graphData?.nodes) ? graphData.nodes : []
  const nodes: DataflowNode[] = []

  rawNodes.forEach((raw) => {
    const id = String(raw?.id ?? '')
    if (!id) return
    const properties = raw?.properties ?? {}
    const fallback = parseText(raw?.text)
    const rawType = properties.dataType ?? fallback.type ?? 'filter'
    const type = (isKnownNodeType(rawType) ? rawType : 'transform') as DataflowNodeType
    const config = omitCoordinates(properties.config ?? {})
    const x = Number(raw?.x)
    const y = Number(raw?.y)
    if (Number.isFinite(x)) config.__x = x
    if (Number.isFinite(y)) config.__y = y
    nodes.push({
      id,
      type,
      name: String(properties.name ?? fallback.name ?? getDataflowNodeTypeLabel(type)),
      config,
    })
  })

  const rawEdges: any[] = Array.isArray(graphData?.edges) ? graphData.edges : []
  const edges: DataflowEdge[] = rawEdges
    .map((raw) => ({
      source: String(raw?.sourceNodeId ?? raw?.source ?? ''),
      target: String(raw?.targetNodeId ?? raw?.target ?? ''),
    }))
    .filter((edge) => edge.source && edge.target)

  return { nodes, edges }
}

/** 契约结构 → LogicFlow 渲染数据（回显） */
export function toLogicFlowData(
  nodes: DataflowNode[] = [],
  edges: DataflowEdge[] = [],
): LogicFlowGraphData {
  return {
    nodes: nodes.map((node, index) => {
      const position = getNodeCoordinate(node, index)
      const type = isKnownNodeType(node.type) ? node.type : 'transform'
      return {
        id: node.id,
        type: LF_NODE_TYPE,
        x: position.x,
        y: position.y,
        text: getNodeText(node.name, type),
        properties: {
          dataType: type,
          name: node.name,
          config: omitCoordinates(node.config),
        },
      }
    }),
    edges: edges.map((edge) => ({
      type: LF_EDGE_TYPE,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
    })),
  }
}

/**
 * 保存前的结构自检（后端不可用时的第一道防线）：
 * 空画布、重复 id、悬空连线都会被拦下，避免把无效 JSON 写进 /dataflows。
 */
export function validateGraph(nodes: DataflowNode[], edges: DataflowEdge[]): string {
  if (!nodes.length) return '画布为空，请至少拖入一个输入或输出节点'
  const ids = new Set<string>()
  for (const node of nodes) {
    if (!node.id) return '存在缺少 id 的节点，请删除后重新添加'
    if (ids.has(node.id)) return `节点 id 重复：${node.id}`
    ids.add(node.id)
    if (!String(node.name ?? '').trim()) return `节点【${node.id}】名称不能为空`
    if (!isKnownNodeType(node.type)) return `节点【${node.id}】的类型 ${node.type} 不在组件清单内`
  }
  for (const edge of edges) {
    if (!ids.has(edge.source)) return `连线的源节点不存在：${edge.source}`
    if (!ids.has(edge.target)) return `连线的目标节点不存在：${edge.target}`
  }
  const hasInput = nodes.some((node) => node.type === 'input')
  const hasOutput = nodes.some((node) => node.type === 'output')
  if (!hasInput || !hasOutput) {
    return '画布缺少 input 或 output 节点：run 时引擎按首尾输入/输出拼同步快照'
  }
  return ''
}

/** 直接编辑 nodes/edges JSON 时的解析（降级模式），失败时抛出可读文案 */
export function parseGraphJson(text: string): { nodes: DataflowNode[]; edges: DataflowEdge[] } {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error('JSON 内容为空')
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch (error: any) {
    throw new Error(`JSON 格式错误：${error?.message ?? error}`)
  }
  const rawNodes: any[] = Array.isArray(parsed) ? parsed : parsed?.nodes ?? []
  const rawEdges: any[] = Array.isArray(parsed) ? [] : parsed?.edges ?? []

  const nodes: DataflowNode[] = rawNodes.map((raw, index) => {
    const rawType = String(raw?.type ?? 'filter')
    const type = (isKnownNodeType(rawType) ? rawType : 'transform') as DataflowNodeType
    const config = raw?.config && typeof raw.config === 'object' ? { ...raw.config } : {}
    return {
      id: String(raw?.id ?? `n${index + 1}`),
      type,
      name: String(raw?.name ?? getDataflowNodeTypeLabel(type)),
      config,
    }
  })
  const edges: DataflowEdge[] = rawEdges.map((raw) => ({
    source: String(raw?.source ?? raw?.sourceNodeId ?? ''),
    target: String(raw?.target ?? raw?.targetNodeId ?? ''),
  }))
  return { nodes, edges }
}

/** JSON 编辑模式的初始文本 */
export function stringifyGraphJson(nodes: DataflowNode[], edges: DataflowEdge[]) {
  return JSON.stringify({ nodes, edges }, null, 2)
}
