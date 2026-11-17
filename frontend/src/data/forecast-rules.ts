import { csvDocument } from './csv'
import type {
  BatchDetailRow,
  BatchModelEntry,
  BatchScope,
  BatchVerdict,
  ChangeLog,
  ConflictOption,
  DatasetEntity,
  FeatureChange,
  FeatureField,
  FeatureMode,
  ForecastModel,
  ForecastReport,
  ForecastResult,
  ForecastState,
  ModelImpact,
  ModelStatus,
  ReportPolicy,
  ReportPolicyOption,
  ReportRow,
  ScopeOption,
  TrainingBatch,
} from './forecast-types'

/**
 * 趋势预测的共享判断规则。
 *
 * 页面展示、训练批次生成、发布校验、报告口径与导出全部调用这里，
 * 保证「影响判断 / 范围 / 批次完整性 / 报告版本」只有一份实现。
 */

export const DRIFT_THRESHOLD_PCT = 30

export function roundValue(value: number, reference: number): number {
  return reference < 100 ? Math.round(value * 100) / 100 : Math.round(value)
}

export function featureFields(fields: FeatureField[]): FeatureField[] {
  return fields.filter((field) => field.role !== 'id' && field.role !== 'date')
}

export function datasetById(state: ForecastState, datasetId: string): DatasetEntity | undefined {
  return state.datasets.find((dataset) => dataset.id === datasetId)
}

/** 取某个数据集历史版本的特征字段；先查变更日志快照，再回退到当前版本。 */
export function fieldsAtVersion(state: ForecastState, datasetId: string, version: number): FeatureField[] {
  const dataset = datasetById(state, datasetId)
  if (!dataset) {
    return []
  }
  if (dataset.version === version) {
    return dataset.fields
  }
  const logs = state.changes
    .filter((change) => change.datasetId === datasetId)
    .sort((a, b) => b.toVersion - a.toVersion)
  for (const log of logs) {
    if (log.toVersion === version) {
      return log.toFields
    }
    if (log.fromVersion === version) {
      return log.fromFields
    }
  }
  return dataset.fields
}

export function pendingChanges(state: ForecastState, changeIds?: string[]): ChangeLog[] {
  const selected = changeIds ? new Set(changeIds) : null
  return state.changes.filter(
    (change) => change.status === '待处理' && (!selected || selected.has(change.id)),
  )
}

/** 模型在指定数据集版本上实际读取的特征。 */
export function modelFeatures(
  state: ForecastState,
  model: ForecastModel,
  version: number,
): FeatureField[] {
  const fields = featureFields(fieldsAtVersion(state, model.datasetId, version))
  if (model.featureMode === '全量') {
    return fields
  }
  const recorded = featureSnapshotFor(model, version)
  if (recorded.length > 0) {
    // 白名单模型以存档的特征快照为准：数据集新增字段不会悄悄扩大训练特征。
    return recorded
      .map((name) => fields.find((field) => field.name === name))
      .filter((field): field is FeatureField => Boolean(field))
  }
  const declared = new Set(model.dependencies.map((dependency) => dependency.field))
  return fields.filter((field) => declared.has(field.name))
}

/** 取模型在某个版本上留档的特征；快照对应当前训练版本时直接复用。 */
function featureSnapshotFor(model: ForecastModel, version: number): string[] {
  if (version !== model.trainedVersion) {
    return []
  }
  if (model.featureSnapshot.length > 0) {
    return model.featureSnapshot
  }
  return model.dependencies.map((dependency) => dependency.field)
}

export function featureBasisText(
  state: ForecastState,
  model: ForecastModel,
  version: number,
  mode: FeatureMode = model.featureMode,
  fields?: FeatureField[],
): { features: string[]; basis: string } {
  const resolved =
    fields ??
    (mode === '全量'
      ? featureFields(fieldsAtVersion(state, model.datasetId, version))
      : modelFeatures(state, model, version))
  const features = resolved.map((field) => field.name)
  const detail = resolved.map((field) => `${field.name}(${field.type})`).join('、')
  return {
    features,
    basis: `${model.datasetId} v${version} ${mode}：${detail}`,
  }
}

