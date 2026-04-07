#!/usr/bin/env node

require('dotenv').config()

const fs = require('fs/promises')
const path = require('path')

const openaiAccountService = require('../src/services/account/openaiAccountService')
const redis = require('../src/models/redis')

const DEFAULT_TOKENS_DIR = path.join(process.cwd(), 'tokens')
const DEFAULT_PROXY = {
  type: 'http',
  host: '127.0.0.1',
  port: 7890
}

function getTokensDir() {
  const cliArg = process.argv[2]
  if (cliArg && cliArg.trim()) {
    return path.resolve(cliArg.trim())
  }
  return DEFAULT_TOKENS_DIR
}

function getExistingAccountMatch(accounts, tokenData) {
  const email = typeof tokenData.email === 'string' ? tokenData.email.trim().toLowerCase() : ''
  const accountId =
    typeof tokenData.accountId === 'string' ? tokenData.accountId.trim().toLowerCase() : ''

  return (
    accounts.find((account) => {
      const accountEmail =
        typeof account.email === 'string' ? account.email.trim().toLowerCase() : ''
      const storedAccountId =
        typeof account.accountId === 'string' ? account.accountId.trim().toLowerCase() : ''

      if (email && accountEmail && email === accountEmail) {
        return true
      }

      if (accountId && storedAccountId && accountId === storedAccountId) {
        return true
      }

      return false
    }) || null
  )
}

async function getTokenFiles(tokensDir) {
  const entries = await fs.readdir(tokensDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(tokensDir, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

async function readTokenFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const data = JSON.parse(raw)
  const refreshToken =
    typeof data.refresh_token === 'string' ? data.refresh_token.trim() : ''

  if (!refreshToken) {
    throw new Error('refresh_token is missing')
  }

  return {
    sourceFile: filePath,
    refreshToken,
    email: typeof data.email === 'string' ? data.email.trim() : '',
    accountId: typeof data.account_id === 'string' ? data.account_id.trim() : ''
  }
}

async function createAndRefreshAccount(name, tokenData) {
  const created = await openaiAccountService.createAccount({
    name,
    openaiOauth: {
      refreshToken: tokenData.refreshToken
    },
    proxy: DEFAULT_PROXY
  })

  try {
    await openaiAccountService.refreshAccountToken(created.id)
    const refreshed = await openaiAccountService.getAccount(created.id)
    return {
      id: created.id,
      accountId: refreshed?.accountId || '',
      email: refreshed?.email || tokenData.email || ''
    }
  } catch (error) {
    await openaiAccountService.deleteAccount(created.id)
    throw error
  }
}

async function main() {
  await redis.connect()

  const tokensDir = getTokensDir()
  const tokenFiles = await getTokenFiles(tokensDir)

  if (tokenFiles.length === 0) {
    console.log(`No token json files found in ${tokensDir}`)
    return
  }

  const existingAccounts = await openaiAccountService.getAllAccounts()
  const results = []

  for (let index = 0; index < tokenFiles.length; index += 1) {
    const filePath = tokenFiles[index]
    const name = `free-${index}`

    try {
      const tokenData = await readTokenFile(filePath)
      const existing = getExistingAccountMatch(existingAccounts, tokenData)

      if (existing) {
        results.push({
          name,
          file: path.basename(filePath),
          status: 'skipped',
          reason: `already exists as ${existing.name} (${existing.id})`
        })
        continue
      }

      const created = await createAndRefreshAccount(name, tokenData)
      existingAccounts.push({
        id: created.id,
        name,
        email: created.email,
        accountId: created.accountId
      })
      results.push({
        name,
        file: path.basename(filePath),
        status: 'created',
        id: created.id,
        accountId: created.accountId || '-',
        email: created.email || '-'
      })
    } catch (error) {
      results.push({
        name,
        file: path.basename(filePath),
        status: 'failed',
        reason: error.message
      })
    }
  }

  console.log(JSON.stringify({ tokensDir, proxy: DEFAULT_PROXY, results }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await redis.disconnect()
    } catch (_) {
      // Ignore Redis shutdown errors for one-shot scripts.
    }
  })
