const express = require('express')

const { authenticateAdmin } = require('../../middleware/auth')
const localModelService = require('../../services/localModelService')
const logger = require('../../utils/logger')

const router = express.Router()

router.get('/local-model/status', authenticateAdmin, async (req, res) => {
  try {
    const status = await localModelService.getStatus()
    return res.json({ success: true, data: status })
  } catch (error) {
    logger.error('❌ Failed to get local model status:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get local model status', message: error.message })
  }
})

router.put('/local-model/enabled', authenticateAdmin, async (req, res) => {
  try {
    const { enabled } = req.body || {}

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' })
    }

    const status = await localModelService.setEnabled(enabled)
    return res.json({
      success: true,
      message: enabled ? 'Local model stack started' : 'Local model stack stopped',
      data: status
    })
  } catch (error) {
    logger.error('❌ Failed to toggle local model stack:', error)
    return res
      .status(500)
      .json({ error: 'Failed to toggle local model stack', message: error.message })
  }
})

module.exports = router
