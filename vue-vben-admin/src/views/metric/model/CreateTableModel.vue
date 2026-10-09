<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    title="生成表 · 在目标库创建物理表"
    :width="760"
    :min-height="240"
    :mask-closable="false"
    :confirm-loading="submitting"
    ok-text="执行建表"
    @ok="handleCreate"
  >
    <div class="ct-root">
      <Alert
        class="mb-3"
        type="warning"
        show-icon
        message="这是真实执行：平台把下面的 DDL 发到目标库建表。表名已存在时不会重复建（幂等，只把状态同步为已建表）。"
      />

      <Descriptions :column="1" size="small" class="mb-3" bordered>
        <DescriptionsItem label="模型">{{ model?.name }}</DescriptionsItem>
        <DescriptionsItem label="目标表">
          <code>{{ model?.tableName }}</code>
          <Tag class="ml-2" :color="TABLE_STATUS_TAG_COLORS[model?.tableStatus || 'none']">
            {{ TABLE_STATUS_LABELS[model?.tableStatus || 'none'] }}
          </Tag>
        </DescriptionsItem>
        <DescriptionsItem label="方言 / 字段">
          {{ dialectLabel }} · {{ fieldCount }} 个字段
        </DescriptionsItem>
      </Descriptions>

      <div v-if="ddl" class="sql-block mb-3">
        <span class="sql-label">建表语句（方言层生成，界面不再手工拼）</span>
        <pre>{{ ddl }}</pre>
      </div>

      <Alert
        v-if="resultError"
        type="error"
        show-icon
        message="建表失败"
        :description="resultError"
        class="mb-3"
      />
      <Alert
        v-if="!model?.columns?.length"
        type="error"
        show-icon
        message="该模型还没有字段，无法建表。请先在「字段」里维护字段。"
      />
    </div>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, ref } from 'vue'

  import { Alert, Descriptions, DescriptionsItem, Tag } from 'ant-design-vue'

  import {
    createMetricModelTableApi,
    getMetricModelApi,
    previewModelDdlApi,
    type MetricModel,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { TABLE_STATUS_LABELS, TABLE_STATUS_TAG_COLORS } from '../data'

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const model = ref<MetricModel | null>(null)
  const ddl = ref('')
  const dialectType = ref('')
  const resultError = ref('')
  const submitting = ref(false)

  const fieldCount = computed(() => model.value?.columns?.length || 0)
  const dialectLabel = computed(() =>
    dialectType.value === 'oracle' ? 'Oracle' : dialectType.value === 'mysql' ? 'MySQL' : '-',
  )

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    model.value = null
    ddl.value = ''
    dialectType.value = ''
    resultError.value = ''
    const id = data?.modelId || ''
    if (!id) return
    try {
      const detail = await getMetricModelApi(id)
      model.value = detail
      ddl.value = detail.tableDdl || ''
      // preview-ddl 走的是同一个方言层 buildDdl，顺带拿到权威方言名；老数据没有留痕 DDL 时它也是兜底
      if (detail.columns?.length) {
        try {
          const preview = await previewModelDdlApi({
            domainId: detail.domainId,
            layer: detail.layer,
            name: detail.name,
            tableName: detail.tableName,
            columns: detail.columns,
            datasourceId: detail.datasourceId,
          })
          dialectType.value = preview?.dialect || ''
          if (preview?.ddl) ddl.value = preview.ddl
        } catch {
          dialectType.value = ''
        }
      }
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '模型加载失败'))
    }
  })

  async function handleCreate() {
    if (!model.value) return
    submitting.value = true
    resultError.value = ''
    try {
      const result = await createMetricModelTableApi(model.value.id)
      if (result.tableStatus === 'created') {
        createMessage.success(
          result.executed
            ? `已创建物理表 ${model.value.tableName}`
            : '表已存在于目标库，状态已同步为已建表',
        )
        closeModal()
      } else {
        resultError.value = result.tableMsg || '后端未返回失败原因，请查看引擎日志'
      }
      emit('success')
    } catch (error) {
      resultError.value = getApiErrorMessage(error, '建表请求失败')
      emit('success')
    } finally {
      submitting.value = false
    }
  }
</script>

<style lang="less" scoped>
  .sql-block {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    background: #f6f8fa;
    border: 1px solid #eaecef;
    border-left: 3px solid #1677ff;
    padding: 10px 14px;
    border-radius: 6px;
    max-height: 260px;
    overflow: auto;

    .sql-label {
      display: block;
      color: #8c8c8c;
      font-size: 11px;
      margin-bottom: 4px;
      letter-spacing: 1px;
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-all;
    }
  }
</style>
