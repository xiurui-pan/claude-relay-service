const { PassThrough } = require('stream')

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  security: jest.fn(),
  api: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((req, _res, next) => next())
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountUnauthorized: jest.fn(),
  markAccountRateLimited: jest.fn(),
  handleSuccessfulAccountUse: jest.fn(),
  isAccountRateLimited: jest.fn(),
  removeAccountRateLimit: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(),
  decrypt: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(),
  recordUsage: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(),
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
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const { handleResponses } = require('../src/routes/openaiRoutes')

function createSseStream(chunks) {
  const stream = new PassThrough()
  process.nextTick(() => {
    for (const chunk of chunks) {
      stream.write(chunk)
    }
    stream.end()
  })
  return stream
}

function createMockRes() {
  const writes = []
  const headers = {}
  let statusCode = 200
  let ended = false
  let jsonBody = null
  let endResolve

  const finished = new Promise((resolve) => {
    endResolve = resolve
  })

  return {
    writes,
    headers,
    finished,
    get statusCode() {
      return statusCode
    },
    get ended() {
      return ended
    },
    get jsonBody() {
      return jsonBody
    },
    destroyed: false,
    headersSent: false,
    status(code) {
      statusCode = code
      return this
    },
    setHeader(key, value) {
      headers[key.toLowerCase()] = value
      this.headersSent = true
    },
    write(chunk) {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk))
      this.headersSent = true
      return true
    },
    json(payload) {
      jsonBody = payload
      this.headersSent = true
      ended = true
      endResolve()
      return this
    },
    flushHeaders() {
      this.headersSent = true
    },
    end(chunk) {
      if (chunk) {
        writes.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk))
      }
      ended = true
      this.headersSent = true
      endResolve()
      return this
    }
  }
}

