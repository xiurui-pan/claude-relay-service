#!/usr/bin/env node

require('dotenv').config()

const openaiAccountService = require('../src/services/account/openaiAccountService')
const redis = require('../src/models/redis')

const FREE_NAME_PATTERN = /^free-\d+$/
const SOCKS5_PROXY = {
  type: 'socks5',
  host: '127.0.0.1',
  port: 7890
}

async function main() {
  await redis.connect()

  const accounts = await openaiAccountService.getAllAccounts()
  const targets = accounts.filter((account) => FREE_NAME_PATTERN.test(account.name || ''))

  const results = []

  for (const account of targets) {
    await openaiAccountService.updateAccount(account.id, {
      proxy: SOCKS5_PROXY
    })

    results.push({
      id: account.id,
      name: account.name,
      proxy: SOCKS5_PROXY
    })
  }

  console.log(
    JSON.stringify(
      {
        updatedCount: results.length,
        proxy: SOCKS5_PROXY,
        results
      },
      null,
      2
    )
  )
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
