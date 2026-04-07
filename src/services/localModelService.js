const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const axios = require('axios')

const redis = require('../models/redis')
const logger = require('../utils/logger')
const claudeConsoleAccountService = require('./account/claudeConsoleAccountService')

class LocalModelService {
  constructor() {
    this.settingsKey = 'system:local_model:settings'
    this.accountIdKey = 'system:local_model:claude_console_account_id'
  }

  getDefaults() {
    const runtimeRoot =
      process.env.LOCAL_MODEL_RUNTIME_ROOT || '/mnt/n0n1/tmp_assets/local-model-runtime'
    const logsDir = process.env.LOCAL_MODEL_LOG_DIR || '/mnt/n0n1/tmp_assets/logs'

    return {
      enabled: false,
      accountName: process.env.LOCAL_MODEL_ACCOUNT_NAME || 'Local Qwopus via CCR',
      ccrApiKey: process.env.LOCAL_MODEL_CCR_API_KEY || '',
      llama: {
        binPath:
          process.env.LOCAL_MODEL_LLAMA_BIN ||
          '/mnt/n0n1/tmp_assets/llama.cpp/build/bin/llama-server',
        modelPath:
          process.env.LOCAL_MODEL_LLAMA_MODEL ||
          '/mnt/n0n1/tmp_assets/models/Qwopus3.5-27B-v3-GGUF/Qwopus3.5-27B-v3-Q6_K.gguf',
        mmprojPath:
          process.env.LOCAL_MODEL_LLAMA_MMPROJ ||
          '/mnt/n0n1/tmp_assets/models/Qwopus3.5-27B-v3-GGUF/mmproj.gguf',
        host: process.env.LOCAL_MODEL_LLAMA_HOST || '127.0.0.1',
        port: parseInt(process.env.LOCAL_MODEL_LLAMA_PORT || '38080', 10),
        ctxSize: parseInt(process.env.LOCAL_MODEL_LLAMA_CTX || '8192', 10),
        batchSize: parseInt(process.env.LOCAL_MODEL_LLAMA_BATCH || '4096', 10),
        ubatchSize: parseInt(process.env.LOCAL_MODEL_LLAMA_UBATCH || '2048', 10),
        parallel: parseInt(process.env.LOCAL_MODEL_LLAMA_PARALLEL || '1', 10),
        gpuLayers: process.env.LOCAL_MODEL_LLAMA_GPU_LAYERS || '999',
        pidFile: process.env.LOCAL_MODEL_LLAMA_PID || path.join(runtimeRoot, 'llama-server.pid'),
        logFile: process.env.LOCAL_MODEL_LLAMA_LOG || path.join(logsDir, 'local-qwopus-llama.log')
      },
      ccr: {
        binPath:
          process.env.LOCAL_MODEL_CCR_BIN ||
          '/mnt/n0n1/tmp_assets/claude-code-router/node_modules/.bin/ccr',
        homeDir: process.env.LOCAL_MODEL_CCR_HOME || runtimeRoot,
        host: process.env.LOCAL_MODEL_CCR_HOST || '127.0.0.1',
        port: parseInt(process.env.LOCAL_MODEL_CCR_PORT || '3456', 10),
        providerName: process.env.LOCAL_MODEL_CCR_PROVIDER || 'llama',
        modelAlias: process.env.LOCAL_MODEL_CCR_MODEL_ALIAS || 'qwopus-27b-q6',
        pidFile: process.env.LOCAL_MODEL_CCR_PID || path.join(runtimeRoot, 'ccr.pid'),
        logFile: process.env.LOCAL_MODEL_CCR_LOG || path.join(logsDir, 'local-qwopus-ccr.log')
      }
    }
  }

  async getSettings() {
    const defaults = this.getDefaults()
    const client = redis.getClient()
    const raw = await client.get(this.settingsKey)

    if (!raw) {
      return defaults
    }

    try {
      const parsed = JSON.parse(raw)
      return {
        ...defaults,
        ...parsed,
        llama: {
          ...defaults.llama,
          ...(parsed.llama || {})
        },
        ccr: {
          ...defaults.ccr,
          ...(parsed.ccr || {})
        }
      }
    } catch (error) {
      logger.warn('⚠️ Failed to parse local model settings, using defaults', error.message)
      return defaults
    }
  }

  async saveSettings(settings) {
    const client = redis.getClient()
    await client.set(this.settingsKey, JSON.stringify(settings))
    return settings
  }

  async getStatus() {
    const settings = await this.getSettings()
    const accountId = await redis.getClient().get(this.accountIdKey)
    const account = accountId ? await claudeConsoleAccountService.getAccount(accountId) : null
    const llamaRunning = await this.isLlamaHealthy(settings)
    const ccrRunning = await this.isCcrHealthy(settings)

    return {
      enabled: settings.enabled === true,
      account: account
        ? {
            id: account.id,
            name: account.name,
            isActive: account.isActive,
            apiUrl: account.apiUrl,
            supportedModels: account.supportedModels
          }
        : null,
      llama: {
        running: llamaRunning,
        url: this.getLlamaBaseUrl(settings),
        modelPath: settings.llama.modelPath,
        logFile: settings.llama.logFile,
        pidFile: settings.llama.pidFile
      },
      ccr: {
        running: ccrRunning,
        url: this.getCcrBaseUrl(settings),
        configPath: this.getCcrConfigPath(settings),
        logFile: settings.ccr.logFile,
        pidFile: settings.ccr.pidFile,
        modelAlias: settings.ccr.modelAlias
      }
    }
  }

