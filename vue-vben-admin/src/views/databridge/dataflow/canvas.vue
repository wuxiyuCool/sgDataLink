<template>
  <PageWrapper :title="pageTitle">
    <template #headerContent>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <Space>
          <Tag v-if="!isNew">ID：{{ dataflowId }}</Tag>
          <Tag :color="getTaskStatusColor(form.lastStatus)">
            {{ getTaskStatusLabel(form.lastStatus) }}
          </Tag>
          <Tag v-if="dirty" color="orange">有未保存的修改（需先保存才能运行）</Tag>
          <Tag v-if="jsonMode" color="red">{{ lfError ? 'JSON 编辑模式（降级）' : 'JSON 编辑模式' }}</Tag>
        </Space>
        <Space>
          <Button @click="goBack">
            <Icon icon="ant-design:unordered-list-outlined" class="mr-1" />
            返回列表
          </Button>
          <Button :loading="saving" type="primary" @click="handleSave">
            <Icon icon="ant-design:save-outlined" class="mr-1" />
            保存画布
          </Button>
          <Popconfirm
            title="确认运行该画布？引擎将按首尾输入/输出节点模拟一次同步"
            ok-text="运行"
            cancel-text="取消"
            @confirm="handleRun"
          >
            <Button :disabled="isNew || dirty" :loading="running" type="primary" ghost>
              运行
            </Button>
          </Popconfirm>
          <Popconfirm title="确认停止当前运行实例？" ok-text="停止" cancel-text="取消" @confirm="handleStop">
            <Button :disabled="isNew || form.lastStatus !== 'running'" :loading="running">
              停止
            </Button>
          </Popconfirm>
          <Button :disabled="isNew" @click="openProgress">进度</Button>
        </Space>
      </div>
      <div class="header-hint">
        拖拽左侧组件到画布编排 ETL 流，鼠标移到节点边缘出现锚点后拖出连线；保存为契约 1.8 的
        nodes / edges 结构
      </div>
    </template>

    <Card :bordered="false" size="small" class="mb-3">
      <Form layout="inline">
        <FormItem label="画布名称" required>
          <Input v-model:value="form.name" style="width: 220px" placeholder="例如：订单宽表加工" />
        </FormItem>
        <FormItem label="调度表达式">
          <Input
            v-model:value="form.scheduleCron"
            allow-clear
            style="width: 190px"
            placeholder="0 0 3 * * ?（留空手动触发）"
          />
        </FormItem>
        <FormItem label="失败重试">
          <Space>
            <InputNumber v-model:value="form.retryCount" :min="0" :max="10" :precision="0" />
            <span class="hint-text">次 / 间隔</span>
            <InputNumber
              v-model:value="form.retryIntervalSec"
              :min="0"
              :max="86400"
              :precision="0"
            />
            <span class="hint-text">秒</span>
          </Space>
        </FormItem>
        <FormItem label="启用">
          <Switch v-model:checked="form.enabled" />
        </FormItem>
        <FormItem>
          <RadioGroup
            :value="jsonMode"
            size="small"
            :options="[
              { label: '画布模式', value: false },
              { label: 'JSON 模式', value: true },
            ]"
            @change="handleModeChange"
          />
        </FormItem>
      </Form>
    </Card>

    <Alert
      v-if="lfError"
      class="mb-3"
      type="warning"
      show-icon
      message="LogicFlow 画布不可用，已自动切换到 JSON 编辑模式"
      :description="lfError"
    />

    <div class="canvas-layout">
      <!-- 左侧组件面板：九类组件，可拖拽或点击加入画布 -->
      <aside v-show="!jsonMode" class="palette">
        <div class="palette-title">组件面板</div>
        <div
          v-for="item in DATAFLOW_NODE_TYPES"
          :key="item.type"
          class="palette-item"
          :style="{ borderColor: item.color }"
          draggable="true"
          @dragstart="handleDragStart(item.type, $event)"
          @dragend="handleDragEnd"
          @click="handlePaletteClick(item.type)"
        >
          <Icon :icon="item.icon" :style="{ color: item.color }" class="palette-icon" />
          <div class="palette-text">
            <div class="palette-label">{{ item.label }}</div>
            <div class="palette-desc">{{ item.type }} · {{ item.desc }}</div>
          </div>
        </div>
        <div class="palette-tip">
          <div v-if="pendingType">
            已选「{{ getDataflowNodeTypeLabel(pendingType) }}」，在画布空白处点击即可放置
            <Button type="link" size="small" @click="pendingType = ''">取消</Button>
          </div>
          <div v-else>拖拽组件到画布，或点击组件后在画布点击放置</div>
        </div>
      </aside>

      <section class="canvas-main">
        <div v-show="!jsonMode" class="canvas-toolbar">
          <Space>
            <Button size="small" :disabled="!selectedNodeId" @click="handleDeleteSelected">
              删除选中节点
            </Button>
            <Button size="small" @click="handleAutoLayout">自动布局</Button>
            <Button size="small" :disabled="!lfReady" @click="handleZoom(true)">放大</Button>
            <Button size="small" :disabled="!lfReady" @click="handleZoom(false)">缩小</Button>
            <Button size="small" :disabled="!lfReady" @click="handleResetZoom">实际大小</Button>
            <span class="hint-text">节点 {{ nodes.length }} 个 / 连线 {{ edges.length }} 条</span>
          </Space>
        </div>

        <Spin :spinning="loadingDetail">
          <div
            v-show="!jsonMode"
            ref="containerRef"
            class="lf-container"
            @dragover.prevent
            @drop="handleDrop"
          ></div>
        </Spin>

        <div v-if="jsonMode" class="json-editor">
          <div class="mb-2 flex items-center justify-between">
            <span class="hint-text">
              直接编辑契约 1.8 的 nodes / edges（坐标写在 config.__x / config.__y）
            </span>
            <Space>
              <Button size="small" @click="handleFormatJson">格式化</Button>
              <Button size="small" type="primary" @click="applyJson()">应用到画布</Button>
            </Space>
          </div>
          <TextArea v-model:value="jsonText" :rows="24" class="json-text" />
        </div>

        <Alert
          class="mt-2"
          type="info"
          show-icon
          message="连线与删除：鼠标移到节点上会出现锚点，从锚点拖到目标节点即完成连线；选中节点或连线按 Delete 删除。"
          description="后端 JSON 深校验只认节点的 id/type/name/config，因此画布坐标统一序列化进 config.__x / config.__y，回显时据此恢复布局。"
        />
      </section>
    </div>

    <NodeConfigDrawer
      v-model:visible="nodeDrawerVisible"
      :node="editingNode"
      :datasource-options="datasourceOptions"
      :datasource-loading="datasourceLoading"
      :siblings="nodes"
      @confirm="handleNodeConfigConfirm"
    />

    <RunProgressDrawer
      v-model:visible="progressVisible"
      :dataflow-id="dataflowId"
      :dataflow-name="form.name"
      :tick="progressTick"
    />
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { computed, nextTick, onMounted, reactive, ref, unref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import {
    Alert,
    Button,
    Card,
    Form,
    Input,
    InputNumber,
    Popconfirm,
    Radio,
    Space,
    Spin,
    Switch,
    Tag,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllDatasourcesApi } from '/@/api/databridge/datasource'
  import {
    createDataflowApi,
    getDataflowApi,
    runDataflowApi,
    stopDataflowApi,
    updateDataflowApi,
  } from '/@/api/databridge/dataflow'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { TaskLastStatus } from '/@/api/databridge/model/commonModel'
  import type {
    DataflowEdge,
    DataflowNode,
    DataflowNodeType,
  } from '/@/api/databridge/model/dataflowModel'
  import type { SelectOption } from '../data'
  import {
    DATAFLOW_NODE_TYPES,
    getDataflowNodeTypeLabel,
    getTaskStatusColor,
    getTaskStatusLabel,
    pickDataflowPayload,
  } from '../data'
  import {
    LF_EDGE_TYPE,
    LF_NODE_TYPE,
    autoLayoutPosition,
    createDefaultConfig,
    createNodeId,
    getNodeText,
    isKnownNodeType,
    parseGraphJson,
    serializeGraph,
    stringifyGraphJson,
    toLogicFlowData,
    validateGraph,
  } from './flowGraph'
  import NodeConfigDrawer from './components/NodeConfigDrawer.vue'
  import RunProgressDrawer from './components/RunProgressDrawer.vue'

  const FormItem = Form.Item
  const TextArea = Input.TextArea
  const RadioGroup = Radio.Group

  const route = useRoute()
  const router = useRouter()
  const { createMessage } = useMessage()

  /** LogicFlow 实例不放进响应式：Proxy 包裹图形引擎容易引起内部引用错乱 */
  let lf: any = null
  /** 程序化回填表单期间抑制「已修改」标记 */
  let suppressDirty = false

  const containerRef = ref<HTMLDivElement | null>(null)
  const lfReady = ref(false)
  const lfError = ref('')
  const jsonMode = ref(false)
  const jsonText = ref('')
  const loadingDetail = ref(false)
  const saving = ref(false)
  const running = ref(false)
  const dirty = ref(false)

  const dataflowId = ref('')
  const nodes = ref<DataflowNode[]>([])
  const edges = ref<DataflowEdge[]>([])

  const pendingType = ref<DataflowNodeType | ''>('')
  const draggingType = ref<DataflowNodeType | ''>('')
  const selectedNodeId = ref('')
  const nodeDrawerVisible = ref(false)
  const editingNode = ref<DataflowNode | null>(null)

  const datasourceOptions = ref<SelectOption[]>([])
  const datasourceLoading = ref(false)

  const progressVisible = ref(false)
  const progressTick = ref(0)

  const form = reactive({
    name: '',
    scheduleCron: '',
    retryCount: 0,
    retryIntervalSec: 60,
    enabled: true,
    lastStatus: undefined as TaskLastStatus | undefined,
  })

  const isNew = computed(() => !unref(dataflowId))
  const routeQueryId = computed(() => String(route.query.id ?? ''))
  const pageTitle = computed(() =>
    unref(isNew) ? '数据开发 · 新建画布' : `数据开发 · ${form.name || '未命名画布'}`,
  )

  /** 画布模式且 LogicFlow 可用（此时图数据是唯一真相源） */
  function canvasActive() {
    return !!(lf && unref(lfReady) && !unref(jsonMode))
  }

  function getGraphData() {
    try {
      return lf?.getGraphData?.() ?? {}
    } catch {
      return {}
    }
  }

  /** 画布当前内容：画布模式取图数据，JSON 模式取已解析的本地数组 */
  function readGraph(): { nodes: DataflowNode[]; edges: DataflowEdge[] } {
    if (canvasActive()) return serializeGraph(getGraphData())
    return { nodes: unref(nodes), edges: unref(edges) }
  }

  /** 图数据 → 本地数组（JSON 文本与统计展示都依赖它） */
  function syncFromCanvas() {
    if (unref(jsonMode)) return
    const graph = readGraph()
    nodes.value = graph.nodes
    edges.value = graph.edges
  }

  function refreshJsonText() {
    const graph = readGraph()
    jsonText.value = stringifyGraphJson(graph.nodes, graph.edges)
  }

  function markDirty() {
    if (suppressDirty) return
    dirty.value = true
  }

  /** 不同 1.x 小版本方法名/参数存在差异，逐个候选名尝试，全部失败返回 null */
  function callLf<T = any>(names: string[], ...args: any[]): T | null {
    if (!lf) return null
    for (const name of names) {
      const fn = (lf as Recordable)?.[name]
      if (typeof fn === 'function') {
        try {
          return fn.apply(lf, args) as T
        } catch {
          // 换下一个候选名
        }
      }
    }
    return null
  }

  async function loadDatasources() {
    datasourceLoading.value = true
    try {
      const list = await getAllDatasourcesApi()
      datasourceOptions.value = list.map((item) => ({
        label: `${item.name}（${item.type} · ${item.host}:${item.port}）`,
        value: item.id as string,
      }))
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '数据源列表加载失败'))
    } finally {
      datasourceLoading.value = false
    }
  }

  /**
   * LogicFlow 初始化：动态 import + 加载失败降级为 JSON 编辑模式。
   * 只用内置 rect 节点 + polyline 边，不注册自定义节点类型，保证运行逻辑最简。
   */
  async function initLogicFlow() {
    const container = containerRef.value
    if (!container || unref(lfReady)) return
    try {
      const core: any = await import('@logicflow/core')
      const LogicFlowCtor = core?.default ?? core?.LogicFlow ?? core?.LF
      if (typeof LogicFlowCtor !== 'function') {
        throw new Error('未取到 LogicFlow 构造函数（@logicflow/core 导出结构不符合预期）')
      }
      await loadLogicFlowStyle()
      lf = new LogicFlowCtor({ container, grid: true, edgeType: LF_EDGE_TYPE })
      lfReady.value = true
      bindLfEvents()
      renderCanvas()
    } catch (error: any) {
      lf = null
      lfReady.value = false
      jsonMode.value = true
      lfError.value = `${
        error?.message ?? error
      }；已自动切换到 JSON 编辑模式，可直接维护 nodes / edges 后保存。`
      refreshJsonText()
    }
  }

  /** 样式为尽力而为：各版本 dist 路径不同，且动态路径不参与打包期解析，失败也不影响功能 */
  async function loadLogicFlowStyle() {
    const candidates = ['@logicflow/core/dist/style/index.css', '@logicflow/core/dist/index.css']
    for (const path of candidates) {
      try {
        await import(/* @vite-ignore */ path)
        return
      } catch {
        // 尝试下一个候选路径
      }
    }
  }

  function bindLfEvents() {
    if (!lf || typeof lf.on !== 'function') return
    const bind = (names: string[], handler: (data: any) => void) => {
      names.forEach((name) => {
        try {
          lf.on(name, handler)
        } catch {
          // 该版本不支持此事件名
        }
      })
    }
    bind(['node:click', 'node-click'], (data) => {
      const id = getNodeIdByData(data?.data ?? data)
      selectedNodeId.value = id
      if (unref(pendingType)) return
      openNodeConfig(id)
    })
    bind(['blank:click', 'blank-click'], (data) => {
      selectedNodeId.value = ''
      if (!unref(pendingType)) return
      const point = getPointFromEvent(data?.e ?? data?.event)
      addNode(unref(pendingType) as DataflowNodeType, point)
      pendingType.value = ''
    })
    bind(['edge:add', 'edge-add'], () => {
      syncFromCanvas()
      markDirty()
    })
    bind(['node:delete', 'node-delete', 'edge:delete', 'edge-delete'], () => {
      syncFromCanvas()
      markDirty()
    })
    bind(['node:dragend', 'node-dragend'], () => {
      syncFromCanvas()
      markDirty()
    })
    bind(['history:change', 'history-change'], () => markDirty())
  }

  function getNodeIdByData(data: any): string {
    return String(data?.id ?? data?.data?.id ?? data?.element?.id ?? '')
  }

  /** 用本地数组重绘画布（回显 / 应用 JSON / 自动布局都会走这里） */
  function renderCanvas() {
    if (!lf || !unref(lfReady)) return
    const data = toLogicFlowData(unref(nodes), unref(edges))
    try {
      lf.render?.(data)
    } catch (error: any) {
      try {
        lf.clearData?.()
        lf.render?.(data)
      } catch (innerError: any) {
        createMessage.error(getApiErrorMessage(innerError, '画布渲染失败，请改用 JSON 模式维护'))
      }
    }
  }

  function getPointFromEvent(event: any) {
    const clientX = Number(event?.clientX)
    const clientY = Number(event?.clientY)
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null
    return getCanvasPoint(clientX, clientY)
  }

  /** 屏幕坐标 → 画布坐标（两种历史 API 都兼容） */
  function getCanvasPoint(clientX: number, clientY: number) {
    if (!lf) return null
    try {
      if (typeof lf.getPointByClient === 'function') {
        const raw = lf.getPointByClient(clientX, clientY)
        const point =
          raw?.canvasOverlayPosition ?? raw?.canvasPosition ?? raw?.domOverlayPosition ?? raw
        if (Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))) {
          return { x: Number(point.x), y: Number(point.y) }
        }
      }
      if (typeof lf.getEventPosition === 'function') {
        const point = lf.getEventPosition({ clientX, clientY })
        if (Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))) {
          return { x: Number(point.x), y: Number(point.y) }
        }
      }
    } catch {
      // 取不到坐标时退回自动布局
    }
    return null
  }

  function handleDragStart(type: DataflowNodeType, e: DragEvent) {
    draggingType.value = type
    try {
      e.dataTransfer?.setData('text/plain', type)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
    } catch {
      // 个别浏览器限制 setData，用 draggingType 兜底
    }
  }

  function handleDragEnd() {
    draggingType.value = ''
  }

  function resolveDragType(e: DragEvent): DataflowNodeType | '' {
    const raw = e.dataTransfer?.getData('text/plain') || unref(draggingType) || ''
    return isKnownNodeType(raw) ? (raw as DataflowNodeType) : ''
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    const type = resolveDragType(e)
    draggingType.value = ''
    if (!type) return
    addNode(type, getCanvasPoint(e.clientX, e.clientY))
  }

  /** 点击组件 = 进入「待放置」状态，再点画布空白处落子（拖拽不便时的兜底路径） */
  function handlePaletteClick(type: DataflowNodeType) {
    if (unref(jsonMode) || !unref(lfReady)) {
      addNode(type, null)
      return
    }
    pendingType.value = unref(pendingType) === type ? '' : type
  }

  function addNode(type: DataflowNodeType, point: { x: number; y: number } | null) {
    const graph = readGraph()
    const id = createNodeId(graph.nodes.map((item) => item.id))
    const name = getDataflowNodeTypeLabel(type)
    const config = createDefaultConfig(type)
    const position = point ?? autoLayoutPosition(graph.nodes.length)

    if (canvasActive() && typeof lf?.addNode === 'function') {
      config.__x = position.x
      config.__y = position.y
      try {
        lf.addNode({
          id,
          type: LF_NODE_TYPE,
          x: position.x,
          y: position.y,
          text: getNodeText(name, type),
          properties: { dataType: type, name, config },
        })
      } catch (error: any) {
        createMessage.error(getApiErrorMessage(error, '节点添加失败，请改用 JSON 模式'))
        return
      }
    } else {
      config.__x = position.x
      config.__y = position.y
      nodes.value = [...graph.nodes, { id, type, name, config }]
      edges.value = graph.edges
      if (!unref(jsonMode)) renderCanvas()
      refreshJsonText()
    }
    syncFromCanvas()
    markDirty()
    selectedNodeId.value = id
    openNodeConfig(id)
  }

  function openNodeConfig(id: string) {
    if (!id) return
    const node = readGraph().nodes.find((item) => item.id === id)
    if (!node) return
    editingNode.value = { ...node, config: { ...node.config } }
    nodeDrawerVisible.value = true
  }

  function handleNodeConfigConfirm(payload: {
    id: string
    name: string
    config: DataflowNode['config']
  }) {
    const node = unref(nodes).find((item) => item.id === payload.id)
    const type = (node?.type ?? 'filter') as DataflowNodeType
    if (canvasActive()) {
      callLf(['setProperties'], payload.id, {
        dataType: type,
        name: payload.name,
        config: payload.config,
      })
      callLf(['updateText'], payload.id, getNodeText(payload.name, type))
    } else if (node) {
      node.name = payload.name
      node.config = { ...node.config, ...payload.config }
      if (!unref(jsonMode)) renderCanvas()
    }
    syncFromCanvas()
    refreshJsonText()
    markDirty()
  }

  function handleDeleteSelected() {
    const id = unref(selectedNodeId)
    if (!id) {
      createMessage.warning('请先选中要删除的节点')
      return
    }
    if (canvasActive()) {
      // deleteElement(id, isSoft) 与 deleteNode(id) 都试一遍，再核对是否真的删掉了
      callLf(['deleteElement', 'deleteNode'], id, true)
      callLf(['deleteElement', 'deleteNode'], id)
    }
    const graph = readGraph()
    if (graph.nodes.some((item) => item.id === id)) {
      if (canvasActive()) {
        createMessage.warning('画布未响应删除操作，请在 JSON 模式下删除该节点')
        return
      }
    }
    nodes.value = graph.nodes.filter((item) => item.id !== id)
    edges.value = graph.edges.filter((item) => item.source !== id && item.target !== id)
    if (canvasActive()) renderCanvas()
    refreshJsonText()
    selectedNodeId.value = ''
    nodeDrawerVisible.value = false
    markDirty()
  }

  function handleAutoLayout() {
    const graph = readGraph()
    nodes.value = graph.nodes.map((node, index) => {
      const position = autoLayoutPosition(index)
      return { ...node, config: { ...node.config, __x: position.x, __y: position.y } }
    })
    edges.value = graph.edges
    if (!unref(jsonMode)) renderCanvas()
    refreshJsonText()
    markDirty()
    createMessage.success('已按加入顺序重排节点位置')
  }

  function handleZoom(zoomIn: boolean) {
    callLf(['zoom'], zoomIn)
  }

  function handleResetZoom() {
    callLf(['resetZoom'], 1)
    callLf(['translateCenter'])
  }

  function handleModeChange(e: any) {
    const next = !!e?.target?.value
    if (next === unref(jsonMode)) return
    if (!next) {
      // JSON → 画布：先校验并应用文本内容
      if (!applyJson(false)) return
      jsonMode.value = false
      if (!unref(lfReady)) {
        nextTick(() => initLogicFlow())
      } else {
        renderCanvas()
      }
      return
    }
    // 画布 → JSON：把画布内容导出到文本域
    const graph = readGraph()
    nodes.value = graph.nodes
    edges.value = graph.edges
    jsonMode.value = true
    jsonText.value = stringifyGraphJson(graph.nodes, graph.edges)
  }

  /** 解析 JSON 文本写入本地数组；showTip=false 时只校验不提示（供内部流程调用） */
  function applyJson(showTip = true): boolean {
    try {
      const graph = parseGraphJson(unref(jsonText))
      const error = validateGraph(graph.nodes, graph.edges)
      if (error) {
        createMessage.warning(error)
        return false
      }
      nodes.value = graph.nodes
      edges.value = graph.edges
      if (unref(lfReady)) renderCanvas()
      if (showTip) createMessage.success('JSON 已应用到画布')
      return true
    } catch (error: any) {
      createMessage.error(error?.message ?? 'JSON 解析失败')
      return false
    }
  }

  function handleFormatJson() {
    try {
      const graph = parseGraphJson(unref(jsonText))
      jsonText.value = stringifyGraphJson(graph.nodes, graph.edges)
      createMessage.success('已格式化')
    } catch (error: any) {
      createMessage.error(error?.message ?? 'JSON 解析失败')
    }
  }

  async function handleSave() {
    if (!String(form.name).trim()) {
      createMessage.warning('请填写画布名称')
      return
    }
    if (unref(jsonMode) && !applyJson(false)) return
    const graph = readGraph()
    const errorMessage = validateGraph(graph.nodes, graph.edges)
    if (errorMessage) {
      createMessage.warning(errorMessage)
      return
    }
    const payload = pickDataflowPayload({
      name: String(form.name).trim(),
      nodes: graph.nodes,
      edges: graph.edges,
      scheduleCron: String(form.scheduleCron || '').trim() || null,
      retryCount: Number(form.retryCount ?? 0),
      retryIntervalSec: Number(form.retryIntervalSec ?? 60),
      enabled: !!form.enabled,
    })
    saving.value = true
    try {
      if (unref(isNew)) {
        const created = await createDataflowApi(payload)
        if (created?.id) {
          dataflowId.value = created.id
          router.replace({ path: '/databridge/dataflow/canvas', query: { id: created.id } })
        }
        createMessage.success(`画布已创建（${created?.id ?? ''}），共 ${graph.nodes.length} 个节点`)
      } else {
        await updateDataflowApi(dataflowId.value, payload)
        createMessage.success('画布已保存')
      }
      dirty.value = false
      refreshJsonText()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      saving.value = false
    }
  }

  async function handleRun() {
    if (unref(isNew) || unref(dirty)) {
      createMessage.warning('请先保存画布再运行')
      return
    }
    running.value = true
    try {
      const result = await runDataflowApi(dataflowId.value)
      form.lastStatus = 'running'
      createMessage.success(`运行已启动，实例 ${result?.instanceId ?? '-'}`)
      openProgress()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '运行失败'))
    } finally {
      running.value = false
    }
  }

  async function handleStop() {
    if (unref(isNew)) return
    running.value = true
    try {
      await stopDataflowApi(dataflowId.value)
      form.lastStatus = 'stopped'
      createMessage.success('停止指令已下发')
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '停止失败'))
    } finally {
      running.value = false
    }
  }

  function openProgress() {
    progressTick.value += 1
    progressVisible.value = true
  }

  function goBack() {
    router.push('/databridge/dataflow')
  }

  async function loadDetail(id: string) {
    suppressDirty = true
    if (!id) {
      dataflowId.value = ''
      nodes.value = []
      edges.value = []
      renderCanvas()
      refreshJsonText()
    } else {
      dataflowId.value = id
      loadingDetail.value = true
      try {
        const detail = await getDataflowApi(id)
        form.name = detail?.name ?? ''
        form.scheduleCron = detail?.scheduleCron ?? ''
        form.retryCount = detail?.retryCount ?? 0
        form.retryIntervalSec = detail?.retryIntervalSec ?? 60
        form.enabled = detail?.enabled !== false
        form.lastStatus = detail?.lastStatus
        nodes.value = (detail?.nodes ?? []).map((node) => ({
          ...node,
          config: { ...(node.config ?? {}) },
        }))
        edges.value = (detail?.edges ?? []).map((edge) => ({
          source: edge.source,
          target: edge.target,
        }))
        renderCanvas()
        refreshJsonText()
      } catch (error: any) {
        createMessage.error(getApiErrorMessage(error, '画布加载失败'))
      } finally {
        loadingDetail.value = false
      }
    }
    await nextTick()
    suppressDirty = false
    dirty.value = false
  }

  /** 同一路由换 id（列表页再次进入别的画布）时重新加载 */
  watch(routeQueryId, (id) => {
    if (!route.path.endsWith('/dataflow/canvas')) return
    if (id === unref(dataflowId)) return
    loadDetail(id)
  })

  watch(
    () => [form.name, form.scheduleCron, form.retryCount, form.retryIntervalSec, form.enabled],
    () => markDirty(),
  )

  onMounted(async () => {
    loadDatasources()
    await nextTick()
    await initLogicFlow()
    await loadDetail(unref(routeQueryId))
  })
