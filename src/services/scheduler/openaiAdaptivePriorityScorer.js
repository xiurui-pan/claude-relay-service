const DEFAULT_PRIORITY = 50
const DEFAULT_PRIMARY_WINDOW_SECONDS = 5 * 60 * 60
const DEFAULT_SECONDARY_WINDOW_SECONDS = 7 * 24 * 60 * 60

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const sigmoid = (x) => 1 / (1 + Math.exp(-x))

const toFiniteNumber = (value) => {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const toTimestamp = (value) => {
  if (!value) {
    return null
  }
  const ts = Date.parse(value)
  return Number.isNaN(ts) ? null : ts
}

const resolveWindowSeconds = (windowData, fallbackSeconds) => {
  const minutes = toFiniteNumber(windowData?.windowMinutes)
  if (minutes !== null && minutes > 0) {
    return minutes * 60
  }
  return fallbackSeconds
}

const normalizePriority = (value) => {
  const priority = parseInt(value, 10)
  if (Number.isNaN(priority)) {
    return DEFAULT_PRIORITY
  }
  return clamp(priority, 1, 100)
}

const normalizeAdaptiveOptions = (options = {}) => {
  const secondaryWeight = toFiniteNumber(options.secondaryWeight)
  const resetTimeWeight = toFiniteNumber(options.resetTimeWeight)
  const manualPriorityWeight = toFiniteNumber(options.manualPriorityWeight)
  const maxUsageAgeMinutes = toFiniteNumber(options.codexUsageMaxAgeMinutes)
  const primarySaturationPercent = toFiniteNumber(options.primarySaturationPercent)
  const secondarySaturationPercent = toFiniteNumber(options.secondarySaturationPercent)
  const primaryHardStopPercent = toFiniteNumber(options.primaryHardStopPercent)
  const secondaryHardStopPercent = toFiniteNumber(options.secondaryHardStopPercent)
  const hardStopGraceSeconds = toFiniteNumber(options.hardStopGraceSeconds)
  const nearCapPenaltyWeight = toFiniteNumber(options.nearCapPenaltyWeight)
  const scheduleDriftPenaltyWeight = toFiniteNumber(options.scheduleDriftPenaltyWeight)

  return {
    enabled: options.enabled !== false,
    includeResponses: options.includeResponses === true,
    secondaryWeight: secondaryWeight === null ? 0.45 : clamp(secondaryWeight, 0, 1),
    resetTimeWeight: resetTimeWeight === null ? 0.25 : clamp(resetTimeWeight, 0, 1),
    manualPriorityWeight: manualPriorityWeight === null ? 0.1 : clamp(manualPriorityWeight, 0, 1),
    codexUsageMaxAgeMinutes:
      maxUsageAgeMinutes === null || maxUsageAgeMinutes <= 0 ? 720 : maxUsageAgeMinutes,
    primarySaturationPercent:
      primarySaturationPercent === null ? 88 : clamp(primarySaturationPercent, 50, 100),
    secondarySaturationPercent:
      secondarySaturationPercent === null ? 82 : clamp(secondarySaturationPercent, 40, 100),
    primaryHardStopPercent:
      primaryHardStopPercent === null ? 98 : clamp(primaryHardStopPercent, 80, 100),
    secondaryHardStopPercent:
      secondaryHardStopPercent === null ? 96 : clamp(secondaryHardStopPercent, 70, 100),
    hardStopGraceSeconds:
      hardStopGraceSeconds === null || hardStopGraceSeconds < 0
        ? 3 * 60
        : Math.floor(hardStopGraceSeconds),
    nearCapPenaltyWeight: nearCapPenaltyWeight === null ? 0.65 : clamp(nearCapPenaltyWeight, 0, 1),
    scheduleDriftPenaltyWeight:
      scheduleDriftPenaltyWeight === null ? 0.35 : clamp(scheduleDriftPenaltyWeight, 0, 1)
  }
}

const hasWindowUsageData = (windowData = {}) =>
  windowData.usedPercent !== undefined ||
  windowData.remainingSeconds !== undefined ||
  windowData.resetAfterSeconds !== undefined ||
  windowData.windowMinutes !== undefined

function computeWindowSignals(
  windowData,
  { windowSeconds, saturationPercent, hardStopPercent, options }
) {
  const usedPercent = toFiniteNumber(windowData?.usedPercent)
  const usedRatio = usedPercent === null ? 0.5 : clamp(usedPercent / 100, 0, 1)

  const remainingSeconds =
    toFiniteNumber(windowData?.remainingSeconds) ?? toFiniteNumber(windowData?.resetAfterSeconds)
  const remainingRatio =
    remainingSeconds === null ? 0.5 : clamp(remainingSeconds / Math.max(1, windowSeconds), 0, 1)
  const elapsedRatio = clamp(1 - remainingRatio, 0, 1)

  const headroomRatio = clamp(1 - usedRatio, 0, 1)

  // 机会项：头寸越充足 + 越接近重置，优先级越高（避免额度浪费）
  const urgencyOpportunity = headroomRatio * elapsedRatio
  const reserveOpportunity = headroomRatio
  const opportunity =
    reserveOpportunity * (1 - options.resetTimeWeight) +
    urgencyOpportunity * options.resetTimeWeight

  // 风险项1：接近上限时非线性升高，防止冲到封顶
  const saturationPivot = clamp(saturationPercent / 100, 0, 1)
  const nearCapPenalty = sigmoid((usedRatio - saturationPivot) * 12)

  // 风险项2：相对时间进度“超前消耗”
  const scheduleDrift = usedRatio - elapsedRatio
  const aheadPenalty = clamp(Math.max(0, scheduleDrift), 0, 1)

  // 风险项3：硬保护阈值（除非马上重置，否则强惩罚）
  const hardStopTriggered =
    usedPercent !== null &&
    usedPercent >= hardStopPercent &&
    (remainingSeconds === null || remainingSeconds > options.hardStopGraceSeconds)
  const hardStopPenalty = hardStopTriggered ? 0.9 : 0

  const risk =
    nearCapPenalty * options.nearCapPenaltyWeight +
    aheadPenalty * options.scheduleDriftPenaltyWeight +
    hardStopPenalty

  const safeFactor = clamp(1 - risk, 0.05, 1)
  const availability = clamp(opportunity * safeFactor, 0, 1)

  return {
    usedPercent,
    usedRatio,
    headroomRatio,
    remainingSeconds,
    remainingRatio,
    elapsedRatio,
    scheduleDrift,
    opportunity,
    nearCapPenalty,
    aheadPenalty,
    hardStopTriggered,
    risk,
    safeFactor,
    availability
  }
}

function buildAdaptivePriority(account, options = {}) {
  const normalizedOptions = normalizeAdaptiveOptions(options)
  const staticPriority = normalizePriority(account?.priority)
  const accountType = account?.accountType || account?.platform || 'openai'

  if (!normalizedOptions.enabled) {
    return {
      applied: false,
      reason: 'disabled',
      priority: staticPriority,
      staticPriority
    }
  }

  if (accountType !== 'openai' && !normalizedOptions.includeResponses) {
    return {
      applied: false,
      reason: 'non_openai_account',
      priority: staticPriority,
      staticPriority
    }
  }

  const codexUsage = account?.codexUsage
  if (!codexUsage || typeof codexUsage !== 'object') {
    return {
      applied: false,
      reason: 'missing_codex_usage',
      priority: staticPriority,
      staticPriority
    }
  }

  const updatedAtTs = toTimestamp(codexUsage.updatedAt)
  if (updatedAtTs === null) {
    return {
      applied: false,
      reason: 'missing_codex_usage_timestamp',
      priority: staticPriority,
      staticPriority
    }
  }

  const ageMinutes = (Date.now() - updatedAtTs) / (60 * 1000)
  if (ageMinutes > normalizedOptions.codexUsageMaxAgeMinutes) {
    return {
      applied: false,
      reason: 'stale_codex_usage',
      priority: staticPriority,
      staticPriority,
      usageAgeMinutes: ageMinutes
    }
  }

  const primaryUsage = codexUsage.primary || {}
  const secondaryUsage = codexUsage.secondary || {}

  const hasPrimaryData = hasWindowUsageData(primaryUsage)
  const hasSecondaryData = hasWindowUsageData(secondaryUsage)
  if (!hasPrimaryData && !hasSecondaryData) {
    return {
      applied: false,
      reason: 'empty_codex_usage',
      priority: staticPriority,
      staticPriority
    }
  }

  const primaryWindowSeconds = resolveWindowSeconds(primaryUsage, DEFAULT_PRIMARY_WINDOW_SECONDS)
  const secondaryWindowSeconds = resolveWindowSeconds(
    secondaryUsage,
    DEFAULT_SECONDARY_WINDOW_SECONDS
  )

  const primary = computeWindowSignals(primaryUsage, {
    windowSeconds: primaryWindowSeconds,
    saturationPercent: normalizedOptions.primarySaturationPercent,
    hardStopPercent: normalizedOptions.primaryHardStopPercent,
    options: normalizedOptions
  })
  const secondary = computeWindowSignals(secondaryUsage, {
    windowSeconds: secondaryWindowSeconds,
    saturationPercent: normalizedOptions.secondarySaturationPercent,
    hardStopPercent: normalizedOptions.secondaryHardStopPercent,
    options: normalizedOptions
  })

  const primaryWeight = 1 - normalizedOptions.secondaryWeight
  let overallAvailability =
    primary.availability * primaryWeight +
    secondary.availability * normalizedOptions.secondaryWeight

  // 双窗口联防：任何窗口头寸过低都会降低总体可用性
  const bottleneckHeadroom = Math.min(primary.headroomRatio, secondary.headroomRatio)
  overallAvailability = clamp(overallAvailability * (0.7 + 0.3 * bottleneckHeadroom), 0, 1)

  // 利用 primaryOverSecondary 指标做弱惩罚（防止短窗相对周窗透支）
  const primaryOverSecondaryPercent = toFiniteNumber(codexUsage.primaryOverSecondaryPercent)
  if (primaryOverSecondaryPercent !== null && primaryOverSecondaryPercent > 100) {
    const overPenalty = clamp((primaryOverSecondaryPercent - 100) / 200, 0, 0.3)
    overallAvailability = clamp(overallAvailability * (1 - overPenalty), 0, 1)
  }

  const autoPriority = clamp(Math.round(101 - overallAvailability * 100), 1, 100)
  const finalPriority = clamp(
    Math.round(
      autoPriority * (1 - normalizedOptions.manualPriorityWeight) +
        staticPriority * normalizedOptions.manualPriorityWeight
    ),
    1,
    100
  )

  return {
    applied: true,
    reason: 'ok',
    priority: finalPriority,
    staticPriority,
    autoPriority,
    overallAvailability,
    windowScores: {
      primary,
      secondary
    },
    usage: {
      primaryUsedPercent: primary.usedPercent,
      primaryRemainingSeconds: primary.remainingSeconds,
      secondaryUsedPercent: secondary.usedPercent,
      secondaryRemainingSeconds: secondary.remainingSeconds,
      primaryOverSecondaryPercent
    }
  }
}

function sortAccountsWithAdaptivePriority(accounts, options = {}) {
  return [...accounts]
    .map((account) => ({
      ...account,
      __adaptiveScheduling: buildAdaptivePriority(account, options)
    }))
    .sort((a, b) => {
      const priorityA = a.__adaptiveScheduling.priority
      const priorityB = b.__adaptiveScheduling.priority
      if (priorityA !== priorityB) {
        return priorityA - priorityB
      }

      const lastUsedA = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0
      const lastUsedB = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0
      if (lastUsedA !== lastUsedB) {
        return lastUsedA - lastUsedB
      }

      const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return createdA - createdB
    })
}

module.exports = {
  buildAdaptivePriority,
  sortAccountsWithAdaptivePriority
}
