import { ref, computed, onUnmounted } from 'vue'

export const useTestState = () => {
  // ========== 状态 ==========
  const testStatus = ref('idle') // idle, testing, success, error
  const responseText = ref('')
  const errorMessage = ref('')
  const testDuration = ref(0)
  const testStartTime = ref(null)
  const abortController = ref(null)

  // ========== 状态样式计算属性 ==========
  const statusStyleMap = {
    idle: {
      title: '准备就绪',
      card: 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50',
      iconBg: 'bg-gray-200 dark:bg-gray-700',
      icon: 'fa-hourglass-start',
      iconColor: 'text-gray-500 dark:text-gray-400',
      text: 'text-gray-700 dark:text-gray-300'
    },
    testing: {
      title: '正在测试...',
      card: 'border-blue-200 bg-blue-50 dark:border-blue-500/30 dark:bg-blue-900/20',
      iconBg: 'bg-blue-100 dark:bg-blue-500/30',
      icon: 'fa-spinner fa-spin',
      iconColor: 'text-blue-500 dark:text-blue-400',
      text: 'text-blue-700 dark:text-blue-300'
    },
    success: {
      title: '测试成功',
      card: 'border-green-200 bg-green-50 dark:border-green-500/30 dark:bg-green-900/20',
      iconBg: 'bg-green-100 dark:bg-green-500/30',
      icon: 'fa-check-circle',
      iconColor: 'text-green-500 dark:text-green-400',
      text: 'text-green-700 dark:text-green-300'
    },
    error: {
      title: '测试失败',
      card: 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-900/20',
      iconBg: 'bg-red-100 dark:bg-red-500/30',
      icon: 'fa-exclamation-circle',
      iconColor: 'text-red-500 dark:text-red-400',
      text: 'text-red-700 dark:text-red-300'
    }
  }

  const currentStyle = computed(() => statusStyleMap[testStatus.value] || statusStyleMap.idle)
  const statusTitle = computed(() => currentStyle.value.title)
  const statusCardClass = computed(() => currentStyle.value.card)
  const statusIconBgClass = computed(() => currentStyle.value.iconBg)
  const statusIcon = computed(() => currentStyle.value.icon)
  const statusIconClass = computed(() => currentStyle.value.iconColor)
  const statusTextClass = computed(() => currentStyle.value.text)

  const finishTest = (status, message = '') => {
    testStatus.value = status
    if (status === 'error') {
      errorMessage.value = message || '测试失败'
    }
    testDuration.value = Date.now() - testStartTime.value
  }

  const extractErrorMessage = (errorData, fallback) => {
    if (!errorData || typeof errorData !== 'object') {
      return fallback
    }
    if (typeof errorData.message === 'string' && errorData.message) {
      return errorData.message
    }
    if (typeof errorData.error === 'string' && errorData.error) {
      return errorData.error
    }
    if (typeof errorData.error?.message === 'string' && errorData.error.message) {
      return errorData.error.message
    }
    if (typeof errorData.msg === 'string' && errorData.msg) {
      return errorData.msg
    }
    if (typeof errorData.msg?.message === 'string' && errorData.msg.message) {
      return errorData.msg.message
    }
    if (typeof errorData.msg?.error?.message === 'string' && errorData.msg.error.message) {
      return errorData.msg.error.message
    }
    return fallback
  }

  // ========== SSE 事件处理 ==========
  const handleWrappedSSEEvent = (data) => {
    switch (data.type) {
      case 'test_start':
        break
      case 'content':
        responseText.value += data.text
        break
      case 'message_stop':
        break
      case 'test_complete':
        if (data.success) {
          finishTest('success')
        } else {
          finishTest('error', data.error || '测试失败')
        }
        break
      case 'error':
        finishTest('error', data.error || '未知错误')
        break
    }
  }

  const appendOpenAIText = (data) => {
    if (typeof data.delta === 'string' && data.delta) {
      responseText.value += data.delta
      return
    }
    if (typeof data.delta?.text === 'string' && data.delta.text) {
      responseText.value += data.delta.text
      return
    }
    if (typeof data.part?.text === 'string' && data.part.text) {
      responseText.value += data.part.text
    }
  }

  const handleOpenAIResponsesEvent = (eventName, data) => {
    const effectiveType = eventName || data?.type

    switch (effectiveType) {
      case 'response.output_text.delta':
      case 'response.content_part.delta':
      case 'response.output_text.added':
      case 'response.content_part.added':
        appendOpenAIText(data || {})
        break
      case 'response.completed':
        finishTest('success')
        break
      case 'response.failed':
      case 'response.incomplete':
      case 'error':
        finishTest(
          'error',
          extractErrorMessage(data, data?.status_details?.error?.message || '测试失败')
        )
        break
      default:
        break
    }
  }

  // ========== SSE 流读取 ==========
  const readSSEStream = async (response, options = {}) => {
    const { mode = 'wrapped' } = options
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let streamDone = false
    let buffer = ''

    while (!streamDone) {
      const { done, value } = await reader.read()
      if (done) {
        streamDone = true
        processSSEBuffer(buffer, mode, true)
        continue
      }

      buffer += decoder.decode(value, { stream: true })
      buffer = processSSEBuffer(buffer, mode)
    }

    if (testStatus.value === 'testing') {
      if (mode === 'openaiResponses') {
        finishTest('success')
      } else if (responseText.value) {
        finishTest('success')
      }
    }
  }

  const processSSEBuffer = (buffer, mode, flush = false) => {
    const normalizedBuffer = buffer.replace(/\r\n/g, '\n')
    const chunks = normalizedBuffer.split('\n\n')
    const pending = flush ? '' : chunks.pop() || ''

    for (const chunk of chunks) {
      processSSEChunk(chunk, mode)
    }

    if (flush && pending.trim()) {
      processSSEChunk(pending, mode)
    }

    return pending
  }

  const processSSEChunk = (chunk, mode) => {
    const lines = chunk.split('\n')
    let eventName = ''
    const dataLines = []

    for (const rawLine of lines) {
      const line = rawLine.trimEnd()
      if (!line) {
        continue
      }
      if (line.startsWith(':')) {
        continue
      }
      if (line.startsWith('event:')) {
        eventName = line.substring(6).trim()
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.substring(5).trimStart())
      }
    }

    if (!dataLines.length) {
      return
    }

    const payload = dataLines.join('\n')
    if (!payload || payload === '[DONE]') {
      return
    }

    try {
      const data = JSON.parse(payload)
      if (mode === 'openaiResponses') {
        handleOpenAIResponsesEvent(eventName, data)
      } else {
        handleWrappedSSEEvent(data)
      }
    } catch {
      if (mode === 'openaiResponses' && payload) {
        responseText.value += payload
      }
    }
  }

  const parseErrorResponse = async (response) => {
    const fallback = `HTTP ${response.status}`
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      try {
        const errorData = await response.json()
        return extractErrorMessage(errorData, fallback)
      } catch {
        return fallback
      }
    }
    const text = await response.text().catch(() => '')
    if (!text) {
      return fallback
    }
    try {
      return extractErrorMessage(JSON.parse(text), fallback)
    } catch {
      return text.length <= 300 ? text : fallback
    }
  }

  // ========== 通用测试请求 ==========
  const sendTestRequest = async (endpoint, payload, options = {}) => {
    const { useSSE = true, headers = {}, sseMode = 'wrapped' } = options

    // 重置状态
    testStatus.value = 'testing'
    responseText.value = ''
    errorMessage.value = ''
    testDuration.value = 0
    testStartTime.value = Date.now()

    // 取消之前的请求
    if (abortController.value) {
      abortController.value.abort()
    }
    abortController.value = new AbortController()

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: abortController.value.signal
      })

      if (!response.ok) {
        throw new Error(await parseErrorResponse(response))
      }

      if (useSSE) {
        await readSSEStream(response, { mode: sseMode })
      } else {
        // JSON 响应
        const data = await response.json()
        if (data.success) {
          finishTest('success')
          responseText.value = data.data?.responseText || 'Test passed'
        } else {
          finishTest('error', data.message || 'Test failed')
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      finishTest('error', err.message || '连接失败')
    }
  }

  // ========== 重置 + 清理 ==========
  const resetState = () => {
    testStatus.value = 'idle'
    responseText.value = ''
    errorMessage.value = ''
    testDuration.value = 0
    testStartTime.value = null
  }

  const cleanup = () => {
    if (abortController.value) {
      abortController.value.abort()
      abortController.value = null
    }
  }

  onUnmounted(cleanup)

  return {
    testStatus,
    responseText,
    errorMessage,
    testDuration,
    statusTitle,
    statusCardClass,
    statusIconBgClass,
    statusIcon,
    statusIconClass,
    statusTextClass,
    sendTestRequest,
    resetState,
    cleanup
  }
}
