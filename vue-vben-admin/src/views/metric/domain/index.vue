<template>
  <PageWrapper title="指标中心 · 指标域" content="按业务主题组织指标资产的树；域编码是界面建表前缀，删除时域下有模型/指标将被拒绝（40902）">
    <Row :gutter="16">
      <Col :span="10">
        <Card :bordered="false" :loading="loading">
          <template #title>域树</template>
          <template #extra>
            <Button type="primary" size="small" @click="openCreate(null)">新增根域</Button>
          </template>
          <Tree
            v-if="treeData.length"
            :tree-data="treeData"
            :field-names="{ title: 'name', key: 'id' }"
            default-expand-all
            :selected-keys="selectedKeys"
            @select="handleSelect"
          >
            <template #title="node">
              <span class="domain-node">
                <span>{{ node.name }}</span>
                <span class="domain-code">{{ node.code }}</span>
                <span class="domain-counts">
                  模型 {{ node.modelCount ?? 0 }} · 指标 {{ node.metricCount ?? 0 }}
                </span>
                <Space :size="0">
                  <Button type="link" size="small" @click.stop="openCreate(node)">子域</Button>
                  <Button type="link" size="small" @click.stop="openEdit(node)">编辑</Button>
                  <Popconfirm
                    title="确认删除该域？域下有模型/指标会被拒绝"
                    ok-text="删除"
                    cancel-text="取消"
                    @confirm="handleDelete(node)"
                  >
                    <Button type="link" size="small" danger @click.stop>删除</Button>
                  </Popconfirm>
                </Space>
              </span>
            </template>
          </Tree>
          <Empty v-else description="暂无指标域" />
        </Card>
      </Col>
      <Col :span="14">
        <Card :bordered="false" :title="selectedNode ? `域详情：${selectedNode.name}` : '域详情'">
          <Descriptions v-if="selectedNode" :column="1" size="small" bordered>
            <DescriptionsItem label="名称">{{ selectedNode.name }}</DescriptionsItem>
            <DescriptionsItem label="编码（建表前缀）">{{ selectedNode.code }}</DescriptionsItem>
            <DescriptionsItem label="父域">{{ parentName(selectedNode.parentId) }}</DescriptionsItem>
            <DescriptionsItem label="备注">{{ selectedNode.remark || '-' }}</DescriptionsItem>
            <DescriptionsItem label="负责人">{{ selectedNode.owner || '-' }}</DescriptionsItem>
            <DescriptionsItem label="建表前缀">{{ selectedNode.tablePrefix || '（默认取域编码）' }}</DescriptionsItem>
            <DescriptionsItem label="排序">{{ selectedNode.sort ?? 0 }}</DescriptionsItem>
            <DescriptionsItem label="模型数">{{ selectedNode.modelCount ?? 0 }}</DescriptionsItem>
            <DescriptionsItem label="指标数">{{ selectedNode.metricCount ?? 0 }}</DescriptionsItem>
          </Descriptions>
          <Empty v-else description="点击左侧域节点查看详情" />
        </Card>
      </Col>
    </Row>

    <Modal
      v-model:open="formVisible"
      :title="formTitle"
      :confirm-loading="submitting"
      :mask-closable="false"
      @ok="handleSubmit"
    >
      <Form ref="formRef" :model="formState" :rules="formRules" layout="vertical" class="mt-3">
        <FormItem label="域名称" name="name">
          <Input v-model:value="formState.name" placeholder="如 交易域" />
        </FormItem>
        <FormItem label="编码（创建后不可改）" name="code">
          <Input
            v-model:value="formState.code"
            :disabled="!!formState.id"
            placeholder="^[a-z][a-z0-9_]{1,30}$，如 trade"
          />
        </FormItem>
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
        <FormItem label="负责人" name="owner">
          <Input v-model:value="formState.owner" placeholder="如 data-team" />
        </FormItem>
        <FormItem label="备注" name="remark">
          <Textarea v-model:value="formState.remark" :rows="2" placeholder="业务口径说明" />
        </FormItem>
        <FormItem label="排序（小的在前）" name="sort">
          <InputNumber v-model:value="formState.sort" :min="0" :max="9999" style="width: 100%" />
        </FormItem>
      </Form>
    </Modal>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive, ref } from 'vue'

  import {
    Button,
    Card,
    Col,
    Descriptions,
    Empty,
    Form,
    Input,
    InputNumber,
    Modal,
    Popconfirm,
    Row,
    Space,
    Tree,
    TreeSelect,
  } from 'ant-design-vue'

  import {
    createMetricDomainApi,
    deleteMetricDomainApi,
    getMetricDomainTreeApi,
    updateMetricDomainApi,
    type MetricDomain,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'

  const FormItem = Form.Item
  const Textarea = Input.TextArea
  const DescriptionsItem = Descriptions.Item

  const { createMessage } = useMessage()

  const loading = ref(false)
  const flatDomains = ref<MetricDomain[]>([])
  const treeData = ref<MetricDomain[]>([])
  const selectedKeys = ref<string[]>([])
  const selectedNode = ref<MetricDomain | null>(null)

  const formVisible = ref(false)
  const submitting = ref(false)
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

  function parentName(parentId?: string) {
    if (!parentId || parentId === '0') return '根域'
    return flatDomains.value.find((d) => d.id === parentId)?.name || parentId
  }

  async function loadTree() {
    loading.value = true
    try {
      const result = await getMetricDomainTreeApi()
      treeData.value = result?.items ?? []
      flatDomains.value = flatten(treeData.value)
      if (selectedNode.value) {
        selectedNode.value = flatDomains.value.find((d) => d.id === selectedNode.value?.id) || null
      }
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '域树加载失败'))
    } finally {
      loading.value = false
    }
  }

  function handleSelect(keys: (string | number)[]) {
    const id = String(keys[0] || '')
    selectedKeys.value = id ? [id] : []
    selectedNode.value = flatDomains.value.find((d) => d.id === id) || null
  }

  function openCreate(parent: MetricDomain | null) {
    formState.id = ''
    formState.name = ''
    formState.code = ''
    formState.parentId = parent?.id
    formState.remark = ''
    formState.owner = ''
    formState.sort = 0
    formVisible.value = true
  }

  function openEdit(node: MetricDomain) {
    formState.id = node.id
    formState.name = node.name
    formState.code = node.code
    formState.parentId = node.parentId && node.parentId !== '0' ? node.parentId : undefined
    formState.remark = node.remark || ''
    formState.owner = node.owner || ''
    formState.sort = node.sort ?? 0
    formVisible.value = true
  }

  async function handleSubmit() {
    submitting.value = true
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
      formVisible.value = false
      await loadTree()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      submitting.value = false
    }
  }

  async function handleDelete(node: MetricDomain) {
    try {
      await deleteMetricDomainApi(node.id)
      createMessage.success(`已删除域【${node.name}】`)
      if (selectedNode.value?.id === node.id) selectedNode.value = null
      await loadTree()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  onMounted(loadTree)
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
  }
</style>
