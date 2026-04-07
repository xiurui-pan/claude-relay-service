const { IncrementalSSEParser } = require('./sseParser')
const { isUnstableUpstreamError } = require('./unstableUpstreamHelper')

const DEFAULT_OPENAI_STREAM_RETRY_PROBE_MS = Math.max(
  0,
  parseInt(process.env.OPENAI_STREAM_RETRY_PROBE_MS || '0', 10) || 0
)

function buildOpenAIStreamErrorPayload(eventData) {
  if (!eventData || typeof eventData !== 'object') {
    return null
  }

  if (eventData.type === 'response.failed') {
    const responseError = eventData.response?.error || {}
    return {
      error: {
        message: responseError.message || 'Response failed',
        type: responseError.type || 'server_error',
        code: responseError.code || null,
        status: responseError.status || responseError.statusCode || null
      }
    }
  }

  if (eventData.error && typeof eventData.error === 'object') {
    return { error: eventData.error }
  }

  if (eventData.type === 'error') {
    return {
      error: {
        message: eventData.message || 'Unknown error',
        type: eventData.type || 'server_error',
        code: eventData.code || null,
        status: eventData.status || eventData.statusCode || null
      }
    }
  }

  return null
}

function getOpenAIStreamErrorInfo(eventData) {
  const payload = buildOpenAIStreamErrorPayload(eventData)
  if (!payload) {
    return null
  }

  const errorObject = payload.error || {}
  const message = String(errorObject.message || eventData?.message || '').trim()
  const type = String(errorObject.type || '').trim().toLowerCase()
  const code = String(errorObject.code || '').trim().toLowerCase()

  let statusCode = Number(
    errorObject.status ||
      errorObject.statusCode ||
      eventData?.status ||
      eventData?.statusCode ||
      eventData?.response?.status ||
      eventData?.response?.statusCode
  )

  if (!Number.isFinite(statusCode)) {
    if (
      type === 'usage_limit_reached' ||
      type === 'rate_limit_error' ||
      type === 'rate_limit_exceeded'
    ) {
      statusCode = 429
    } else if (
      type === 'authentication_error' ||
      type === 'invalid_api_key' ||
      type === 'invalidated_oauth_token' ||
      code === 'invalidated_oauth_token'
    ) {
      statusCode = 401
    } else {
      statusCode = 500
    }
  }

  return {
    payload,
    message,
    type,
    code,
    statusCode
  }
}

function isRetryableOpenAIInternalMessage(message = '') {
  const value = String(message).toLowerCase()
  return (
    value.includes('an error occurred while processing your request') ||
    value.includes('please include the request id') ||
    value.includes("we're currently experiencing high demand") ||
    value.includes('we are currently experiencing high demand') ||
    value.includes('may cause temporary errors') ||
    value.includes('internal error') ||
    value.includes('server error')
  )
}

function classifyOpenAIStreamProbeEvent(eventData) {
  const errorInfo = getOpenAIStreamErrorInfo(eventData)
  if (!errorInfo) {
    return null
  }

  const { statusCode, type, code, payload, message } = errorInfo

  if (
    statusCode === 429 ||
    type === 'usage_limit_reached' ||
    type === 'rate_limit_error' ||
    type === 'rate_limit_exceeded'
  ) {
    return {
      action: 'rate_limit',
      statusCode: 429,
      payload,
      message,
      resetsInSeconds:
        payload?.error?.resets_in_seconds || payload?.error?.resets_in || eventData?.resets_in_seconds
    }
  }

  if (
    statusCode === 401 ||
    statusCode === 402 ||
    type === 'authentication_error' ||
    type === 'invalid_api_key' ||
    type === 'invalidated_oauth_token' ||
    code === 'invalidated_oauth_token'
  ) {
    return {
      action: 'unauthorized',
      statusCode,
      payload,
      message
    }
  }

  if (isUnstableUpstreamError(statusCode, payload) || isRetryableOpenAIInternalMessage(message)) {
    return {
      action: 'retryable_upstream_error',
      statusCode,
      payload,
      message
    }
  }

  return {
    action: 'forward_error',
    statusCode,
    payload,
    message
  }
}

function isMeaningfulOpenAIStreamEvent(eventData) {
  const type = String(eventData?.type || '').trim()
  if (!type) {
    return false
  }

  if (type === 'response.created' || type === 'response.in_progress') {
    return false
  }

  return true
}

async function observeInitialOpenAIStream(
  stream,
  waitMs = DEFAULT_OPENAI_STREAM_RETRY_PROBE_MS
) {
  if (!stream || typeof stream.on !== 'function') {
    return {
      action: 'forward',
      bufferedChunks: [],
      streamEnded: false
    }
  }

  return await new Promise((resolve, reject) => {
    const parser = new IncrementalSSEParser()
    const bufferedChunks = []
    let settled = false
    let timer = null
    let hasMeaningfulEvent = false

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
      }
      stream.removeListener?.('data', onData)
      stream.removeListener?.('end', onEnd)
      stream.removeListener?.('error', onError)
      try {
        stream.pause?.()
      } catch (_) {
        //
      }
    }

    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve({
        action: result?.action || 'forward',
        bufferedChunks,
        streamEnded: !!result?.streamEnded,
        errorInfo: result?.errorInfo || null
      })
    }

    const onData = (chunk) => {
      if (settled) {
        return
      }

      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bufferedChunks.push(bufferChunk)

      const events = parser.feed(bufferChunk.toString())
      for (const event of events) {
        if (event.type !== 'data' || !event.data) {
          continue
        }

        const classification = classifyOpenAIStreamProbeEvent(event.data)
        if (classification) {
          finish({
            action: classification.action === 'forward_error' ? 'forward' : classification.action,
            errorInfo: classification
          })
          return
        }

        if (isMeaningfulOpenAIStreamEvent(event.data)) {
          hasMeaningfulEvent = true
          finish({ action: 'forward' })
          return
        }
      }
    }

    const onEnd = () => {
      if (!hasMeaningfulEvent) {
        const classification = classifyOpenAIStreamProbeEvent({
          type: 'error',
          message: 'Upstream stream ended before any meaningful content was received',
          status: 502,
          code: 'STREAM_PREMATURE_END'
        })

        if (classification) {
          finish({
            action: classification.action === 'forward_error' ? 'retryable_upstream_error' : classification.action,
            errorInfo: classification
          })
          return
        }
      }

      finish({ action: 'forward', streamEnded: true })
    }

    const onError = (error) => {
      const classification = classifyOpenAIStreamProbeEvent({
        type: 'error',
        message: error?.message || 'Upstream stream error',
        code: error?.code || null,
        status: error?.statusCode || error?.status || null
      })

      if (classification && classification.action !== 'forward_error') {
        finish({
          action: classification.action,
          errorInfo: classification
        })
        return
      }

      if (bufferedChunks.length > 0) {
        finish({ action: 'forward', streamEnded: true })
        return
      }

      cleanup()
      reject(error)
    }

    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
    if (waitMs > 0) {
      timer = setTimeout(() => finish({ action: 'forward' }), waitMs)
    }
  })
}

module.exports = {
  DEFAULT_OPENAI_STREAM_RETRY_PROBE_MS,
  buildOpenAIStreamErrorPayload,
  getOpenAIStreamErrorInfo,
  isRetryableOpenAIInternalMessage,
  classifyOpenAIStreamProbeEvent,
  isMeaningfulOpenAIStreamEvent,
  observeInitialOpenAIStream
}
