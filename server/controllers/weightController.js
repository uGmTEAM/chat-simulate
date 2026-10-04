// 权重控制器 - /api/weights + /api/tokens
const express = require('express');
const db = require('../models/db');

const router = express.Router();

// GET /api/weights - 查询 token 权重
router.get('/', (req, res) => {
  const { layer, limit, offset, keyword } = req.query;
  const limitNum = parseInt(limit || '100');
  const offsetNum = parseInt(offset || '0');

  try {
    let sql = 'SELECT * FROM token_weights';
    const params = [];
    const conditions = [];

    if (layer && ['char', 'word', 'sentence'].includes(layer)) {
      conditions.push('layer = ?');
      params.push(layer);
    }
    if (keyword) {
      conditions.push('(token LIKE ? OR context LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');

    sql += ' ORDER BY count DESC LIMIT ? OFFSET ?';
    params.push(limitNum, offsetNum);

    const rows = db.query(sql, params);

    // 总数
    let countSql = 'SELECT COUNT(*) as c FROM token_weights';
    if (conditions.length) countSql += ' WHERE ' + conditions.join(' AND ');
    const total = db.query(countSql, params.slice(0, -2))[0].c;

    res.json({ items: rows, total, limit: limitNum, offset: offsetNum });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/weights/adjust - 微调权重
router.post('/adjust', (req, res) => {
  const { id, delta, newWeight } = req.body || {};

  try {
    if (newWeight !== undefined) {
      db.run('UPDATE token_weights SET weight = ? WHERE id = ?', [newWeight, id]);
    } else if (delta !== undefined) {
      db.run(
        'UPDATE token_weights SET weight = MAX(0.1, MIN(10, weight + ?)) WHERE id = ?',
        [delta, id]
      );
    } else {
      return res.status(400).json({ error: 'delta 或 newWeight 必传一个' });
    }

    // 更新 FTS

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tokens/:id - 删除 token 权重
router.delete('/:id', (req, res) => {
  try {
    db.run('DELETE FROM token_weights WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/weights/stats - 权重统计
router.get('/stats', (req, res) => {
  try {
    const byLayer = db.query(
      'SELECT layer, COUNT(*) as count, SUM(count) as total_occurrences FROM token_weights GROUP BY layer'
    );
    const avgWeight = db.query('SELECT AVG(weight) as avg FROM token_weights')[0].avg;
    const topTokens = db.query(
      'SELECT layer, token, count, weight FROM token_weights ORDER BY count DESC LIMIT 20'
    );

    res.json({ byLayer, avgWeight, topTokens });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
