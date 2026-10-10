<template>
  <PageWrapper
    title="指标中心 · 数据建模"
    content="建模即建表：界面建表(ddl) 走 草稿 → 启用 → 生成表；引用表(reference) 只登记源库已有表，平台不建也不删。字段的角色（维度/时间/度量）决定指标可用性；左侧「分层 → 分类」树按数仓层次快速捞建模"
  >
    <GuideCard :guide="PAGE_GUIDES.model" />

    <div class="model-layout">
      <!-- 左：分层 → 分类 树，用于快速定位建模（窄屏可收起） -->
      <div v-show="treeVisible" class="tree-pane">
        <Card :bordered="false" size="small">
          <template #title>
            <span class="tree-title">
              <Icon icon="ion:albums-outline" :size="15" />
              分层树
            </span>
          </template>
          <template #extra>
            <Space :size="0">
              <Tooltip title="重新拉取分层树与计数">
                <Button type="text" size="small" :loading="treeLoading" @click="loadCategoryTree">
                  <Icon icon="ant-design:reload-outlined" :size="14" />
                </Button>
              </Tooltip>
              <Tooltip title="收起分层树（窄屏更宽敞）">
                <Button type="text" size="small" @click="treeVisible = false">
                  <Icon icon="ant-design:menu-fold-outlined" :size="14" />
                </Button>
              </Tooltip>
            </Space>
          </template>

          <div class="tree-bar">
            <Button type="primary" size="small" @click="openCreateCategory()">
              <Icon icon="ant-design:plus-outlined" class="mr-1" />
              新建分类
            </Button>
            <span class="tree-sum">
              已建 <b>{{ categoryTotal }}</b> 个分类 · 共 <b>{{ modelTotal }}</b> 个建模
            </span>
          </div>

          <Tree
            v-model:selectedKeys="selectedKeys"
            v-model:expandedKeys="expandedKeys"
            :tree-data="treeData"
            block-node
            @select="handleTreeSelect"
          >
            <template #title="node">
              <!-- 根：全部模型（点它＝清掉分层与分类两个条件） -->
              <span v-if="node.kind === 'all'" :class="nodeClass(node)">
                <Icon icon="ion:cube-outline" :size="14" class="node-icon" />
                <span class="node-name">全部模型</span>
                <span class="node-count">{{ node.count }}</span>
              </span>

              <!-- 分层根：固定 5 个，只按该层筛 -->
              <span v-else-if="node.kind === 'layer'" :class="nodeClass(node)">
                <Tag :color="LAYER_TAG_COLORS[node.layer] || 'default'" class="node-tag">
                  {{ node.layer }}
                </Tag>
                <span class="node-name">{{ node.label }}</span>
                <span class="node-count">{{ node.count }}</span>
                <Tooltip :title="`在 ${node.layer} 分层下新建一个分类`">
                  <span class="node-act" @click.stop="openCreateCategory(node.layer)">
                    <Icon icon="ant-design:plus-outlined" :size="12" />
                  </span>
                </Tooltip>
              </span>

              <!-- 虚拟节点：该层里没归类的建模 -->
              <span v-else-if="node.kind === 'none'" :class="nodeClass(node)">
                <Tooltip title="这一层还没归类的建模；点开后勾选行，就能批量归到同层的分类">
                  <span class="node-inner">
                    <Icon icon="ion:file-tray-outline" :size="14" class="node-icon" />
                    <span class="node-name node-name--muted">未分类</span>
                    <span class="node-count">{{ node.count }}</span>
                  </span>
                </Tooltip>
              </span>

              <!-- 分类节点：名称 + 计数 + 描述副标题，hover 出行内操作 -->
              <span v-else :class="nodeClass(node)">
                <Tooltip placement="left" :title="node.description || '这个分类还没写描述'">
                  <span class="node-main">
                    <span class="node-name">{{ node.name }}</span>
                    <span v-if="node.description" class="node-desc">{{ node.description }}</span>
                    <span v-else class="node-desc node-desc--empty">还没写描述，点铅笔补一句</span>
                  </span>
                </Tooltip>
                <span class="node-count">{{ node.count }}</span>
                <span class="node-ops" @click.stop>
                  <Tooltip title="在同一分层下再建一个分类">
                    <span class="node-act" @click="openCreateCategory(node.layer)">
                      <Icon icon="ant-design:plus-outlined" :size="12" />
                    </span>
                  </Tooltip>
                  <Tooltip title="编辑名称、描述与排序（层级不可改）">
                    <span class="node-act" @click="openEditCategory(node)">
                      <Icon icon="ant-design:edit-outlined" :size="12" />
                    </span>
                  </Tooltip>
                  <Popconfirm
                    placement="right"
                    :ok-button-props="{ danger: true }"
                    ok-text="删除分类"
                    @confirm="handleDeleteCategory(node)"
                  >
                    <template #title>删除分类【{{ node.name }}】</template>
                    <template #description>
                      <div class="pop-line">
                        该分类下 {{ node.count }} 个建模将退回未分类，不会删除建模本身，
                        也不会动数据库里的表。
                      </div>
                    </template>
                    <span class="node-act node-act--danger">
                      <Icon icon="ant-design:delete-outlined" :size="12" />
                    </span>
                  </Popconfirm>
                </span>
              </span>
            </template>
          </Tree>

          <div class="tree-hint">
            点<b>分层根</b>＝只看这一层；点<b>分类</b>＝这一层里该分类的建模；点<b>未分类</b>＝这一层还没归类的。
            分层根固定 5 个（不能增删改名），分类是自己建的归组节点。
          </div>
        </Card>
      </div>

      <!-- 右：筛选 + 列表 -->
      <div class="list-pane">
        <Card :bordered="false" class="mb-3">
          <Form :model="query" layout="inline" @finish="handleSearch">
            <FormItem label="域" name="domainId">
              <TreeSelect
                v-model:value="query.domainId"
                :tree-data="domainOptions"
                tree-default-expand-all
                allow-clear
                placeholder="全部域"
                style="width: 200px"
              />
            </FormItem>
            <FormItem label="分层" name="layer">
              <Select
                v-model:value="query.layer"
                :options="LAYER_OPTIONS"
                allow-clear
                placeholder="全部分层"
                style="width: 150px"
                @change="handleLayerFilterChange"
              />
            </FormItem>
            <FormItem label="状态" name="status">
              <Select
                v-model:value="query.status"
                :options="MODEL_STATUS_OPTIONS"
                allow-clear
                placeholder="全部状态"
                style="width: 130px"
              />
            </FormItem>
            <FormItem label="关键字" name="keyword">
              <Input
                v-model:value="query.keyword"
                allow-clear
                placeholder="模型/表名"
                style="width: 180px"
              />
            </FormItem>
            <FormItem>
              <Space>
                <Button type="primary" html-type="submit">查询</Button>
                <Button @click="handleReset">重置</Button>
              </Space>
            </FormItem>
          </Form>
        </Card>

        <Card :bordered="false">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <Button v-if="!treeVisible" size="small" @click="treeVisible = true">
                <Icon icon="ion:albums-outline" class="mr-1" />
                分层树
              </Button>
              <template v-if="treeFilterText">
                <span class="filter-chip">
                  <Icon icon="ion:funnel-outline" :size="13" />
                  {{ treeFilterText }}
                </span>
                <Button type="link" size="small" @click="clearTreeFilter">清除分层筛选</Button>
              </template>
            </div>
            <Button type="primary" @click="handleCreate">
              <Icon icon="ant-design:plus-outlined" class="mr-1" />
              新建模型
            </Button>
          </div>

          <!-- 勾了行才出现：批量归类入口；归类结果（含跨层点名）在勾选清空后仍留在原位 -->
          <div v-if="selectedRowKeys.length || assignResult" class="batch-bar mb-3">
            <div v-if="selectedRowKeys.length" class="batch-bar__head">
              <Icon icon="ant-design:tags-twotone" :size="16" class="batch-bar__icon" />
              <span class="batch-bar__count">已选 {{ selectedRowKeys.length }} 个建模</span>
              <span class="batch-bar__meta">
                所属分层：{{ selectedLayersText }} · 分类只装同层建模，跨层的会被逐条点名
              </span>
              <Space :size="6" wrap class="batch-bar__ops">
                <Select
                  v-model:value="assignCategoryId"
                  placeholder="归到哪个分类"
                  :style="{ width: '220px' }"
                >
                  <SelectOptGroup
                    v-for="group in assignGroups"
                    :key="group.layer"
                    :label="group.label"
                  >
                    <SelectOption v-for="item in group.items" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </SelectOption>
                  </SelectOptGroup>
                  <template #notFoundContent>
                    <span class="batch-bar__empty">
                      所选分层还没有分类，先去左侧分层树点该层的「＋」建一个
                    </span>
                  </template>
                </Select>
                <Button
                  type="primary"
                  :loading="assigning"
                  :disabled="!assignCategoryId"
                  @click="handleAssign(assignCategoryId || '')"
                >
                  批量归类
                </Button>
                <Button :loading="assigning" @click="handleAssign('')">移出分类</Button>
                <Button type="text" @click="clearSelection">取消选择</Button>
              </Space>
            </div>
            <Alert
              v-if="assignResult"
              class="mt-2"
              :type="assignResult.failed ? 'warning' : 'success'"
              show-icon
              closable
              :message="assignSummaryText"
              @close="assignResult = null"
            >
              <template v-if="assignResult.failures.length" #description>
                <div
                  v-for="(row, i) in assignResult.failures.slice(0, 5)"
                  :key="i"
                  class="pop-line"
                >
                  {{ row.name }}：{{ row.message }}
                </div>
                <div v-if="assignResult.failures.length > 5" class="pop-line">
                  …另有 {{ assignResult.failures.length - 5 }} 个未列出
                </div>
              </template>
            </Alert>
          </div>

          <Table
            :columns="columns"
            :data-source="dataSource"
            :loading="loading"
            :pagination="getPagination"
            :row-selection="rowSelection"
            row-key="id"
            size="middle"
            :scroll="{ x: 1380 }"
            @change="handleTableChange"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'layer'">
                <Tag :color="LAYER_TAG_COLORS[record.layer] || 'default'">{{ record.layer }}</Tag>
              </template>
              <template v-else-if="column.key === 'category'">
                <Tooltip v-if="categoryName(record.categoryId)" :title="categoryTipText(record)">
                  <Tag color="blue" class="cat-tag">{{ categoryName(record.categoryId) }}</Tag>
                </Tooltip>
                <Tooltip
                  v-else
                  :title="`点左侧 ${record.layer} 分层下的「未分类」可以一次捞出它们`"
                >
                  <Tag class="cat-tag cat-tag--none">未分类</Tag>
                </Tooltip>
              </template>
              <template v-else-if="column.key === 'createType'">
                <Tag>{{ record.createType === 'ddl' ? '界面建表' : '引用表' }}</Tag>
              </template>
              <template v-else-if="column.key === 'status'">
                <Tag :color="MODEL_STATUS_TAG_COLORS[record.status || 'draft']">
                  {{ MODEL_STATUS_LABELS[record.status || 'draft'] }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'tableStatus'">
                <Tooltip>
                  <template #title>
                    <span v-if="record.createType !== 'ddl'"
                      >引用表：由源系统维护，平台不建也不删</span
                    >
                    <span v-else-if="record.tableStatus === 'created'">
                      平台已在目标库创建 {{ record.tableName }}（{{ formatTime(record.tableAt) }}）
                    </span>
                    <span v-else-if="record.tableStatus === 'failed'">
                      上次建表失败：{{ record.tableMsg || '未记录原因' }}
                    </span>
                    <span v-else>启用后点「生成表」才会在目标库真建这张表</span>
                  </template>
                  <Tag :color="TABLE_STATUS_TAG_COLORS[record.tableStatus || 'none']">
                    {{ TABLE_STATUS_LABELS[record.tableStatus || 'none'] }}
                  </Tag>
                </Tooltip>
              </template>
              <template v-else-if="column.key === 'action'">
                <Space :size="0" wrap>
                  <Button type="link" size="small" @click="handleColumns(record)">字段</Button>
                  <Button
                    type="link"
                    size="small"
                    :loading="previewingId === record.id"
                    @click="handlePreview(record)"
                  >
                    预览数据
                  </Button>
                  <Button
                    v-if="record.status !== 'online'"
                    type="link"
                    size="small"
                    @click="handleToggleStatus(record, 'online')"
                  >
                    启用
                  </Button>
                  <Popconfirm
                    v-else
                    title="停用后指标与任务不能再引用该模型，已建的物表不受影响"
                    @confirm="handleToggleStatus(record, 'offline')"
                  >
                    <Button type="link" size="small">停用</Button>
                  </Popconfirm>
                  <Tooltip :title="createTableTip(record)">
                    <Button
                      type="link"
                      size="small"
                      :disabled="!canCreateTable(record)"
                      @click="handleCreateTable(record)"
                    >
                      生成表
                    </Button>
                  </Tooltip>
                  <Button type="link" size="small" @click="handleEdit(record)">编辑</Button>
                  <Button type="link" size="small" danger @click="handleDelete(record)"
                    >删除</Button
                  >
                </Space>
              </template>
            </template>
          </Table>
        </Card>
      </div>
    </div>

    <ModelModal @register="registerModelModal" @success="refreshAll" />
    <ColumnsModal @register="registerColumnsModal" @success="refreshAll" />
    <CreateTableModel @register="registerCreateTableModal" @success="reload" />
    <ModelDeleteModal @register="registerDeleteModal" @success="refreshAll" />
    <CategoryModal @register="registerCategoryModal" @success="loadCategoryTree" />

    <BasicModal
      v-bind="$attrs"
      :width="1040"
      centered
      canFullscreen
      :footer="null"
      @register="registerPreviewModal"
    >
      <template #title>
        <span class="modal-title">
          <Icon icon="ion:eye-outline" :size="18" />
          数据预览 · {{ previewModel?.name || '' }}
        </span>
      </template>
      <div class="preview-modal-root">
        <Alert v-if="previewError" type="error" show-icon :message="previewError" class="mb-3" />
        <div v-if="previewResult?.sql" class="sql-block mb-3">
          <span class="sql-label">执行 SQL</span>
          <code>{{ previewResult.sql }}</code>
        </div>
        <div v-if="previewResult?.rows" class="preview-meta mb-2">
          共 <b>{{ previewRows.length }}</b> 行 · 只读预览，最多返回前 100 行
        </div>
        <Table
          v-if="previewResult?.rows"
          :columns="previewColumns"
          :data-source="previewRows"
          :pagination="{ pageSize: 10, showTotal: (t: number) => `共 ${t} 行` }"
          size="small"
          :scroll="{ x: true }"
          row-key="__idx"
          :row-class-name="(_: any, index: number) => (index % 2 === 1 ? 'striped-row' : '')"
        />
      </div>
    </BasicModal>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onActivated, onMounted, reactive, ref } from 'vue'

  import { useRoute, useRouter } from 'vue-router'

  import {
    Alert,
    Button,
    Card,
    Form,
    Input,
    Popconfirm,
    Select,
    Space,
    Table,
    Tag,
    Tooltip,
    Tree,
    TreeSelect,
  } from 'ant-design-vue'

  import { getMetricDomainTreeApi, type MetricDomain } from '/@/api/databridge/metric'
  import {
    assignMetricModelCategoryApi,
    deleteMetricModelCategoryApi,
    getMetricModelApi,
    getMetricModelCategoryTreeApi,
    getMetricModelsApi,
    previewModelDataApi,
    updateMetricModelApi,
    type MetricModel,
    type MetricModelCategory,
    type MetricModelCategoryLayerNode,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModal } from '/@/components/Modal'
  import { PageWrapper } from '/@/components/Page'
  import { PAGE_GUIDES } from '../guides'
  import GuideCard from '../components/GuideCard.vue'
  import { useMessage } from '/@/hooks/web/useMessage'

  import {
    LAYER_OPTIONS,
    LAYER_TAG_COLORS,
    MODEL_STATUS_LABELS,
    MODEL_STATUS_OPTIONS,
    MODEL_STATUS_TAG_COLORS,
    TABLE_STATUS_LABELS,
    TABLE_STATUS_TAG_COLORS,
    formatTime,
  } from '../data'
  import { usePagedFetch } from '../../databridge/hooks/usePagedFetch'
  import CategoryModal from './CategoryModal.vue'
  import ColumnsModal from './ColumnsModal.vue'
  import CreateTableModel from './CreateTableModel.vue'
  import ModelDeleteModal from './ModelDeleteModal.vue'
  import ModelModal from './ModelModal.vue'

  const FormItem = Form.Item
  const SelectOptGroup = Select.OptGroup
  const SelectOption = Select.Option

  /** 树节点 key 的前缀：分层根 / 分类 / 该层未分类（虚拟节点，不落库） */
  const KEY_ALL = 'all'
  const KEY_LAYER = 'layer:'
  const KEY_CATEGORY = 'cat:'
  const KEY_NONE = 'none:'

  const { createMessage } = useMessage()
  const [registerModelModal, { openModal: openModelModal }] = useModal()
  const [registerColumnsModal, { openModal: openColumnsModal }] = useModal()
  const [registerCreateTableModal, { openModal: openCreateTableModal }] = useModal()
  const [registerDeleteModal, { openModal: openDeleteModal }] = useModal()
  const [registerPreviewModal, { openModal: openPreviewModal }] = useModal()
  const [registerCategoryModal, { openModal: openCategoryModal }] = useModal()

  const query = reactive({
    domainId: undefined as string | undefined,
    layer: undefined as string | undefined,
    status: undefined as string | undefined,
    categoryId: undefined as string | undefined,
    keyword: undefined as string | undefined,
  })

  const route = useRoute()
  const router = useRouter()

  const domainOptions = ref<any[]>([])

  // ==================== 分层树 ====================

  const treeLayers = ref<MetricModelCategoryLayerNode[]>([])
  const treeLoading = ref(false)
  const treeVisible = ref(true)
  const categoryTotal = ref(0)
  const selectedKeys = ref<string[]>([KEY_ALL])
  const expandedKeys = ref<string[]>([KEY_ALL])
  let expandedInitialized = false

  const modelTotal = computed(() =>
    treeLayers.value.reduce((sum, layer) => sum + (layer.modelCount || 0), 0),
  )

  /** 分类的唯一来源是 tree 的 children（后端不另开平铺列表） */
  const categoryById = computed<Record<string, MetricModelCategory>>(() => {
    const map: Record<string, MetricModelCategory> = {}
    treeLayers.value.forEach((layer) =>
      (layer.children || []).forEach((item) => {
        map[item.id] = item
      }),
    )
    return map
  })

  const treeData = computed(
    () =>
      [
        {
          key: KEY_ALL,
          nodeKey: KEY_ALL,
          kind: 'all',
          title: '全部模型',
          count: modelTotal.value,
          children: treeLayers.value.map((layer) => ({
            key: `${KEY_LAYER}${layer.layer}`,
            nodeKey: `${KEY_LAYER}${layer.layer}`,
            kind: 'layer',
            title: layer.label,
            layer: layer.layer,
            label: layer.label,
            count: layer.modelCount || 0,
            children: [
              ...(layer.children || []).map((item) => ({
                key: `${KEY_CATEGORY}${item.id}`,
                nodeKey: `${KEY_CATEGORY}${item.id}`,
                kind: 'category',
                title: item.name,
                id: item.id,
                name: item.name,
                layer: item.layer,
                description: item.description || '',
                count: item.modelCount || 0,
              })),
              // 「未分类」是该层的虚拟桶：只有真有模型时才出现
              ...(layer.uncategorized > 0
                ? [
                    {
                      key: `${KEY_NONE}${layer.layer}`,
                      nodeKey: `${KEY_NONE}${layer.layer}`,
                      kind: 'none',
                      title: '未分类',
                      layer: layer.layer,
                      count: layer.uncategorized,
                    },
                  ]
                : []),
            ],
          })),
        },
      ] as any[],
  )

  function nodeClass(node: any) {
    return ['node', `node--${node.kind}`, { 'node--on': selectedKeys.value[0] === node.nodeKey }]
  }

  /** 由「分层 + 分类」反推树节点 key，用于 URL 带入与筛选表单联动 */
  function nodeKeyFor(layer?: string, categoryId?: string) {
    if (categoryId && categoryId !== 'none') return `${KEY_CATEGORY}${categoryId}`
    if (categoryId === 'none') return layer ? `${KEY_NONE}${layer}` : KEY_ALL
    return layer ? `${KEY_LAYER}${layer}` : KEY_ALL
  }

  function filterOfKey(key: string) {
    if (key.startsWith(KEY_CATEGORY)) {
      const id = key.slice(KEY_CATEGORY.length)
      return { layer: categoryById.value[id]?.layer, categoryId: id }
    }
    if (key.startsWith(KEY_NONE)) return { layer: key.slice(KEY_NONE.length), categoryId: 'none' }
    if (key.startsWith(KEY_LAYER))
      return { layer: key.slice(KEY_LAYER.length), categoryId: undefined }
    return { layer: undefined, categoryId: undefined }
  }

  async function loadCategoryTree() {
    treeLoading.value = true
    try {
      const result = await getMetricModelCategoryTreeApi()
      treeLayers.value = result?.layers || []
      categoryTotal.value = Number(result?.total) || 0
      if (!expandedInitialized) {
        expandedKeys.value = [
          KEY_ALL,
          ...treeLayers.value.map((layer) => `${KEY_LAYER}${layer.layer}`),
        ]
        expandedInitialized = true
      }
      // 当前选中的分类已被删除（他人操作/本端删除）：回到它所在的分层根
      const selected = selectedKeys.value[0] || KEY_ALL
      if (
        selected.startsWith(KEY_CATEGORY) &&
        !categoryById.value[selected.slice(KEY_CATEGORY.length)]
      ) {
        const fallback = filterOfKey(selected)
        selectedKeys.value = [nodeKeyFor(fallback.layer, undefined)]
        query.layer = fallback.layer
        query.categoryId = undefined
      }
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '分层树加载失败'))
    } finally {
      treeLoading.value = false
    }
  }

  function applyNodeFilter(key: string) {
    selectedKeys.value = [key]
    const parsed = filterOfKey(key)
    query.layer = parsed.layer
    query.categoryId = parsed.categoryId
    clearSelection()
    search()
  }

  function handleTreeSelect(keys: (string | number)[]) {
    // block-node 下重复点同一个节点会回传空数组（取消选中）：等价于回到「全部模型」
    applyNodeFilter(String(keys[0] || '') || KEY_ALL)
  }

  function clearTreeFilter() {
    applyNodeFilter(KEY_ALL)
  }

  const treeFilterText = computed(() => {
    if (!query.layer && !query.categoryId) return ''
    const layerLabel = LAYER_OPTIONS.find((item) => item.value === query.layer)?.label
    const scope = layerLabel ? `${query.layer} ${layerLabel}` : '全部分层'
    if (query.categoryId === 'none') return `分层：${scope} · 未分类`
    if (query.categoryId) {
      return `分层：${scope} · 分类「${
        categoryById.value[query.categoryId]?.name || query.categoryId
      }」`
    }
    return `分层：${scope}`
  })

  function categoryName(categoryId?: string) {
    if (!categoryId) return ''
    return categoryById.value[categoryId]?.name || ''
  }

  function categoryTipText(record: MetricModel) {
    const item = categoryById.value[record.categoryId || '']
    if (!item) return '这个建模还没归类'
    return [
      `${item.layer} · ${item.name}`,
      item.description,
      '要挪走：勾选行后用「批量归类」；改分层需要在编辑里重选分类',
    ]
      .filter(Boolean)
      .join(' — ')
  }

  // ==================== 分类 CRUD（只动元数据，不碰物理表） ====================

  function openCreateCategory(layer?: string) {
    openCategoryModal(true, { layer: layer || query.layer || 'DWD' })
  }

  function openEditCategory(node: any) {
    const record = categoryById.value[node.id]
    if (!record) {
      createMessage.warning('这个分类刚刚被删除，请刷新分层树')
      return
    }
    openCategoryModal(true, { record })
  }

  async function handleDeleteCategory(node: any) {
    // 先记「当前是否正选中这个分类」：刷新树之后这个 id 就从映射里消失了
    const wasSelected = query.categoryId === node.id
    try {
      const result = await deleteMetricModelCategoryApi(node.id)
      createMessage.success(
        `已删除分类【${node.name}】，${
          result?.movedModels ?? 0
        } 个建模退回未分类（建模本身与数据库里的表都没动）`,
      )
      await loadCategoryTree()
      // 删的正是当前筛选节点：落到它所在的分层根，用户能直接看到退回「未分类」的那批
      if (wasSelected) applyNodeFilter(`${KEY_LAYER}${node.layer}`)
      else reload()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '删除分类失败'))
    }
  }

  // ==================== 批量归类 ====================

  const selectedRowKeys = ref<string[]>([])
  const selectedRows = ref<Record<string, MetricModel>>({})
  const assignCategoryId = ref<string | undefined>(undefined)
  const assigning = ref(false)
  const assignResult = ref<{
    assigned: number
    failed: number
    target: string
    failures: { name: string; message: string }[]
  } | null>(null)

  const rowSelection = computed(() => ({
    type: 'checkbox' as const,
    selectedRowKeys: selectedRowKeys.value,
    // 翻页时保留勾选：批量归类常常要跨页挑
    preserveSelectedRowKeys: true,
    onChange: (keys: (string | number)[], rows: any[]) => {
      selectedRowKeys.value = keys.map((key) => String(key))
      const map: Record<string, MetricModel> = {}
      rows.forEach((row) => {
        if (row?.id) map[String(row.id)] = row
      })
      selectedRows.value = map
      if (!selectedRowKeys.value.length) assignResult.value = null
    },
  }))

  const selectedList = computed(
    () =>
      selectedRowKeys.value.map((key) => selectedRows.value[key]).filter(Boolean) as MetricModel[],
  )

  const selectedLayers = computed(() => [...new Set(selectedList.value.map((item) => item.layer))])

  const selectedLayersText = computed(() => selectedLayers.value.join(' / ') || '未知')

  /** 分类只装同层建模：单层勾选时只给该层的分类，跨层勾选时按分层分组给全（失败会点名） */
  const assignGroups = computed(() => {
    const layers =
      selectedLayers.value.length === 1
        ? treeLayers.value.filter((layer) => layer.layer === selectedLayers.value[0])
        : treeLayers.value
    return layers
      .map((layer) => ({
        layer: layer.layer,
        label: `${layer.layer} ${layer.label}（${(layer.children || []).length} 个分类）`,
        items: layer.children || [],
      }))
      .filter((group) => group.items.length)
  })

  const assignSummaryText = computed(() => {
    const result = assignResult.value
    if (!result) return ''
    const target = result.target ? `归入【${result.target}】` : '退回未分类'
    return `批量归类完成：成功 ${result.assigned} 个（${target}）${
      result.failed ? ` · 未成功 ${result.failed} 个` : ''
    }`
  })

  function clearSelection() {
    selectedRowKeys.value = []
    selectedRows.value = {}
  }

  async function handleAssign(categoryId: string) {
    if (!selectedRowKeys.value.length) {
      createMessage.warning('先在列表左侧勾选要归类的建模')
      return
    }
    if (categoryId && !categoryById.value[categoryId]) {
      createMessage.warning('请先选择一个分类，或直接点「移出分类」')
      return
    }
    if (selectedRowKeys.value.length > 500) {
      createMessage.warning('单次批量归类上限 500 个，请分页分批处理')
      return
    }
    assigning.value = true
    try {
      const result = await assignMetricModelCategoryApi({
        categoryId,
        modelIds: selectedRowKeys.value,
      })
      const failures = (result?.results || [])
        .filter((item) => !item.ok)
        .map((item) => ({
          name: selectedRows.value[item.id]?.name || item.id,
          message: item.message || '归类失败',
        }))
      assignResult.value = {
        assigned: result?.assigned || 0,
        failed: result?.failed || 0,
        target: categoryId ? categoryById.value[categoryId]?.name || categoryId : '',
        failures,
      }
      if (result?.assigned) {
        createMessage.success(
          `已把 ${result.assigned} 个建模${
            categoryId ? ` 归入【${categoryById.value[categoryId]?.name}】` : ' 退回未分类'
          }`,
        )
      }
      if (result?.failed) {
        createMessage.warning(`${result.failed} 个建模没归类成功，原因见批量条下方明细`)
      }
      clearSelection()
      assignCategoryId.value = undefined
      await loadCategoryTree()
      reload()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '批量归类失败'))
    } finally {
      assigning.value = false
    }
  }

  // ==================== 列表 ====================

  const columns = [
    { title: '模型名称', dataIndex: 'name', key: 'name', width: 180 },
    { title: '物理表', dataIndex: 'tableName', key: 'tableName', width: 200 },
    { title: '分层', key: 'layer', width: 90 },
    { title: '分类', key: 'category', width: 150 },
    { title: '创建方式', key: 'createType', width: 100 },
    { title: '时间列', dataIndex: 'timeColumn', key: 'timeColumn', width: 130 },
    { title: '状态', key: 'status', width: 100 },
    { title: '表状态', key: 'tableStatus', width: 110 },
    { title: '操作', key: 'action', width: 320, fixed: 'right' as const },
  ]

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<MetricModel>(
    (params) =>
      getMetricModelsApi({
        page: params.page,
        size: params.size,
        domainId: query.domainId,
        layer: query.layer,
        status: query.status,
        categoryId: query.categoryId,
        keyword: query.keyword,
      }),
    query,
  )

  function toTreeOptions(nodes: MetricDomain[]): any[] {
    return nodes.map((node) => ({
      value: node.id,
      title: node.name,
      children: node.children?.length ? toTreeOptions(node.children) : undefined,
    }))
  }

  async function loadDomains() {
    try {
      const result = await getMetricDomainTreeApi()
      domainOptions.value = toTreeOptions(result?.items ?? [])
    } catch {
      domainOptions.value = []
    }
  }

  function handleSearch() {
    search()
  }

  function handleReset() {
    query.domainId = undefined
    query.layer = undefined
    query.status = undefined
    query.categoryId = undefined
    query.keyword = undefined
    selectedKeys.value = [KEY_ALL]
    clearSelection()
    resetFetch()
  }

  /** 顶部「分层」下拉与树是同一条筛选：改下拉就把选中态挪到对应节点 */
  function handleLayerFilterChange() {
    selectedKeys.value = [nodeKeyFor(query.layer, query.categoryId)]
  }

  function refreshAll() {
    reload()
    loadCategoryTree()
  }

  function handleCreate() {
    // 树上点了某层/某分类：新建模型默认落到这一层（分类要重选，跨层会被拒）
    openModelModal(true, { isUpdate: false, layer: query.layer })
  }

  function handleEdit(record: MetricModel) {
    openModelModal(true, { record, isUpdate: true })
  }

  function handleColumns(record: MetricModel) {
    openColumnsModal(true, { modelId: record.id, modelName: record.name })
  }

  function handleDelete(record: MetricModel) {
    openDeleteModal(true, { modelId: record.id })
  }

  /** 只有「界面建表」的模型由平台负责建表；引用表本就存在于源库 */
  function canCreateTable(record: MetricModel) {
    return record.createType === 'ddl' && record.status === 'online'
  }

  function createTableTip(record: MetricModel) {
    if (record.createType !== 'ddl') return '引用表存在于源库，平台不建也不删'
    if (record.status !== 'online') return '草稿/停用模型不能生成表，请先点「启用」'
    return record.tableStatus === 'created'
      ? '已建表，再次点击幂等同步状态'
      : '在目标库执行建表 DDL'
  }

  function handleCreateTable(record: MetricModel) {
    if (!canCreateTable(record)) return
    openCreateTableModal(true, { modelId: record.id })
  }

  async function handleToggleStatus(record: MetricModel, status: 'online' | 'offline') {
    try {
      await updateMetricModelApi(record.id, { status })
      createMessage.success(
        status === 'online'
          ? `已启用【${record.name}】${
              record.createType === 'ddl' ? '，现在可以点「生成表」建物理表' : ''
            }`
          : `已停用【${record.name}】`,
      )
      reload()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '状态更新失败'))
    }
  }

  const previewingId = ref('')
  const previewModel = ref<MetricModel | null>(null)
  const previewResult = ref<Awaited<ReturnType<typeof previewModelDataApi>> | null>(null)
  const previewError = ref('')

  const previewColumns = computed(() =>
    (previewResult.value?.columns || []).map((c) => ({
      title: c,
      dataIndex: c,
      key: c,
      ellipsis: true,
    })),
  )

  const previewRows = computed(() =>
    (previewResult.value?.rows || []).map((row, index) => {
      const record: Recordable = { __idx: index }
      ;(previewResult.value?.columns || []).forEach((col, i) => {
        record[col] = row[i]
      })
      return record
    }),
  )

  async function handlePreview(record: MetricModel) {
    previewingId.value = record.id
    previewModel.value = record
    previewResult.value = null
    previewError.value = ''
    try {
      previewResult.value = await previewModelDataApi(record.id)
      if (!previewResult.value.executable) {
        previewError.value = previewResult.value.error || '内存模式不发起真实查询'
      }
      openPreviewModal(true)
    } catch (error) {
      previewError.value = getApiErrorMessage(
        error,
        '预览失败（数据源 SQL 执行错误将透传真实库信息）',
      )
      openPreviewModal(true)
    } finally {
      previewingId.value = ''
    }
  }

  async function openColumnsFor(modelId: string) {
    try {
      const detail = await getMetricModelApi(modelId)
      openColumnsModal(true, { modelId, modelName: detail?.name || modelId })
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '目标模型加载失败'))
    }
  }

  /** URL 上的筛选（域/分层/分类，分类含 none）落到 query 与树的选中态；返回是否变了条件 */
  function syncFilterFromRoute() {
    let changed = false
    const domainId = String(route.query.domainId || '')
    if (domainId && domainId !== query.domainId) {
      query.domainId = domainId
      changed = true
    }
    const categoryId = String(route.query.categoryId || '')
    const layer = String(route.query.layer || '')
    if (layer || categoryId) {
      const nextLayer = layer || categoryById.value[categoryId]?.layer
      const nextCategory = categoryId || undefined
      if (nextLayer !== query.layer || nextCategory !== query.categoryId) {
        query.layer = nextLayer
        query.categoryId = nextCategory
        changed = true
      }
      selectedKeys.value = [nodeKeyFor(nextLayer, nextCategory)]
      // 直达 URL 指到某个分类时把它所在的分层展开，否则用户看不到高亮节点
      if (nextLayer) {
        const layerKey = `${KEY_LAYER}${nextLayer}`
        if (!expandedKeys.value.includes(layerKey))
          expandedKeys.value = [...expandedKeys.value, layerKey]
      }
    }
    return changed
  }

  /** 直达路由：?domainId= / ?columnsFor= / ?createModel=1 / ?layer= / ?categoryId=（含 none） */
  function applyRouteIntent() {
    const columnsFor = String(route.query.columnsFor || '')
    if (columnsFor) openColumnsFor(columnsFor)
    else if (route.query.createModel) openModelModal(true, { isUpdate: false, layer: query.layer })
    if (columnsFor || route.query.createModel) {
      // 只吃掉「开弹窗」这两个意图参数，筛选参数留在地址栏里便于分享
      const kept: Recordable = {}
      if (query.domainId) kept.domainId = query.domainId
      if (query.layer) kept.layer = query.layer
      if (query.categoryId) kept.categoryId = query.categoryId
      router.replace({ name: 'MetricModels', query: kept })
    }
  }

  onMounted(async () => {
    loadDomains()
    await loadCategoryTree()
    syncFilterFromRoute()
    search()
    applyRouteIntent()
  })
  onActivated(() => {
    const changed = syncFilterFromRoute()
    if (changed) search()
    applyRouteIntent()
  })
