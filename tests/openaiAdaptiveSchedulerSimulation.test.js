const {
  sortAccountsWithAdaptivePriority
} = require('../src/services/scheduler/openaiAdaptivePriorityScorer')

function cloneAccounts(accounts) {
  return JSON.parse(JSON.stringify(accounts))
}

function pickStaticAccount(accounts) {
  return [...accounts].sort((a, b) => {
    const priorityA = parseInt(a.priority, 10) || 50
    const priorityB = parseInt(b.priority, 10) || 50
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
  })[0]
}

function pickAdaptiveAccount(accounts, options) {
  const sorted = sortAccountsWithAdaptivePriority(accounts, options)
  const best = sorted[0]
  if (!best) {
    return null
  }

  const bestPriority = best.__adaptiveScheduling?.priority
  const bandDelta = Math.max(0, Math.floor(options.selectionBandDelta ?? 3))
  if (!Number.isFinite(bestPriority) || bandDelta <= 0) {
    return best
  }

  const bandCandidates = sorted.filter((item) => {
    const p = item.__adaptiveScheduling?.priority
    return Number.isFinite(p) && p <= bestPriority + bandDelta
  })

  return [...bandCandidates].sort((a, b) => {
    const lastUsedA = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0
    const lastUsedB = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0
    if (lastUsedA !== lastUsedB) {
      return lastUsedA - lastUsedB
    }
    const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return createdA - createdB
  })[0]
}

function tickWindow(windowData, stepSeconds) {
  if (!windowData) {
    return
  }

  const windowMinutes = Number(windowData.windowMinutes || 0)
  const fullWindowSeconds = Math.max(1, Math.floor(windowMinutes * 60))
  let remainingSeconds = Number(windowData.remainingSeconds)
  if (!Number.isFinite(remainingSeconds)) {
    remainingSeconds = fullWindowSeconds
  }
  remainingSeconds -= stepSeconds

  while (remainingSeconds <= 0) {
    remainingSeconds += fullWindowSeconds
    windowData.usedPercent = 0
  }

  windowData.remainingSeconds = remainingSeconds
}

function applyLoad(account, { primaryPercentCost, secondaryPercentCost }) {
  const { primary } = account.codexUsage
  const { secondary } = account.codexUsage
  primary.usedPercent = Number(primary.usedPercent || 0) + primaryPercentCost
  secondary.usedPercent = Number(secondary.usedPercent || 0) + secondaryPercentCost
}

function countHardStopExposure(account, options) {
  const { primary } = account.codexUsage
  const { secondary } = account.codexUsage

  const primaryHit =
    Number(primary.usedPercent || 0) >= options.primaryHardStopPercent &&
    Number(primary.remainingSeconds || 0) > options.hardStopGraceSeconds
  const secondaryHit =
    Number(secondary.usedPercent || 0) >= options.secondaryHardStopPercent &&
    Number(secondary.remainingSeconds || 0) > options.hardStopGraceSeconds
  return Number(primaryHit) + Number(secondaryHit)
}

function runSimulation(strategyName, options, initialAccounts) {
  const accounts = cloneAccounts(initialAccounts)
  const selectionCount = new Map(accounts.map((a) => [a.id, 0]))
  const riskyIds = new Set(['risk-1', 'risk-2'])

  let now = Date.parse('2026-03-01T00:00:00Z')
  const stepSeconds = 60
  const totalSteps = 600
  let riskSelections = 0
  let hardStopExposure = 0

  for (let step = 0; step < totalSteps; step++) {
    for (const account of accounts) {
      account.codexUsage.updatedAt = new Date(now).toISOString()
    }

    let selected
    if (strategyName === 'adaptive') {
      selected = pickAdaptiveAccount(accounts, options)
    } else {
      selected = pickStaticAccount(accounts)
    }

    if (!selected) {
      throw new Error('No account selected in simulation')
    }

    selectionCount.set(selected.id, selectionCount.get(selected.id) + 1)
    if (riskyIds.has(selected.id)) {
      riskSelections += 1
    }

    applyLoad(selected, { primaryPercentCost: 1.8, secondaryPercentCost: 0.35 })
    selected.lastUsedAt = new Date(now).toISOString()

    for (const account of accounts) {
      tickWindow(account.codexUsage.primary, stepSeconds)
      tickWindow(account.codexUsage.secondary, stepSeconds)
      hardStopExposure += countHardStopExposure(account, options)
    }

    now += stepSeconds * 1000
  }

  const counts = [...selectionCount.values()]
  const maxSelect = Math.max(...counts)
  const minSelect = Math.min(...counts)

  return {
    riskSelections,
    hardStopExposure,
    maxSelect,
    minSelect,
    totalSteps
  }
}

