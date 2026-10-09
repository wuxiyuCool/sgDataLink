<template>
  <div>
    <div class="type-hint">
      类型族与长度上限取自后端方言层（当前按
      <b>{{ dialectType === 'oracle' ? 'Oracle' : 'MySQL' }}</b>
      渲染：{{ dialectHint }}
    </div>
    <Table
      :columns="editorColumns"
      :data-source="localColumns"
      :pagination="false"
      size="small"
      row-key="__key"
      :scroll="{ y: 320 }"
    >
      <template #bodyCell="{ column, index, record }">
        <template v-if="column.key === 'columnName'">
          <Input
            v-if="allowStruct"
            v-model:value="record.columnName"
            size="small"
            placeholder="物理列名"
            @change="sync"
          />
          <span v-else>{{ record.columnName }}</span>
        </template>
        <template v-else-if="column.key === 'bizName'">
          <Input v-model:value="record.bizName" size="small" placeholder="业务名" @change="sync" />
        </template>
        <template v-else-if="column.key === 'dataType'">
          <Select
            v-if="allowStruct"
            :value="typeOf(record).family"
            :options="familyOptions"
            size="small"
            style="width: 100%"
            @change="(v: any) => applyType(record, { family: v })"
          />
          <span v-else>{{ record.dataType || '-' }}</span>
        </template>
        <template v-else-if="column.key === 'length'">
          <InputNumber
            v-if="allowStruct"
            :value="typeOf(record).length"
            :min="1"
            :max="maxLengthOf(record)"
            size="small"
            style="width: 100%"
            :disabled="!editableLength(record)"
            @update:value="(v: any) => applyType(record, { length: Number(v) || undefined })"
          />
          <span v-else>-</span>
        </template>
        <template v-else-if="column.key === 'scale'">
          <InputNumber
            v-if="allowStruct"
            :value="typeOf(record).scale"
            :min="0"
            :max="10"
            size="small"
            style="width: 100%"
            :disabled="!editableScale(record)"
            @update:value="(v: any) => applyType(record, { scale: Number(v) })"
          />
          <span v-else>-</span>
        </template>
        <template v-else-if="column.key === 'role'">
          <Select
            v-model:value="record.role"
            :options="COLUMN_ROLE_OPTIONS"
            size="small"
            style="width: 100%"
            @change="sync"
          />
        </template>
        <template v-else-if="column.key === 'aggDefault'">
          <Select
            v-model:value="record.aggDefault"
            :options="AGG_OPTIONS"
            size="small"
            style="width: 100%"
            :disabled="record.role !== 'measure'"
            allow-clear
            @change="sync"
          />
        </template>
        <template v-else-if="column.key === 'isKey'">
          <Checkbox
            :checked="!!record.isKey"
            :disabled="!allowStruct"
            @update:checked="
              (v: boolean) => {
                record.isKey = v
                sync()
              }
            "
          />
        </template>
        <template v-else-if="column.key === 'action'">
          <Button
            type="link"
            size="small"
            danger
            :disabled="!allowStruct"
            @click="removeRow(index)"
          >
            删除
          </Button>
        </template>
      </template>
    </Table>
    <Button v-if="allowStruct" size="small" class="mt-2" block type="dashed" @click="addRow">
      + 添加字段
    </Button>
  </div>
</template>

<script lang="ts">
  /** 类型目录进程内取一次即可（后端方言层的只读产物） */
  import type { ColumnTypeFamily } from '/@/api/databridge/metric'

  import { getColumnTypesApi } from '/@/api/databridge/metric'

  let catalogCache: { mysql: ColumnTypeFamily[]; oracle: ColumnTypeFamily[] } | null = null

  export function loadColumnTypeCatalog() {
    if (!catalogCache) {
      catalogCache = getColumnTypesApi().catch(() => null)
    }
    return catalogCache
  }
</script>

