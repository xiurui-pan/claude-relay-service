const DEFAULT_PRIORITY = 50
const DEFAULT_PRIMARY_WINDOW_SECONDS = 5 * 60 * 60
const DEFAULT_SECONDARY_WINDOW_SECONDS = 7 * 24 * 60 * 60

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

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

const computeQuotaRemainingRatio = (usedPercent) => {
  const used = toFiniteNumber(usedPercent)
  if (used === null) {
    return 0.5
  }
  return clamp(1 - used / 100, 0, 1)
}

const computeResetClosenessRatio = (remainingSeconds, windowSeconds) => {
  const remaining = toFiniteNumber(remainingSeconds)
  if (remaining === null || remaining < 0) {
    return 0.5
  }

  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return 0.5
  }

  return clamp(1 - remaining / windowSeconds, 0, 1)
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

  return {
    enabled: options.enabled !== false,
    includeResponses: options.includeResponses === true,
    secondaryWeight: secondaryWeight === null ? 0.45 : clamp(secondaryWeight, 0, 1),
    resetTimeWeight: resetTimeWeight === null ? 0.25 : clamp(resetTimeWeight, 0, 1),
    manualPriorityWeight: manualPriorityWeight === null ? 0.1 : clamp(manualPriorityWeight, 0, 1),
    codexUsageMaxAgeMinutes:
      maxUsageAgeMinutes === null || maxUsageAgeMinutes <= 0 ? 720 : maxUsageAgeMinutes
  }
}

const hasWindowUsageData = (windowData = {}) =>
  windowData.usedPercent !== undefined ||
  windowData.remainingSeconds !== undefined ||
  windowData.resetAfterSeconds !== undefined ||
  windowData.windowMinutes !== undefined

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
  if (updatedAtTs !== null) {
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

  const primaryQuotaRemaining = computeQuotaRemainingRatio(primaryUsage.usedPercent)
  const secondaryQuotaRemaining = computeQuotaRemainingRatio(secondaryUsage.usedPercent)

  const primaryRemainingSeconds =
    toFiniteNumber(primaryUsage.remainingSeconds) ?? toFiniteNumber(primaryUsage.resetAfterSeconds)
  const secondaryRemainingSeconds =
    toFiniteNumber(secondaryUsage.remainingSeconds) ??
    toFiniteNumber(secondaryUsage.resetAfterSeconds)

  const primaryResetCloseness = computeResetClosenessRatio(
    primaryRemainingSeconds,
    primaryWindowSeconds
  )
  const secondaryResetCloseness = computeResetClosenessRatio(
    secondaryRemainingSeconds,
    secondaryWindowSeconds
  )

  const quotaWeight = 1 - normalizedOptions.resetTimeWeight
  const primaryAvailability =
    primaryQuotaRemaining * quotaWeight + primaryResetCloseness * normalizedOptions.resetTimeWeight
  const secondaryAvailability =
    secondaryQuotaRemaining * quotaWeight +
    secondaryResetCloseness * normalizedOptions.resetTimeWeight

  const primaryWeight = 1 - normalizedOptions.secondaryWeight
  const overallAvailability =
    primaryAvailability * primaryWeight + secondaryAvailability * normalizedOptions.secondaryWeight

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
    usage: {
      primaryUsedPercent: toFiniteNumber(primaryUsage.usedPercent),
      primaryRemainingSeconds,
      secondaryUsedPercent: toFiniteNumber(secondaryUsage.usedPercent),
      secondaryRemainingSeconds
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