function changeLabel(change: FeatureChange): string {
  switch (change.kind) {
    case '新增':
      return `新增 ${change.field}(${change.after})`
    case '移除':
      return `移除 ${change.field}(${change.before})`
    case '类型变更':
      return `${change.field} 类型 ${change.before}→${change.after}`
    case '分布漂移':
      return `${change.field} 分布漂移 ${change.driftPct ?? 0}%（${change.before}→${change.after}）`
  }
}

function severityRank(severity: ModelImpact['severity']): number {
  return { none: 0, additive: 1, required: 2, blocking: 3 }[severity]
}

/**
 * 影响判断：逐个模型比较「已训练版本的特征依据」与待处理变更后的字段。
 * 未命中的模型也保留核对依据，避免整批重训掩盖判断边界。
 */
export function analyzeImpact(state: ForecastState, changeIds?: string[]): ModelImpact[] {
  const changes = pendingChanges(state, changeIds)
  return state.models.map((model) => {
    const version = model.trainedVersion
    const previousFields = featureFields(fieldsAtVersion(state, model.datasetId, version))
    const used = new Set(modelFeatures(state, model, version).map((field) => field.name))
    const reasons: string[] = []
    const evidence: string[] = []
    let severity: ModelImpact['severity'] = 'none'

    for (const change of changes) {
      if (change.datasetId !== model.datasetId) {
        evidence.push(`${change.id} 属于 ${change.datasetId}，与本模型数据集不同，不受影响`)
        continue
      }
      if (version >= change.toVersion) {
        evidence.push(`${change.id} 已包含在当前训练版本 v${version}，无需重训`)
        continue
      }
      // 字段基线用「该变更的上一个版本」而不是模型训练版本：
      // 多版本累积时也能准确识别每个字段的变化来源。
      const nextFields = featureFields(change.toFields)
      const baseFields = featureFields(change.fromFields)
      const nextMap = new Map(nextFields.map((field) => [field.name, field]))
      const previousMap = new Map(baseFields.map((field) => [field.name, field]))
      let touched = false

      const changeByField = new Map(change.changes.map((item) => [item.field, item]))

      for (const field of baseFields) {
        const meta = changeByField.get(field.name)
        const next = nextMap.get(field.name)
        if (!next) {
          if (used.has(field.name)) {
            severity = 'blocking'
            reasons.push(`${change.id} 移除了依赖字段 ${field.name}，需人工确认替代口径`)
            touched = true
          } else {
            evidence.push(`${field.name} 被移除，但本模型未读取该字段`)
          }
          continue
        }
        if (next.type !== field.type) {
          if (used.has(field.name)) {
            severity = severity === 'blocking' ? severity : 'required'
            reasons.push(`${change.id} 把依赖字段 ${field.name} 的类型由 ${field.type} 改为 ${next.type}`)
            touched = true
          } else {
            evidence.push(`${field.name} 类型变化，但本模型未读取该字段`)
          }
          continue
        }
        if (meta?.kind === '分布漂移' && (meta.driftPct ?? 0) > DRIFT_THRESHOLD_PCT) {
          if (used.has(field.name)) {
            severity = severity === 'blocking' ? severity : severity === 'required' ? severity : 'additive'
            reasons.push(
              `${change.id} 的 ${field.name} 均值漂移 ${meta.driftPct}%，超过 ${DRIFT_THRESHOLD_PCT}% 阈值`,
            )
            touched = true
          } else {
            evidence.push(`${field.name} 分布漂移，但本模型未读取该字段`)
          }
        }
      }

      for (const field of nextFields) {
        if (previousMap.has(field.name)) {
          continue
        }
        if (model.featureMode === '全量') {
          severity = severity === 'blocking' || severity === 'required' ? severity : 'additive'
          reasons.push(`${change.id} 新增 ${field.name}(${field.type})，全量模式会把它纳入训练特征`)
          touched = true
        } else if (used.has(field.name)) {
          severity = severity === 'blocking' || severity === 'required' ? severity : 'additive'
          reasons.push(`${change.id} 新增白名单声明的 ${field.name}(${field.type})`)
          touched = true
        } else {
          evidence.push(`${field.name} 为新增字段，白名单模式未声明，不改变训练特征`)
        }
      }

      if (!touched) {
        evidence.push(`${change.id} 的字段变化均未命中本模型读取的特征`)
      }
    }

    if (reasons.length === 0) {
      reasons.push(
        changes.length === 0
          ? '当前没有待处理的字段变更'
          : `${model.featureMode}模式读取的特征未发生变化，继续使用批次 ${model.activeBatchId ?? '—'}`,
      )
    }

    const affected = severity !== 'none'
    const afterStatus: ModelStatus = affected ? '待重训' : model.status
    return {
      modelId: model.id,
      modelName: model.name,
      datasetId: model.datasetId,
      affected,
      severity,
      reasons,
      evidence: evidence.join('；') || '依赖字段与数据集版本一致',
      featureBasis: featureBasisText(state, model, version).basis,
      activeBatchId: model.activeBatchId,
      modelVersion: model.modelVersion,
      beforeStatus: model.status,
      afterStatus,
    }
  })
}

