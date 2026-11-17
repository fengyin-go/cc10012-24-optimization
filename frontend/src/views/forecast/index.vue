<template>
  <section class="page" data-module="forecast">
    <header class="page-head">
      <div>
        <h2>趋势预测管理</h2>
        <p class="page-desc">
          按特征依赖判断影响范围，只重训受影响模型并生成训练批次；特征依赖与数据集版本一起更新，重训失败保留上一份已生效模型。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportOverview">导出预测运营清单</button>
        <button class="btn ghost" type="button" @click="resetAll">恢复示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        :class="['tab', activeTab === tab.key ? 'tab-active' : '']"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <span v-if="tab.key === 'batches' && batchCount" class="tab-count">{{ batchCount }}</span>
      </button>
    </nav>

    <p v-if="errorMessage" class="notice warn">{{ errorMessage }}</p>

    <ModelPanel v-if="activeTab === 'models'" @changed="reloadSummary" />
    <ImpactPanel
      v-else-if="activeTab === 'impact'"
      @changed="reloadSummary"
      @scope-change="onScopeChange"
    />
    <BatchPanel
      v-else-if="activeTab === 'batches'"
      :change-ids="changeIds"
      :operator="operator"
      :focus-batch="focusBatchId"
      @changed="reloadSummary"
      @focus-consumed="focusBatchId = ''"
    />
    <ReportPanel
      v-else-if="activeTab === 'reports'"
      @changed="reloadSummary"
      @open-batch="openBatch"
    />

    <footer class="page-foot">
      <span>
        批次 {{ batchCount }} 个 · 报告 {{ reportCount }} 份 · 生效批次 {{ summary.activeBatchId ?? '—' }}
      </span>
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { downloadCsv } from '@/api/download'
import { forecastState, resetForecast } from '@/api/local-service'
import { csvDocument } from '@/data/csv'
import { useSessionStore } from '@/stores/session'
import type { ForecastState } from '@/data/forecast-types'
import BatchPanel from './BatchPanel.vue'
import ImpactPanel from './ImpactPanel.vue'
import ModelPanel from './ModelPanel.vue'
import ReportPanel from './ReportPanel.vue'

type TabKey = 'models' | 'impact' | 'batches' | 'reports'

const tabs: { key: TabKey; label: string }[] = [
  { key: 'models', label: '模型与特征' },
  { key: 'impact', label: '特征影响判断' },
  { key: 'batches', label: '训练批次' },
  { key: 'reports', label: '预测报告' },
]

const session = useSessionStore()
const operator = session.operator
const activeTab = ref<TabKey>('models')
const changeIds = ref<string[]>([])
/** 从报告明细跳回训练批次时保持可追溯的批次号。 */
const focusBatchId = ref('')
const errorMessage = ref('')
const summary = ref<ForecastState>(forecastState())

const batchCount = computed(
  () => summary.value.batches.filter((batch) => batch.status !== '已作废').length,
)
const reportCount = computed(() => summary.value.reports.length)
const stats = computed(() => {
  const state = summary.value
  const pending = state.changes.filter((change) => change.status === '待处理').length
  return [
    { label: '预测模型', value: state.models.length },
    { label: '待处理字段变更', value: pending },
    { label: '训练批次', value: batchCount.value },
    { label: '已归档报告', value: state.reports.filter((report) => report.status === '已归档').length },
  ]
})

function reloadSummary() {
  summary.value = forecastState()
}

function onScopeChange(next: string[]) {
  changeIds.value = next
}

function openBatch(batchId: string) {
  focusBatchId.value = batchId
  activeTab.value = 'batches'
}

function exportOverview() {
  const state = forecastState()
  const rows = state.batches.map((batch) => [
    batch.id,
    batch.status,
    batch.scope,
    batch.datasetVersions,
    batch.featureBasis.length,
    batch.entries
      .map((entry) => `${entry.modelId} v${entry.fromModelVersion}→v${entry.fromModelVersion + 1}`)
      .join('、'),
    batch.status === '已发布' && batch.id === state.activeBatchId ? '当前生效' : '非当前',
  ])
  downloadCsv(
    'forecast-batches.csv',
    csvDocument(
      ['批次号', '状态', '范围', '数据集版本', '特征依据条数', '模型版本', '发布状态'],
      rows,
    ),
  )
}

function resetAll() {
  resetForecast()
  changeIds.value = []
  reloadSummary()
  errorMessage.value = '已恢复示例数据，请切换页签重新读取'
}

watch(activeTab, () => {
  errorMessage.value = ''
  reloadSummary()
})

onMounted(() => {
  const state = forecastState()
  changeIds.value = state.changes.filter((change) => change.status === '待处理').map((change) => change.id)
  reloadSummary()
})
</script>
