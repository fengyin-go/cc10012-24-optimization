<template>
  <section class="panel" data-panel="forecast-reports">
    <div class="panel-head">
      <div>
        <h3>预测报告与归档</h3>
        <p class="panel-desc">
          单批次口径版本一致但覆盖面有限；分段口径覆盖全量但需逐行标注批次。报告与预测结果、模型快照一起归档。
        </p>
      </div>
      <div class="panel-actions">
        <button class="btn" type="button" @click="refresh">刷新报告</button>
      </div>
    </div>

    <div class="form-row">
      <label class="field">
        <span>报告口径</span>
        <select v-model="policy">
          <option v-for="option in policyOptions" :key="option.policy" :value="option.policy">
            {{ option.policy }}{{ option.recommended ? '（推荐）' : '' }}
          </option>
        </select>
      </label>
      <label class="field grow">
        <span>报告标题</span>
        <input v-model="title" placeholder="例如：2026-11-17 经营预测日报" />
      </label>
      <button class="btn primary" type="button" @click="submit">生成并归档报告</button>
    </div>

    <p v-if="actionMessage" :class="['notice', actionTone]">{{ actionMessage }}</p>

    <div class="compare-grid">
      <article v-for="option in policyOptions" :key="option.policy" class="compare-card">
        <header>
          <strong>{{ option.policy }}</strong>
          <span :class="['badge', option.recommended ? 'badge-ok' : 'badge-muted']">
            {{ option.recommended ? '推荐' : '可选' }}
          </span>
        </header>
        <p class="muted">{{ option.coverage }}</p>
        <p class="muted">{{ option.consistency }}</p>
        <p class="muted">{{ option.caveat }}</p>
        <p v-if="option.conflict" class="error-text">存在口径冲突：{{ option.rationale }}</p>
        <p v-else class="muted">{{ option.rationale }}</p>
        <p class="muted">批次分组：{{ option.batchGroups.join('、') || '—' }}</p>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>报告编号</th>
          <th>标题</th>
          <th>口径</th>
          <th>批次分组</th>
          <th>预测结果</th>
          <th>归档</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="report in reports" :key="report.id" :data-report-id="report.id">
          <td>{{ report.id }}</td>
          <td>{{ report.title }}</td>
          <td>{{ report.policy }}</td>
          <td class="cell-wrap">{{ report.batchGroups.join('、') }}</td>
          <td>{{ report.results.length }} 条 · {{ report.models.length }} 个模型版本</td>
          <td>{{ report.status }}{{ report.archivedAt ? ` · ${report.archivedAt}` : '' }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openReport(report.id)">明细</button>
            <button class="link" type="button" @click="exportReport(report.id)">导出</button>
          </td>
        </tr>
        <tr v-if="!reports.length">
          <td colspan="7" class="empty-state">暂无归档报告</td>
        </tr>
      </tbody>
    </table>

    <div v-if="activeReport" class="batch-detail" data-report-detail>
      <header class="panel-head">
        <div>
          <h4>{{ activeReport.id }} · {{ activeReport.title }}</h4>
          <p class="panel-desc">{{ activeReport.tradeoff }}</p>
        </div>
        <div class="panel-actions">
          <button class="btn ghost" type="button" @click="activeReportId = ''">收起</button>
        </div>
      </header>
      <p class="muted">口径：{{ activeReport.policy }} · 批次分组：{{ activeReport.batchGroups.join('、') }}</p>
      <p class="muted">
        来源批次：
        <button
          v-for="batchId in activeReport.batchGroups"
          :key="batchId"
          class="link"
          type="button"
          @click="emit('open-batch', batchId)"
        >
          {{ batchId }}
        </button>
        <span class="muted"> · 文件 {{ activeReport.sourceBatchFiles.join('、') || '—' }}</span>
      </p>
      <ul v-if="activeReport.warnings.length" class="audit-list warn-list">
        <li v-for="line in activeReport.warnings" :key="line">{{ line }}</li>
      </ul>
      <table class="data-table">
        <thead>
          <tr>
            <th>分组</th>
            <th>批次号</th>
            <th>模型</th>
            <th>模型版本</th>
            <th>数据集版本</th>
            <th>读取特征</th>
            <th>系数</th>
            <th>预测值</th>
            <th>预测区间</th>
            <th>边界</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in activeReport.rows" :key="`${row.batchId}-${row.modelId}`">
            <td>{{ row.groupLabel }}</td>
            <td>{{ row.batchId }}</td>
            <td>{{ row.modelId }} {{ row.modelName }}</td>
            <td>v{{ row.modelVersion }}</td>
            <td>v{{ row.datasetVersion }}</td>
            <td class="cell-wrap">{{ row.features.join('、') }}</td>
            <td>{{ row.coefficient }}</td>
            <td>{{ row.value }}</td>
            <td>[{{ row.lower }}, {{ row.upper }}]</td>
            <td>{{ row.boundary }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        归档模型快照：{{ activeReport.models.map((model) => `${model.modelId} v${model.modelVersion}`).join('、') }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadCsv } from '@/api/download'
import {
  forecastState,
  generateReport,
  policyOptions as loadPolicyOptions,
  reportCsvContent,
  reportById,
} from '@/api/local-service'
import type { ForecastReport, ReportPolicy } from '@/data/forecast-types'

const emit = defineEmits<{ changed: []; 'open-batch': [batchId: string] }>()

const policyOptions = ref(loadPolicyOptions())
const policy = ref<ReportPolicy>(policyOptions.value.find((option) => option.recommended)?.policy ?? '单批次')
const title = ref('')
const reports = ref<ForecastReport[]>([])
const activeReportId = ref('')
const actionMessage = ref('')
const actionTone = ref<'ok' | 'warn'>('ok')

const activeReport = computed<ForecastReport | undefined>(() =>
  reports.value.find((report) => report.id === activeReportId.value),
)

function notify(message: string, ok: boolean) {
  actionMessage.value = message
  actionTone.value = ok ? 'ok' : 'warn'
}

function refresh() {
  policyOptions.value = loadPolicyOptions()
  if (!policyOptions.value.some((option) => option.policy === policy.value)) {
    policy.value = policyOptions.value[0]?.policy ?? '单批次'
  }
  reports.value = forecastState().reports
  emit('changed')
}

function submit() {
  const result = generateReport({ policy: policy.value, title: title.value })
  notify(result.message, result.ok)
  refresh()
}

function openReport(reportId: string) {
  activeReportId.value = activeReportId.value === reportId ? '' : reportId
}

function exportReport(reportId: string) {
  const report = reportById(reportId)
  if (!report) {
    notify(`没有找到报告 ${reportId}`, false)
    return
  }
  const { filename, content } = reportCsvContent(report)
  downloadCsv(filename, content)
  notify(`已导出 ${filename}，内容与报告明细一致`, true)
}

onMounted(refresh)
</script>