function predictionFactor(
  model: ForecastModel,
  changes: ChangeLog[],
  used: Set<string>,
): number {
  let factor = 1
  for (const change of changes) {
    if (change.datasetId !== model.datasetId) {
      continue
    }
    for (const item of change.changes) {
      if (!used.has(item.field)) {
        continue
      }
      if (item.kind === '分布漂移') {
        factor += (Math.min(item.driftPct ?? 0, 100) / 100) * 0.04
      }
      if (item.kind === '新增') {
        factor += 0.015
      }
    }
    const added = featureFields(change.toFields).filter(
      (field) =>
        model.featureMode === '全量' &&
        !featureFields(change.fromFields).some((previous) => previous.name === field.name),
    )
    factor += Math.min(added.length, 2) * 0.005
  }
  return factor
}

function coefficientAfter(model: ForecastModel, factor: number): string {
  const match = model.coefficient.match(/β=([0-9.]+)/)
  const beta = match ? Number(match[1]) : 1
  return `β=${(beta * (1 + (factor - 1) / 2)).toFixed(2)}`
}

function buildEntry(
  state: ForecastState,
  model: ForecastModel,
  changes: ChangeLog[],
  options: { forceFailure?: string } = {},
): BatchModelEntry {
  // 重训一律读取数据集当前版本：同一批次里同一数据集只能落在一个版本上。
  const targetVersion = datasetById(state, model.datasetId)?.version ?? model.trainedVersion
  const fields = modelFeatures(state, model, targetVersion)
  const { features, basis } = featureBasisText(
    state,
    model,
    targetVersion,
    model.featureMode,
    fields,
  )
  const used = new Set(features)
  const changedTypes = changes
    .filter((change) => change.datasetId === model.datasetId)
    .flatMap((change) => change.changes)
    .filter((item) => item.kind === '类型变更' && used.has(item.field))
    .map((item) => `${item.field} ${item.before}→${item.after}`)
  const typeNote = changedTypes.length > 0 ? `已完成类型适配（${changedTypes.join('、')}）；` : ''
  const factor = predictionFactor(model, changes, used)
  const predicted = roundValue(model.baselineValue * factor, model.baselineValue)
  const spread = Math.max(predicted * 0.08, model.baselineValue < 100 ? 0.05 : 1)
  const lower = roundValue(predicted - spread, model.baselineValue)
  const upper = roundValue(predicted + spread, model.baselineValue)
  const [low, high] = model.targetRange
  const inRange = lower >= low && upper <= high
  const failure = options.forceFailure
  return {
    modelId: model.id,
    modelName: model.name,
    algorithm: model.algorithm,
    featureMode: model.featureMode,
    datasetId: model.datasetId,
    fromModelVersion: model.modelVersion,
    fromVersion: model.trainedVersion,
    toVersion: targetVersion,
    fromBatchId: model.activeBatchId,
    features,
    featureBasis: options.forceFailure
      ? `${basis}（训练中止：${options.forceFailure}）`
      : basis,
    status: failure ? '失败' : '成功',
    guard: failure ? '失败' : inRange ? '通过' : '失败',
    guardDetail: failure
      ? `训练失败：${failure}，保留上一份已生效模型 v${model.modelVersion}`
      : inRange
        ? `${typeNote}预测值 ${predicted} 与区间 [${lower}, ${upper}] 落在目标区间 [${low}, ${high}]`
        : `${typeNote}预测区间 [${lower}, ${upper}] 越过目标区间 [${low}, ${high}]，不允许发布`,
    coefficient: failure ? model.coefficient : coefficientAfter(model, factor),
    predictedValue: predicted,
    lowerBound: lower,
    upperBound: upper,
    failureReason: failure,
  }
}

