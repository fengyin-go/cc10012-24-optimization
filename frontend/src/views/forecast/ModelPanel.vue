<template>
  <section class="panel" data-panel="forecast-models">
    <div class="panel-head">
      <div>
        <h3>模型与特征依赖</h3>
        <p class="panel-desc">
          特征来源、数据集版本与生效批次统一登记。受影响模型只标记为待重训，不会自动改写已生效版本。
        </p>
      </div>
      <div class="panel-actions">
        <button class="btn" type="button" @click="refresh">重新读取</button>
        <button class="btn" type="button" @click="exportModels">导出模型特征清单</button>
      </div>
    </div>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">预测模型</span>
        <strong class="stat-value">{{ views.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待重训</span>
        <strong class="stat-value">{{ pendingCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">生效批次</span>
        <strong class="stat-value">{{ activeBatch || '—' }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>模型编号</th>
          <th>模型名称</th>
          <th>数据集</th>
          <th>特征读取方式</th>
          <th>特征依据</th>
          <th>模型版本</th>
          <th>生效批次</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="view in views"
          :key="view.model.id"
          :data-model-id="view.model.id"
          :class="{ 'row-pending': view.impactStatus === '待重训' }"
        >
          <td>{{ view.model.id }}</td>
          <td>{{ view.model.name }}</td>
          <td>{{ view.model.datasetId }} {{ view.datasetName }} v{{ view.datasetVersion }}</td>
          <td>{{ view.model.featureMode }}（{{ view.features.length }} 个特征）</td>
          <td class="cell-wrap">{{ view.featureBasis }}</td>
          <td>v{{ view.model.modelVersion }}（训练于 v{{ view.model.trainedVersion }}）</td>
          <td>{{ view.model.activeBatchId ?? '未发布' }}</td>
          <td>
            <span :class="['badge', view.impactStatus === '待重训' ? 'badge-warn' : 'badge-ok']">
              {{ view.impactStatus }}
            </span>
          </td>
        </tr>
        <tr v-if="!views.length">
          <td colspan="8" class="empty-state">暂无预测模型</td>
        </tr>
      </tbody>
    </table>

    <div class="detail-grid">
      <article v-for="view in views" :key="`detail-${view.model.id}`" class="detail-card">
        <header>
          <strong>{{ view.model.id }} · {{ view.model.name }}</strong>
          <span class="muted">{{ view.model.algorithm }}</span>
        </header>
        <p class="muted">目标字段：{{ view.model.target }} · 预测步长 {{ view.model.horizon }}</p>
        <p>
          特征：<span class="chip" v-for="field in view.features" :key="field">{{ field }}</span>
          <span v-if="!view.features.length" class="muted">全量读取（未登记显式字段）</span>
        </p>
        <p class="muted">
          系数 {{ view.model.coefficient }} · {{ view.model.metric }} · 置信区间 {{ view.model.confidence }}
        </p>
        <p class="muted">最近训练：{{ view.model.lastTrainedAt }} · 批次状态：{{ view.activeBatchStatus }}</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadCsv } from '@/api/download'
import { forecastState, modelViews } from '@/api/local-service'
import { csvDocument } from '@/data/csv'
import type { ForecastModelView } from '@/data/forecast-types'

const emit = defineEmits<{ changed: [] }>()

const views = ref<ForecastModelView[]>([])
const activeBatch = ref<string | null>(null)

const pendingCount = computed(
  () => views.value.filter((view) => view.impactStatus === '待重训').length,
)

function refresh() {
  views.value = modelViews()
  activeBatch.value = forecastState().activeBatchId
  emit('changed')
}

function exportModels() {
  const rows = views.value.map((view) => [
    view.model.id,
    view.model.name,
    view.model.algorithm,
    `${view.model.datasetId} ${view.datasetName}`,
    `v${view.model.trainedVersion}→v${view.datasetVersion}`,
    view.model.featureMode,
    view.featureBasis,
    `v${view.model.modelVersion}`,
    view.model.activeBatchId ?? '未发布',
    view.impactStatus,
  ])
  downloadCsv(
    'forecast-model-features.csv',
    csvDocument(
      [
        '模型编号',
        '模型名称',
        '算法',
        '数据集',
        '数据集版本',
        '特征读取方式',
        '特征依据',
        '模型版本',
        '生效批次',
        '状态',
      ],
      rows,
    ),
  )
}

onMounted(refresh)
</script>