</script>
<style lang="less" scoped>
  .canvas-layout {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }

  .palette {
    flex: 0 0 208px;
    padding: 8px;
    border: 1px solid #f0f0f0;
    border-radius: 4px;
    background: #fafafa;

    .palette-title {
      margin-bottom: 8px;
      color: #595959;
      font-weight: 600;
    }

    .palette-item {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
      padding: 6px 8px;
      border: 1px solid #d9d9d9;
      border-left-width: 3px;
      border-radius: 4px;
      background: #fff;
      cursor: grab;
      transition: box-shadow 0.2s;

      &:hover {
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      }
    }

    .palette-icon {
      margin-right: 8px;
      font-size: 18px;
    }

    .palette-label {
      color: #262626;
      font-size: 13px;
    }

    .palette-desc {
      color: #8c8c8c;
      font-size: 12px;
      white-space: nowrap;
    }

    .palette-tip {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed #d9d9d9;
      color: #8c8c8c;
      font-size: 12px;
    }
  }

  .canvas-main {
    flex: 1;
    min-width: 0;
  }

  .canvas-toolbar {
    margin-bottom: 8px;
  }

  .lf-container {
    width: 100%;
    height: 560px;
    border: 1px solid #d9d9d9;
    border-radius: 4px;
    background: #fff;
    overflow: hidden;
  }

  .json-text {
    font-family: monospace;
    font-size: 12px;
  }

  .hint-text {
    color: #8c8c8c;
  }

  .header-hint {
    margin-top: 8px;
    color: #8c8c8c;
    font-size: 12px;
  }
</style>
