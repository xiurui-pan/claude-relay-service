const {
  buildAdaptivePriority,
  sortAccountsWithAdaptivePriority
} = require('../src/services/scheduler/openaiAdaptivePriorityScorer')

describe('openaiAdaptivePriorityScorer', () => {
  it('should prefer account with more remaining quota in adaptive mode', () => {
    const now = new Date().toISOString()
    const accounts = [
      {
        id: 'high-usage',
        accountId: 'high-usage',
        accountType: 'openai',
        priority: 50,
        codexUsage: {
          updatedAt: now,
          primary: { usedPercent: 82, remainingSeconds: 15000, windowMinutes: 300 },
          secondary: { usedPercent: 76, remainingSeconds: 420000, windowMinutes: 10080 }
        }
      },
      {
        id: 'low-usage',
        accountId: 'low-usage',
        accountType: 'openai',
        priority: 50,
        codexUsage: {
          updatedAt: now,
          primary: { usedPercent: 21, remainingSeconds: 9000, windowMinutes: 300 },
          secondary: { usedPercent: 25, remainingSeconds: 280000, windowMinutes: 10080 }
        }
      }
    ]

    const sorted = sortAccountsWithAdaptivePriority(accounts, { enabled: true })
    expect(sorted[0].id).toBe('low-usage')
    expect(sorted[0].__adaptiveScheduling.applied).toBe(true)
    expect(sorted[0].__adaptiveScheduling.priority).toBeLessThan(
      sorted[1].__adaptiveScheduling.priority
    )
  })

  it('should account for reset remaining time when usage is equal', () => {
    const now = new Date().toISOString()
    const accounts = [
      {
        id: 'reset-late',
        accountType: 'openai',
        priority: 50,
        codexUsage: {
          updatedAt: now,
          primary: { usedPercent: 60, remainingSeconds: 17000, windowMinutes: 300 },
          secondary: { usedPercent: 60, remainingSeconds: 500000, windowMinutes: 10080 }
        }
      },
      {
        id: 'reset-soon',
        accountType: 'openai',
        priority: 50,
        codexUsage: {
          updatedAt: now,
          primary: { usedPercent: 60, remainingSeconds: 120, windowMinutes: 300 },
          secondary: { usedPercent: 60, remainingSeconds: 500000, windowMinutes: 10080 }
        }
      }
    ]

    const sorted = sortAccountsWithAdaptivePriority(accounts, {
      enabled: true,
      resetTimeWeight: 0.8
    })
    expect(sorted[0].id).toBe('reset-soon')
  })

  it('should fallback to static priority when codex usage is stale', () => {
    const staleTs = new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString()
    const result = buildAdaptivePriority(
      {
        accountType: 'openai',
        priority: 33,
        codexUsage: {
          updatedAt: staleTs,
          primary: { usedPercent: 10, remainingSeconds: 600, windowMinutes: 300 }
        }
      },
      {
        enabled: true,
        codexUsageMaxAgeMinutes: 60
      }
    )

    expect(result.applied).toBe(false)
    expect(result.reason).toBe('stale_codex_usage')
    expect(result.priority).toBe(33)
  })

  it('should fallback to static priority when codex usage is missing', () => {
    const result = buildAdaptivePriority({
      accountType: 'openai',
      priority: 12
    })

    expect(result.applied).toBe(false)
    expect(result.reason).toBe('missing_codex_usage')
    expect(result.priority).toBe(12)
  })

  it('should fallback to static priority when codex usage timestamp is missing', () => {
    const result = buildAdaptivePriority({
      accountType: 'openai',
      priority: 22,
      codexUsage: {
        primary: { usedPercent: 20, remainingSeconds: 1000, windowMinutes: 300 }
      }
    })

    expect(result.applied).toBe(false)
    expect(result.reason).toBe('missing_codex_usage_timestamp')
    expect(result.priority).toBe(22)
  })

  it('should heavily penalize account that is close to hard stop', () => {
    const now = new Date().toISOString()
    const riskHigh = buildAdaptivePriority({
      accountType: 'openai',
      priority: 50,
      codexUsage: {
        updatedAt: now,
        primary: { usedPercent: 99, remainingSeconds: 3600, windowMinutes: 300 },
        secondary: { usedPercent: 97, remainingSeconds: 80000, windowMinutes: 10080 }
      }
    })

    const safer = buildAdaptivePriority({
      accountType: 'openai',
      priority: 50,
      codexUsage: {
        updatedAt: now,
        primary: { usedPercent: 55, remainingSeconds: 7200, windowMinutes: 300 },
        secondary: { usedPercent: 45, remainingSeconds: 360000, windowMinutes: 10080 }
      }
    })

    expect(riskHigh.applied).toBe(true)
    expect(safer.applied).toBe(true)
    expect(riskHigh.priority).toBeGreaterThan(safer.priority)
    expect(riskHigh.windowScores.primary.hardStopTriggered).toBe(true)
  })
})
