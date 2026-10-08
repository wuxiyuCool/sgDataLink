<template>
  <div>
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
          <Input
            v-if="allowStruct"
            v-model:value="record.dataType"
            size="small"
            placeholder="如 varchar"
            @change="sync"
          />
          <span v-else>{{ record.dataType || '-' }}</span>
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
            @update:checked="(v: boolean) => { record.isKey = v; sync() }"
          />
        </template>
        <template v-else-if="column.key === 'action'">
          <Button type="link" size="small" danger :disabled="!allowStruct" @click="removeRow(index)">
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

<script lang="ts" setup>
  /** 模型字段编辑器：ddl 建表（allowStruct 全量可编辑）与字段维护（业务名/角色）共用 */
  import { ref, watch } from 'vue'

  import { Button, Checkbox, Input, Select, Table } from 'ant-design-vue'

  import type { MetricModelColumn } from '/@/api/databridge/metric'

  import { AGG_OPTIONS, COLUMN_ROLE_OPTIONS } from '../data'

  const props = withDefaults(
    defineProps<{
      modelValue: MetricModelColumn[]
      /** 允许增删行与改物理列名/类型（ddl 模式） */
      allowStruct?: boolean
    }>(),
    { modelValue: () => [], allowStruct: false },
  )

  const emit = defineEmits<{ (e: 'update:modelValue', value: MetricModelColumn[]): void }>()

  const editorColumns = [
    { title: '物理列', key: 'columnName', width: 140 },
    { title: '业务名', key: 'bizName', width: 140 },
    { title: '类型', key: 'dataType', width: 110 },
    { title: '角色', key: 'role', width: 110 },
    { title: '默认聚合', key: 'aggDefault', width: 150 },
    { title: '主键', key: 'isKey', width: 60 },
    { title: '', key: 'action', width: 60 },
  ]

  const localColumns = ref<(MetricModelColumn & { __key: number })[]>([])

  watch(
    () => props.modelValue,
    (value) => {
      localColumns.value = (value || []).map((col, index) => ({ ...col, __key: index }))
    },
    { immediate: true, deep: false },
  )

  function sync() {
    emit(
      'update:modelValue',
      localColumns.value.map(({ __key, ...rest }) => rest),
    )
  }

  function addRow() {
    localColumns.value = [
      ...localColumns.value,
      { __key: Date.now(), columnName: '', bizName: '', dataType: 'varchar', role: 'dimension' },
    ]
  }

  function removeRow(index: number) {
    localColumns.value = localColumns.value.filter((_, i) => i !== index)
    sync()
  }
</script>