function blockingFailure(
  state: ForecastState,
  model: ForecastModel,
  version: number,
): string | null {
  const fields = new Map(
    featureFields(fieldsAtVersion(state, model.datasetId, version)).map((field) => [field.name, field]),
  )
  const missing = modelFeatures(state, model, model.trainedVersion)
    .filter((field) => !fields.has(field.name))
    .map((field) => field.name)
  if (missing.length > 0) {
    return `依赖字段 ${missing.join('、')} 在 v${version} 已不存在`
  }
  return null
}

/** 训练范围比较：增量只看受影响模型，整批覆盖全部已生效模型。两者都必须守住预测边界。 */
export function planScope(
  state: ForecastState,
  changeIds: string[],
  scope: BatchScope,
): ScopeOption {
  const impacts = analyzeImpact(state, changeIds)
  const affected = impacts.filter((impact) => impact.affected)
  const models = state.models.filter((model) => model.status !== '已失效')
  const targeted =
    scope === '增量'
      ? models.filter((model) => affected.some((impact) => impact.modelId === model.id))
      : models
  const changes = pendingChanges(state, changeIds)
  const entries = targeted.map((model) => {
    const version = datasetById(state, model.datasetId)?.version ?? model.trainedVersion
    const failure =
      model.status === '已失效' ? '模型已失效' : blockingFailure(state, model, version)
    return buildEntry(state, model, changes, { forceFailure: failure ?? undefined })
  })
  const boundaryPassed = entries.every((entry) => entry.status === '成功' && entry.guard === '通过')
  const failed = entries.filter((entry) => entry.status === '失败')
  const outOfRange = entries.filter((entry) => entry.status === '成功' && entry.guard === '失败')
  const boundaryNote = boundaryPassed
    ? `${entries.length} 个模型预测区间均在目标范围内`
    : [
        ...failed.map((entry) => `${entry.modelId} 训练失败`),
        ...outOfRange.map((entry) => `${entry.modelId} 预测越界`),
      ].join('；')
  const uniqueDatasets = [...new Set(entries.map((entry) => entry.datasetId))]
  return {
    scope,
    modelIds: targeted.map((model) => model.id),
    affectedCount: affected.length,
    totalCount: models.length,
    estimatedMinutes: targeted.length * (scope === '增量' ? 4 : 6),
    coverage:
      scope === '增量'
        ? `覆盖受影响模型 ${targeted.length}/${models.length}，未受影响模型继续使用原批次`
        : `覆盖全部模型 ${targeted.length}/${models.length}`,
    consistency:
      scope === '增量'
        ? '新批次只包含受影响模型，报告中需按批次分段标注'
        : '整批共用同一数据集版本与批次号，报告可单批次输出',
    boundary: boundaryPassed ? '通过' : '不通过',
    boundaryNote: `${boundaryNote}；数据集 ${uniqueDatasets.join('、') || '—'}`,
    entries,
  }
}

