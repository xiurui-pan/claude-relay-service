const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

jest.mock('axios', () => jest.fn())

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/headerFilter', () => ({
  filterForOpenAI: jest.fn((headers) => ({ ...headers }))
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn(),
  isSubscriptionExpired: jest.fn(() => false)
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  _deleteSessionMapping: jest.fn().mockResolvedValue(),
  markAccountRateLimited: jest.fn().mockResolvedValue()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn().mockResolvedValue({ success: true }),
  sanitizeErrorForClient: jest.fn((errorData) => errorData),
  isRetryableNetworkError: jest.fn((error) =>
    ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT'].includes(
      (error?.code || '').toUpperCase()
    )
  ),
  getRetryableNetworkStatus: jest.fn((error) =>
    ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes((error?.code || '').toUpperCase()) ? 504 : 502
  ),
  buildFriendlyNetworkError: jest.fn((statusCode = 502) => ({
    error: {
      message: '上游网络连接失败，请稍后重试',
      status: statusCode
    }
  })),
  buildFriendlyRateLimitError: jest.fn((resetsInSeconds = null) => ({
    error: {
      message: '触发上游限流，请稍后重试',
      status: 429,
      resets_in_seconds: resetsInSeconds
    }
  })),
  buildFriendlyUpstreamError: jest.fn((statusCode, message = '') => ({
    error: {
      message: message || '上游服务暂时不可用，请稍后重试',
      status: statusCode
    }
  }))
}))

const axios = require('axios')
const relayService = require('../src/services/relay/openaiResponsesRelayService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

function createReq() {
  const req = new PassThrough()
  req.method = 'POST'
  req.path = '/responses'
  req.headers = {
    'user-agent': 'codex-code/2.1.92-codex.1',
    session_id: 'sess-1'
  }
  req.body = {
    model: 'gpt-5.4',
    stream: true
  }
  return req
}

function createRes() {
  const res = new EventEmitter()
  res.headersSent = false
  res.destroyed = false
  res.statusCode = 200
  res.payload = null
  res.status = jest.fn((code) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn((payload) => {
    res.payload = payload
    res.headersSent = true
    return res
  })
  res.setHeader = jest.fn(() => {
    res.headersSent = true
  })
  res.write = jest.fn(() => true)
  res.end = jest.fn(() => {
    res.headersSent = true
    return res
  })
  return res
}

describe('openaiResponsesRelayService early stream retry handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'acct-1',
      name: 'Responses One',
      apiKey: 'token-1',
      baseApi: 'https://example.invalid',
      providerEndpoint: 'responses'
    })
  })

  it('returns retryableUpstreamError for early SSE upstream failures before piping the stream', async () => {
    const stream = new PassThrough()
    process.nextTick(() => {
      stream.write(
        [
          'event: error',
          'data: {"type":"error","message":"An error occurred while processing your request. Please include the request ID req-1 in your message."}',
          '',
          ''
        ].join('\n')
      )
      stream.end()
    })

    axios.mockResolvedValueOnce({
      status: 200,
      data: stream
    })

    const req = createReq()
    const res = createRes()

    const result = await relayService.handleRequest(
      req,
      res,
      { id: 'acct-1', name: 'Responses One' },
      { id: 'key-1' },
      { returnRetryableUpstreamResult: true }
    )

    expect(result).toBeTruthy()
    expect(result.retryableUpstreamError).toBe(true)
    expect(result.status).toBe(500)
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'acct-1',
      'openai-responses',
      500,
      null,
      expect.objectContaining({
        source: 'openai_responses_stream_probe'
      })
    )
    expect(res.json).not.toHaveBeenCalled()
    expect(res.write).not.toHaveBeenCalled()
  })

  it('returns retryableUpstreamError when the stream aborts before any meaningful output', async () => {
    const stream = new PassThrough()
    process.nextTick(() => {
      const error = new Error('aborted')
      error.code = 'ECONNRESET'
      stream.emit('error', error)
    })

    axios.mockResolvedValueOnce({
      status: 200,
      data: stream
    })

    const req = createReq()
    const res = createRes()

    const result = await relayService.handleRequest(
      req,
      res,
      { id: 'acct-1', name: 'Responses One' },
      { id: 'key-1' },
      { returnRetryableUpstreamResult: true }
    )

    expect(result).toBeTruthy()
    expect(result.retryableUpstreamError).toBe(true)
    expect(result.status).toBe(500)
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'acct-1',
      'openai-responses',
      500,
      null,
      expect.objectContaining({
        source: 'openai_responses_stream_probe'
      })
    )
    expect(res.json).not.toHaveBeenCalled()
    expect(res.write).not.toHaveBeenCalled()
  })

  it('retries 429 on the same account before returning a rate-limited result', async () => {
    axios
      .mockResolvedValueOnce({
        status: 429,
        data: { error: { message: 'limit', resets_in_seconds: 12 } },
        headers: {}
      })
      .mockResolvedValueOnce({
        status: 429,
        data: { error: { message: 'limit', resets_in_seconds: 12 } },
        headers: {}
      })
      .mockResolvedValueOnce({
        status: 429,
        data: { error: { message: 'limit', resets_in_seconds: 12 } },
        headers: {}
      })

    const req = createReq()
    req.body.stream = false
    const res = createRes()

    const result = await relayService.handleRequest(
      req,
      res,
      { id: 'acct-1', name: 'Responses One' },
      { id: 'key-1' },
      { returnRateLimitResult: true }
    )

    expect(axios).toHaveBeenCalledTimes(3)
    expect(result).toEqual({
      rateLimited: true,
      resetsInSeconds: 12,
      errorData: {
        error: {
          message: '触发上游限流，请稍后重试',
          status: 429,
          resets_in_seconds: 12
        }
      }
    })
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'acct-1',
      'openai-responses',
      429,
      12
    )
    expect(res.json).not.toHaveBeenCalled()
  })

  it('retries network failures on the same account before returning retryableUpstreamError', async () => {
    const networkError = new Error('socket hang up')
    networkError.code = 'ECONNRESET'

    axios.mockRejectedValue(networkError)

    const req = createReq()
    req.body.stream = false
    const res = createRes()

    const result = await relayService.handleRequest(
      req,
      res,
      { id: 'acct-1', name: 'Responses One' },
      { id: 'key-1' },
      { returnRetryableUpstreamResult: true }
    )

    expect(axios).toHaveBeenCalledTimes(3)
    expect(result).toEqual({
      retryableUpstreamError: true,
      status: 502,
      errorData: {
        error: {
          message: '上游网络连接失败，请稍后重试',
          status: 502
        }
      },
      clientError: {
        error: {
          message: '上游网络连接失败，请稍后重试',
          status: 502
        }
      }
    })
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'acct-1',
      'openai-responses',
      502
    )
  })
})