<script lang="ts" setup>
  /**
   * 模型字段编辑器：ddl 建表（allowStruct 全量可编辑）与字段维护（业务名/角色）共用。
   * 类型不接受自由文本：选「类型族」+ 填「长度/小数位」，由方言层目录给出该库真实类型名与上限，
   * 避免手打 varchar（无长度）之类两库都建不出表的串。
   */
  import { computed, ref, watch } from 'vue'

  import { Button, Checkbox, Input, InputNumber, Select, Table } from 'ant-design-vue'

  import type { MetricModelColumn } from '/@/api/databridge/metric'

  import { AGG_OPTIONS, COLUMN_ROLE_OPTIONS } from '../data'

  const props = withDefaults(
    defineProps<{
      modelValue: MetricModelColumn[]
      /** 允许增删行与改物理列名/类型（ddl 模式） */
      allowStruct?: boolean
      /** 目标数据源方言，决定类型下拉里显示的真实类型名与长度上限 */
      dialectType?: string
    }>(),
    { modelValue: () => [], allowStruct: false, dialectType: 'mysql' },
  )

  const emit = defineEmits<{ (e: 'update:modelValue', value: MetricModelColumn[]): void }>()

  /** 源库原生类型别名 → 类型族（引用表拿到的是 VARCHAR2/NUMBER 等原生写法） */
  const FAMILY_ALIASES: Record<string, string> = {
    VARCHAR2: 'VARCHAR',
    NVARCHAR: 'VARCHAR',
    STRING: 'VARCHAR',
    CHARACTER: 'VARCHAR',
    NCHAR: 'CHAR',
    NUMBER: 'DECIMAL',
    NUMERIC: 'DECIMAL',
    FLOAT: 'DECIMAL',
    DOUBLE: 'DECIMAL',
    REAL: 'DECIMAL',
    INTEGER: 'INT',
    SMALLINT: 'INT',
    TINYINT: 'INT',
    MEDIUMINT: 'INT',
    DATETIME2: 'DATETIME',
    TIME: 'VARCHAR',
    CLOB: 'TEXT',
    BLOB: 'TEXT',
    JSON: 'TEXT',
  }

  const catalog = ref<ColumnTypeFamily[]>([])

  const familyOptions = computed(() =>
    catalog.value.map((item) => ({
      label: `${item.label} ${item.rendered}`,
      value: item.family,
    })),
  )

  const dialectHint = computed(() => {
    const names = catalog.value.map((item) => item.rendered).join('、')
    return names ? `DDL 里会生成：${names}` : '类型目录加载中…'
  })

  loadColumnTypeCatalog().then((data) => {
    if (data)
      catalog.value = data[props.dialectType === 'oracle' ? 'oracle' : 'mysql'] || data.mysql
  })

  watch(
    () => props.dialectType,
    (value) => {
      if (catalog.value.length) catalog.value = []
      loadColumnTypeCatalog().then((data) => {
        if (data) catalog.value = data[value === 'oracle' ? 'oracle' : 'mysql'] || data.mysql
      })
    },
  )

  const editorColumns = [
    { title: '物理列', key: 'columnName', width: 130 },
    { title: '业务名', key: 'bizName', width: 120 },
    { title: '类型', key: 'dataType', width: 170 },
    { title: '长度', key: 'length', width: 80 },
    { title: '小数位', key: 'scale', width: 72 },
    { title: '角色', key: 'role', width: 100 },
    { title: '默认聚合', key: 'aggDefault', width: 130 },
    { title: '主键', key: 'isKey', width: 52 },
    { title: '', key: 'action', width: 52 },
  ]

  const localColumns = ref<(MetricModelColumn & { __key: number })[]>([])

  watch(
    () => props.modelValue,
    (value) => {
      localColumns.value = (value || []).map((col, index) => ({ ...col, __key: index }))
    },
    { immediate: true, deep: false },
  )

  function specOf(family: string) {
    return (
      catalog.value.find((item) => item.family === family) ||
      catalog.value[0] || { family: 'VARCHAR' }
    )
  }

  function typeOf(record: MetricModelColumn) {
    const raw = String(record.dataType || '')
      .trim()
      .toUpperCase()
    const base = raw.replace(/\(.*/, '').trim()
    const nums = (raw.match(/\d+/g) || []).map(Number)
    const spec = specOf(FAMILY_ALIASES[base] || base)
    const hasScale = Boolean((spec as ColumnTypeFamily).hasScale)
    return {
      family: spec.family,
      length:
        nums[0] ||
        (spec as ColumnTypeFamily).defaultLength ||
        (spec as ColumnTypeFamily).defaultPrecision,
      scale: nums.length > 1 ? nums[1] : (spec as ColumnTypeFamily).defaultScale,
      hasScale,
    }
  }

  function editableLength(record: MetricModelColumn) {
    const spec = specOf(typeOf(record).family) as ColumnTypeFamily
    return Boolean(spec.hasLength || spec.hasScale)
  }

  function editableScale(record: MetricModelColumn) {
    return Boolean((specOf(typeOf(record).family) as ColumnTypeFamily).hasScale)
  }

  function maxLengthOf(record: MetricModelColumn) {
    return (specOf(typeOf(record).family) as ColumnTypeFamily).maxLength || 65535
  }

  function applyType(
    record: MetricModelColumn,
    patch: { family?: string; length?: number; scale?: number },
  ) {
    const current = typeOf(record)
    const spec = specOf(patch.family || current.family) as ColumnTypeFamily
    const length = patch.length === undefined ? current.length : patch.length
    const scale = patch.scale === undefined ? current.scale : patch.scale
    if (spec.hasLength) record.dataType = `${spec.family}(${length || spec.defaultLength})`
    else if (spec.hasScale)
      record.dataType = `${spec.family}(${length || spec.defaultPrecision},${
        scale ?? spec.defaultScale
      })`
    else record.dataType = spec.family
    sync()
  }

  function sync() {
    emit(
      'update:modelValue',
      localColumns.value.map(({ __key, ...rest }) => rest),
    )
  }

  function addRow() {
    localColumns.value = [
      ...localColumns.value,
      {
        __key: Date.now(),
        columnName: '',
        bizName: '',
        dataType: 'VARCHAR(64)',
        role: 'dimension',
      },
    ]
    sync()
  }

  function removeRow(index: number) {
    localColumns.value = localColumns.value.filter((_, i) => i !== index)
    sync()
  }
</script>

<style lang="less" scoped>
  .type-hint {
    margin-bottom: 6px;
    font-size: 12px;
    color: rgb(0 0 0 / 45%);
  }
</style>