describe('OpenAI adaptive scheduler simulation', () => {
  it('should reduce risky-account hits and hard-stop exposure vs static scheduling', () => {
    const options = {
      enabled: true,
      includeResponses: false,
      codexUsageMaxAgeMinutes: 720,
      secondaryWeight: 0.45,
      resetTimeWeight: 0.25,
      manualPriorityWeight: 0.1,
      primarySaturationPercent: 88,
      secondarySaturationPercent: 82,
      primaryHardStopPercent: 98,
      secondaryHardStopPercent: 96,
      hardStopGraceSeconds: 180,
      nearCapPenaltyWeight: 0.65,
      scheduleDriftPenaltyWeight: 0.35,
      selectionBandDelta: 3
    }

    const initialAccounts = [
      {
        id: 'risk-1',
        accountType: 'openai',
        priority: 50,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        codexUsage: {
          updatedAt: '2026-03-01T00:00:00.000Z',
          primary: { usedPercent: 97, remainingSeconds: 13200, windowMinutes: 300 },
          secondary: { usedPercent: 92, remainingSeconds: 420000, windowMinutes: 10080 }
        }
      },
      {
        id: 'risk-2',
        accountType: 'openai',
        priority: 50,
        createdAt: '2026-01-01T00:01:00.000Z',
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        codexUsage: {
          updatedAt: '2026-03-01T00:00:00.000Z',
          primary: { usedPercent: 95, remainingSeconds: 15000, windowMinutes: 300 },
          secondary: { usedPercent: 89, remainingSeconds: 450000, windowMinutes: 10080 }
        }
      },
      {
        id: 'safe-1',
        accountType: 'openai',
        priority: 50,
        createdAt: '2026-01-01T00:02:00.000Z',
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        codexUsage: {
          updatedAt: '2026-03-01T00:00:00.000Z',
          primary: { usedPercent: 55, remainingSeconds: 600, windowMinutes: 300 },
          secondary: { usedPercent: 52, remainingSeconds: 470000, windowMinutes: 10080 }
        }
      },
      {
        id: 'safe-2',
        accountType: 'openai',
        priority: 50,
        createdAt: '2026-01-01T00:03:00.000Z',
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        codexUsage: {
          updatedAt: '2026-03-01T00:00:00.000Z',
          primary: { usedPercent: 48, remainingSeconds: 7800, windowMinutes: 300 },
          secondary: { usedPercent: 46, remainingSeconds: 490000, windowMinutes: 10080 }
        }
      },
      {
        id: 'safe-3',
        accountType: 'openai',
        priority: 50,
        createdAt: '2026-01-01T00:04:00.000Z',
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        codexUsage: {
          updatedAt: '2026-03-01T00:00:00.000Z',
          primary: { usedPercent: 44, remainingSeconds: 9000, windowMinutes: 300 },
          secondary: { usedPercent: 41, remainingSeconds: 500000, windowMinutes: 10080 }
        }
      },
      {
        id: 'safe-4',
        accountType: 'openai',
        priority: 50,
        createdAt: '2026-01-01T00:05:00.000Z',
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        codexUsage: {
          updatedAt: '2026-03-01T00:00:00.000Z',
          primary: { usedPercent: 42, remainingSeconds: 10200, windowMinutes: 300 },
          secondary: { usedPercent: 43, remainingSeconds: 510000, windowMinutes: 10080 }
        }
      },
      {
        id: 'safe-5',
        accountType: 'openai',
        priority: 50,
        createdAt: '2026-01-01T00:06:00.000Z',
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        codexUsage: {
          updatedAt: '2026-03-01T00:00:00.000Z',
          primary: { usedPercent: 38, remainingSeconds: 11100, windowMinutes: 300 },
          secondary: { usedPercent: 40, remainingSeconds: 520000, windowMinutes: 10080 }
        }
      },
      {
        id: 'safe-6',
        accountType: 'openai',
        priority: 50,
        createdAt: '2026-01-01T00:07:00.000Z',
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        codexUsage: {
          updatedAt: '2026-03-01T00:00:00.000Z',
          primary: { usedPercent: 36, remainingSeconds: 12000, windowMinutes: 300 },
          secondary: { usedPercent: 39, remainingSeconds: 530000, windowMinutes: 10080 }
        }
      }
    ]

    const staticResult = runSimulation('static', options, initialAccounts)
    const adaptiveResult = runSimulation('adaptive', options, initialAccounts)

    expect(adaptiveResult.riskSelections).toBeLessThan(staticResult.riskSelections)
    expect(adaptiveResult.hardStopExposure).toBeLessThan(staticResult.hardStopExposure)
    expect(adaptiveResult.maxSelect - adaptiveResult.minSelect).toBeLessThanOrEqual(120)
  })
})
