<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? '编辑同步任务' : '新建同步任务'"
    :width="860"
    :min-height="420"
    :mask-closable="false"
    :confirm-loading="submitting"
    :ok-text="step === STEP_MAPPING ? (isUpdate ? '保存' : '创建任务') : '下一步'"
    @ok="handleOk"
  >
    <Steps :current="step" size="small" class="mb-5">
      <Step v-for="item in STEP_TITLES" :key="item" :title="item" />
    </Steps>

    <Form
      ref="formRef"
      :model="formState"
      :rules="getRules"
      :label-col="{ span: 6 }"
      :wrapper-col="{ span: 16 }"
    >
      <!-- 步骤一：基本信息（用 v-show 保证字段始终注册在 Form 中，便于分步校验） -->
      <div v-show="step === STEP_BASIC">
        <FormItem label="任务名称" name="name">
          <Input v-model:value="formState.name" placeholder="例如：订单表全量同步" />
        </FormItem>
        <FormItem label="同步模式" name="syncMode">
          <RadioGroup v-model:value="formState.syncMode">
            <Radio value="full">全量（full）</Radio>
            <Radio value="incremental">增量（incremental）</Radio>
          </RadioGroup>
        </FormItem>
        <FormItem
          v-if="formState.syncMode === 'incremental'"
          label="增量列"
          name="incrementalColumn"
        >
          <Input v-model:value="formState.incrementalColumn" placeholder="例如：UPDATE_TIME（增量模式必填）" />
        </FormItem>
        <FormItem label="写入策略" name="writeMode">
          <Select v-model:value="formState.writeMode" :options="WRITE_MODE_OPTIONS" />
        </FormItem>
        <FormItem label="批次大小" name="batchSize">
          <InputNumber v-model:value="formState.batchSize" :min="1" :max="100000" style="width: 100%" />
        </FormItem>
        <FormItem label="是否启用" name="enabled">
          <Switch v-model:checked="formState.enabled" />
        </FormItem>

        <!-- 调度配置：对标 FineDataLink 定时调度 + 失败重试（Mock 阶段仅存储与展示） -->
        <Divider orientation="left" plain class="!mt-0 !mb-3">调度配置</Divider>
        <FormItem
          label="调度表达式"
          name="scheduleCron"
          extra="Quartz 风格 6 位 cron，留空表示仅手动触发；Mock 阶段仅保存该表达式，不会触发实际调度"
        >
          <Input
            v-model:value="formState.scheduleCron"
            allow-clear
            placeholder="例如：0 0 2 * * ?（每天 02:00）"
          >
            <template #prefix>
              <Icon icon="ant-design:clock-circle-outlined" />
            </template>
          </Input>
        </FormItem>
        <FormItem label="失败重试次数" name="retryCount" extra="取值 0~10，0 表示失败后不重试">
          <InputNumber
            v-model:value="formState.retryCount"
            :min="0"
            :max="MAX_RETRY_COUNT"
            :precision="0"
            addon-after="次"
            style="width: 100%"
          />
        </FormItem>
        <FormItem label="重试间隔" name="retryIntervalSec" extra="单位秒，两次重试之间的等待时长">
          <InputNumber
            v-model:value="formState.retryIntervalSec"
            :min="0"
            :max="MAX_RETRY_INTERVAL_SEC"
            :precision="0"
            addon-after="秒"
            style="width: 100%"
          />
        </FormItem>
        <FormItem label="调度方式">
          <span class="text-gray-500">{{ scheduleSummary }}</span>
        </FormItem>
      </div>

      <!-- 步骤二：源/目标数据源 -->
      <div v-show="step === STEP_DATASOURCE">
        <FormItem label="源数据源" name="sourceId">
          <Select
            v-model:value="formState.sourceId"
            :options="datasourceOptions"
            :loading="datasourceLoading"
            show-search
            option-filter-prop="label"
            placeholder="请选择源数据源（来自 /datasources）"
            @change="formState.sourceTable = ''"
          />
        </FormItem>
        <FormItem label="源表" name="sourceTable" extra="选定数据源后可输入关键字远程搜索表名">
          <TableSelect v-model:value="formState.sourceTable" :datasource-id="formState.sourceId" />
        </FormItem>
        <FormItem label="目标数据源" name="targetId">
          <Select
            v-model:value="formState.targetId"
            :options="datasourceOptions"
            :loading="datasourceLoading"
            show-search
            option-filter-prop="label"
            placeholder="请选择目标数据源（来自 /datasources）"
            @change="formState.targetTable = ''"
          />
        </FormItem>
        <FormItem label="目标表" name="targetTable" extra="选定数据源后可输入关键字远程搜索表名">
          <TableSelect v-model:value="formState.targetTable" :datasource-id="formState.targetId" />
        </FormItem>
      </div>
    </Form>

    <!-- 步骤三：字段映射 -->
    <div v-show="step === STEP_MAPPING">
      <div class="mb-2 text-gray-500">
        字段映射：{{ formState.sourceTable || '源表' }} → {{ formState.targetTable || '目标表'
        }}（保存时随任务整体提交）
      </div>
      <FieldMappingEditor
        :key="editorKey"
        :mappings="formState.fieldMappings"
        @change="handleMappingChange"
      />
    </div>

    <template #insertFooter>
      <Button v-if="step > STEP_BASIC" class="float-left" @click="handlePrev">上一步</Button>
    </template>
  </BasicModal>
