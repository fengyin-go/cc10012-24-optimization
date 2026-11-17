<template>
  <section class="panel" data-panel="forecast-impact">
    <div class="panel-head">
      <div>
        <h3>特征影响判断</h3>
        <p class="panel-desc">
          逐模型比较「已训练版本的特征依据」与数据集新版本。影响判断只读特征依赖，不触发重训。
        </p>
      </div>
      <div class="panel-actions">
        <button class="btn" type="button" @click="refresh">重新判断</button>
        <button class="btn" type="button" @click="exportImpacts">导出影响判断</button>
      </div>
    </div>

    <div class="change-list">
      <label v-for="change in changes" :key="change.id" class="change-item">
        <input v-model="selected" type="checkbox" :value="change.id" />
        <span class="change-body">
          <strong>{{ change.id }} · {{ change.title }}</strong>
          <span class="muted">
            {{ change.datasetId }} v{{ change.fromVersion }}→v{{ change.toVersion }} ·
            {{ change.status }} · 登记于 {{ change.registeredAt }}
          </span>
          <span class="chip-row">
            <span v-for="item in change.changes" :key="`${change.id}-${item.field}`" :class="['chip', chipClass(item.kind)]">
              {{ item.field }} · {{ item.kind }}
            </span>
          </span>
          <span class="muted">{{ change.note }}</span>
        </span>
      </label>
      <p v-if="!changes.length" class="muted">没有登记字段变更</p>
    </div>

    <p v-if="notice" :class="['notice', noticeTone]">{{ notice }}</p>

    <table class="data-table">
      <thead>
        <tr>
          <th>模型</th>
          <th>数据集</th>
          <th>已训练版本</th>
          <th>判断</th>
          <th>原因</th>
          <th>未命中依据</th>
          <th>生效批次</th>
          <th>状态变化</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="impact in impacts"
          :key="impact.modelId"
          :data-impact-id="impact.modelId"
          :class="{ 'row-pending': impact.affected }"
        >
          <td>{{ impact.modelId }} {{ impact.modelName }}</td>
          <td>{{ impact.datasetId }}</td>
          <td class="cell-wrap">{{ impact.featureBasis }}</td>
          <td>
            <span :class="['badge', impact.affected ? 'badge-warn' : 'badge-ok']">
              {{ impact.affected ? `受影响 · ${severityLabel(impact.severity)}` : '不受影响' }}
            </span>
          </td>
          <td class="cell-wrap">{{ impact.reasons.join('；') }}</td>
          <td class="cell-wrap muted">{{ impact.evidence }}</td>
          <td>{{ impact.activeBatchId ?? '—' }}</td>
          <td>{{ impact.beforeStatus }} → {{ impact.afterStatus }}</td>
        </tr>
        <tr v-if="!impacts.length">
          <td colspan="8" class="empty-state">请选择至少一条字段变更</td>
        </tr>
      </tbody>
    </table>

    <footer class="panel-foot">
      <span>
        受影响 {{ affectedCount }} 个，未受影响 {{ impacts.length - affectedCount }} 个；未受影响模型保持原有效批次。
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { downloadCsv } from '@/api/download'
import { diagnoseImpact, forecastState } from '@/api/local-service'
import { csvDocument } from '@/data/csv'
import type { FeatureChangeKind, ModelImpact } from '@/data/forecast-types'

const emit = defineEmits<{ changed: []; 'scope-change': [changeIds: string[]] }>()

const changes = ref(forecastState().changes.filter((change) => change.status === '待处理'))
const selected = ref<string[]>(changes.value.map((change) => change.id))
const impacts = ref<ModelImpact[]>([])
const notice = ref('')
const noticeTone = ref<'ok' | 'warn'>('ok')

const affectedCount = computed(() => impacts.value.filter((item) => item.affected).length)

function severityLabel(severity: ModelImpact['severity']): string {
  switch (severity) {
    case 'blocking':
      return '阻断'
    case 'required':
      return '必需特征变化'
    case 'additive':
      return '新增/漂移'
    default:
      return '无'
  }
}

function chipClass(kind: FeatureChangeKind): string {
  return kind === '类型变更' || kind === '移除' ? 'chip-danger' : kind === '分布漂移' ? 'chip-warn' : 'chip-info'
}

function refresh() {
  if (selected.value.length === 0) {
    impacts.value = []
    notice.value = '请至少选择一条变更后再判断'
    noticeTone.value = 'warn'
    emit('scope-change', [])
    return
  }
  const result = diagnoseImpact(selected.value)
  impacts.value = result.impacts
  const pending = result.impacts.filter((item) => item.affected).map((item) => item.modelId)
  notice.value = `按 ${selected.value.length} 条变更判断：${pending.length ? `${pending.join('、')} 需要重训` : '没有模型需要重训'}`
  noticeTone.value = 'ok'
  emit('scope-change', selected.value)
  emit('changed')
}

function exportImpacts() {
  const rows = impacts.value.map((impact) => [
    selected.value.join('|'),
    impact.modelId,
    impact.modelName,
    impact.datasetId,
    impact.featureBasis,
    impact.affected ? '是' : '否',
    severityLabel(impact.severity),
    impact.reasons.join('；'),
    impact.evidence,
    impact.activeBatchId ?? '',
    `${impact.beforeStatus}→${impact.afterStatus}`,
  ])
  downloadCsv(
    'forecast-impact.csv',
    csvDocument(
      [
        '变更',
        '模型编号',
        '模型名称',
        '数据集',
        '已训练特征依据',
        '是否受影响',
        '严重度',
        '原因',
        '未命中依据',
        '生效批次',
        '状态变化',
      ],
      rows,
    ),
  )
}

watch(selected, refresh, { deep: true })

onMounted(refresh)
</script>
