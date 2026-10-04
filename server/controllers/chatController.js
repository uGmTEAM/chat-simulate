// 对话控制器 - /api/chat
const express = require('express');
const db = require('../models/db');
const simulateService = require('../services/simulateService');
const modelService = require('../services/modelService');
const botCommands = require('../utils/botCommands');
const config = require('../config');
const { setupSSE } = require('../utils/stream');
const path = require('path');

const router = express.Router();

// 获取会话的模型目录（聊天会话有副本，训练会话直接用原模型）
function getSessionModelDir(sessionId) {
  if (!sessionId) return modelService.modelDir('default');
  try {
    const sessions = db.query('SELECT model_dir, model_id, type FROM sessions WHERE id = ?', [sessionId]);
    if (sessions.length > 0) {
      const s = sessions[0];
      // 聊天会话优先用副本（如果存在）
      if (s.model_dir && require('fs').existsSync(s.model_dir)) return s.model_dir;
      // 否则用绑定的原模型
      if (s.model_id) return modelService.modelDir(s.model_id);
    }
  } catch (e) {}
  return modelService.modelDir('default');
}

// 内存中活跃的生成任务（用于强制终止）
const activeGenerations = new Map();

// 获取会话最近 N 条历史（给生成当上下文）
function getRecentHistory(sessionId, limit = 10) {
  try {
    return db.query(
      'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      [sessionId, limit]
    ).reverse();
  } catch (e) { return []; }
}

// POST /api/chat - 发送消息
router.post('/', async (req, res) => {
  const { message, sessionId, stream: wantStream = true } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message 不能为空' });
  }

  // 会话锁定检查
  if (sessionId) {
    try {
      const sess = db.query('SELECT locked, locked_by FROM sessions WHERE id = ?', [sessionId])[0];
      if (sess && sess.locked) {
        const currentUser = req.user?.username || 'unknown';
        if (sess.locked_by !== currentUser) {
          return res.status(403).json({
            error: '会话已被锁定',
            locked_by: sess.locked_by,
            locked_at: sess.locked_at,
          });
        }
      }
    } catch (e) {}
  }

  // Bot 指令直接返回（非流式）
  const cmd = botCommands.parseCommand(message.trim());
  if (cmd) {
    try {
      const result = await cmd.handler(cmd.args, sessionId);
      if (sessionId) {
        db.run('INSERT INTO messages (session_id, role, content, thinking, created_at) VALUES (?, ?, ?, ?, ?)', [sessionId, 'user', message, '', Date.now()]);
        db.run('INSERT INTO messages (session_id, role, content, thinking, created_at) VALUES (?, ?, ?, ?, ?)', [sessionId, 'assistant', result, '', Date.now()]);
      }
      return res.json({ reply: result, source: 'command' });
    } catch (err) {
      return res.json({ reply: `指令执行失败: ${err.message}`, source: 'error' });
    }
  }

  // SSE 流式输出
  const sse = setupSSE(res);
  const genId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const state = { aborted: false };
  activeGenerations.set(genId, state);

  res.on('close', () => {
    state.aborted = true;
    activeGenerations.delete(genId);
  });

  try {
    sse.send('start', { genId, sessionId });

    // 保存用户消息
    if (sessionId) {
      db.run('INSERT INTO messages (session_id, role, content, thinking, created_at) VALUES (?, ?, ?, ?, ?)', [sessionId, 'user', message, '', Date.now()]);
      // 自动锁定会话给当前用户
      try { db.lockSession(sessionId, req.user?.username || 'unknown'); } catch (e) {}
    }

    // 拿历史上下文（不含刚插入的这条 user 消息）
    const history = sessionId ? getRecentHistory(sessionId, 8) : [];
    const modelDir = getSessionModelDir(sessionId);

    const shouldStop = () => state.aborted;

    let reply = '';
    let thinking = '';

    for await (const chunk of simulateService.streamGenerateWithContext(message, history, shouldStop, modelDir)) {
      if (state.aborted) break;

      if (chunk.type === 'stop') break;
      if (chunk.type === 'thinking_start') {
        sse.send('thinking_start', '');
      } else if (chunk.type === 'thinking_token') {
        thinking += chunk.text;
        sse.send('thinking_token', chunk.text);
      } else if (chunk.type === 'thinking_done') {
        thinking = chunk.text;
        sse.send('thinking_done', '');
      } else if (chunk.type === 'reply_start') {
        sse.send('reply_start', '');
      } else if (chunk.type === 'token') {
        reply += chunk.text;
        sse.send('token', chunk.text);
      } else if (chunk.type === 'done') {
        thinking = chunk.thinking || thinking;
        reply = chunk.reply || reply;
        break;
      }
    }

    // 保存 AI 回复（带 thinking）
    if (sessionId && reply) {
      db.run('INSERT INTO messages (session_id, role, content, thinking, created_at) VALUES (?, ?, ?, ?, ?)', [sessionId, 'assistant', reply, thinking, Date.now()]);

      // 自动训练暂时关闭 — 需要先有足够干净的种子数据才能自我学习，否则会越学越烂
      // 训练应通过 /api/models/:id/train 或 scripts/train-greetings.js 手动提供高质量 pairs
      try {
        // const modelDir = getSessionModelDir(sessionId);
        // simulateService.autoTrainFromDialogue(history, message, reply, modelDir);
      } catch (e) {
        logger?.warn?.('自动训练异常: ' + e.message);
      }
    }

    sse.end({ genId, stopped: state.aborted, length: reply.length, hasThinking: !!thinking });
  } catch (err) {
    sse.error(err.message);
  } finally {
    activeGenerations.delete(genId);
  }
});

// POST /api/chat/stop - 强制终止生成
router.post('/stop', (req, res) => {
  const { genId } = req.body || {};
  if (!genId) return res.status(400).json({ error: 'genId 必填' });
  const state = activeGenerations.get(genId);
  if (state) { state.aborted = true; res.json({ success: true, genId }); }
  else res.json({ success: false, error: '生成任务已不存在' });
});

// POST /api/chat/regenerate - 重新生成
router.post('/regenerate', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId 必填' });
  try {
    const lastUserMsg = db.query(
      "SELECT * FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
      [sessionId]
    )[0];
    if (!lastUserMsg) return res.status(404).json({ error: '没有找到用户消息' });

    db.run(
      "DELETE FROM messages WHERE session_id = ? AND role = 'assistant' AND created_at > ?",
      [sessionId, lastUserMsg.created_at]
    );

    const history = getRecentHistory(sessionId, 8);
    const result = simulateService.generateWithContext(lastUserMsg.content, history);

    if (result.reply) {
      db.run('INSERT INTO messages (session_id, role, content, thinking, created_at) VALUES (?, ?, ?, ?, ?)', [sessionId, 'assistant', result.reply, result.thinking, Date.now()]);
      simulateService.autoTrainFromDialogue(history, lastUserMsg.content, result.reply);
    }
    res.json({ reply: result.reply, thinking: result.thinking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