</template>
<script lang="ts" setup>
  import { computed, reactive, ref, unref } from 'vue'
  import {
    Button,
    Divider,
    Form,
    Input,
    InputNumber,
    Radio,
    Select,
    Steps,
    Switch,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllDatasourcesApi } from '/@/api/databridge/datasource'
  import { createTaskApi, updateTaskApi } from '/@/api/databridge/task'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { Datasource } from '/@/api/databridge/model/datasourceModel'
  import type { FieldMapping, Task, TaskPayload } from '/@/api/databridge/model/taskModel'
  import FieldMappingEditor from '../components/FieldMappingEditor.vue'
  import TableSelect from '../components/TableSelect.vue'
  import {
    DEFAULT_RETRY_COUNT,
    DEFAULT_RETRY_INTERVAL_SEC,
    MAX_RETRY_COUNT,
    MAX_RETRY_INTERVAL_SEC,
    STEP_BASIC,
    STEP_DATASOURCE,
    STEP_FIELDS,
    STEP_MAPPING,
    STEP_TITLES,
  } from './task.data'
  import { pickTaskPayload, validateFieldTransforms, WRITE_MODE_OPTIONS } from '../data'

  const FormItem = Form.Item
  const RadioGroup = Radio.Group
  const Step = Steps.Step

  const emit = defineEmits(['register', 'success'])
  const { createMessage } = useMessage()

  const formRef = ref()
  const step = ref(STEP_BASIC)
  const isUpdate = ref(false)
  const submitting = ref(false)
  const editorKey = ref(0)
  const datasourceOptions = ref<{ label: string; value: string }[]>([])
  const datasourceLoading = ref(false)

  const defaultForm = (): any => ({
    id: undefined,
    name: '',
    syncMode: 'full',
    incrementalColumn: '',
    writeMode: 'upsert',
    batchSize: 1000,
    enabled: true,
    scheduleCron: '',
    retryCount: DEFAULT_RETRY_COUNT,
    retryIntervalSec: DEFAULT_RETRY_INTERVAL_SEC,
    sourceId: undefined,
    sourceTable: '',
    targetId: undefined,
    targetTable: '',
    fieldMappings: [] as FieldMapping[],
  })

  const formState = reactive<any>(defaultForm())

  /** 调度配置摘要，只读展示，避免用户误以为 Mock 阶段会真正定时执行 */
  const scheduleSummary = computed(() => {
    const cron = (formState.scheduleCron || '').trim()
    const retry = `失败重试 ${Number(formState.retryCount ?? 0)} 次 / 间隔 ${Number(
      formState.retryIntervalSec ?? 0,
    )} 秒`
    return cron ? `定时：${cron}（${retry}）` : `手动触发（${retry}）`
  })

  const getRules = computed<Record<string, any>>(() => ({
    name: [{ required: true, message: '请输入任务名称', trigger: 'blur' }],
    syncMode: [{ required: true, message: '请选择同步模式', trigger: 'change' }],
    incrementalColumn:
      formState.syncMode === 'incremental'
        ? [{ required: true, message: '增量模式必须填写增量列', trigger: 'blur' }]
        : [],
    writeMode: [{ required: true, message: '请选择写入策略', trigger: 'change' }],
    batchSize: [{ required: true, type: 'number', message: '请输入批次大小', trigger: 'change' }],
    sourceId: [{ required: true, message: '请选择源数据源', trigger: 'change' }],
    sourceTable: [{ required: true, message: '请选择源表', trigger: 'change' }],
    targetId: [{ required: true, message: '请选择目标数据源', trigger: 'change' }],
    targetTable: [{ required: true, message: '请选择目标表', trigger: 'change' }],
  }))

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    step.value = STEP_BASIC
    isUpdate.value = !!data?.isUpdate
    submitting.value = false
    setModalProps({ confirmLoading: false })
    Object.assign(formState, defaultForm())
    formRef.value?.clearValidate?.()

    if (data?.record) {
      const record: Task = data.record
      Object.assign(formState, {
        id: record.id,
        name: record.name,
        syncMode: record.syncMode,
        incrementalColumn: record.incrementalColumn || '',
        writeMode: record.writeMode || 'insert',
        batchSize: record.batchSize ?? 1000,
        enabled: record.enabled !== false,
        scheduleCron: record.scheduleCron ?? '',
        retryCount: record.retryCount ?? DEFAULT_RETRY_COUNT,
        retryIntervalSec: record.retryIntervalSec ?? DEFAULT_RETRY_INTERVAL_SEC,
        sourceId: record.sourceId,
        sourceTable: record.sourceTable,
        targetId: record.targetId,
        targetTable: record.targetTable,
        fieldMappings: (record.fieldMappings ?? []).map((item) => ({ ...item })),
      })
    }
    editorKey.value += 1
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

  function handleMappingChange(mappings: FieldMapping[]) {
    formState.fieldMappings = mappings
  }

  async function validateCurrentStep(): Promise<boolean> {
    const fields = STEP_FIELDS[step.value] ?? []
    if (!formRef.value) return true
    if (!fields.length) return true
    try {
      await formRef.value.validate(fields)
      return true
    } catch {
      return false
    }
  }

  function handlePrev() {
    step.value = Math.max(STEP_BASIC, step.value - 1)
  }

  async function handleOk() {
    if (step.value < STEP_MAPPING) {
      if (!(await validateCurrentStep())) return
      step.value += 1
      return
    }
    await handleSubmit()
  }

  /** InputNumber 清空后为 null，提交前统一钳制到合法区间 */
  function toIntInRange(value: any, min: number, max: number, fallback: number) {
    const num = Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.min(max, Math.max(min, Math.round(num)))
  }

  /**
   * 只提交契约 1.2 的请求字段（含调度配置），id 走 URL，
   * lastStatus / createdAt / progress 等响应侧字段不回传
   */
  function buildPayload(): TaskPayload {
    const incremental = formState.syncMode === 'incremental'
    const task: Task = {
      name: formState.name,
      syncMode: formState.syncMode,
      sourceId: formState.sourceId,
      sourceTable: formState.sourceTable,
      targetId: formState.targetId,
      targetTable: formState.targetTable,
      writeMode: formState.writeMode,
      batchSize: Number(formState.batchSize),
      incrementalColumn: incremental ? formState.incrementalColumn : null,
      // 调度配置：cron 留空 => null（仅手动触发），Mock 阶段后端只存不调度
      scheduleCron: String(formState.scheduleCron || '').trim() || null,
      retryCount: toIntInRange(formState.retryCount, 0, MAX_RETRY_COUNT, DEFAULT_RETRY_COUNT),
      retryIntervalSec: toIntInRange(
        formState.retryIntervalSec,
        0,
        MAX_RETRY_INTERVAL_SEC,
        DEFAULT_RETRY_INTERVAL_SEC,
      ),
      fieldMappings: formState.fieldMappings ?? [],
      enabled: !!formState.enabled,
    }
    return pickTaskPayload(task)
  }

  async function handleSubmit() {
    if (formRef.value) {
      try {
        await formRef.value.validate()
      } catch {
        step.value = STEP_BASIC
        return
      }
    }
    const mappings: FieldMapping[] = formState.fieldMappings ?? []
    if (!mappings.length) {
      createMessage.warning('请至少配置一个字段映射')
      return
    }
    const transformError = validateFieldTransforms(mappings)
    if (transformError) {
      createMessage.warning(transformError)
      return
    }
    submitting.value = true
    setModalProps({ confirmLoading: true })
    try {
      const payload = buildPayload()
      const taskId = formState.id as string | undefined
      if (unref(isUpdate) && taskId) {
        await updateTaskApi(taskId, payload)
        createMessage.success('任务已更新')
      } else {
        await createTaskApi(payload)
        createMessage.success('任务已创建')
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
