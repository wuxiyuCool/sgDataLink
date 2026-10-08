<template>
  <PageWrapper
    title="指标中心 · 指标域"
    content="按业务主题组织指标资产的树；域编码是界面建表前缀，删除时域下有模型/指标将被拒绝（40902）。右键节点弹出新建子域/编辑/删除菜单"
  >
    <GuideCard :guide="PAGE_GUIDES.domain" />
    <Row :gutter="16">
      <Col :span="9">
        <Card :bordered="false" :loading="loading">
          <template #title>域树</template>
          <template #extra>
            <Button type="primary" size="small" @click="openCreate(null)">新增根域</Button>
          </template>
          <Tree
            v-if="treeData.length"
            v-model:selectedKeys="selectedKeys"
            :tree-data="treeData"
            :field-names="{ title: 'name', key: 'id', children: 'children' }"
            default-expand-all
            block-node
            @select="handleSelect"
          >
            <template #title="node">
              <Dropdown :trigger="['contextmenu']">
                <span class="domain-node">
                  <span>{{ node.name }}</span>
                  <span class="domain-code">{{ node.code }}</span>
                  <span class="domain-counts"
                    >模型 {{ node.modelCount ?? 0 }} · 指标 {{ node.metricCount ?? 0 }}</span
                  >
                  <Tooltip title="在此域下新建子域">
                    <span class="node-add" @click.stop="openCreate(node)">
                      <Icon icon="ant-design:plus-outlined" :size="12" />
                    </span>
                  </Tooltip>
                </span>
                <template #overlay>
                  <Menu @click="handleContextMenu($event, node)">
                    <MenuItem key="create">新建子域</MenuItem>
                    <MenuItem key="edit">编辑域</MenuItem>
                    <MenuItem key="delete" danger>删除域</MenuItem>
                  </Menu>
                </template>
              </Dropdown>
            </template>
          </Tree>
          <Empty v-else description="暂无指标域" />
          <div class="tree-hint">
            提示：悬停节点出现「+」逐层新建子域；右键节点弹出操作菜单；单击节点在右侧查看该域的数据模型
          </div>
        </Card>
      </Col>
      <Col :span="15">
        <Card :bordered="false">
          <template #title>
            <Space>
              数据模型
              <Tag v-if="selectedNode" color="blue">{{ selectedNode.name }}</Tag>
              <span v-else class="all-hint">（未选域 = 全部）</span>
            </Space>
          </template>
          <template #extra>
            <Button type="primary" size="small" :disabled="!selectedNode" @click="goCreateModel">
              在本域新建模型
            </Button>
          </template>
          <Table
            :columns="modelColumns"
            :data-source="models"
            :loading="modelsLoading"
            :pagination="{ pageSize: 10, showTotal: (t: number) => `共 ${t} 条` }"
            row-key="id"
            size="small"
            :scroll="{ x: 640 }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'layer'">
                <Tag :color="LAYER_TAG_COLORS[record.layer] || 'default'">{{ record.layer }}</Tag>
              </template>
              <template v-else-if="column.key === 'createType'">
                <Tag>{{ record.createType === 'ddl' ? '界面建表' : '引用表' }}</Tag>
              </template>
              <template v-else-if="column.key === 'status'">
                <Tag :color="record.status === 'online' ? 'success' : 'default'">
                  {{ record.status === 'online' ? '启用' : '停用' }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'action'">
                <Button type="link" size="small" @click="goModels(record)">建模页查看</Button>
              </template>
            </template>
          </Table>
          <Descriptions v-if="selectedNode" :column="3" size="small" class="mt-2">
            <DescriptionsItem label="域编码">{{ selectedNode.code }}</DescriptionsItem>
            <DescriptionsItem label="负责人">{{ selectedNode.owner || '-' }}</DescriptionsItem>
            <DescriptionsItem label="备注">{{ selectedNode.remark || '-' }}</DescriptionsItem>
          </Descriptions>
        </Card>
      </Col>
    </Row>

    <BasicModal
      v-bind="$attrs"
      :width="640"
      centered
      canFullscreen
      :mask-closable="false"
      ok-text="保存"
      cancel-text="取消"
      @register="registerDomainModal"
      @ok="handleSubmit"
    >
      <template #title>
        <span class="modal-title">
          <Icon :icon="formState.id ? 'ion:create-outline' : 'ion:add-circle-outline'" :size="18" />
          {{ formTitle }}
        </span>
      </template>
      <div class="domain-modal-root">
        <Alert
          class="mb-4"
          type="info"
          show-icon
          :bordered="false"
          message="域编码创建后不可修改，并作为该域界面建表的物理表前缀；删除时若域下已有模型/指标将被拒绝"
        />
        <Form ref="formRef" :model="formState" :rules="formRules" layout="vertical">
          <Row :gutter="16">
            <Col :span="12">
              <FormItem label="域名称" name="name">
                <Input v-model:value="formState.name" placeholder="如 交易域" />
              </FormItem>
            </Col>
            <Col :span="12">
              <FormItem label="编码（建表前缀）" name="code">
                <Input
                  v-model:value="formState.code"
                  :disabled="!!formState.id"
                  placeholder="^[a-z][a-z0-9_]{1,30}$，如 trade"
                />
              </FormItem>
            </Col>
            <Col :span="12">
              <FormItem label="父域" name="parentId">
                <TreeSelect
                  v-model:value="formState.parentId"
                  :tree-data="parentOptions"
                  tree-default-expand-all
                  allow-clear
                  placeholder="留空 = 根域"
                  style="width: 100%"
                />
              </FormItem>
            </Col>
            <Col :span="6">
              <FormItem label="排序" name="sort" extra="小的排前">
                <InputNumber
                  v-model:value="formState.sort"
                  :min="0"
                  :max="9999"
                  style="width: 100%"
                />
              </FormItem>
            </Col>
            <Col :span="6">
              <FormItem label="负责人" name="owner">
                <Input v-model:value="formState.owner" placeholder="如 data-team" />
              </FormItem>
            </Col>
          </Row>
          <FormItem label="备注" name="remark">
            <Textarea v-model:value="formState.remark" :rows="2" placeholder="业务口径说明" />
          </FormItem>
        </Form>
      </div>
    </BasicModal>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive, ref } from 'vue'

  import {
    Alert,
    Button,
    Card,
    Col,
    Descriptions,
    Dropdown,
    Empty,
    Form,
    Input,
    InputNumber,
    Menu,
    Row,
    Space,
    Table,
    Tag,
    Tooltip,
    Tree,
    TreeSelect,
  } from 'ant-design-vue'

  import { useRouter } from 'vue-router'

  import {
    createMetricDomainApi,
    deleteMetricDomainApi,
    getMetricDomainTreeApi,
    getMetricModelsApi,
    updateMetricDomainApi,
    type MetricDomain,
    type MetricModel,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModal } from '/@/components/Modal'
  import { PageWrapper } from '/@/components/Page'
  import { PAGE_GUIDES } from '../guides'
  import GuideCard from '../components/GuideCard.vue'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { LAYER_TAG_COLORS } from '../data'

  const FormItem = Form.Item
  const Textarea = Input.TextArea
  const MenuItem = Menu.Item
  const DescriptionsItem = Descriptions.Item

  const router = useRouter()
  const { createMessage, createConfirm } = useMessage()

  const loading = ref(false)
  const flatDomains = ref<MetricDomain[]>([])
  const treeData = ref<MetricDomain[]>([])
  const selectedKeys = ref<string[]>([])
  const selectedNode = ref<MetricDomain | null>(null)

  const models = ref<MetricModel[]>([])
  const modelsLoading = ref(false)

  const modelColumns = [
    { title: '模型名称', dataIndex: 'name', key: 'name', width: 160 },
    { title: '物理表', dataIndex: 'tableName', key: 'tableName', width: 180 },
    { title: '分层', key: 'layer', width: 80 },
    { title: '创建方式', key: 'createType', width: 100 },
    { title: '状态', key: 'status', width: 80 },
    { title: '操作', key: 'action', width: 120 },
  ]

  const [
    registerDomainModal,
    {
      openModal: openDomainModal,
      closeModal: closeDomainModal,
      setModalProps: setDomainModalProps,
    },
  ] = useModal()

  const formTitle = computed(() => (formState.id ? '编辑指标域' : '新增指标域'))

  const formState = reactive({
    id: '',
    name: '',
    code: '',
    parentId: undefined as string | undefined,
    remark: '',
    owner: '',
    sort: 0,
  })

  const formRules = {
    name: [{ required: true, message: '请输入域名称' }],
    code: [
      { required: true, message: '请输入域编码' },
      { pattern: /^[a-z][a-z0-9_]{1,30}$/, message: '编码需匹配 ^[a-z][a-z0-9_]{1,30}$' },
    ],
  }

  const parentOptions = computed(() => {
    const toOption = (nodes: MetricDomain[]): any[] =>
      nodes.map((node) => ({
        value: node.id,
        title: node.name,
        disabled: node.id === formState.id,
        children: node.children?.length ? toOption(node.children) : undefined,
      }))
    return toOption(treeData.value)
  })

  function flatten(nodes: MetricDomain[], out: MetricDomain[] = []) {
    nodes.forEach((node) => {
      out.push(node)
      if (node.children?.length) flatten(node.children, out)
    })
    return out
  }

  async function loadTree(keepSelection = true) {
    loading.value = true
    try {
      const result = await getMetricDomainTreeApi()
      treeData.value = result?.items ?? []
      flatDomains.value = flatten(treeData.value)
      if (keepSelection && selectedNode.value) {
        selectedNode.value = flatDomains.value.find((d) => d.id === selectedNode.value?.id) || null
        if (!selectedNode.value) selectedKeys.value = []
      }
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '域树加载失败'))
    } finally {
      loading.value = false
    }
  }

  async function loadModels() {
    modelsLoading.value = true
    try {
      const result = await getMetricModelsApi({
        page: 1,
        size: 100,
        domainId: selectedNode.value?.id || undefined,
      })
      models.value = result?.items || []
    } catch (error) {
      models.value = []
      createMessage.error(getApiErrorMessage(error, '模型列表加载失败'))
    } finally {
      modelsLoading.value = false
    }
  }

  function handleSelect(keys: (string | number)[]) {
    const id = String(keys[0] || '')
    selectedKeys.value = id ? [id] : []
    selectedNode.value = flatDomains.value.find((d) => d.id === id) || null
    loadModels()
  }

  function handleContextMenu({ key }: { key: string | number }, node: MetricDomain) {
    if (key === 'create') openCreate(node)
    else if (key === 'edit') openEdit(node)
    else if (key === 'delete') handleDelete(node)
  }

  function openCreate(parent: MetricDomain | null) {
    formState.id = ''
    formState.name = ''
    formState.code = ''
    formState.parentId = parent?.id
    formState.remark = ''
    formState.owner = ''
    formState.sort = 0
    openDomainModal(true)
  }

  function openEdit(node: MetricDomain) {
    formState.id = node.id
    formState.name = node.name
    formState.code = node.code
    formState.parentId = node.parentId && node.parentId !== '0' ? node.parentId : undefined
    formState.remark = node.remark || ''
    formState.owner = node.owner || ''
    formState.sort = node.sort ?? 0
    openDomainModal(true)
  }

  async function handleSubmit() {
    setDomainModalProps({ confirmLoading: true })
    try {
      const payload = {
        name: formState.name.trim(),
        code: formState.code.trim(),
        parentId: formState.parentId || '0',
        remark: formState.remark,
        owner: formState.owner,
        sort: formState.sort,
      }
      if (formState.id) {
        // 编辑不改 code（后端也会拒绝变更）
        await updateMetricDomainApi(formState.id, {
          name: payload.name,
          remark: payload.remark,
          owner: payload.owner,
          parentId: payload.parentId,
          sort: payload.sort,
        })
        createMessage.success('域已更新')
      } else {
        await createMetricDomainApi(payload)
        createMessage.success('域已创建')
      }
      closeDomainModal()
      await loadTree()
      await loadModels()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      setDomainModalProps({ confirmLoading: false })
    }
  }

  function handleDelete(node: MetricDomain) {
    createConfirm({
      iconType: 'warning',
      title: `删除域【${node.name}】`,
      content: '软删除；域下有模型/指标时后端将拒绝（40902）。确认删除？',
      onOk: async () => {
        try {
          await deleteMetricDomainApi(node.id)
          createMessage.success('域已删除')
          if (selectedNode.value?.id === node.id) {
            selectedNode.value = null
            selectedKeys.value = []
          }
          await loadTree()
          await loadModels()
        } catch (error) {
          createMessage.error(getApiErrorMessage(error, '删除失败'))
        }
      },
    })
  }

  function goCreateModel() {
    router.push({ path: '/metric/models', query: { domainId: selectedNode.value?.id } })
  }

  function goModels(record: MetricModel) {
    router.push({ path: '/metric/models', query: { domainId: record.domainId } })
  }

  onMounted(async () => {
    await loadTree(false)
    await loadModels()
  })
</script>

<style lang="less" scoped>
  .domain-node {
    display: inline-flex;
    align-items: center;
    gap: 8px;

    .domain-code {
      color: #999;
      font-size: 12px;
    }

    .domain-counts {
      color: #666;
      font-size: 12px;
    }

    .node-add {
      display: none;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 4px;
      color: #1677ff;
      cursor: pointer;
    }
  }

  :deep(.ant-tree-node-content-wrapper:hover) .node-add {
    display: inline-flex;

    &:hover {
      background: rgba(22, 119, 255, 0.1);
    }
  }

  .tree-hint {
    margin-top: 8px;
    color: #999;
    font-size: 12px;
  }

  .all-hint {
    color: #999;
    font-size: 12px;
    font-weight: normal;
  }

  .modal-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
</style>
