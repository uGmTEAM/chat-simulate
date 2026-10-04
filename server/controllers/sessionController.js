// 会话控制器 - /api/sessions
// 会话分两种: chat (聊天，模型副本隔离) / train (训练，直接操作原模型)
const express = require('express');
const db = require('../models/db');
const modelService = require('../services/modelService');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const router = express.Router();

// 生成会话内部 ID（用于文件夹命名）
function genSessionId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `sess_${ts}${rand}`;
}

// GET /api/sessions - 列出所有会话
router.get('/', (req, res) => {
  try {
    const sessions = db.query(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as msg_count 
       FROM sessions s ORDER BY s.updated_at DESC`
    );
    // 补充模型名称
    const models = modelService.listModels();
    const modelMap = {};
    for (const m of models) modelMap[m.id] = m.name;
    res.json(sessions.map(s => ({
      ...s,
      model_name: modelMap[s.model_id] || 'default',
      locked: !!s.locked,
      locked_by: s.locked_by || null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions - 创建新会话
// body: { name, type: 'chat'|'train', model_id }
router.post('/', (req, res) => {
  try {
    const type = req.body?.type || 'chat';
    const name = req.body?.name || `${type === 'train' ? '训练' : '聊天'}会话 ${new Date().toLocaleString()}`;
    const modelId = req.body?.model_id || 'default';
    const now = Date.now();
    const internalId = genSessionId();

    let modelDirForSession = null;

    if (type === 'chat') {
      // 聊天会话：复制模型到独立副本
      const chatDir = path.join(modelService.CHATS_DIR, internalId);
      modelDirForSession = path.join(chatDir, 'model');
      modelService.copyModel(modelId, modelDirForSession);
    } else {
      // 训练会话：直接用原模型目录
      modelDirForSession = modelService.modelDir(modelId);
    }

    db.run(
      'INSERT INTO sessions (name, type, model_id, model_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [name, type, modelId, modelDirForSession, now, now]
    );
    const id = db.lastInsertRowId();

    res.json({
      id, name, type, model_id: modelId, model_dir: modelDirForSession,
      created_at: now, updated_at: now,
      internal_id: internalId,
      model_isolation: type === 'chat' ? 'copied (isolated)' : 'shared (direct)',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id - 获取会话详情（含消息）
router.get('/:id', (req, res) => {
  try {
    const sessions = db.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (sessions.length === 0) return res.status(404).json({ error: '会话不存在' });
    const session = sessions[0];
    const messages = db.query(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ ...session, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sessions/:id - 重命名 / 切换模型（仅限 train 会话）
router.put('/:id', (req, res) => {
  try {
    const fields = [];
    const vals = [];
    if (req.body?.name) { fields.push('name = ?'); vals.push(req.body.name); }
    if (req.body?.model_id) {
      fields.push('model_id = ?');
      vals.push(req.body.model_id);
      // chat 会话: 重新复制新模型到 model_dir
      const sess = db.query('SELECT type FROM sessions WHERE id = ?', [req.params.id])[0];
      if (sess && sess.type === 'chat') {
        const newDir = path.join(modelService.DATA_DIR, 'chats', 'sess_' + req.params.id, 'model');
        modelService.copyModel(req.body.model_id, newDir);
        fields.push('model_dir = ?');
        vals.push(newDir);
      } else {
        // train 会话: 直接指向原模型目录
        fields.push('model_dir = ?');
        vals.push(modelService.modelDir(req.body.model_id));
      }
    }
    if (fields.length === 0) return res.json({ success: true });
    fields.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(req.params.id);
    db.run('UPDATE sessions SET ' + fields.join(', ') + ' WHERE id = ?', vals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id - 部分更新(跟 PUT 同逻辑)
router.patch('/:id', (req, res) => {
  const fields = [];
  const vals = [];
  if (req.body?.name) { fields.push('name = ?'); vals.push(req.body.name); }
  if (req.body?.model_id) {
    fields.push('model_id = ?');
    vals.push(req.body.model_id);
    const sess = db.query('SELECT type FROM sessions WHERE id = ?', [req.params.id])[0];
    if (sess && sess.type === 'chat') {
      const newDir = path.join(modelService.DATA_DIR, 'chats', 'sess_' + req.params.id, 'model');
      modelService.copyModel(req.body.model_id, newDir);
      fields.push('model_dir = ?');
      vals.push(newDir);
    } else {
      fields.push('model_dir = ?');
      vals.push(modelService.modelDir(req.body.model_id));
    }
  }
  if (fields.length === 0) return res.json({ success: true });
  fields.push('updated_at = ?');
  vals.push(Date.now());
  vals.push(req.params.id);
  db.run('UPDATE sessions SET ' + fields.join(', ') + ' WHERE id = ?', vals);
  res.json({ success: true });
});

// DELETE /api/sessions/:id - 删除会话（同时清理模型副本）
router.delete('/:id', (req, res) => {
  try {
    const sessions = db.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (sessions.length > 0 && sessions[0].model_dir && sessions[0].type === 'chat') {
      // 删除聊天会话的模型副本
      const chatDir = path.dirname(sessions[0].model_dir);
      if (fs.existsSync(chatDir)) fs.rmSync(chatDir, { recursive: true, force: true });
    }
    db.run('DELETE FROM messages WHERE session_id = ?', [req.params.id]);
    db.run('DELETE FROM sessions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 会话锁定状态
 * locked: boolean - 是否锁定
 * locked_by: string - 锁定者标识（可选）
 * locked_at: number - 锁定时间戳
 */

// POST /api/sessions/:id/export - 导出会话为 JSON
router.post('/:id/export', (req, res) => {
  try {
    const sessions = db.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (sessions.length === 0) return res.status(404).json({ error: '会话不存在' });
    const session = sessions[0];
    const messages = db.query(
      'SELECT role, content, thinking, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );

    const model = modelService.getModel(session.model_id);
    const dateStr = new Date(session.created_at).toISOString().replace(/[-T:]/g, '-').slice(0, 19);

    const exportData = {
      user: 'user',
      model_id: session.model_id,
      detail: {
        who: model?.botName || 'AI助手',
        datetime: dateStr,
        info: {
          session_type: session.type,
          session_name: session.name,
          total_turns: messages.length,
          model_isolation: session.type === 'chat' ? 'copied' : 'shared',
        },
      },
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        thinking: m.thinking || '',
        timestamp: m.created_at,
      })),
    };

    const exportDir = modelService.EXPORTS_DIR;
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    const fname = `session_${req.params.id}_${dateStr}.json`;
    const fpath = path.join(exportDir, fname);
    fs.writeFileSync(fpath, JSON.stringify(exportData, null, 2), 'utf8');

    res.json({ success: true, file: fname, path: fpath, data: exportData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/lock - 锁定会话
router.post('/:id/lock', (req, res) => {
  try {
    const sessions = db.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (sessions.length === 0) return res.status(404).json({ error: '会话不存在' });

    const lockedBy = req.body?.locked_by || 'system';
    const lockedAt = Date.now();

    db.run(
      'UPDATE sessions SET locked = ?, locked_by = ?, locked_at = ? WHERE id = ?',
      [true, lockedBy, lockedAt, req.params.id]
    );

    res.json({ success: true, locked: true, locked_by: lockedBy, locked_at: lockedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/unlock - 解锁会话
router.post('/:id/unlock', (req, res) => {
  try {
    const sessions = db.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (sessions.length === 0) return res.status(404).json({ error: '会话不存在' });

    db.run(
      'UPDATE sessions SET locked = ?, locked_by = NULL, locked_at = NULL WHERE id = ?',
      [false, req.params.id]
    );

    res.json({ success: true, locked: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id/lock-status - 查询锁定状态
router.get('/:id/lock-status', (req, res) => {
  try {
    const sessions = db.query('SELECT locked, locked_by, locked_at FROM sessions WHERE id = ?', [req.params.id]);
    if (sessions.length === 0) return res.status(404).json({ error: '会话不存在' });

    const { locked, locked_by, locked_at } = sessions[0];
    res.json({ locked: !!locked, locked_by, locked_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/unlock - admin 解锁任意会话
router.post('/unlock', (req, res) => {
  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'session_id 必填' });
    db.unlockSession(session_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
