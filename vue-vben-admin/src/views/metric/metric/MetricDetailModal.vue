<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="`指标详情：${metric?.name || ''}（${metric?.code || ''}）`"
    :width="920"
    :min-height="360"
    :mask-closable="false"
    :footer="null"
  >
    <Tabs v-model:activeKey="activeTab">
      <TabPane key="tree" tab="展开树（子指标与公式）">
        <Spin :spinning="treeLoading">
          <Tree
            v-if="treeNode"
            :tree-data="[treeNode]"
            :field-names="{ title: 'title', key: 'key' }"
            default-expand-all
          >
            <template #title="node">
              <Space>
                <Tag :color="METRIC_TYPE_TAG_COLORS[node.type] || 'default'">
                  {{ METRIC_TYPE_LABELS[node.type] || node.type }}
                </Tag>
                <span>{{ node.title }}</span>
                <span v-if="node.exprText" class="expr-text">{{ node.exprText }}</span>
              </Space>
            </template>
          </Tree>
          <Empty v-else description="无展开数据" />
        </Spin>
      </TabPane>

      <TabPane key="lineage" tab="血缘">
        <Spin :spinning="lineageLoading">
          <Row :gutter="16">
            <Col :span="12">
              <Card size="small" title="上游（被本指标引用）">
                <List :data-source="lineage?.parents || []" size="small">
                  <template #renderItem="{ item }">
                    <List.Item>
                      <Space>
                        <Tag :color="METRIC_TYPE_TAG_COLORS[item.type]">{{ METRIC_TYPE_LABELS[item.type] || item.type }}</Tag>
                        {{ item.name }}（{{ item.code }}）
                      </Space>
                    </List.Item>
                  </template>
                </List>
              </Card>
            </Col>
            <Col :span="12">
              <Card size="small" title="下游（引用了本指标）">
                <List :data-source="lineage?.children || []" size="small">
                  <template #renderItem="{ item }">
                    <List.Item>
                      <Space>
                        <Tag :color="METRIC_TYPE_TAG_COLORS[item.type]">{{ METRIC_TYPE_LABELS[item.type] || item.type }}</Tag>
                        {{ item.name }}（{{ item.code }}）
                      </Space>
                    </List.Item>
                  </template>
                </List>
              </Card>
            </Col>
          </Row>
        </Spin>
      </TabPane>

      <TabPane key="preview" tab="试跑（真实执行）">
        <Space class="mb-3" wrap>
          <span>日期：</span>
          <RangePicker v-model:value="previewRange" value-format="YYYY-MM-DD" />
          <span>维度：</span>
          <Select
            v-model:value="previewDims"
            :options="dimensionOptions"
            mode="multiple"
            allow-clear
            style="min-width: 220px"
            placeholder="不选 = 单值"
          />
          <Button type="primary" :loading="previewLoading" @click="handlePreview">执行</Button>
        </Space>
        <div v-if="previewResult?.sql" class="sql-block mb-3">{{ previewResult.sql }}</div>
        <Alert v-if="previewError" type="error" show-icon :message="previewError" />
        <Table
          v-if="previewResult?.rows"
          :columns="previewColumns"
          :data-source="previewRows"
          size="small"
          :pagination="{ pageSize: 10 }"
          row-key="__idx"
          :scroll="{ x: true }"
        />
        <div v-if="previewResult?.elapsedMs != null" class="text-gray mt-2" style="font-size: 12px">
          耗时 {{ previewResult.elapsedMs }} ms
        </div>
      </TabPane>

      <TabPane key="versions" tab="版本">
        <Table
          :columns="versionColumns"
          :data-source="versions"
          :loading="versionsLoading"
          :pagination="false"
          size="small"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'createdAt'">{{ formatTime(record.createdAt) }}</template>
            <template v-else-if="column.key === 'action'">
              <Popconfirm
                title="回滚会把该版本内容覆盖为当前指标并生成新版本，确认？"
                @confirm="handleRollback(record.version)"
              >
                <Button type="link" size="small" :disabled="record.version === metric?.version">
                  回滚到此版本
                </Button>
              </Popconfirm>
            </template>
          </template>
        </Table>
      </TabPane>
    </Tabs>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, ref } from 'vue'

  import {
    Alert,
    Button,
    Card,
    Col,
    Empty,
    List,
    Popconfirm,
    Row,
    Select,
    Space,
    Spin,
    Table,
    Tabs,
    Tag,
    Tree,
  } from 'ant-design-vue'

  import { DatePicker } from 'ant-design-vue'

  import {
    getMetricLineageApi,
    getMetricModelApi,
    getMetricTreeApi,
    getMetricVersionsApi,
    previewMetricApi,
    rollbackMetricApi,
    type MetricItem,
    type MetricTreeNode,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { METRIC_TYPE_LABELS, METRIC_TYPE_TAG_COLORS, formatTime } from '../data'

  const TabPane = Tabs.TabPane
  const RangePicker = DatePicker.RangePicker

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const metric = ref<MetricItem | null>(null)
  const activeTab = ref('tree')

  const treeNode = ref<any>(null)
  const treeLoading = ref(false)
  const lineage = ref<Awaited<ReturnType<typeof getMetricLineageApi>> | null>(null)
  const lineageLoading = ref(false)

  const dimensionOptions = ref<{ label: string; value: string }[]>([])
  const previewRange = ref<[string, string] | null>(null)
  const previewDims = ref<string[]>([])
  const previewLoading = ref(false)
  const previewResult = ref<Awaited<ReturnType<typeof previewMetricApi>> | null>(null)
  const previewError = ref('')

  const versions = ref<any[]>([])
  const versionsLoading = ref(false)

  const versionColumns = [
    { title: '版本', dataIndex: 'version', key: 'version', width: 80 },
    { title: '修改说明', dataIndex: 'note', key: 'note' },
    { title: '操作人', dataIndex: 'updatedBy', key: 'updatedBy', width: 120 },
    { title: '时间', key: 'createdAt', width: 170 },
    { title: '操作', key: 'action', width: 130 },
  ]

  function mapTree(node: MetricTreeNode): any {
    return {
      key: `${node.id}-${Math.random().toString(36).slice(2, 6)}`,
      title: `${node.name}（${node.code}）`,
      type: node.type,
      exprText: node.expr ? String(node.expr).slice(0, 80) : '',
      children: (node.children || []).map(mapTree),
    }
  }

  async function loadTree(id: string) {
    treeLoading.value = true
    try {
      const tree = await getMetricTreeApi(id)
      treeNode.value = tree ? mapTree(tree) : null
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '展开树加载失败'))
    } finally {
      treeLoading.value = false
    }
  }

  async function loadLineage(id: string) {
    lineageLoading.value = true
    try {
      lineage.value = await getMetricLineageApi(id)
    } finally {
      lineageLoading.value = false
    }
  }

  async function loadDimensions(item: MetricItem) {
    dimensionOptions.value = []
    const modelId = item.modelId || item.defineParams?.modelId || item.defineParams?.baseMetricModelId
    if (!modelId) return
    try {
      const detail = await getMetricModelApi(modelId)
      dimensionOptions.value = (detail?.columns || [])
        .filter((c) => c.role === 'dimension')
        .map((c) => ({ label: `${c.bizName || c.columnName}（${c.columnName}）`, value: c.columnName }))
    } catch {
      dimensionOptions.value = []
    }
  }

  const previewColumns = computed(() =>
    (previewResult.value?.columns || []).map((c) => ({ title: c, dataIndex: c, key: c, ellipsis: true }))
  )

  const previewRows = computed(() =>
    (previewResult.value?.rows || []).map((row, index) => {
      const record: Recordable = { __idx: index }
      ;(previewResult.value?.columns || []).forEach((col, i) => {
        record[col] = row[i]
      })
      return record
    })
  )

  async function handlePreview() {
    if (!metric.value) return
    previewLoading.value = true
    previewError.value = ''
    previewResult.value = null
    try {
      previewResult.value = await previewMetricApi(metric.value.id, {
        dateRange: previewRange.value ? { start: previewRange.value[0], end: previewRange.value[1] } : null,
        dimensions: previewDims.value,
        limit: 100,
      })
      if (!previewResult.value.executable) previewError.value = '内存模式不发起真实查询'
    } catch (error) {
      previewError.value = getApiErrorMessage(error, '试跑失败（50201 透传真实库错误）')
    } finally {
      previewLoading.value = false
    }
  }

  async function loadVersions(id: string) {
    versionsLoading.value = true
    try {
      const result = await getMetricVersionsApi(id)
      versions.value = (result?.items || []).slice().reverse()
    } finally {
      versionsLoading.value = false
    }
  }

  async function handleRollback(version: number) {
    if (!metric.value) return
    try {
      await rollbackMetricApi(metric.value.id, version)
      createMessage.success(`已回滚 v${version} 为新草稿，请检查后重新上线`)
      emit('success')
      closeModal()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '回滚失败'))
    }
  }

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    metric.value = data?.record || null
    activeTab.value = data?.tab || 'tree'
    previewResult.value = null
    previewError.value = ''
    previewRange.value = null
    previewDims.value = []
    if (!metric.value) return
    loadTree(metric.value.id)
    loadLineage(metric.value.id)
    loadDimensions(metric.value)
    loadVersions(metric.value.id)
  })
</script>

<style lang="less" scoped>
  .expr-text {
    color: #999;
    font-size: 12px;
    font-family: Consolas, Monaco, monospace;
  }

  .sql-block {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    background: #f6f8fa;
    padding: 8px 12px;
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