  async setEnabled(enabled) {
    const settings = await this.getSettings()
    settings.enabled = enabled === true
    settings.ccrApiKey = settings.ccrApiKey || this.generateApiKey()
    await this.saveSettings(settings)

    if (settings.enabled) {
      try {
        await this.startStack(settings)
        await this.ensureClaudeConsoleAccount(settings, true)
      } catch (error) {
        settings.enabled = false
        await this.saveSettings(settings)
        await this.ensureClaudeConsoleAccount(settings, false).catch(() => {})
        await this.stopStack(settings).catch(() => {})
        throw error
      }
    } else {
      let accountError = null
      let stopError = null

      try {
        await this.ensureClaudeConsoleAccount(settings, false)
      } catch (error) {
        accountError = error
      }

      try {
        await this.stopStack(settings)
      } catch (error) {
        stopError = error
      }

      if (accountError || stopError) {
        throw stopError || accountError
      }
    }

    return await this.getStatus()
  }

  async startStack(settings) {
    this.ensureFileExists(settings.llama.binPath, 'llama-server binary')
    this.ensureFileExists(settings.llama.modelPath, 'llama model')
    this.ensureFileExists(settings.llama.mmprojPath, 'llama mmproj')
    this.ensureFileExists(settings.ccr.binPath, 'CCR binary')

    this.ensureDir(path.dirname(settings.llama.logFile))
    this.ensureDir(path.dirname(settings.ccr.logFile))
    this.ensureDir(path.dirname(settings.llama.pidFile))
    this.ensureDir(path.dirname(settings.ccr.pidFile))
    this.ensureDir(path.dirname(this.getCcrConfigPath(settings)))

    await this.writeCcrConfig(settings)

    if (!(await this.isLlamaHealthy(settings))) {
      await this.startLlamaServer(settings)
    }

    if (await this.isCcrHealthy(settings)) {
      await this.stopCcr(settings)
    }

    await this.startCcr(settings)
  }

  async stopStack(settings) {
    await this.stopCcr(settings)
    await this.stopLlamaServer(settings)
  }

  async ensureClaudeConsoleAccount(settings, shouldBeActive) {
    const client = redis.getClient()
    let accountId = await client.get(this.accountIdKey)
    let account = accountId ? await claudeConsoleAccountService.getAccount(accountId) : null

    if (!account) {
      const accounts = await claudeConsoleAccountService.getAllAccounts()
      account = accounts.find((item) => item.name === settings.accountName) || null
      if (account) {
        accountId = account.id
        await client.set(this.accountIdKey, accountId)
      }
    }

    const payload = {
      name: settings.accountName,
      description: 'Managed by local model switch',
      apiUrl: this.getCcrBaseUrl(settings),
      apiKey: settings.ccrApiKey,
      priority: 100,
      supportedModels: this.getClaudeModelMappings(settings.ccr.modelAlias),
      userAgent: 'claude-relay-service/local-qwopus',
      rateLimitDuration: 1,
      accountType: 'shared',
      dailyQuota: 0,
      quotaResetTime: '00:00',
      maxConcurrentTasks: 0,
      disableAutoProtection: false,
      interceptWarmup: false,
      isActive: shouldBeActive
    }

    if (!account) {
      const created = await claudeConsoleAccountService.createAccount(payload)
      await client.set(this.accountIdKey, created.id)
      return created
    }

    await claudeConsoleAccountService.updateAccount(account.id, payload)
    return await claudeConsoleAccountService.getAccount(account.id)
  }

  getClaudeModelMappings(targetModel) {
    const models = [
      'default',
      'best',
      'opus',
      'sonnet',
      'haiku',
      'opusplan',
      'opus[1m]',
      'sonnet[1m]',
      'claude-opus-4-6',
      'claude-opus-4-6[1m]',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6[1m]',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-20250514',
      'claude-opus-4-1-20250805',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-5-20250929',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-haiku-20240307'
    ]

    return models.reduce((acc, model) => {
      acc[model] = targetModel
      return acc
    }, {})
  }

  async writeCcrConfig(settings) {
    const config = {
      HOST: settings.ccr.host,
      PORT: settings.ccr.port,
      APIKEY: settings.ccrApiKey,
      LOG: true,
      NON_INTERACTIVE_MODE: true,
      Providers: [
        {
          name: settings.ccr.providerName,
          api_base_url: `${this.getLlamaBaseUrl(settings)}/v1/chat/completions`,
          api_key: 'local',
          models: [settings.ccr.modelAlias]
        }
      ],
      Router: {
        default: `${settings.ccr.providerName},${settings.ccr.modelAlias}`,
        background: `${settings.ccr.providerName},${settings.ccr.modelAlias}`,
        think: `${settings.ccr.providerName},${settings.ccr.modelAlias}`,
        longContext: `${settings.ccr.providerName},${settings.ccr.modelAlias}`,
        webSearch: `${settings.ccr.providerName},${settings.ccr.modelAlias}`
      }
    }

    fs.writeFileSync(this.getCcrConfigPath(settings), `${JSON.stringify(config, null, 2)}\n`)
  }

