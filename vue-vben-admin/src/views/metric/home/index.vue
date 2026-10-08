<template>
  <PageWrapper title="指标中心 · 首页概览" content="域/模型/指标资产、清洗任务与智能问数的实时统计">
    <Spin :spinning="loading">
      <Row :gutter="16" class="mb-4">
        <Col :span="6">
          <Card :bordered="false">
            <Statistic title="指标域" :value="dash?.domains.total ?? 0" />
          </Card>
        </Col>
        <Col :span="6">
          <Card :bordered="false">
            <Statistic title="数据模型" :value="dash?.models.total ?? 0" />
          </Card>
        </Col>
        <Col :span="6">
          <Card :bordered="false">
            <Statistic title="指标总数" :value="dash?.metrics.total ?? 0" />
          </Card>
        </Col>
        <Col :span="6">
          <Card :bordered="false">
            <Statistic
              title="近 7 天问数"
              :value="dash?.chat.last7dQueries ?? 0"
              :suffix="dash && dash.chat.last7dFailed ? `失败 ${dash.chat.last7dFailed}` : ''"
            />
          </Card>
        </Col>
      </Row>

      <Row :gutter="16" class="mb-4">
        <Col :span="8">
          <Card title="指标构成" :bordered="false">
            <Descriptions :column="1" size="small">
              <DescriptionsItem label="原子指标">
                {{ dash?.metrics.byType.ATOMIC ?? 0 }}
              </DescriptionsItem>
              <DescriptionsItem label="派生指标">
                {{ dash?.metrics.byType.DERIVED ?? 0 }}
              </DescriptionsItem>
              <DescriptionsItem label="复合指标">
                {{ dash?.metrics.byType.COMPOSITE ?? 0 }}
              </DescriptionsItem>
              <DescriptionsItem label="状态分布">
                <Space>
                  <Tag color="success">上线 {{ dash?.metrics.byStatus.online ?? 0 }}</Tag>
                  <Tag>草稿 {{ dash?.metrics.byStatus.draft ?? 0 }}</Tag>
                  <Tag color="warning">下线 {{ dash?.metrics.byStatus.offline ?? 0 }}</Tag>
                </Space>
              </DescriptionsItem>
            </Descriptions>
          </Card>
        </Col>
        <Col :span="8">
          <Card title="模型分层" :bordered="false">
            <Descriptions :column="1" size="small">
              <DescriptionsItem v-for="layer in LAYER_KEYS" :key="layer" :label="layer">
                <Tag :color="LAYER_TAG_COLORS[layer]">{{ dash?.models.byLayer[layer] ?? 0 }}</Tag>
              </DescriptionsItem>
            </Descriptions>
          </Card>
        </Col>
        <Col :span="8">
          <Card title="清洗任务（近 24h）" :bordered="false">
            <Descriptions :column="1" size="small">
              <DescriptionsItem label="任务数">
                {{ dash?.tasks.total ?? 0 }}（启用 {{ dash?.tasks.enabled ?? 0 }}）
              </DescriptionsItem>
              <DescriptionsItem label="成功 / 失败 / 运行中">
                {{ dash?.tasks.last24h.success ?? 0 }} /
                {{ dash?.tasks.last24h.failed ?? 0 }} /
                {{ dash?.tasks.last24h.running ?? 0 }}
              </DescriptionsItem>
              <DescriptionsItem label="成功率">
                {{ ((dash?.tasks.successRate ?? 1) * 100).toFixed(1) }}%
              </DescriptionsItem>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Card title="热门指标 Top10（近 7 天问数命中）" :bordered="false">
        <Table
          :columns="hotColumns"
          :data-source="dash?.hotMetrics ?? []"
          :pagination="false"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'action'">
              <Button type="link" size="small" @click="goChat(record)">问一问</Button>
            </template>
          </template>
        </Table>
        <Empty v-if="!dash?.hotMetrics?.length" description="近 7 天暂无问数记录" />
      </Card>
    </Spin>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { onMounted, ref } from 'vue'
  import { Button, Card, Col, Descriptions, Empty, Row, Spin, Statistic, Table, Tag } from 'ant-design-vue'
  import { useRouter } from 'vue-router'

  import { getMetricDashboardApi, type MetricDashboard } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { LAYER_TAG_COLORS } from '../data'

  const DescriptionsItem = Descriptions.Item

  const LAYER_KEYS = ['ODS', 'DIM', 'DWD', 'DWS', 'ADS']

  const router = useRouter()
  const { createMessage } = useMessage()
  const loading = ref(false)
  const dash = ref<MetricDashboard | null>(null)

  const hotColumns = [
    { title: '指标', dataIndex: 'name', key: 'name' },
    { title: '问数次数', dataIndex: 'count', key: 'count', width: 120 },
    { title: '操作', key: 'action', width: 120 },
  ]

  async function load() {
    loading.value = true
    try {
      dash.value = await getMetricDashboardApi()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '概览加载失败'))
    } finally {
      loading.value = false
    }
  }

  function goChat(record: { name: string }) {
    router.push({ path: '/metric/chat', query: { q: `${record.name}是多少` } })
  }

  onMounted(load)
</script>
