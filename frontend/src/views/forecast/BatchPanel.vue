<template>
  <section class="panel" data-panel="forecast-batches">
    <div class="panel-head">
      <div>
        <h3>训练批次</h3>
        <p class="panel-desc">
          增量只重训受影响模型，整批覆盖全部已生效模型。两种范围都要守住预测边界，批次记录读取的特征依据与数据集版本。
        </p>
      </div>
      <div class="panel-actions">
        <button class="btn" type="button" @click="refresh">刷新批次</button>
      </div>
    </div>

    <div class="form-row">
      <label class="field">
        <span>重训范围</span>
        <select v-model="scope">
          <option value="增量">增量（仅受影响模型）</option>
          <option value="整批">整批（全部已生效模型）</option>
        </select>
      </label>
      <label class="field grow">
        <span>批次说明</span>
        <input v-model="note" placeholder="例如：DATA-0003 新增促销标记后增量重训" />
      </label>
      <label class="field">
        <span>故障注入</span>
        <select v-model="failureModel">
          <option value="">不注入</option>
          <option v-for="modelId in failureCandidates" :key="modelId" :value="modelId">
            {{ modelId }} 训练失败
          </option>
        </select>
      </label>
      <button class="btn primary" type="button" :disabled="!props.changeIds.length" @click="submit">
        生成训练批次
      </button>
    </div>

    <p v-if="!props.changeIds.length" class="notice warn">
      请先在「特征影响判断」里选择至少一条字段变更，训练批次按所选变更判断重训范围。
    </p>
    <p v-if="actionMessage" :class="['notice', actionTone]">{{ actionMessage }}</p>

    <div v-if="scopePlan && props.changeIds.length" class="compare-grid">
      <article v-for="option in [incremental, full]" :key="option.scope" class="compare-card">
        <header>
          <strong>{{ option.scope }}重训</strong>
          <span :class="['badge', option.boundary === '通过' ? 'badge-ok' : 'badge-danger']">
            边界{{ option.boundary }}
          </span>
        </header>
        <p class="muted">{{ option.coverage }}</p>
        <p class="muted">模型：{{ option.modelIds.join('、') || '—' }}</p>
        <p class="muted">预计 {{ option.estimatedMinutes }} 分钟 · {{ option.consistency }}</p>
        <p :class="option.boundary === '通过' ? 'muted' : 'error-text'">{{ option.boundaryNote }}</p>
      </article>
    </div>

    <div v-if="conflict" class="conflict-card">
      <h4>{{ conflict.title }}</h4>
      <p class="muted">口径取舍：{{ conflict.chosen }}</p>
      <p class="muted">{{ conflict.rationale }}</p>
      <table class="data-table compact">
        <thead>
          <tr><th>方案</th><th>覆盖面</th><th>一致性</th><th>成本 / 边界</th></tr>
        </thead>
        <tbody>
          <tr v-for="option in conflict.options" :key="option.label">
            <td>{{ option.label }}</td>
            <td>{{ option.coverage }}</td>
            <td>{{ option.consistency }}</td>
            <td>{{ option.cost }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>批次号</th>
          <th>范围</th>
          <th>特征依据</th>
          <th>数据集版本</th>
          <th>模型版本</th>
          <th>状态</th>
          <th>完整性</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in batches" :key="item.batch.id" :data-batch-id="item.batch.id">
          <td>
            <button class="link" type="button" @click="openBatch(item.batch.id)">{{ item.batch.id }}</button>
          </td>
          <td>{{ item.batch.scope }}</td>
          <td class="cell-wrap">{{ item.batch.featureBasis.length }} 条特征依据</td>
          <td class="cell-wrap">{{ item.batch.datasetVersions }}</td>
          <td class="cell-wrap">
            {{ item.batch.entries.map((entry) => `${entry.modelId} v${entry.fromModelVersion}→v${entry.fromModelVersion + 1}`).join('、') }}
          </td>
          <td>
            <span :class="['badge', toneClass(item.verdict.tone)]">{{ item.verdict.statusLabel }}</span>
          </td>
          <td class="cell-wrap">
            <span v-if="item.verdict.reasons.length">{{ item.verdict.reasons.join('；') }}</span>
            <span v-else class="muted">条目全部成功且边界通过</span>
          </td>
          <td class="row-actions">
            <button
              class="link"
              type="button"
              :disabled="!item.verdict.publishable"
              @click="publish(item.batch.id)"
            >
              发布
            </button>
            <button
              class="link"
              type="button"
              :disabled="item.batch.status === '已发布'"
              @click="discard(item.batch.id)"
            >
              作废
            </button>
            <button class="link" type="button" @click="openBatch(item.batch.id)">明细</button>
            <button class="link" type="button" @click="exportBatch(item.batch.id)">导出</button>
          </td>
        </tr>
        <tr v-if="!batches.length">
          <td colspan="8" class="empty-state">暂无训练批次</td>
        </tr>
      </tbody>
    </table>

    <div v-if="activeDetail" class="batch-detail" data-batch-detail>
      <header class="panel-head">
        <div>
          <h4>{{ activeDetail.batch.id }} · {{ activeDetail.batch.status }}</h4>
          <p class="panel-desc">{{ activeDetail.batch.note }}</p>
        </div>
        <div class="panel-actions">
          <button class="btn ghost" type="button" @click="activeDetailId = ''">收起</button>
        </div>
      </header>
      <p class="muted">数据集版本：{{ activeDetail.batch.datasetVersions }}</p>
      <p class="muted">生成于 {{ activeDetail.batch.createdAt }} · 发布 {{ activeDetail.batch.publishedAt ?? '—' }} · 操作人 {{ activeDetail.batch.operator }}</p>
      <ul class="audit-list">
        <li v-for="line in activeDetail.verdict.audit" :key="line">{{ line }}</li>
      </ul>
      <table class="data-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>数据集版本</th>
            <th>模型版本</th>
            <th>特征模式</th>
            <th>特征依据</th>
            <th>预测值</th>
            <th>预测区间</th>
            <th>边界</th>
            <th>系数</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in detailRows" :key="row.modelId">
            <td>{{ row.modelId }} {{ row.modelName }}</td>
            <td>{{ row.dataset }} {{ row.datasetVersion }}</td>
            <td>{{ row.modelVersion }}</td>
            <td>{{ row.featureMode }}</td>
            <td class="cell-wrap">{{ row.featureBasis }}</td>
            <td>{{ row.predictedValue }}</td>
            <td>{{ row.interval }}</td>
            <td>{{ row.boundary }}</td>
            <td>{{ row.coefficient }}</td>
            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="activeDetail.verdict.reasons.length" class="error-text">
        {{ activeDetail.verdict.reasons.join('；') }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadCsv } from '@/api/download'
import {
  batchOptions,
  createTrainingBatch,
  discardBatch,
  diagnoseImpact,
  publishTrainingBatch,
  batchById,
} from '@/api/local-service'
import { batchCsv, batchDetailRows } from '@/data/forecast-rules'
import type { BatchDetailRow, BatchScope, BatchVerdict, TrainingBatch } from '@/data/forecast-types'

const props = defineProps<{ changeIds: string[]; operator: string; focusBatch?: string }>()
const emit = defineEmits<{ changed: []; 'focus-consumed': [] }>()

type BatchItem = { batch: TrainingBatch; verdict: BatchVerdict }

const scope = ref<BatchScope>('增量')
const note = ref('')
const failureModel = ref('')
const actionMessage = ref('')
const actionTone = ref<'ok' | 'warn'>('ok')
const batches = ref<BatchItem[]>([])
const activeDetailId = ref('')

const diagnostics = computed(() => diagnoseImpact(props.changeIds))
const incremental = computed(() => diagnostics.value.incremental)
const full = computed(() => diagnostics.value.full)
const conflict = computed(() =>
  props.changeIds.length > 0 && diagnostics.value.conflict.detected ? diagnostics.value.conflict : null,
)
const scopePlan = computed(() =>
  props.changeIds.length === 0 ? null : scope.value === '增量' ? incremental.value : full.value,
)
const failureCandidates = computed(() => scopePlan.value?.modelIds ?? [])

const activeDetail = computed<BatchItem | undefined>(() =>
  batches.value.find((item) => item.batch.id === activeDetailId.value),
)
const detailRows = computed<BatchDetailRow[]>(() =>
  activeDetail.value ? batchDetailRows(activeDetail.value.batch) : [],
)

function toneClass(tone: BatchVerdict['tone']): string {
  return { info: 'badge-muted', success: 'badge-ok', warning: 'badge-warn', danger: 'badge-danger' }[tone]
}

function notify(message: string, ok: boolean) {
  actionMessage.value = message
  actionTone.value = ok ? 'ok' : 'warn'
}

function refresh() {
  batches.value = batchOptions()
  emit('changed')
}

function submit() {
  const result = createTrainingBatch({
    changeIds: props.changeIds,
    scope: scope.value,
    note: note.value || `${scope.value}重训：${props.changeIds.join('、')}`,
    operator: props.operator,
    failureModelIds: failureModel.value ? [failureModel.value] : [],
  })
  notify(result.message, result.ok)
  refresh()
}

function publish(batchId: string) {
  const result = publishTrainingBatch(batchId)
  notify(result.message, result.ok)
  refresh()
}

function discard(batchId: string) {
  const result = discardBatch(batchId)
  notify(result.message, result.ok)
  refresh()
}

function openBatch(batchId: string) {
  activeDetailId.value = activeDetailId.value === batchId ? '' : batchId
}

function exportBatch(batchId: string) {
  const batch = batchById(batchId)
  if (!batch) {
    notify(`没有找到训练批次 ${batchId}`, false)
    return
  }
  const { filename, content } = batchCsv(batch)
  downloadCsv(filename, content)
  notify(`已导出 ${filename}，内容与页面明细一致`, true)
}

onMounted(() => {
  refresh()
  if (props.focusBatch) {
    activeDetailId.value = props.focusBatch
    emit('focus-consumed')
  }
})
</script>
