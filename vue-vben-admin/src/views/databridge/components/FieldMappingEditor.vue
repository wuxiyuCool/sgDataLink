<template>
  <div class="field-mapping-editor">
    <Table
      :columns="columns"
      :data-source="rows"
      :pagination="false"
      :scroll="{ x: 1150 }"
      row-key="__key"
      size="small"
      :bordered="true"
    >
      <template #bodyCell="{ column, index }">
        <template v-if="column.key === 'sourceField'">
          <Input
            v-model:value="rows[index].sourceField"
            size="small"
            placeholder="如 ID"
            :disabled="readonly"
            @change="emitChange"
          />
        </template>
        <template v-else-if="column.key === 'sourceType'">
          <Input
            v-model:value="rows[index].sourceType"
            size="small"
            placeholder="如 NUMBER(18,2)"
            :disabled="readonly"
            @change="emitChange"
          />
        </template>
        <template v-else-if="column.key === 'targetField'">
          <Input
            v-model:value="rows[index].targetField"
            size="small"
            placeholder="如 ID"
            :disabled="readonly"
            @change="emitChange"
          />
        </template>
        <template v-else-if="column.key === 'targetType'">
          <Input
            v-model:value="rows[index].targetType"
            size="small"
            placeholder="如 BIGINT"
            :disabled="readonly"
            @change="emitChange"
          />
        </template>
        <template v-else-if="column.key === 'transform'">
          <div class="flex items-center">
            <Select
              :value="rows[index].transformType"
              size="small"
              style="width: 100px"
              :options="FIELD_TRANSFORM_OPTIONS"
              :disabled="readonly"
              @change="handleTransformChange(index, $event)"
            />
            <Input
              v-if="needTransformValue(rows[index].transformType)"
              v-model:value="rows[index].transformValue"
              size="small"
              class="ml-1 flex-1"
              :placeholder="rows[index].transformType === 'constant' ? '常量值' : '如 UPPER(TRIM(NAME))'"
              :disabled="readonly"
              @change="emitChange"
            />
          </div>
        </template>
        <template v-else-if="column.key === 'primaryKey'">
          <Checkbox
            :checked="!!rows[index].primaryKey"
            :disabled="readonly"
            @change="handlePrimaryChange(index, $event)"
          />
        </template>
        <template v-else-if="column.key === 'action'">
          <Button type="link" size="small" danger :disabled="readonly" @click="handleRemove(index)">
            删除
          </Button>
        </template>
      </template>
    </Table>

    <div class="mt-2 flex items-center">
      <Button size="small" :disabled="readonly" @click="handleAdd">
        <Icon icon="ant-design:plus-outlined" class="mr-1" />
        新增字段
      </Button>
      <Button size="small" class="ml-2" :disabled="readonly" @click="handleAlignTarget">
        目标字段与源字段同名
      </Button>
      <span class="ml-3 text-gray-500">共 {{ rows.length }} 个字段映射</span>
      <span class="ml-3 text-gray-400">
        转换（对标 FDL 转换组件）仅保存与回显，Mock 阶段不参与同步执行
      </span>
    </div>
  </div>
</template>
<script lang="ts" setup>
  import { computed, ref } from 'vue'
  import { Button, Checkbox, Input, Select, Table } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import type {
    FieldMapping,
    FieldTransform,
    FieldTransformType,
  } from '/@/api/databridge/model/taskModel'
  import type { TableColumn } from '../data'
  import { FIELD_TRANSFORM_OPTIONS, needTransformValue } from '../data'

  const props = defineProps({
    /** 仅用于初始化（父组件切换数据时用 :key 强制重建本组件） */
    mappings: {
      type: Array as () => FieldMapping[],
      default: () => [],
    },
    readonly: { type: Boolean, default: false },
    /** 主键勾选列，任务编辑与映射页都需要 */
    showPrimaryKey: { type: Boolean, default: true },
  })

  const emit = defineEmits(['change'])

  interface MappingRow extends Omit<FieldMapping, 'transform'> {
    __key: string
    /** 行内编辑用的扁平字段，提交时经 toTransform() 归一为 transform: null | { type, value } */
    transformType: FieldTransformType
    transformValue: string
  }

  let seed = 0

  function toRow(item: FieldMapping): MappingRow {
    seed += 1
    return {
      sourceField: item.sourceField ?? '',
      targetField: item.targetField ?? '',
      sourceType: item.sourceType ?? '',
      targetType: item.targetType ?? '',
      primaryKey: !!item.primaryKey,
      transformType: item.transform?.type ?? 'none',
      transformValue: item.transform?.value ?? '',
      __key: `row-${seed}`,
    }
  }

  const rows = ref<MappingRow[]>((props.mappings ?? []).map(toRow))

  const columns = computed(() => {
    const cols: TableColumn[] = [
      { title: '源字段', key: 'sourceField', width: 150 },
      { title: '源类型', key: 'sourceType', width: 140 },
      { title: '目标字段', key: 'targetField', width: 150 },
      { title: '目标类型', key: 'targetType', width: 140 },
      { title: '转换', key: 'transform', width: 260 },
    ]
    if (props.showPrimaryKey) {
      cols.push({ title: '主键', key: 'primaryKey', width: 70, align: 'center' })
    }
    cols.push({ title: '操作', key: 'action', width: 80, align: 'center' })
    return cols
  })

  /** 契约 1.2：none / 未选择归一为 null，常量与表达式才携带 value */
  function toTransform(row: MappingRow): FieldTransform | null {
    if (!row.transformType || row.transformType === 'none') return null
    return {
      type: row.transformType,
      value: needTransformValue(row.transformType) ? row.transformValue : null,
    }
  }

  function clean(): FieldMapping[] {
    return rows.value.map((item) => ({
      sourceField: item.sourceField,
      targetField: item.targetField,
      sourceType: item.sourceType,
      targetType: item.targetType,
      primaryKey: !!item.primaryKey,
      transform: toTransform(item),
    }))
  }

  function emitChange() {
    emit('change', clean())
  }

  function handleAdd() {
    rows.value.push({
      sourceField: '',
      targetField: '',
      sourceType: '',
      targetType: '',
      primaryKey: false,
      transformType: 'none',
      transformValue: '',
      __key: `row-${++seed}`,
    })
    emitChange()
  }

  function handleRemove(index: number) {
    rows.value.splice(index, 1)
    emitChange()
  }

  function handlePrimaryChange(index: number, e: any) {
    rows.value[index].primaryKey = !!e?.target?.checked
    emitChange()
  }

  function handleTransformChange(index: number, value: any) {
    const row = rows.value[index]
    row.transformType = (value ?? 'none') as FieldTransformType
    // 切回不需要填值的类型时清空常量/表达式，避免脏值随请求体提交
    if (!needTransformValue(row.transformType)) row.transformValue = ''
    emitChange()
  }

  function handleAlignTarget() {
    rows.value.forEach((item) => {
      if (!item.targetField) item.targetField = item.sourceField
      if (!item.targetType) item.targetType = item.sourceType
    })
    emitChange()
  }

  defineExpose({
    /** 供父组件主动读取当前映射（不含 __key 内部字段） */
    getMappings: clean,
    /** 供父组件重置内容（会重建内部行，避免 v-model 双向同步死循环） */
    setMappings(list: FieldMapping[]) {
      rows.value = (list ?? []).map(toRow)
      emitChange()
    },
  })
</script>
