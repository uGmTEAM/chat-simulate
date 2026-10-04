// 统计控制器 - /api/stats + /api/commands
const express = require('express');
const db = require('../models/db');
const { COMMANDS } = require('../utils/botCommands');

const router = express.Router();

// GET /api/stats - 总体统计
router.get('/', (req, res) => {
  try {
    const tokenCount = db.query('SELECT COUNT(*) as c FROM token_weights')[0].c;
    const tokenByLayer = db.query(
      'SELECT layer, COUNT(*) as c FROM token_weights GROUP BY layer'
    );
    const sessionCount = db.query('SELECT COUNT(*) as c FROM sessions')[0].c;
    const msgCount = db.query('SELECT COUNT(*) as c FROM messages')[0].c;
    const corpusCount = db.query('SELECT COUNT(*) as c FROM corpus')[0].c;
    const trainCount = db.query("SELECT COUNT(*) as c FROM train_logs WHERE status='completed'")[0].c;
    const trainLogs = db.query(
      'SELECT type, COUNT(*) as c FROM train_logs GROUP BY type'
    );
    const recentTrains = db.query(
      'SELECT * FROM train_logs ORDER BY started_at DESC LIMIT 10'
    );

    // 数据库文件大小
    const fs = require('fs');
    const path = require('path');
    const dbPath = path.resolve(__dirname, '../../data/sqlite.db');
    let dbSize = 0;
    try { dbSize = fs.statSync(dbPath).size; } catch (e) {}

    res.json({
      tokenCount,
      tokenByLayer,
      sessionCount,
      msgCount,
      corpusCount,
      trainCount,
      trainLogs,
      recentTrains,
      dbSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/commands - 列出所有 Bot 指令
router.get('/commands', (req, res) => {
  const commands = Object.entries(COMMANDS).map(([cmd, info]) => ({
    cmd,
    description: info.description,
  }));
  res.json(commands);
});

module.exports = router;
