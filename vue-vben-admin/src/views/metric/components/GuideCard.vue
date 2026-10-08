<template>
  <Card :bordered="false" class="mb-3 guide-card">
    <Collapse ghost>
      <CollapsePanel key="guide">
        <template #header>
          <span class="guide-header">
            <Icon icon="ion:book-outline" :size="16" />
            {{ title }}
          </span>
        </template>
        <p v-if="intro" class="guide-intro">{{ intro }}</p>
        <ol class="guide-steps">
          <li v-for="(step, i) in steps" :key="i">{{ step }}</li>
        </ol>
        <slot></slot>
      </CollapsePanel>
    </Collapse>
  </Card>
</template>

<script lang="ts" setup>
  import { computed } from 'vue'

  import { Card, Collapse } from 'ant-design-vue'

  import { Icon } from '/@/components/Icon'

  const CollapsePanel = Collapse.Panel

  const props = defineProps<{
    guide: { title: string; intro?: string; steps: string[] }
  }>()

  const title = computed(() => props.guide.title)
  const intro = computed(() => props.guide.intro)
  const steps = computed(() => props.guide.steps)
</script>

<style lang="less" scoped>
  .guide-card {
    background: rgba(22, 119, 255, 0.03);
  }

  .guide-header {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    color: #1677ff;
  }

  .guide-intro {
    color: #666;
    margin-bottom: 8px;
  }

  .guide-steps {
    margin: 0;
    padding-left: 20px;
    color: #444;

    li {
      margin-bottom: 4px;
      line-height: 1.7;
    }
  }
</style>
