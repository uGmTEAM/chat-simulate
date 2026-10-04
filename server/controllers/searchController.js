// 搜索控制器 - 使用 LIKE 模糊搜索（sql.js 默认不含 FTS5）
const express = require('express');
const db = require('../models/db');

const router = express.Router();

// GET /api/search/history - 搜索对话历史
router.get('/history', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q 必填' });
  const like = `%${q}%`;

  try {
    const limit = parseInt(req.query.limit || '20');
    const results = db.query(
      `SELECT m.id, m.role, m.content, m.created_at, s.name as session_name
       FROM messages m
       LEFT JOIN sessions s ON s.id = m.session_id
       WHERE m.content LIKE ?
       ORDER BY m.created_at DESC
       LIMIT ?`,
      [like, limit]
    );
    res.json({ results, query: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search/weights - 搜索 token 权重
router.get('/weights', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q 必填' });
  const like = `%${q}%`;

  try {
    const limit = parseInt(req.query.limit || '50');
    const results = db.query(
      `SELECT t.id, t.layer, t.context, t.token, t.count, t.weight
       FROM token_weights t
       WHERE t.token LIKE ? OR t.context LIKE ?
       ORDER BY t.count DESC
       LIMIT ?`,
      [like, like, limit]
    );
    res.json({ results, query: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search/corpus - 搜索训练语料库
router.get('/corpus', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q 必填' });
  const like = `%${q}%`;

  try {
    const limit = parseInt(req.query.limit || '20');
    const results = db.query(
      `SELECT c.id, c.input, c.output, c.source, c.created_at
       FROM corpus c
       WHERE c.input LIKE ? OR c.output LIKE ?
       ORDER BY c.created_at DESC
       LIMIT ?`,
      [like, like, limit]
    );
    res.json({ results, query: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
