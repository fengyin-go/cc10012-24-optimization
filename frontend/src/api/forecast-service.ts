import { createForecastSeed } from '@/data/forecast-seed'
import {
  buildTrainingBatch,
  featureBasisText,
  modelFeatures,
  conflictOptions,
  evaluateBatch,
  latestResultsByModel,
  planScope,
  reportCsv,
  reportFileStamp,
  reportHasMixedVersions,
  reportPolicyOptions,
  buildReport,
  analyzeImpact,
} from '@/data/forecast-rules'
import type {
  BatchScope,
  ForecastModelView,
  ForecastReport,
  ForecastState,
  ReportPolicy,
  TrainingBatch,
} from '@/data/forecast-types'
import type { ActionResult } from '@/data/types'

/**
 * 趋势预测本地服务。
 *
 * 规则判断全部在 forecast-rules.ts；本文件只负责读写 localStorage 与状态流转。
 * 训练批次的生成、发布、作废与报告归档都从这里走，页面不做业务判断。
 */

const STORAGE_KEY = 'data-explore-studio:forecast'

function read(): ForecastState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createForecastSeed()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = createForecastSeed()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    const parsed = JSON.parse(raw) as ForecastState
    if (!parsed || parsed.schemaVersion !== 1) {
      const seed = createForecastSeed()
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
      return seed
    }
    return parsed
  } catch {
    const seed = createForecastSeed()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

function write(state: ForecastState): ForecastState {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
  return state
}

function nowText(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** 批次号按秒生成，同秒重复时追加序号，保证每份训练批次有唯一编号。 */
function nextBatchId(state: ForecastState): string {
  const base = `BATCH-${stamp()}`
  if (!state.batches.some((batch) => batch.id === base)) {
    return base
  }
  let index = 2
  while (state.batches.some((batch) => batch.id === `${base}-${index}`)) {
    index += 1
  }
  return `${base}-${index}`
}

function stamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function forecastState(): ForecastState {
  return read()
}

export function resetForecast(): void {
  write(createForecastSeed())
}

export function modelViews(state: ForecastState = read()): ForecastModelView[] {
  const impacts = analyzeImpact(state)
  return state.models.map((model) => {
    const impact = impacts.find((item) => item.modelId === model.id)
    const dataset = state.datasets.find((item) => item.id === model.datasetId)
    const batch = state.batches.find((item) => item.id === model.activeBatchId)
    const resolved = featureBasisText(state, model, model.trainedVersion)
    const basis = impact?.featureBasis ?? resolved.basis
    const features = modelFeatures(state, model, model.trainedVersion).map((field) => field.name)
    return {
      model,
      datasetName: dataset?.name ?? '—',
      datasetVersion: dataset?.version ?? 0,
      featureBasis: basis,
      features,
      activeBatchStatus: batch ? batch.status : model.activeBatchId ? '批次缺失' : '未发布',
      impactStatus: impact?.affected ? '待重训' : model.status,
    }
  })
}

export type CreateBatchInput = {
  changeIds: string[]
  scope: BatchScope
  note: string
  operator: string
  /** 演示「重训失败」用的故障注入：命中的模型按失败处理，保留上一份已生效模型。 */
  failureModelIds?: string[]
}

export type CreateBatchResult = {
  ok: boolean
  message: string
  batchId?: string
  dedupeHit?: boolean
}

export function diagnoseImpact(changeIds: string[]) {
  const state = read()
  return {
    impacts: analyzeImpact(state, changeIds),
    incremental: planScope(state, changeIds, '增量'),
    full: planScope(state, changeIds, '整批'),
    conflict: conflictOptions(state, changeIds),
  }
}

/** 生成训练批次：读取特征字段 → 形成批次 → 写入唯一一份。 */
export function createTrainingBatch(input: CreateBatchInput): CreateBatchResult {
  const state = read()
  if (input.changeIds.length === 0) {
    return { ok: false, message: '请先选择要参与判断的字段变更' }
  }
  const plan = planScope(state, input.changeIds, input.scope)
  if (plan.entries.length === 0) {
    return { ok: false, message: '本次变更没有需要重训的模型，未生成训练批次' }
  }
  const id = nextBatchId(state)
  const built = buildTrainingBatch(read(), {
    changeIds: input.changeIds,
    scope: input.scope,
    note: input.note,
    operator: input.operator,
    now: nowText(),
    id,
  })
  const batch = built.batch
  for (const modelId of input.failureModelIds ?? []) {
    const entry = batch.entries.find((item) => item.modelId === modelId)
    if (!entry) {
      continue
    }
    entry.status = '失败'
    entry.guard = '失败'
    entry.failureReason = '上游特征快照读取超时'
    entry.guardDetail = `训练失败：${entry.failureReason}，保留上一份已生效模型 v${entry.fromModelVersion}`
    entry.featureBasis = `${entry.featureBasis}（训练中止：${entry.failureReason}）`
  }
  if (batch.entries.some((entry) => entry.status === '失败')) {
    batch.status = '失败'
    batch.failureReason = batch.entries
      .filter((entry) => entry.status === '失败')
      .map((entry) => `${entry.modelId} ${entry.failureReason}`)
      .join('；')
  }
  if (built.dedupeHit) {
    const existing = state.batches.find((item) => item.dedupeKey === batch.dedupeKey)
    return {
      ok: true,
      message: `同一判断依据已有训练批次 ${existing?.id}，重复提交未新增批次`,
      batchId: existing?.id,
      dedupeHit: true,
    }
  }
  // 并发约束：同一时间只允许一个未发布的完整批次，避免两个批次各自发布后报告混用模型版本。
  const inFlight = state.batches.find(
    (item) => item.status === '待发布' || item.status === '训练中',
  )
  if (inFlight) {
    return {
      ok: false,
      message: `训练批次 ${inFlight.id} 仍处于「${inFlight.status}」；并发重训只允许一个完整批次，请先发布或作废该批次`,
    }
  }
  // 待发布批次占用唯一的训练通道；发布或作废后释放，保证同一时刻只有一个完整批次在途。
  const next: ForecastState = {
    ...state,
    batches: [...state.batches, batch],
    runningBatchId: batch.status === '待发布' ? batch.id : null,
  }
  write(next)
  const failureCount = batch.entries.filter((entry) => entry.status === '失败').length
  const message =
    batch.status === '失败'
      ? failureCount === batch.entries.length
        ? `训练批次 ${batch.id} 已记录，全部 ${failureCount} 个模型训练失败，继续使用上一份已生效模型，批次不可发布`
        : `训练批次 ${batch.id} 已生成，${failureCount} 个模型训练失败；失败模型保留上一份已生效版本，批次不可发布`
      : `训练批次 ${batch.id} 已生成，读取 ${batch.featureBasis.length} 条特征依据，等待发布`
  return { ok: true, message, batchId: batch.id }
}

export function publishTrainingBatch(batchId: string): ActionResult {
  const state = read()
  if (state.runningBatchId && state.runningBatchId !== batchId) {
    return { ok: false, message: `批次 ${state.runningBatchId} 正在发布，不能并发发布第二个批次` }
  }
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到训练批次 ${batchId}` }
  }
  const otherInFlight = state.batches.find(
    (item) => item.id !== batch.id && (item.status === '待发布' || item.status === '训练中'),
  )
  if (otherInFlight) {
    return {
      ok: false,
      message: `训练批次 ${otherInFlight.id} 也在等待发布；同一时间只能发布一个完整批次，请先处理该批次`,
    }
  }
  const verdict = evaluateBatch(state, batch)
  if (!verdict.publishable) {
    return { ok: false, message: `批次 ${batchId} 不可发布：${verdict.reasons.join('；')}` }
  }
  if (batchHasVersionConflict(batch)) {
    return { ok: false, message: `批次 ${batchId} 内混用了多个数据集版本，禁止发布` }
  }
  const publishedAt = nowText()
  const successful = batch.entries.filter((entry) => entry.status === '成功')
  const byModel = new Map(successful.map((entry) => [entry.modelId, entry]))
  const changedDatasets = new Set(batch.changeIds.map((changeId) => state.changes.find((change) => change.id === changeId)?.datasetId))
  const nextModels = state.models.map((model) => {
    const entry = byModel.get(model.id)
    if (!entry) {
      return model
    }
    const targetChange = state.changes
      .filter((change) => change.datasetId === model.datasetId)
      .sort((a, b) => a.toVersion - b.toVersion)
      .find((change) => change.toVersion === entry.toVersion)
    const toFields = targetChange?.toFields ?? []
    const resolvedFields =
      toFields.length > 0
        ? toFields
        : (state.datasets.find((dataset) => dataset.id === model.datasetId)?.fields ?? [])
    const dependencies = model.dependencies.map((dependency) => {
      const field = resolvedFields.find((item) => item.name === dependency.field)
      return field
        ? {
            ...dependency,
            resolvedType: field.type,
            resolvedVersion: entry.toVersion,
          }
        : dependency
    })
    return {
      ...model,
      status: '已生效' as const,
      modelVersion: model.modelVersion + 1,
      trainedVersion: entry.toVersion,
      activeBatchId: batch.id,
      coefficient: entry.coefficient,
      featureSnapshot: entry.features,
      baselineValue: entry.predictedValue,
      lastTrainedAt: publishedAt,
      pendingReason: undefined,
      dependencies,
    }
  })
  const archivedResults = successful.map((entry, index) => ({
    id: `RES-${batch.id}-${String(index + 1).padStart(2, '0')}`,
    batchId: batch.id,
    modelId: entry.modelId,
    modelName: entry.modelName,
    datasetId: entry.datasetId,
    datasetVersion: entry.toVersion,
    modelVersion: entry.fromModelVersion + 1,
    features: entry.features,
    coefficient: entry.coefficient,
    horizon: state.models.find((model) => model.id === entry.modelId)?.horizon ?? '7 天',
    value: entry.predictedValue,
    lower: entry.lowerBound,
    upper: entry.upperBound,
    boundary: entry.guard === '通过' ? ('在界内' as const) : ('越界' as const),
    archivedAt: publishedAt,
  }))
  const nextChanges = state.changes.map((change) =>
    batch.changeIds.includes(change.id)
      ? { ...change, status: '已归档' as const, batchIds: [...change.batchIds, batch.id] }
      : change,
  )
  const superseded = state.batches.map((item) => {
    if (item.id === batch.id || item.status !== '待发布') {
      return item
    }
    const overlap = item.entries.some((entry) => byModel.has(entry.modelId))
    return overlap
      ? {
          ...item,
          status: '已作废' as const,
          failureReason: `已被完整批次 ${batch.id} 取代，避免同一模型混用两个模型版本`,
        }
      : item
  })
  const next: ForecastState = {
    ...state,
    models: nextModels,
    changes: nextChanges,
    batches: superseded.map((item) =>
      item.id === batch.id
        ? { ...item, status: '已发布' as const, publishedAt }
        : item,
    ),
    results: [...state.results, ...archivedResults],
    activeBatchId: batch.id,
    runningBatchId: null,
  }
  write(next)
  return {
    ok: true,
    message: `训练批次 ${batch.id} 已发布：${successful.length} 个模型版本与数据集版本一起更新，预测结果已归档`,
  }
}

/** 一个批次里同一模型只能出现一次，且同一数据集只能落在同一版本。 */
function batchHasVersionConflict(batch: TrainingBatch): boolean {
  const modelIds = new Set(batch.entries.map((entry) => entry.modelId))
  if (modelIds.size !== batch.entries.length) {
    return true
  }
  const versionByDataset = new Map<string, number>()
  for (const entry of batch.entries) {
    const seen = versionByDataset.get(entry.datasetId)
    if (seen !== undefined && seen !== entry.toVersion) {
      return true
    }
    versionByDataset.set(entry.datasetId, entry.toVersion)
  }
  return false
}

export function discardBatch(batchId: string): ActionResult {
  const state = read()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到训练批次 ${batchId}` }
  }
  if (batch.status === '已发布') {
    return { ok: false, message: '已发布批次留档，不能作废；如需回退请重新训练后发布新批次' }
  }
  write({
    ...state,
    batches: state.batches.map((item) =>
      item.id === batchId
        ? { ...item, status: '已作废', failureReason: item.failureReason ?? '人工作废' }
        : item,
    ),
    runningBatchId: state.runningBatchId === batchId ? null : state.runningBatchId,
  })
  return { ok: true, message: `训练批次 ${batchId} 已作废，已生效模型保持不变` }
}