/** 口径冲突：受影响模型只是全部模型的一部分时，增量与整批的覆盖面/一致性/成本互相牵制。 */
export function conflictOptions(state: ForecastState, changeIds: string[]): {
  detected: boolean
  title: string
  options: ConflictOption[]
  chosen: string
  rationale: string
} {
  const incremental = planScope(state, changeIds, '增量')
  const full = planScope(state, changeIds, '整批')
  const detected = incremental.affectedCount > 0 && incremental.affectedCount < incremental.totalCount
  const options: ConflictOption[] = [
    {
      label: '仅增量重训受影响模型',
      coverage: incremental.coverage,
      consistency: incremental.consistency,
      cost: `预计 ${incremental.estimatedMinutes} 分钟，边界${incremental.boundary}`,
    },
    {
      label: '整批重训全部模型',
      coverage: full.coverage,
      consistency: full.consistency,
      cost: `预计 ${full.estimatedMinutes} 分钟，边界${full.boundary}`,
    },
  ]
  const incrementalPublishable = incremental.boundary === '通过'
  const fullPublishable = full.boundary === '通过'
  let chosen = ''
  let rationale = ''
  if (detected) {
    if (incrementalPublishable) {
      chosen = '仅增量重训受影响模型'
      rationale =
        '增量范围守住预测边界且只改动受影响模型，成本更低；未受影响模型继续使用已生效批次，报告需按批次分段标注，避免在同一预测里混用旧特征和新系数。'
    } else if (fullPublishable) {
      chosen = '整批重训全部模型'
      rationale =
        '增量范围内存在训练失败或越界，无法形成完整批次；整批能守住边界并统一口径，代价是重训全部模型。'
    } else {
      chosen = '两者均不发布'
      rationale =
        '增量与整批都无法守住预测边界，保留上一份已生效批次，先修正失败模型的字段类型或依赖口径后再提交。'
    }
  } else if (incremental.affectedCount > 0) {
    chosen = '整批重训全部模型'
    rationale = '本次变更影响全部模型，增量与整批范围一致，直接整批输出统一口径。'
  } else {
    chosen = '不生成训练批次'
    rationale = '没有模型受本次变更影响，继续使用已生效批次。'
  }
  return {
    detected,
    title: detected
      ? '增量与整批口径冲突：覆盖面与版本一致性不可兼得'
      : '口径一致：本次变更的增量范围可直接输出',
    options,
    chosen,
    rationale,
  }
}

export function dedupeKeyFor(
  state: ForecastState,
  changeIds: string[],
  scope: BatchScope,
  entries: BatchModelEntry[],
): string {
  const versionMap = [...new Set(entries.map((entry) => entry.datasetId))]
    .sort()
    .map((datasetId) => `${datasetId}@${datasetById(state, datasetId)?.version ?? 0}`)
    .join(',')
  return `${scope}|${[...changeIds].sort().join(',')}|${entries
    .map((entry) => entry.modelId)
    .sort()
    .join(',')}|${versionMap}`
}

function batchStatusLabel(batch: TrainingBatch): BatchVerdict['statusLabel'] {
  switch (batch.status) {
    case '训练中':
      return '训练中'
    case '待发布':
      return '待发布'
    case '已发布':
      return '已发布'
    case '失败':
      return '失败'
    case '已作废':
      return '已作废'
  }
}

/** 批次完整性判断：页面、批次详情、发布与导出共用这一份判断。 */
export function evaluateBatch(state: ForecastState, batch: TrainingBatch): BatchVerdict {
  const reasons: string[] = []
  const audit: string[] = []
  const entries = batch.entries
  const complete = entries.length > 0 && entries.every((entry) => entry.status === '成功')
  const guardPassed = complete && entries.every((entry) => entry.guard === '通过')
  // 版本漂移只在批次尚未落地时检查；已发布批次是历史留档，不再拿当前版本反推。
  const live = batch.status === '待发布' || batch.status === '训练中'
  const datasetDrift = live
    ? Object.entries(batch.datasetVersionMap).filter(([datasetId, version]) => {
        const dataset = datasetById(state, datasetId)
        return !dataset || dataset.version !== version
      })
    : []
  const modelDrift = live
    ? entries.filter((entry) => {
        const model = state.models.find((item) => item.id === entry.modelId)
        return (
          !model ||
          model.modelVersion !== entry.fromModelVersion ||
          model.activeBatchId !== entry.fromBatchId
        )
      })
    : []
  const failedEntries = entries.filter((entry) => entry.status === '失败')
  const outOfRange = entries.filter((entry) => entry.status === '成功' && entry.guard === '失败')

  if (entries.length === 0) {
    reasons.push('批次没有可训练的模型')
  }
  for (const entry of failedEntries) {
    reasons.push(`${entry.modelId} 训练失败：${entry.failureReason ?? '未登记原因'}`)
  }
  for (const entry of outOfRange) {
    reasons.push(`${entry.modelId} 预测越界：${entry.guardDetail}`)
  }
  if (datasetDrift.length > 0) {
    reasons.push(
      `数据集版本已推进：${datasetDrift
        .map(([datasetId, version]) => `${datasetId} 批次基于 v${version}`)
        .join('、')}，需重新训练`,
    )
  }
  if (modelDrift.length > 0) {
    reasons.push(
      `模型已被其他批次更新：${modelDrift.map((entry) => entry.modelId).join('、')}，当前批次会混用模型版本`,
    )
  }
  if (batch.status === '训练中') {
    reasons.push('训练尚未完成')
  }
  if (batch.status === '已发布' || batch.status === '已作废') {
    reasons.push(`批次状态为「${batch.status}」，不可再次发布`)
  }

  const publishable =
    reasons.length === 0 && batch.status === '待发布' && complete && guardPassed
  const statusLabel = publishable ? '可发布' : batchStatusLabel(batch)
  const tone: BatchVerdict['tone'] =
    batch.status === '已发布'
      ? 'success'
      : batch.status === '失败' || failedEntries.length > 0 || outOfRange.length > 0
        ? 'danger'
        : batch.status === '待发布'
          ? guardPassed
            ? 'success'
            : 'warning'
          : 'info'

  audit.push(`特征依据：${batch.featureBasis.length} 条，逐条对应模型读取的特征字段`)
  audit.push(`数据集版本：${batch.datasetVersions}`)
  audit.push(
    `模型版本：${entries.map((entry) => `${entry.modelId} v${entry.fromModelVersion}→v${entry.fromModelVersion + 1}`).join('、') || '—'}`,
  )
  audit.push(`批次文件：${batch.artifactFile}`)
  if (batch.conflict) {
    audit.push(`口径取舍：${batch.conflict.chosen} —— ${batch.conflict.rationale}`)
  }
  return { statusLabel, tone, publishable, complete, reasons, audit }
}

