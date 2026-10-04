// 数据导入控制器 - /api/dataset + /api/config
const express = require('express');
const db = require('../models/db');
const trainService = require('../services/trainService');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const logger = require('../middlewares/logger');

const router = express.Router();

// POST /api/dataset/download - 手动触发内置语料库导入
router.post('/download', (req, res) => {
  try {
    const corpusPath = config.corpus.path;
    if (!fs.existsSync(corpusPath)) {
      return res.status(404).json({ error: `内置语料库不存在: ${corpusPath}` });
    }

    const data = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));
    if (!Array.isArray(data)) {
      return res.status(400).json({ error: '语料库格式错误' });
    }

    // 导入到 corpus 表
    let imported = 0;
    const now = Date.now();
    for (const item of data) {
      if (!item.input || !item.output) continue;

      db.run(
        'INSERT OR IGNORE INTO corpus (input, output, source, created_at) VALUES (?, ?, ?, ?)',
        [item.input, item.output, 'builtin', now]
      );

      // 同时训练到 N-gram 权重
      trainService.manualTrain(item.input, item.output);
      imported++;
    }

    // 重建 FTS

    logger.info(`📚 内置语料库导入完成: ${imported} 组`);
    res.json({ success: true, imported, total: data.length });
  } catch (err) {
    logger.error('语料库导入失败', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dataset/status - 语料库状态
router.get('/status', (req, res) => {
  const corpusPath = config.corpus.path;
  let builtinExists = fs.existsSync(corpusPath);
  let builtinSize = 0;

  if (builtinExists) {
    try {
      const data = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));
      builtinSize = Array.isArray(data) ? data.length : 0;
    } catch (e) {}
  }

  const dbCount = db.query('SELECT COUNT(*) as c FROM corpus')[0].c;

  res.json({ builtinExists, builtinSize, importedInDB: dbCount });
});

// POST /api/dataset/import - 上传自定义 JSON 语料库
router.post('/import', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const data = req.body;
    if (!Array.isArray(data)) {
      return res.status(400).json({ error: '请求体必须是 JSON 数组' });
    }

    const now = Date.now();
    let imported = 0;
    for (const item of data) {
      if (!item.input || !item.output) continue;

      db.run(
        'INSERT INTO corpus (input, output, source, created_at) VALUES (?, ?, ?, ?)',
        [item.input, item.output, 'user_upload', now]
      );
      trainService.manualTrain(item.input, item.output);
      imported++;
    }

    res.json({ success: true, imported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dataset - 清空所有语料库
router.delete('/', (req, res) => {
  try {
    db.run('DELETE FROM corpus WHERE source != ?', ['builtin']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 配置 API =====

// GET /api/config - 获取当前配置
router.get('/', (req, res) => {
  res.json({
    saveStrategy: config.saveStrategy,
    fallbackStrategy: config.fallbackStrategy,
    defaultAI: config.defaultAI,
    proxy: config.proxy,
    simulate: config.simulate,
  });
});

// POST /api/config - 更新配置
router.post('/', express.json(), (req, res) => {
  try {
    const { saveStrategy, fallbackStrategy, defaultAI, proxy, simulate } = req.body;

    if (saveStrategy) {
      config.saveStrategy = { ...config.saveStrategy, ...saveStrategy };
      db.setSaveStrategy(config.saveStrategy.mode, config.saveStrategy.intervalSeconds);
    }
    if (fallbackStrategy) {
      config.fallbackStrategy = { ...config.fallbackStrategy, ...fallbackStrategy };
    }
    if (defaultAI) config.defaultAI = defaultAI;
    if (proxy) config.proxy = { ...config.proxy, ...proxy };
    if (simulate) config.simulate = { ...config.simulate, ...simulate };

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/keys - 更新 AI API Keys
router.post('/keys', express.json(), (req, res) => {
  try {
    const keys = req.body || {};
    for (const [provider, key] of Object.entries(keys)) {
      if (key && typeof key === 'string') {
        config.aiKeys[provider] = key;
      }
    }
    res.json({ success: true, updated: Object.keys(keys) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