export function batchOptions() {
  const state = read()
  return state.batches
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((batch) => ({ batch, verdict: evaluateBatch(state, batch) }))
}

export function batchById(batchId: string): TrainingBatch | undefined {
  return read().batches.find((batch) => batch.id === batchId)
}

export function policyOptions() {
  return reportPolicyOptions(read())
}

export type GenerateReportInput = {
  policy: ReportPolicy
  title: string
}

export function generateReport(input: GenerateReportInput): {
  ok: boolean
  message: string
  reportId?: string
} {
  const state = read()
  const title = input.title.trim() || '经营预测报告'
  let built: ReturnType<typeof buildReport>
  try {
    built = buildReport(state, input.policy, title)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '报告口径校验失败' }
  }
  if (built.rows.length === 0) {
    return { ok: false, message: '当前没有可用于报告的预测结果' }
  }
  const id = `REP-${stamp()}`
  const models = built.rows.map((row) => {
    const model = state.models.find((item) => item.id === row.modelId)
    return {
      modelId: row.modelId,
      modelName: row.modelName,
      modelVersion: row.modelVersion,
      datasetId: model?.datasetId ?? '—',
      datasetVersion: row.datasetVersion,
      featureMode: model?.featureMode ?? '白名单',
      features: row.features,
      coefficient: row.coefficient,
      status: model?.status ?? '已生效',
    }
  })
  const results = built.rows.map((row) => ({
    modelId: row.modelId,
    modelVersion: row.modelVersion,
    batchId: row.batchId,
    value: row.value,
    lower: row.lower,
    upper: row.upper,
    boundary: row.boundary,
  }))
  const files = [...new Set(built.batchGroups)]
    .map((batchId) => state.batches.find((batch) => batch.id === batchId)?.artifactFile)
    .filter((file): file is string => Boolean(file))
  const report: ForecastReport = {
    id,
    title,
    status: '已归档',
    policy: input.policy,
    batchId: built.batchGroups.length === 1 ? built.batchGroups[0] : null,
    batchGroups: built.batchGroups,
    rows: built.rows,
    models,
    results,
    warnings: built.warnings,
    tradeoff: built.tradeoff,
    sourceBatchFiles: files,
    artifactFile: reportFileStamp(id),
    createdAt: nowText(),
    archivedAt: nowText(),
  }
  write({ ...state, reports: [report, ...state.reports] })
  return {
    ok: true,
    message: `报告 ${id} 已按「${input.policy}」口径归档，包含 ${built.rows.length} 条预测结果与 ${models.length} 个模型版本`,
    reportId: id,
  }
}

export function reportById(reportId: string): ForecastReport | undefined {
  return read().reports.find((report) => report.id === reportId)
}

export function reportCsvContent(report: ForecastReport): { filename: string; content: string } {
  const { content } = reportCsv(report)
  return { filename: report.artifactFile, content }
}

export function reportIsMixed(report: ForecastReport): boolean {
  return reportHasMixedVersions(report)
}