export function batchDetailRows(batch: TrainingBatch): BatchDetailRow[] {
  return batch.entries.map((entry) => ({
    modelId: entry.modelId,
    modelName: entry.modelName,
    dataset: entry.datasetId,
    datasetVersion: `v${entry.fromVersion}→v${entry.toVersion}`,
    modelVersion: `v${entry.fromModelVersion}→v${entry.fromModelVersion + 1}`,
    featureMode: entry.featureMode,
    featureBasis: entry.featureBasis,
    features: entry.features.join('、'),
    predictedValue: String(entry.predictedValue),
    interval: `[${entry.lowerBound}, ${entry.upperBound}]`,
    boundary: entry.guard,
    coefficient: entry.coefficient,
    status: entry.status,
  }))
}

const BATCH_DETAIL_HEADER = [
  '模型编号',
  '模型名称',
  '数据集',
  '数据集版本',
  '模型版本',
  '特征模式',
  '特征依据',
  '读取特征',
  '预测值',
  '预测区间',
  '边界校验',
  '系数',
  '训练状态',
]

export function batchCsv(batch: TrainingBatch): { filename: string; content: string } {
  const rows = batchDetailRows(batch).map((row) => [
    row.modelId,
    row.modelName,
    row.dataset,
    row.datasetVersion,
    row.modelVersion,
    row.featureMode,
    row.featureBasis,
    row.features,
    row.predictedValue,
    row.interval,
    row.boundary,
    row.coefficient,
    row.status,
  ])
  return {
    filename: batch.artifactFile,
    content: csvDocument(BATCH_DETAIL_HEADER, rows),
  }
}

