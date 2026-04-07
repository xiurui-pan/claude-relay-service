const { getSafeMessage, mapToErrorCode } = require('../src/utils/errorSanitizer')

describe('errorSanitizer OpenAI relay messages', () => {
  it('maps temporarily unusable OpenAI account pool to service unavailable', () => {
    const error = new Error('No available OpenAI accounts are currently usable for model: gpt-5.4')
    error.statusCode = 503

    expect(mapToErrorCode(error).code).toBe('E001')
    expect(getSafeMessage(error)).toBe('Service temporarily unavailable')
  })

  it('maps unsupported requested model to model not available', () => {
    const error = new Error('No available OpenAI accounts support the requested model: gpt-5.4')
    error.statusCode = 400

    expect(mapToErrorCode(error).code).toBe('E006')
    expect(getSafeMessage(error)).toBe('Model not available')
  })

  it('keeps structured upstream 502 payloads out of internal server error', () => {
    const payload = {
      error: {
        message: '上游服务暂时不可用，请稍后重试',
        type: 'upstream_service_unavailable',
        code: 'upstream_service_unavailable',
        status: 502
      }
    }

    expect(mapToErrorCode(payload).code).toBe('E007')
    expect(getSafeMessage(payload)).toBe('Upstream service error')
  })
})
