// 历史消息控制器 - /api/history
const express = require('express');
const db = require('../models/db');

const router = express.Router();

// GET /api/history/:sessionId - 会话历史消息
router.get('/:sessionId', (req, res) => {
  try {
    const messages = db.query(
      'SELECT id, role, content, thinking, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC',
      [req.params.sessionId]
    );
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/history/message/:id - 更新消息（thinking 或 content）
router.patch('/message/:id', (req, res) => {
  try {
    const { thinking, content } = req.body || {};
    const fields = [];
    const values = [];
    if (thinking !== undefined) { fields.push('thinking = ?'); values.push(thinking); }
    if (content !== undefined) { fields.push('content = ?'); values.push(content); }
    if (fields.length === 0) return res.status(400).json({ error: '无更新字段' });
    values.push(req.params.id);
    db.run(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/history/message/:id - 删除单条消息
router.delete('/message/:id', (req, res) => {
  try {
    db.run('DELETE FROM messages WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

