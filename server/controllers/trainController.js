// 训练控制器 - /api/train + /api/ai-train/*
const express = require('express');
const db = require('../models/db');
const trainService = require('../services/trainService');
const aiTrainService = require('../services/aiTrainService');
const aiProvider = require('../services/aiProvider');
const snapshotService = require('../services/snapshotService');

const router = express.Router();

// POST /api/train - 手动训练
router.post('/', (req, res) => {
  const { input, output } = req.body || {};
  if (!input || !output) {
    return res.status(400).json({ error: 'input 和 output 都必填' });
  }

  try {
    const result = trainService.manualTrain(input, output, req.body.sessionId);
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 云训练 =====

// POST /api/train/cloud/start - 启动云训练
router.post('/cloud/start', async (req, res) => {
  const { provider, mode, maxRounds, contextWindowSize } = req.body || {};

  try {
    const task = await aiTrainService.startCloudTrain({
      provider, mode, maxRounds, contextWindowSize,
    });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/train/cloud/stop - 停止云训练
router.post('/cloud/stop', (req, res) => {
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: 'taskId 必填' });

  try {
    const task = aiTrainService.stopCloudTrain(taskId);
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/train/cloud/status - 查询训练状态
router.get('/cloud/status/:taskId?', (req, res) => {
  try {
    if (req.params.taskId) {
      res.json(aiTrainService.getCloudTrainStatus(req.params.taskId));
    } else {
      res.json(aiTrainService.listActiveTasks());
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/train/cloud/logs/:taskId - 获取训练日志
router.get('/cloud/logs/:taskId', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50');
    res.json(aiTrainService.getCloudTrainLogs(req.params.taskId, limit));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/train/providers - 列出可用 AI 供应商
router.get('/providers', (req, res) => {
  res.json(aiProvider.listProviders());
});

// POST /api/train/providers/test - 测试供应商连通性
router.post('/providers/test', async (req, res) => {
  const { provider } = req.body || {};
  if (!provider) return res.status(400).json({ error: 'provider 必填' });

  try {
    const result = await aiProvider.testProvider(provider);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/train/logs - 训练日志查询
router.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '50');
  const offset = parseInt(req.query.offset || '0');

  const logs = db.query(
    'SELECT * FROM train_logs ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
  res.json(logs);
});

module.exports = router;
