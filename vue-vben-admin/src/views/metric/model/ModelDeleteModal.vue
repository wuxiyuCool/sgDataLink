<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    title="删除模型"
    :width="620"
    :min-height="180"
    :mask-closable="false"
    :confirm-loading="submitting"
    :ok-button-props="{ disabled: !canConfirm, danger: dropTable }"
    ok-text="确认删除"
    @ok="handleDelete"
  >
    <div v-if="model" class="del-root">
      <p class="mb-2">
        将从平台删除模型登记 <b>{{ model.name }}</b
        >（表 <code>{{ model.tableName }}</code
        >）。 被指标或汇总任务引用时后端会拒绝删除，并提示引用数量。
      </p>

      <Alert
        v-if="isReference"
        type="warning"
        show-icon
        class="mb-3"
        message="引用表由源系统维护：平台只删登记，绝不会 DROP 这张表。"
      />
      <Alert
        v-else-if="!canDrop"
        type="info"
        show-icon
        class="mb-3"
        :message="`当前表状态为「${tableStatusLabel}」，目标库里没有平台建过的这张表，删除登记不涉及物理表。`"
      />

      <template v-if="canDrop">
        <Checkbox v-model:checked="dropTable" class="mb-2">
          同时删除物理表（DROP TABLE <code>{{ model.tableName }}</code
          >）
        </Checkbox>
        <Alert
          v-if="dropTable"
          type="error"
          show-icon
          class="mb-2"
          message="不可恢复：表里的数据会一并删除。请下方手输表名确认。"
        />
        <div v-if="dropTable">
          <div class="tip mb-1"
            >请输入要删除的表名：<code>{{ model.tableName }}</code></div
          >
          <Input v-model:value="typedName" placeholder="逐字输入表名以解锁删除" />
        </div>
      </template>

      <Alert v-if="dropMsg" type="error" show-icon class="mt-3" :message="dropMsg" />
    </div>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, ref } from 'vue'

  import { Alert, Checkbox, Input } from 'ant-design-vue'

  import {
    deleteMetricModelApi,
    getMetricModelApi,
    type MetricModel,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { TABLE_STATUS_LABELS } from '../data'

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const model = ref<MetricModel | null>(null)
  const dropTable = ref(false)
  const typedName = ref('')
  const submitting = ref(false)
  const dropMsg = ref('')

  const isReference = computed(() => model.value?.createType !== 'ddl')
  // 硬闸门在前端只是体验，后端同样会拒：只有平台真建出来的表才允许连带 DROP
  const canDrop = computed(() => !isReference.value && model.value?.tableStatus === 'created')
  const tableStatusLabel = computed(
    () => TABLE_STATUS_LABELS[model.value?.tableStatus || 'none'] || '未建表',
  )
  const canConfirm = computed(
    () => !!model.value && (!dropTable.value || typedName.value.trim() === model.value.tableName),
  )

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    model.value = null
    dropTable.value = false
    typedName.value = ''
    dropMsg.value = ''
    const id = data?.modelId || ''
    if (!id) return
    try {
      model.value = await getMetricModelApi(id)
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '模型加载失败'))
    }
  })

  async function handleDelete() {
    if (!model.value || !canConfirm.value) return
    submitting.value = true
    try {
      const result = await deleteMetricModelApi(model.value.id, { dropTable: dropTable.value })
      emit('success')
      if (result.dropped) {
        createMessage.success(`已删除模型并 DROP 物理表 ${model.value.tableName}`)
        closeModal()
      } else if (result.dropMsg) {
        // 模型登记已没了、表还在：必须留在弹窗里说明，否则变成无人知晓的孤儿表
        dropMsg.value = `模型登记已删除，但物理表 ${model.value.tableName} 没有删掉：${result.dropMsg}。请到目标库确认后手工清理，再关闭本窗口。`
        setModalProps({ showOkBtn: false, cancelText: '知道了' })
      } else {
        createMessage.success(`已删除模型【${model.value.name}】（未动物理表）`)
        closeModal()
      }
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    } finally {
      submitting.value = false
    }
  }
</script>

<style lang="less" scoped>
  .del-root {
    code {
      background: #f6f8fa;
      padding: 1px 6px;
      border-radius: 4px;
    }

    .tip {
      color: #8c8c8c;
      font-size: 12px;
    }
  }
</style>