describe('handleResponses internal stream retry', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    apiKeyService.hasPermission.mockReturnValue(true)
    apiKeyService.recordUsage.mockResolvedValue({})
    openaiAccountService.isTokenExpired.mockReturnValue(false)
    openaiAccountService.decrypt.mockImplementation((value) => value)
    unifiedOpenAIScheduler.isAccountRateLimited.mockResolvedValue(false)
    unifiedOpenAIScheduler.handleSuccessfulAccountUse.mockResolvedValue()
    unifiedOpenAIScheduler.removeAccountRateLimit.mockResolvedValue()
    unifiedOpenAIScheduler.markAccountUnauthorized.mockResolvedValue()
    unifiedOpenAIScheduler.markAccountRateLimited.mockResolvedValue()
    upstreamErrorHelper.markTempUnavailable.mockResolvedValue()
  })

  it('retries early upstream internal stream errors and only forwards the successful second stream', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockImplementation(
      async (_apiKeyData, _sessionHash, _requestedModel, options = {}) => {
        if (!options.excludedAccountIds || !options.excludedAccountIds.includes('acct-1')) {
          return { accountId: 'acct-1', accountType: 'openai' }
        }
        return { accountId: 'acct-2', accountType: 'openai' }
      }
    )

    openaiAccountService.getAccount.mockImplementation(async (accountId) => ({
      id: accountId,
      name: accountId === 'acct-1' ? 'First Account' : 'Second Account',
      accessToken: accountId === 'acct-1' ? 'token-1' : 'token-2',
      accountId: accountId === 'acct-1' ? 'chatgpt-acct-1' : 'chatgpt-acct-2',
      proxy: null
    }))

    const firstErrorStream = createSseStream([
      'event: error\n',
      'data: {"type":"error","message":"An error occurred while processing your request. Please include the request ID req-1 in your message."}\n\n'
    ])

    const secondSuccessStream = createSseStream([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_ok","status":"in_progress","model":"gpt-5.4"}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_ok","status":"completed","model":"gpt-5.4","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'
    ])

    axios.post
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'x-request-id': 'req-1' },
        data: firstErrorStream
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'x-request-id': 'req-2' },
        data: secondSuccessStream
      })

    const req = new PassThrough()
    req.apiKey = { id: 'key-1', permissions: ['openai'] }
    req.headers = { 'user-agent': 'codex_cli_rs/0.117.0', session_id: 'sess-1' }
    req.body = {
      model: 'gpt-5.4',
      stream: true,
      store: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with OK only.' }]
        }
      ]
    }
    req.path = '/responses'
    req.originalUrl = '/openai/responses'

    const res = createMockRes()

    await handleResponses(req, res)
    await res.finished

    expect(axios.post).toHaveBeenCalledTimes(2)
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledTimes(1)
    expect(unifiedOpenAIScheduler.handleSuccessfulAccountUse).toHaveBeenCalledWith(
      'acct-2',
      'openai',
      expect.any(String)
    )
    expect(res.statusCode).toBe(200)

    const output = res.writes.join('')
    expect(output).toContain('response.created')
    expect(output).toContain('"delta":"OK"')
    expect(output).not.toContain('An error occurred while processing your request')
    expect(output).not.toContain('req-1')
  })

  it('retries compact high demand errors before forwarding success', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockImplementation(
      async (_apiKeyData, _sessionHash, _requestedModel, options = {}) => {
        if (!options.excludedAccountIds || !options.excludedAccountIds.includes('acct-compact-1')) {
          return { accountId: 'acct-compact-1', accountType: 'openai' }
        }
        return { accountId: 'acct-compact-2', accountType: 'openai' }
      }
    )

    openaiAccountService.getAccount.mockImplementation(async (accountId) => ({
      id: accountId,
      name: accountId,
      accessToken: `${accountId}-token`,
      accountId,
      proxy: null
    }))

    const firstErrorStream = createSseStream([
      'event: error\n',
      `data: ${JSON.stringify({
        type: 'error',
        message:
          "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors."
      })}\n\n`
    ])

    const secondSuccessStream = createSseStream([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_compact","status":"in_progress","model":"gpt-5.4"}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"COMPACT_OK"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_compact","status":"completed","model":"gpt-5.4","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'
    ])

    axios.post
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'x-request-id': 'compact-req-1' },
        data: firstErrorStream
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'x-request-id': 'compact-req-2' },
        data: secondSuccessStream
      })

    const req = new PassThrough()
    req.apiKey = { id: 'key-compact', permissions: ['openai'] }
    req.headers = { 'user-agent': 'codex_cli_rs/0.117.0', session_id: 'sess-compact' }
    req.body = {
      model: 'gpt-5.4',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with OK only.' }]
        }
      ]
    }
    req.path = '/responses/compact'
    req.originalUrl = '/openai/responses/compact'

    const res = createMockRes()

    await handleResponses(req, res)
    await res.finished

    expect(axios.post).toHaveBeenCalledTimes(2)
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)

    const output = res.writes.join('')
    expect(output).toContain('COMPACT_OK')
    expect(output).not.toContain("We're currently experiencing high demand")
  })

  it('retries 429 on the same account before switching to another OpenAI account', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockImplementation(
      async (_apiKeyData, _sessionHash, _requestedModel, options = {}) => {
        if (!options.excludedAccountIds || !options.excludedAccountIds.includes('acct-429-1')) {
          return { accountId: 'acct-429-1', accountType: 'openai' }
        }
        return { accountId: 'acct-429-2', accountType: 'openai' }
      }
    )

    openaiAccountService.getAccount.mockImplementation(async (accountId) => ({
      id: accountId,
      name: accountId,
      accessToken: `${accountId}-token`,
      accountId,
      proxy: null
    }))

    axios.post
      .mockResolvedValueOnce({
        status: 429,
        headers: {},
        data: { error: { message: 'rate limited', resets_in_seconds: 30 } }
      })
      .mockResolvedValueOnce({
        status: 429,
        headers: {},
        data: { error: { message: 'rate limited', resets_in_seconds: 30 } }
      })
      .mockResolvedValueOnce({
        status: 429,
        headers: {},
        data: { error: { message: 'rate limited', resets_in_seconds: 30 } }
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: {
          id: 'resp-429-ok',
          model: 'gpt-5.4',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }
      })

    const req = new PassThrough()
    req.apiKey = { id: 'key-429', permissions: ['openai'] }
    req.headers = { 'user-agent': 'codex_cli_rs/0.117.0', session_id: 'sess-429' }
    req.body = {
      model: 'gpt-5.4',
      stream: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with OK only.' }]
        }
      ]
    }
    req.path = '/responses'
    req.originalUrl = '/openai/responses'

    const res = createMockRes()

    await handleResponses(req, res)
    await res.finished

    expect(axios.post).toHaveBeenCalledTimes(4)
    expect(unifiedOpenAIScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      'acct-429-1',
      'openai',
      expect.any(String),
      30
    )
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual(
      expect.objectContaining({
        id: 'resp-429-ok',
        model: 'gpt-5.4'
      })
    )
  })

  it('retries network connect failures on the same account before switching to another OpenAI account', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockImplementation(
      async (_apiKeyData, _sessionHash, _requestedModel, options = {}) => {
        if (!options.excludedAccountIds || !options.excludedAccountIds.includes('acct-net-1')) {
          return { accountId: 'acct-net-1', accountType: 'openai' }
        }
        return { accountId: 'acct-net-2', accountType: 'openai' }
      }
    )

    openaiAccountService.getAccount.mockImplementation(async (accountId) => ({
      id: accountId,
      name: accountId,
      accessToken: `${accountId}-token`,
      accountId,
      proxy: null
    }))

    const networkError = new Error(
      'Client network socket disconnected before secure TLS connection was established'
    )
    networkError.code = 'ECONNRESET'

    axios.post
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: {
          id: 'resp-net-ok',
          model: 'gpt-5.4',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }
      })

    const req = new PassThrough()
    req.apiKey = { id: 'key-net', permissions: ['openai'] }
    req.headers = { 'user-agent': 'codex_cli_rs/0.117.0', session_id: 'sess-net' }
    req.body = {
      model: 'gpt-5.4',
      stream: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with OK only.' }]
        }
      ]
    }
    req.path = '/responses'
    req.originalUrl = '/openai/responses'

    const res = createMockRes()

    await handleResponses(req, res)
    await res.finished

    expect(axios.post).toHaveBeenCalledTimes(4)
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'acct-net-1',
      'openai',
      502,
      null,
      expect.objectContaining({
        source: 'openai_network'
      })
    )
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual(
      expect.objectContaining({
        id: 'resp-net-ok',
        model: 'gpt-5.4'
      })
    )
  })
})