export function buildTrainingBatch(
  state: ForecastState,
  options: {
    changeIds: string[]
    scope: BatchScope
    note: string
    operator: string
    now: string
    id: string
  },
): { batch: TrainingBatch; dedupeHit: boolean; conflict: ReturnType<typeof conflictOptions> } {
  const selected = pendingChanges(state, options.changeIds)
  const plan = planScope(state, options.changeIds, options.scope)
  const conflict = conflictOptions(state, options.changeIds)
  const entries = plan.entries
  const versions = [...new Set(entries.map((entry) => entry.datasetId))]
  const datasetVersionMap: Record<string, number> = {}
  for (const datasetId of versions) {
    datasetVersionMap[datasetId] = datasetById(state, datasetId)?.version ?? 0
  }
  const failed = entries.some((entry) => entry.status === '失败')
  const guardFailed = entries.some((entry) => entry.guard === '失败')
  const status = entries.length === 0 || failed || guardFailed ? '失败' : '待发布'
  const datasetVersions = Object.entries(datasetVersionMap)
    .map(([datasetId, version]) => `${datasetId} v${version}`)
    .join(' · ')
  // 同版本文件：批次产物带自己的批次版本号，文件名、页面明细与导出内容一一对应。
  const artifactVersion = 1
  const batch: TrainingBatch = {
    id: options.id,
    status,
    scope: options.scope,
    changeIds: selected.map((change) => change.id),
    changeSummary: selected.flatMap((change) =>
      change.changes.map((item) => `${change.datasetId} v${change.fromVersion}→v${change.toVersion}：${changeLabel(item)}`),
    ),
    datasetVersions,
    datasetVersionMap,
    featureBasis: entries.map((entry) => `${entry.modelId}：${entry.featureBasis}`),
    entries,
    dedupeKey: dedupeKeyFor(state, options.changeIds, options.scope, entries),
    conflict: {
      detected: conflict.detected,
      title: conflict.title,
      options: conflict.options,
      chosen: conflict.chosen,
      rationale: conflict.rationale,
    },
    artifactFile: `forecast-batch-${options.id}-v${artifactVersion}.csv`,
    artifactVersion,
    createdAt: options.now,
    publishedAt: null,
    failureReason: failed
      ? entries.filter((entry) => entry.status === '失败').map((entry) => `${entry.modelId} ${entry.failureReason}`).join('；')
      : null,
    operator: options.operator,
    note: options.note,
  }
  const existing = state.batches.find(
    (item) => item.dedupeKey === batch.dedupeKey && item.status !== '失败' && item.status !== '已作废',
  )
  return { batch, dedupeHit: Boolean(existing), conflict }
}

export function latestResultsByModel(state: ForecastState): Map<string, ForecastResult> {
  const map = new Map<string, ForecastResult>()
  for (const result of state.results) {
    const current = map.get(result.modelId)
    if (!current || current.modelVersion <= result.modelVersion) {
      map.set(result.modelId, result)
    }
  }
  return map
}

/** 报告口径：单批次（版本一致、覆盖面可能不足）与分段（覆盖全量、逐行标注批次）。 */
export function reportPolicyOptions(state: ForecastState): ReportPolicyOption[] {
  const latest = latestResultsByModel(state)
  const totalModels = state.models.filter((model) => model.status !== '已失效').length
  const active = state.batches.find((batch) => batch.id === state.activeBatchId)
  const activeModelIds = active
    ? active.entries.filter((entry) => entry.status === '成功').map((entry) => entry.modelId)
    : []
  const activeResultModels = new Set(
    state.results.filter((result) => result.batchId === active?.id).map((result) => result.modelId),
  )
  const singleCoverage = activeModelIds.filter((modelId) => activeResultModels.has(modelId)).length
  const singleMissing = state.models
    .filter((model) => model.status !== '已失效' && !activeModelIds.includes(model.id))
    .map((model) => model.id)
  const groups = [...new Set([...latest.values()].map((result) => result.batchId))]
  const mixed = groups.length > 1
  return [
    {
      policy: '单批次',
      batchId: active?.id ?? null,
      batchGroups: active ? [active.id] : [],
      modelIds: activeModelIds,
      coverage: `覆盖 ${singleCoverage}/${totalModels} 个模型${singleMissing.length ? `，缺少 ${singleMissing.join('、')}` : ''}`,
      consistency: '同一批次号、同一数据集版本、同一系数口径',
      caveat: singleMissing.length
        ? '缺少未包含在该批次的模型，不能为了补齐而混入其他批次'
        : '全部模型来自同一批次，可直接对外',
      recommended: !mixed && singleMissing.length === 0,
      rationale:
        !mixed && singleMissing.length === 0
          ? '当前生效批次覆盖全部模型，单批次口径即可，避免混用两类模型版本。'
          : '单批次口径虽然版本一致，但覆盖面不足；补齐需要引入其他批次。',
      conflict: singleMissing.length > 0,
    },
    {
      policy: '分段',
      batchId: null,
      batchGroups: groups,
      modelIds: [...latest.keys()],
      coverage: `覆盖 ${latest.size}/${totalModels} 个模型，按 ${groups.length} 个批次分组`,
      consistency: mixed
        ? '每个分组内版本一致，分组之间批次不同，报告逐行标注批次与模型版本'
        : '所有结果来自同一批次，分段与单批次等价',
      caveat: mixed
        ? '分组之间不能互相比较系数；每一行的特征与系数来自同一批次，报告不混用旧特征和新系数'
        : '无需分段',
      recommended: mixed,
      rationale: mixed
        ? '在覆盖面优先的前提下选择分段口径，逐行标注批次与模型版本，避免同一预测混用旧特征和新系数。'
        : '所有模型已在同一批次，单批次更简洁。',
      conflict: false,
    },
  ]
}