  async isLlamaHealthy(settings) {
    try {
      const response = await axios.get(`${this.getLlamaBaseUrl(settings)}/v1/models`, {
        timeout: 2000
      })
      return response.status === 200
    } catch {
      return false
    }
  }

  async isCcrHealthy(settings) {
    try {
      const response = await axios.get(`${this.getCcrBaseUrl(settings)}/health`, {
        timeout: 2000
      })
      return response.status === 200
    } catch {
      return false
    }
  }

  async startLlamaServer(settings) {
    logger.info('🚀 Starting local llama-server')
    const args = [
      '-m',
      settings.llama.modelPath,
      '--mmproj',
      settings.llama.mmprojPath,
      '-ngl',
      String(settings.llama.gpuLayers),
      '-c',
      String(settings.llama.ctxSize),
      '-b',
      String(settings.llama.batchSize),
      '-ub',
      String(settings.llama.ubatchSize),
      '-np',
      String(settings.llama.parallel),
      '--host',
      settings.llama.host,
      '--port',
      String(settings.llama.port)
    ]

    const out = fs.openSync(settings.llama.logFile, 'a')
    const child = spawn(settings.llama.binPath, args, {
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        http_proxy: '',
        https_proxy: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        all_proxy: '',
        ALL_PROXY: ''
      }
    })
    child.unref()
    fs.writeFileSync(settings.llama.pidFile, String(child.pid))

    await this.waitForHealth(() => this.isLlamaHealthy(settings), 120000, 2000)
  }

  async stopLlamaServer(settings) {
    logger.info('🛑 Stopping local llama-server')
    const pids = new Set()
    const managedPid = this.readPid(settings.llama.pidFile)
    if (managedPid) {
      pids.add(managedPid)
    }

    for (const pid of this.findPidsByPort(settings.llama.port)) {
      pids.add(pid)
    }

    for (const pid of pids) {
      this.killPid(pid)
    }

    this.removeFile(settings.llama.pidFile)
    await this.waitForStop(() => this.isLlamaHealthy(settings), 30000, 1000)
  }

  async startCcr(settings) {
    logger.info('🚀 Starting local CCR')
    const out = fs.openSync(settings.ccr.logFile, 'a')
    const child = spawn(settings.ccr.binPath, ['start'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        HOME: settings.ccr.homeDir
      }
    })
    child.unref()
    fs.writeFileSync(settings.ccr.pidFile, String(child.pid))

    await this.waitForHealth(() => this.isCcrHealthy(settings), 30000, 1000)
  }

  async stopCcr(settings) {
    logger.info('🛑 Stopping local CCR')
    spawnSync(settings.ccr.binPath, ['stop'], {
      env: {
        ...process.env,
        HOME: settings.ccr.homeDir
      },
      stdio: 'ignore'
    })

    const managedPid = this.readPid(settings.ccr.pidFile)
    if (managedPid) {
      this.killPid(managedPid)
    }

    this.removeFile(settings.ccr.pidFile)
    await this.waitForStop(() => this.isCcrHealthy(settings), 10000, 500)
  }

  generateApiKey() {
    return `sk-local-${crypto.randomBytes(18).toString('hex')}`
  }

  getLlamaBaseUrl(settings) {
    return `http://${settings.llama.host}:${settings.llama.port}`
  }

  getCcrBaseUrl(settings) {
    return `http://${settings.ccr.host}:${settings.ccr.port}`
  }

  getCcrConfigPath(settings) {
    return path.join(settings.ccr.homeDir, '.claude-code-router', 'config.json')
  }

  ensureFileExists(filePath, label) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`${label} not found: ${filePath}`)
    }
  }

  ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true })
  }

  readPid(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return null
      }
      const pid = parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10)
      return Number.isFinite(pid) ? pid : null
    } catch {
      return null
    }
  }

  removeFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch {
      // noop
    }
  }

  findPidsByPort(port) {
    const result = spawnSync('lsof', [`-tiTCP:${String(port)}`, '-sTCP:LISTEN'], {
      encoding: 'utf8'
    })
    if (result.status !== 0 || !result.stdout) {
      return []
    }

    return result.stdout
      .split(/\s+/)
      .map((item) => parseInt(item, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid)
  }

  killPid(pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < 5000) {
      if (!this.isProcessRunning(pid)) {
        return
      }
    }

    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // noop
    }
  }

  isProcessRunning(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async waitForHealth(checkFn, timeoutMs, intervalMs) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (await checkFn()) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    throw new Error('Service startup timed out')
  }

  async waitForStop(checkFn, timeoutMs, intervalMs) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (!(await checkFn())) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
}

module.exports = new LocalModelService()
