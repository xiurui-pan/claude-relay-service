const { PassThrough } = require('stream')

const openaiRoutes = require('../src/routes/openaiRoutes')

const {
  isRetryableOpenAIInternalMessage,
  classifyOpenAIStreamProbeEvent,
  observeInitialOpenAIStream
} = openaiRoutes.__testables

describe('openaiRoutes stream retry logic', () => {
  it('treats upstream internal processing errors as retryable', () => {
    expect(
      isRetryableOpenAIInternalMessage(
        'An error occurred while processing your request. Please include the request ID 123 in your message.'
      )
    ).toBe(true)
  })

  it('treats compact high demand errors as retryable', () => {
    expect(
      isRetryableOpenAIInternalMessage(
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors."
      )
    ).toBe(true)
  })

  it('classifies high demand error events as retryable upstream errors', () => {
    const result = classifyOpenAIStreamProbeEvent({
      type: 'error',
      message:
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors."
    })

    expect(result).toBeTruthy()
    expect(result.action).toBe('retryable_upstream_error')
    expect(result.statusCode).toBe(500)
  })

  it('classifies invalidated oauth token events as unauthorized', () => {
    const result = classifyOpenAIStreamProbeEvent({
      type: 'response.failed',
      response: {
        error: {
          message: 'Encountered invalidated oauth token for user, failing request',
          type: 'authentication_error',
          code: 'invalidated_oauth_token'
        }
      }
    })

    expect(result).toBeTruthy()
    expect(result.action).toBe('unauthorized')
    expect(result.statusCode).toBe(401)
  })

  it('captures early retryable SSE errors before forwarding', async () => {
    const stream = new PassThrough()
    const pending = observeInitialOpenAIStream(stream, 200)

    stream.write(
      [
        'event: error',
        'data: {"type":"error","message":"An error occurred while processing your request. Please include the request ID abc in your message."}',
        '',
        ''
      ].join('\n')
    )
    stream.end()

    const result = await pending
    expect(result.action).toBe('retryable_upstream_error')
    expect(result.errorInfo).toBeTruthy()
    expect(result.errorInfo.message).toContain('An error occurred while processing your request')
    expect(result.bufferedChunks.length).toBeGreaterThan(0)
  })

  it('forwards normal early response events', async () => {
    const stream = new PassThrough()
    const pending = observeInitialOpenAIStream(stream, 200)

    stream.write(
      [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"OK"}',
        '',
        ''
      ].join('\n')
    )
    stream.end()

    const result = await pending
    expect(result.action).toBe('forward')
    expect(result.bufferedChunks.length).toBeGreaterThan(0)
  })
})
