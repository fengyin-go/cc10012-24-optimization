/** 趋势预测领域模型：数据集版本、特征依赖、训练批次、模型版本与预测归档。 */

export type FeatureType = '文本' | '数值' | '布尔' | '日期' | '枚举'

export type FeatureField = {
  name: string
  type: FeatureType
  /** id / date 字段不进入宽表特征；未标注的按普通特征处理。 */
  role?: 'id' | 'date' | 'feature'
  mean?: number
  missingRate?: number
  note?: string
}

export type DatasetStatus = '草稿' | '待审核' | '已生效'

export type DatasetEntity = {
  id: string
  name: string
  version: number
  status: DatasetStatus
  sourceTable: string
  owner: string
  fields: FeatureField[]
  updatedAt: string
}

export type FeatureDependency = {
  datasetId: string
  field: string
  /** 该依赖从哪个数据集版本开始提供；用于识别「字段首次可用」。 */
  addedInVersion?: number
  /** 最近一次成功训练时锁定的字段类型与数据集版本。 */
  resolvedType?: FeatureType
  resolvedVersion?: number
  required: boolean
}

export type ModelStatus = '已生效' | '待重训' | '已失效'

export type FeatureMode = '全量' | '白名单'

export type ForecastModel = {
  id: string
  name: string
  algorithm: string
  datasetId: string
  target: string
  /** 全量模式读取数据集整张宽表，新增字段即改变特征；白名单只读取声明的特征。 */
  featureMode: FeatureMode
  dependencies: FeatureDependency[]
  status: ModelStatus
  modelVersion: number
  /** 当前生效模型训练时使用的数据集版本。 */
  trainedVersion: number
  activeBatchId: string | null
  targetRange: [number, number]
  baselineValue: number
  coefficient: string
  /** 最近一次发布时读取的特征快照，与数据集版本一起留档。 */
  featureSnapshot: string[]
  horizon: string
  pendingReason?: string
  lastTrainedAt: string
  confidence: string
  metric: string
}

export type FeatureChangeKind = '新增' | '移除' | '类型变更' | '分布漂移'

export type FeatureChange = {
  field: string
  kind: FeatureChangeKind
  before: string
  after: string
  driftPct?: number
  detail: string
}

export type ChangeStatus = '待处理' | '已归档'

export type ChangeLog = {
  id: string
  datasetId: string
  fromVersion: number
  toVersion: number
  title: string
  changes: FeatureChange[]
  fromFields: FeatureField[]
  toFields: FeatureField[]
  status: ChangeStatus
  registeredAt: string
  note: string
  batchIds: string[]
}

export type BatchScope = '增量' | '整批'

export type BatchStatus = '训练中' | '待发布' | '已发布' | '失败' | '已作废'

export type BatchEntryStatus = '待训练' | '成功' | '失败'

export type GuardStatus = '未校验' | '通过' | '失败'

export type BatchModelEntry = {
  modelId: string
  modelName: string
  algorithm: string
  featureMode: FeatureMode
  datasetId: string
  fromModelVersion: number
  fromVersion: number
  toVersion: number
  /** 模型创建批次时正在使用的批次，发布前用它做并发漂移检查。 */
  fromBatchId: string | null
  features: string[]
  featureBasis: string
  status: BatchEntryStatus
  guard: GuardStatus
  guardDetail: string
  coefficient: string
  predictedValue: number
  lowerBound: number
  upperBound: number
  failureReason?: string
}

export type ConflictOption = {
  label: string
  coverage: string
  consistency: string
  cost: string
}

export type BatchConflict = {
  detected: boolean
  title: string
  options: ConflictOption[]
  chosen: string
  rationale: string
}

export type TrainingBatch = {
  id: string
  status: BatchStatus
  scope: BatchScope
  changeIds: string[]
  changeSummary: string[]
  datasetVersions: string
  /** 全部条目读取的数据集版本快照，发布时逐条核对。 */
  datasetVersionMap: Record<string, number>
  /** 训练批次读取的特征字段依据，一行一条，可审计。 */
  featureBasis: string[]
  entries: BatchModelEntry[]
  dedupeKey: string
  conflict: BatchConflict | null
  artifactFile: string
  artifactVersion: number
  createdAt: string
  publishedAt: string | null
  failureReason: string | null
  operator: string
  note: string
}

