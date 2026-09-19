<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? '编辑数据管道' : '新建数据管道'"
    :width="720"
    :min-height="320"
    :mask-closable="false"
    :confirm-loading="submitting"
    @ok="handleSubmit"
  >
    <Form
      ref="formRef"
      :model="formState"
      :rules="getRules"
      :label-col="{ span: 6 }"
      :wrapper-col="{ span: 16 }"
    >
      <FormItem label="管道名称" name="name">
        <Input v-model:value="formState.name" placeholder="例如：订单库实时镜像" />
      </FormItem>
      <FormItem label="源数据源" name="sourceId">
        <Select
          v-model:value="formState.sourceId"
          :options="datasourceOptions"
          :loading="datasourceLoading"
          show-search
          option-filter-prop="label"
          placeholder="请选择 CDC 捕获端数据源"
        />
      </FormItem>
      <FormItem label="目标数据源" name="targetId">
        <Select
          v-model:value="formState.targetId"
          :options="datasourceOptions"
          :loading="datasourceLoading"
          show-search
          option-filter-prop="label"
          placeholder="请选择镜像写入端数据源"
        />
      </FormItem>
      <FormItem
        label="同步对象"
        name="syncObjects"
        :extra="
          textMode
            ? '批量粘贴：每行一个表名（库.表），也支持逗号 / 分号分隔'
            : '标签输入：回车或逗号分隔成标签，可直接粘贴多行表名自动拆分'
        "
      >
        <div class="mb-1">
          <RadioGroup
            :value="textMode"
            size="small"
            :options="[
              { label: '标签输入', value: false },
              { label: '多行粘贴', value: true },
            ]"
            @change="handleModeChange"
          />
        </div>
        <Select
          v-if="!textMode"
          v-model:value="formState.syncObjects"
          mode="tags"
          :options="syncObjectOptions"
          :token-separators="TOKEN_SEPARATORS"
          placeholder="例如：APP_USER.T_ORDER"
        />
        <TextArea
          v-else
          v-model:value="syncObjectsText"
          :rows="5"
          placeholder="APP_USER.T_ORDER&#10;APP_USER.T_ORDER_ITEM"
          @change="handleTextChange"
        />
      </FormItem>
      <FormItem label="已识别表数">
        <span class="text-gray-500">{{ currentSyncObjects.length }} 张表</span>
      </FormItem>
      <FormItem
        label="DDL 变更策略"
        name="ddlPolicy"
        extra="ignore 忽略结构变更，report 仅回报异常；Mock 阶段只存储回显"
      >
        <Select v-model:value="formState.ddlPolicy" :options="DDL_POLICY_OPTIONS" />
      </FormItem>
      <Alert
        type="info"
        show-icon
        message="管道只做搬运（对标 FDL 数据管道），运行状态、QPS、延迟与位点由引擎 cdc 模式回报，列表页 3 秒轮询刷新。"
      />
    </Form>
  </BasicModal>