function reportRow(
  result: ForecastResult,
  groupIndex: number,
  label: string,
): ReportRow {
  return {
    groupIndex,
    groupLabel: label,
    modelId: result.modelId,
    modelName: result.modelName,
    modelVersion: result.modelVersion,
    batchId: result.batchId,
    features: result.features,
    coefficient: result.coefficient,
    datasetVersion: result.datasetVersion,
    value: result.value,
    lower: result.lower,
    upper: result.upper,
    boundary: result.boundary,
  }
}

export function buildReport(
  state: ForecastState,
  policy: ReportPolicy,
  title: string,
): { rows: ReportRow[]; batchGroups: string[]; warnings: string[]; tradeoff: string } {
  if (policy === '单批次') {
    const batch = state.batches.find((item) => item.id === state.activeBatchId)
    if (!batch) {
      throw new Error('当前没有可用的生效批次，无法生成单批次报告')
    }
    const results = state.results.filter((result) => result.batchId === batch.id)
    const modelIds = results.map((result) => result.modelId)
    const missing = state.models
      .filter((model) => model.status !== '已失效' && !modelIds.includes(model.id))
      .map((model) => model.id)
    return {
      rows: results.map((result) => reportRow(result, 0, `${batch.id}（单批次口径）`)),
      batchGroups: [batch.id],
      warnings: missing.length
        ? [`单批次报告未包含模型 ${missing.join('、')}，不得从其他批次补齐`]
        : [],
      tradeoff: missing.length
        ? `单批次保证版本一致，但缺少 ${missing.length} 个模型；若必须全覆盖请改用分段口径。`
        : '全部模型来自同一批次，特征与系数口径一致，未混用其他模型版本。',
    }
  }
  const results = [...latestResultsByModel(state).values()]
  const groups = [...new Set(results.map((result) => result.batchId))]
  const rows = groups.flatMap((batchId, index) =>
    results
      .filter((result) => result.batchId === batchId)
      .map((result) =>
        reportRow(result, index, `${batchId}（分组 ${index + 1}，模型版本 v${result.modelVersion}）`),
      ),
  )
  const warnings =
    groups.length > 1
      ? [
          `报告包含 ${groups.length} 个训练批次，分组之间模型版本与系数不同，禁止跨组比较或合并计算`,
          '每一行的特征与系数均来自同一批次，未混用旧特征和新系数',
        ]
      : []
  return {
    rows,
    batchGroups: groups,
    warnings,
    tradeoff:
      groups.length > 1
        ? '分段口径覆盖全部模型，代价是报告内存在多个批次版本；通过逐行批次标注和分组提示避免口径误读。'
        : '所有结果来自同一批次，分段与单批次口径一致。',
  }
}

const REPORT_HEADER = [
  '分组',
  '批次号',
  '模型编号',
  '模型名称',
  '模型版本',
  '数据集版本',
  '读取特征',
  '系数',
  '预测值',
  '预测区间',
  '边界',
]

export function reportCsv(report: Pick<ForecastReport, 'rows'>): {
  content: string
} {
  const rows = report.rows.map((row) => [
    row.groupLabel,
    row.batchId,
    row.modelId,
    row.modelName,
    `v${row.modelVersion}`,
    `v${row.datasetVersion}`,
    row.features.join('、'),
    row.coefficient,
    row.value,
    `[${row.lower}, ${row.upper}]`,
    row.boundary,
  ])
  return { content: csvDocument(REPORT_HEADER, rows) }
}

export function reportFileStamp(reportId: string): string {
  return `forecast-report-${reportId}.csv`
}

export function reportHasMixedVersions(report: ForecastReport): boolean {
  const versions = new Set(report.rows.map((row) => `${row.batchId}|v${row.modelVersion}|v${row.datasetVersion}`))
  return versions.size > 1
}
