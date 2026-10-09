<template>
  <PageWrapper
    title="指标中心 · 数据建模"
    content="建模即建表：界面建表(ddl) 走 草稿 → 启用 → 生成表；引用表(reference) 只登记源库已有表，平台不建也不删。字段的角色（维度/时间/度量）决定指标可用性"
  >
    <GuideCard :guide="PAGE_GUIDES.model" />
    <Card :bordered="false" class="mb-3">
      <Form layout="inline" @finish="handleSearch">
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
      <div class="mb-3 flex justify-end">
        <Button type="primary" @click="handleCreate">
          <Icon icon="ant-design:plus-outlined" class="mr-1" />
          新建模型
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        row-key="id"
        size="middle"
        :scroll="{ x: 1260 }"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'layer'">
            <Tag :color="LAYER_TAG_COLORS[record.layer] || 'default'">{{ record.layer }}</Tag>
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
                <span v-if="record.createType !== 'ddl'">引用表：由源系统维护，平台不建也不删</span>
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
              <Button type="link" size="small" danger @click="handleDelete(record)">删除</Button>
            </Space>
          </template>
        </template>
      </Table>
    </Card>

    <ModelModal @register="registerModelModal" @success="reload" />
    <ColumnsModal @register="registerColumnsModal" @success="reload" />
    <CreateTableModel @register="registerCreateTableModal" @success="reload" />
    <ModelDeleteModal @register="registerDeleteModal" @success="reload" />

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
  import { computed, onMounted, reactive, ref } from 'vue'

  import { useRoute } from 'vue-router'

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
    TreeSelect,
  } from 'ant-design-vue'

  import { getMetricDomainTreeApi, type MetricDomain } from '/@/api/databridge/metric'
  import {
    getMetricModelsApi,
    previewModelDataApi,
    updateMetricModelApi,
    type MetricModel,
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
  import ColumnsModal from './ColumnsModal.vue'
  import CreateTableModel from './CreateTableModel.vue'
  import ModelDeleteModal from './ModelDeleteModal.vue'
  import ModelModal from './ModelModal.vue'

  const FormItem = Form.Item

  const { createMessage } = useMessage()
  const [registerModelModal, { openModal: openModelModal }] = useModal()
  const [registerColumnsModal, { openModal: openColumnsModal }] = useModal()
  const [registerCreateTableModal, { openModal: openCreateTableModal }] = useModal()
  const [registerDeleteModal, { openModal: openDeleteModal }] = useModal()
  const [registerPreviewModal, { openModal: openPreviewModal }] = useModal()

  const query = reactive({
    domainId: undefined as string | undefined,
    layer: undefined as string | undefined,
    status: undefined as string | undefined,
    keyword: undefined as string | undefined,
  })

  // 域管理页「在本域新建模型」跳转带 ?domainId= 时预置筛选
  const route = useRoute()
  if (route.query.domainId) query.domainId = String(route.query.domainId)

  const domainOptions = ref<any[]>([])

  const columns = [
    { title: '模型名称', dataIndex: 'name', key: 'name', width: 180 },
    { title: '物理表', dataIndex: 'tableName', key: 'tableName', width: 220 },
    { title: '分层', key: 'layer', width: 90 },
    { title: '创建方式', key: 'createType', width: 100 },
    { title: '时间列', dataIndex: 'timeColumn', key: 'timeColumn', width: 140 },
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
    query.keyword = undefined
    resetFetch()
  }

  function handleCreate() {
    openModelModal(true, { isUpdate: false })
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

  onMounted(() => {
    loadDomains()
    search()
  })
</script>

<style lang="less" scoped>
  .modal-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }

  .preview-meta {
    color: #8c8c8c;
    font-size: 12px;

    b {
      color: #1677ff;
    }
  }

  .sql-block {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    background: #f6f8fa;
    border: 1px solid #eaecef;
    border-left: 3px solid #1677ff;
    padding: 10px 14px;
    border-radius: 6px;
    word-break: break-all;

    .sql-label {
      display: block;
      color: #8c8c8c;
      font-size: 11px;
      margin-bottom: 4px;
      letter-spacing: 1px;
    }

    code {
      background: transparent;
      color: #24292e;
    }
  }
</style>