</script>

<style lang="less" scoped>
  .model-layout {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }

  .tree-pane {
    flex: 0 0 272px;
    width: 272px;
  }

  .list-pane {
    flex: 1;
    min-width: 0;
  }

  @media (max-width: 992px) {
    .model-layout {
      flex-direction: column;
    }

    .tree-pane {
      flex: none;
      width: 100%;
    }
  }

  .tree-title {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-weight: 600;
  }

  .tree-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .tree-sum {
    font-size: 12px;
    color: @text-color-secondary;

    b {
      color: @primary-color;
    }
  }

  .tree-hint {
    margin-top: 10px;
    padding: 8px 10px;
    font-size: 12px;
    line-height: 18px;
    color: @text-color-secondary;
    background: @background-color-light;
    border-radius: 6px;

    b {
      color: @text-color;
    }
  }

  .node {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    max-width: 100%;

    &--on {
      .node-name {
        font-weight: 600;
        color: @primary-color;
      }

      .node-count {
        color: @primary-color;
        background: fade(@primary-color, 12%);
      }
    }
  }

  .node-main {
    display: inline-flex;
    flex-direction: column;
    min-width: 0;
  }

  .node-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &--muted {
      color: @text-color-secondary;
    }
  }

  .node-desc {
    max-width: 180px;
    overflow: hidden;
    font-size: 11px;
    line-height: 16px;
    color: @text-color-secondary;
    text-overflow: ellipsis;
    white-space: nowrap;

    &--empty {
      font-style: italic;
      opacity: 0.7;
    }
  }

  .node-icon {
    flex-shrink: 0;
    color: @text-color-secondary;
  }

  .node-inner {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }

  .node-tag {
    margin-right: 0;
    line-height: 18px;
  }

  .node-count {
    flex-shrink: 0;
    padding: 0 6px;
    font-size: 11px;
    line-height: 17px;
    color: @text-color-secondary;
    background: @background-color-light;
    border-radius: 9px;
  }

  .node-ops {
    display: none;
    flex-shrink: 0;
    gap: 2px;
    align-items: center;

    /* 确认框弹出时保持可见，免得鼠标移开就消失 */
    &:focus-within {
      display: inline-flex;
    }
  }

  .node-act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    font-size: 12px;
    color: @primary-color;
    border-radius: 4px;
    cursor: pointer;

    &:hover {
      background: fade(@primary-color, 12%);
    }

    &--danger {
      color: @error-color;

      &:hover {
        background: fade(@error-color, 12%);
      }
    }
  }

  :deep(.ant-tree-node-content-wrapper) {
    &:hover .node-ops,
    &:focus-within .node-ops {
      display: inline-flex;
    }
  }

  :deep(.ant-tree-title) {
    display: block;
    min-width: 0;
  }

  .filter-chip {
    display: inline-flex;
    gap: 5px;
    align-items: center;
    padding: 2px 10px;
    font-size: 12px;
    color: @primary-color;
    background: fade(@primary-color, 8%);
    border: 1px solid fade(@primary-color, 25%);
    border-radius: 12px;
  }

  .batch-bar {
    padding: 10px 12px;
    background: @component-background;
    border: 1px solid @border-color-split;
    border-left: 3px solid @primary-color;
    border-radius: 6px;

    &__head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    &__icon {
      color: @primary-color;
    }

    &__count {
      font-weight: 600;
    }

    &__meta {
      font-size: 12px;
      color: @text-color-secondary;
    }

    &__ops {
      margin-left: auto;
    }

    &__empty {
      font-size: 12px;
      color: @text-color-secondary;
    }
  }

  .pop-line {
    max-width: 320px;
    font-size: 12px;
    line-height: 18px;
  }

  .cat-tag {
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;

    &--none {
      color: @text-color-secondary;
      border-style: dashed;
    }
  }

  .modal-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }

  .preview-meta {
    color: @text-color-secondary;
    font-size: 12px;

    b {
      color: @primary-color;
    }
  }

  .sql-block {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    background: @background-color-light;
    border: 1px solid @border-color-split;
    border-left: 3px solid @primary-color;
    padding: 10px 14px;
    border-radius: 6px;
    word-break: break-all;

    .sql-label {
      display: block;
      color: @text-color-secondary;
      font-size: 11px;
      margin-bottom: 4px;
      letter-spacing: 1px;
    }

    code {
      background: transparent;
      color: @text-color;
    }
  }
</style>
