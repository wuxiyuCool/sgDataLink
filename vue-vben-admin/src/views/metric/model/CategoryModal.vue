<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? `编辑分类：${record?.name || ''}` : '新建分类'"
    :width="620"
    :min-height="220"
    :mask-closable="false"
    :confirm-loading="submitting"
    ok-text="保存"
    @ok="handleSubmit"
  >
    <div class="cat-modal">
      <Alert
        class="mb-3"
        type="info"
        show-icon
        :bordered="false"
        message="分类只是建模页「分层 → 分类」树上的归组节点：保存与删除都只改元数据，不会删建模，更不会碰数据库里的表。"
      />
      <Form ref="formRef" :model="formState" :rules="formRules" layout="vertical">
        <BasicTitle class="sec" span>分类挂在哪个分层下</BasicTitle>
        <Row :gutter="16">
          <Col :span="12">
            <FormItem label="所属分类层" name="layer">
              <Tooltip :title="layerTip">
                <div>
                  <Select
                    v-model:value="formState.layer"
                    :options="LAYER_OPTIONS"
                    :disabled="isUpdate"
                    placeholder="选择分层"
                    style="width: 100%"
                  />
                </div>
              </Tooltip>
            </FormItem>
          </Col>
          <Col :span="12">
            <FormItem label="排序" name="sort" extra="数字小的排前面（只在同一分层内比较）">
              <InputNumber
                v-model:value="formState.sort"
                :min="0"
                :max="9999"
                style="width: 100%"
              />
            </FormItem>
          </Col>
          <Col :span="24">
            <FormItem label="分类名称" name="name">
              <Input
                v-model:value="formState.name"
                :maxlength="64"
                placeholder="如 交易明细 / 维度登记 / 应用出数"
              />
            </FormItem>
          </Col>
        </Row>

        <BasicTitle class="sec" span :help-message="DESC_HELP">这个分类装什么</BasicTitle>
        <FormItem label="分类描述" name="description">
          <Textarea
            v-model:value="formState.description"
            :rows="3"
            :maxlength="512"
            show-count
            placeholder="一句话说清这里归哪些建模，例如：一行一笔订单/一次访问的明细事实，指标都从这里取数。这句话会显示在树节点的副标题上。"
          />
        </FormItem>
        <div class="field-tip">
          当前归属：<b>{{ layerLabel }}</b> 分层
          <template v-if="isUpdate">
            · 层级不可改；要把建模挪到别的层，请在目标层新建分类后用列表的「批量归类」搬过去
          </template>
          <template v-else>· 同名分类在同一分层内不能重复，不同分层可以同名</template>
        </div>
      </Form>
    </div>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, reactive, ref } from 'vue'

  import { Alert, Col, Form, Input, InputNumber, Row, Select, Tooltip } from 'ant-design-vue'

  import {
    createMetricModelCategoryApi,
    updateMetricModelCategoryApi,
    type MetricModelCategory,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicTitle } from '/@/components/Basic'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { LAYER_OPTIONS } from '../data'

  const FormItem = Form.Item
  const Textarea = Input.TextArea

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const isUpdate = ref(false)
  const submitting = ref(false)
  const record = ref<MetricModelCategory | null>(null)

  /** 层级是分类在树上的挂载位置，后端对「PUT 带 layer」一律拒绝，界面因此直接禁用 */
  const layerTip = '层级创建后不可改，要换层请新建分类再批量归类（分类的层就是它挂在哪个分层根下）'
  const DESC_HELP =
    '描述会显示成分层树下这个分类节点的副标题，鼠标悬停还能看全文——写清「这一类建模的共同口径」，别人点树时才猜得中。'

  const formState = reactive({
    name: '',
    layer: 'DWD' as string,
    description: '',
    sort: 0,
  })

  const formRules = {
    name: [{ required: true, message: '请输入分类名称' }],
    layer: [{ required: true, message: '请选择所属分类层' }],
  }

  const layerLabel = computed(
    () => LAYER_OPTIONS.find((item) => item.value === formState.layer)?.label || formState.layer,
  )

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    submitting.value = false
    isUpdate.value = !!data?.record?.id
    record.value = data?.record || null
    formState.name = record.value?.name || ''
    formState.layer = record.value?.layer || data?.layer || 'DWD'
    formState.description = record.value?.description || ''
    formState.sort = Number(record.value?.sort) || 0
  })

  async function handleSubmit() {
    const name = formState.name.trim()
    if (!name) {
      createMessage.warning('请填写分类名称')
      return
    }
    submitting.value = true
    try {
      const description = formState.description.trim()
      const sort = Number(formState.sort) || 0
      let saved: MetricModelCategory | undefined
      if (isUpdate.value && record.value) {
        // 编辑不下发 layer（后端带 layer 键即 40001）
        saved = await updateMetricModelCategoryApi(record.value.id, { name, description, sort })
        createMessage.success(`分类【${name}】已更新`)
      } else {
        saved = await createMetricModelCategoryApi({
          name,
          layer: formState.layer,
          description,
          sort,
        })
        createMessage.success(`分类【${name}】已创建，可以直接把同层建模归进来`)
      }
      closeModal()
      emit('success', { id: saved?.id, layer: saved?.layer || formState.layer })
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      submitting.value = false
    }
  }
</script>

<style lang="less" scoped>
  .cat-modal {
    .sec {
      margin-bottom: 8px;
      font-size: 13px;
      color: @text-color-secondary;
    }

    :deep(.ant-form-item) {
      margin-bottom: 12px;
    }
  }

  .field-tip {
    font-size: 12px;
    line-height: 18px;
    color: @text-color-secondary;

    b {
      color: @primary-color;
    }
  }
</style>