export type ForecastResult = {
  id: string
  batchId: string
  modelId: string
  modelName: string
  datasetId: string
  datasetVersion: number
  modelVersion: number
  features: string[]
  coefficient: string
  horizon: string
  value: number
  lower: number
  upper: number
  boundary: '在界内' | '越界'
  archivedAt: string
}

export type ReportPolicy = '单批次' | '分段'

export type ReportRow = {
  groupIndex: number
  groupLabel: string
  modelId: string
  modelName: string
  modelVersion: number
  batchId: string
  features: string[]
  coefficient: string
  datasetVersion: number
  value: number
  lower: number
  upper: number
  boundary: string
}

export type ReportModelSnapshot = {
  modelId: string
  modelName: string
  modelVersion: number
  datasetId: string
  datasetVersion: number
  featureMode: FeatureMode
  features: string[]
  coefficient: string
  status: ModelStatus
}

export type ReportResultSnapshot = {
  modelId: string
  modelVersion: number
  batchId: string
  value: number
  lower: number
  upper: number
  boundary: string
}

export type ForecastReport = {
  id: string
  title: string
  status: '草稿' | '已归档'
  policy: ReportPolicy
  batchId: string | null
  batchGroups: string[]
  rows: ReportRow[]
  /** 生成报告时归档的模型快照，和预测结果一起留档。 */
  models: ReportModelSnapshot[]
  results: ReportResultSnapshot[]
  warnings: string[]
  tradeoff: string
  sourceBatchFiles: string[]
  artifactFile: string
  createdAt: string
  archivedAt: string | null
}

export type ForecastState = {
  schemaVersion: number
  datasets: DatasetEntity[]
  models: ForecastModel[]
  changes: ChangeLog[]
  batches: TrainingBatch[]
  results: ForecastResult[]
  reports: ForecastReport[]
  /** 最近一次完整发布的批次。 */
  activeBatchId: string | null
  /** 正在占用训练/发布通道的批次；并发重训只允许一个。 */
  runningBatchId: string | null
}

/** 影响判断结果：每个模型一条，未受影响的模型也保留原因，便于核对边界。 */
export type ModelImpact = {
  modelId: string
  modelName: string
  datasetId: string
  affected: boolean
  severity: 'none' | 'additive' | 'required' | 'blocking'
  reasons: string[]
  evidence: string
  featureBasis: string
  activeBatchId: string | null
  modelVersion: number
  beforeStatus: ModelStatus
  afterStatus: ModelStatus
}

export type ScopeOption = {
  scope: BatchScope
  modelIds: string[]
  affectedCount: number
  totalCount: number
  estimatedMinutes: number
  coverage: string
  consistency: string
  boundary: '通过' | '不通过'
  boundaryNote: string
  entries: BatchModelEntry[]
}

export type ReportPolicyOption = {
  policy: ReportPolicy
  batchId: string | null
  batchGroups: string[]
  modelIds: string[]
  coverage: string
  consistency: string
  caveat: string
  recommended: boolean
  rationale: string
  conflict: boolean
}

export type ForecastModelView = {
  model: ForecastModel
  datasetName: string
  datasetVersion: number
  featureBasis: string
  features: string[]
  activeBatchStatus: string
  /** 按待处理变更推导的状态：受影响即展示为待重训，不改写已生效模型。 */
  impactStatus: ModelStatus
}

export type BatchVerdict = {
  statusLabel: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  publishable: boolean
  complete: boolean
  reasons: string[]
  audit: string[]
}

export type BatchDetailRow = {
  modelId: string
  modelName: string
  dataset: string
  datasetVersion: string
  modelVersion: string
  featureMode: FeatureMode
  featureBasis: string
  features: string
  predictedValue: string
  interval: string
  boundary: string
  coefficient: string
  status: string
}