</template>
<script lang="ts" setup>
  import { computed, reactive, ref, unref } from 'vue'
  import { Alert, Form, Input, Radio, Select } from 'ant-design-vue'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllDatasourcesApi } from '/@/api/databridge/datasource'
  import { createPipelineApi, updatePipelineApi } from '/@/api/databridge/pipeline'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { Datasource } from '/@/api/databridge/model/datasourceModel'
  import type {
    Pipeline,
    PipelineDdlPolicy,
    PipelinePayload,
  } from '/@/api/databridge/model/pipelineModel'
  import { DEFAULT_DDL_POLICY, DDL_POLICY_OPTIONS, pickPipelinePayload } from '../data'
  import { parseSyncObjects, stringifySyncObjects, SYNC_OBJECT_SAMPLES } from './pipeline.data'

  const FormItem = Form.Item
  const TextArea = Input.TextArea
  const RadioGroup = Radio.Group

  /** 粘贴多行 / 逗号 / 分号都能切成独立标签 */
  const TOKEN_SEPARATORS = ['\n', ',', '，', ';', '；', ' ']

  const emit = defineEmits(['register', 'success'])
  const { createMessage } = useMessage()

  const formRef = ref()
  const isUpdate = ref(false)
  const submitting = ref(false)
  const datasourceLoading = ref(false)
  const datasourceOptions = ref<{ label: string; value: string }[]>([])
  const syncObjectOptions = SYNC_OBJECT_SAMPLES.map((item) => ({ label: item, value: item }))

  const defaultForm = () => ({
    id: undefined as string | undefined,
    name: '',
    sourceId: undefined as string | undefined,
    targetId: undefined as string | undefined,
    syncObjects: [] as string[],
    ddlPolicy: DEFAULT_DDL_POLICY as PipelineDdlPolicy,
  })

  const formState = reactive<ReturnType<typeof defaultForm>>(defaultForm())

  /** 同步对象输入方式：false 标签输入，true 多行粘贴 */
  const textMode = ref(false)
  const syncObjectsText = ref('')

  /** 当前生效的同步对象（两种输入方式统一收敛到数组，表单校验也走这一份） */
  const currentSyncObjects = computed<string[]>(() =>
    unref(textMode) ? parseSyncObjects(unref(syncObjectsText)) : formState.syncObjects ?? [],
  )

  function handleModeChange(e: any) {
    const next = !!e?.target?.value
    if (next === unref(textMode)) return
    if (next) {
      // 切到多行粘贴：用当前标签回填文本域
      syncObjectsText.value = stringifySyncObjects(formState.syncObjects)
    } else {
      // 切回标签：解析文本并写回数组，保证校验与提交口径一致
      formState.syncObjects = parseSyncObjects(unref(syncObjectsText))
    }
    textMode.value = next
  }

  function handleTextChange() {
    formState.syncObjects = parseSyncObjects(unref(syncObjectsText))
  }

  const getRules = computed<Record<string, any>>(() => ({
    name: [{ required: true, message: '请输入管道名称', trigger: 'blur' }],
    sourceId: [{ required: true, message: '请选择源数据源', trigger: 'change' }],
    targetId: [
      { required: true, message: '请选择目标数据源', trigger: 'change' },
      {
        validator: (_rule: any, _value: any) => {
          if (formState.sourceId && formState.targetId && formState.sourceId === formState.targetId) {
            return Promise.reject(new Error('源数据源与目标数据源不能相同'))
          }
          return Promise.resolve()
        },
        trigger: 'change',
      },
    ],
    syncObjects: [
      {
        required: true,
        type: 'array',
        message: '请至少填写一个同步对象（表名）',
        trigger: 'change',
      },
    ],
    ddlPolicy: [{ required: true, message: '请选择 DDL 变更策略', trigger: 'change' }],
  }))

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    isUpdate.value = !!data?.isUpdate
    submitting.value = false
    textMode.value = false
    syncObjectsText.value = ''
    Object.assign(formState, defaultForm())
    setModalProps({ confirmLoading: false })
    formRef.value?.clearValidate?.()

    if (data?.record) {
      const record: Pipeline = data.record
      Object.assign(formState, {
        id: record.id,
        name: record.name,
        sourceId: record.sourceId,
        targetId: record.targetId,
        syncObjects: [...(record.syncObjects ?? [])],
        ddlPolicy: record.ddlPolicy || DEFAULT_DDL_POLICY,
      })
    }
    loadDatasources()
  })

  async function loadDatasources() {
    datasourceLoading.value = true
    try {
      const list: Datasource[] = await getAllDatasourcesApi()
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

  /** 只提交契约 1.7 的请求字段，status / runningInstanceId 等响应侧字段不回传 */
  function buildPayload(): PipelinePayload {
    return pickPipelinePayload({
      name: formState.name,
      sourceId: String(formState.sourceId ?? ''),
      targetId: String(formState.targetId ?? ''),
      syncObjects: currentSyncObjects.value,
      ddlPolicy: formState.ddlPolicy,
    })
  }

  async function handleSubmit() {
    if (formRef.value) {
      try {
        await formRef.value.validate()
      } catch {
        return
      }
    }
    submitting.value = true
    setModalProps({ confirmLoading: true })
    try {
      const payload = buildPayload()
      const id = formState.id
      if (unref(isUpdate) && id) {
        await updatePipelineApi(id, payload)
        createMessage.success('数据管道已更新')
      } else {
        await createPipelineApi(payload)
        createMessage.success('数据管道已创建（默认停止状态，需手动启动）')
      }
      closeModal()
      emit('success')
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      submitting.value = false
      setModalProps({ confirmLoading: false })
    }
  }
</script>
