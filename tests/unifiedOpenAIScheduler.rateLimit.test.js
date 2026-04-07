jest.mock('../src/services/account/openaiAccountService', () => ({
  setAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn(),
  sortAccountsByPriority: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')

describe('unifiedOpenAIScheduler markAccountRateLimited', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not force schedulable=false when openai-responses auto protection skips rate limit marking', async () => {
    openaiResponsesAccountService.markAccountRateLimited.mockResolvedValue(false)

    await scheduler.markAccountRateLimited('resp-acct-1', 'openai-responses', null, 120)

    expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
      'resp-acct-1',
      2
    )
    expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
  })
})
