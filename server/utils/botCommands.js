// Bot 对话内指令解析
// 用户在对话中输入 /help, /save 等指令时触发
const db = require('../models/db');
const ngram = require('./ngram');
const logger = require('../middlewares/logger');

const COMMANDS = {
  '/help': {
    description: '显示所有可用指令',
    handler: handleHelp,
  },
  '/reset': {
    description: '重置当前会话',
    handler: handleReset,
  },
  '/save': {
    description: '手动保存权重到数据库',
    handler: handleSave,
  },
  '/stats': {
    description: '显示统计信息',
    handler: handleStats,
  },
  '/search': {
    description: '/search <关键词> - 搜索对话历史',
    handler: handleSearch,
  },
  '/weights': {
    description: '/weights <关键词> - 搜索相关 token 权重',
    handler: handleWeights,
  },
  '/snapshots': {
    description: '列出所有快照',
    handler: handleSnapshots,
  },
  '/rollback': {
    description: '恢复到最近一次快照',
    handler: handleRollback,
  },
  '/config': {
    description: '显示当前配置',
    handler: handleConfig,
  },
};

function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');
  if (COMMANDS[cmd]) {
    return { cmd, args, handler: COMMANDS[cmd].handler };
  }
  return null;
}

async function executeCommand(command, sessionId) {
  return await command.handler(command.args, sessionId);
}

// ===== 各指令实现 =====

function handleHelp() {
  const lines = Object.entries(COMMANDS).map(([cmd, info]) => `  ${cmd} - ${info.description}`);
  return '📋 可用指令:\n' + lines.join('\n');
}

function handleReset(args, sessionId) {
  if (sessionId) {
    db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
  }
  return '🔄 当前会话已重置';
}

function handleSave() {
  const ok = db.save();
  return ok ? '✅ 权重已保存到数据库' : '❌ 保存失败，请查看日志';
}

function handleStats() {
  const tokenCount = db.query('SELECT COUNT(*) as c FROM token_weights')[0].c;
  const sessionCount = db.query('SELECT COUNT(*) as c FROM sessions')[0].c;
  const msgCount = db.query('SELECT COUNT(*) as c FROM messages')[0].c;
  const corpusCount = db.query('SELECT COUNT(*) as c FROM corpus')[0].c;
  const trainCount = db.query("SELECT COUNT(*) as c FROM train_logs WHERE status='completed'")[0].c;

  return [
    '📊 当前统计:',
    `  Token 权重条目: ${tokenCount}`,
    `  会话数: ${sessionCount}`,
    `  消息总数: ${msgCount}`,
    `  内置语料: ${corpusCount}`,
    `  已完成训练: ${trainCount}`,
  ].join('\n');
}

function handleSearch(args, sessionId) {
  if (!args) return '请提供搜索关键词，例如: /search 你好';
  try {
    const like = `%${args}%`;
    const results = db.query(
      `SELECT m.content, s.name as session_name, m.created_at
       FROM messages m
       LEFT JOIN sessions s ON s.id = m.session_id
       WHERE m.content LIKE ?
       ORDER BY m.created_at DESC LIMIT 10`,
      [like]
    );
    if (!results.length) return `没找到包含「${args}」的历史消息`;
    const lines = results.map(r => `  [${new Date(r.created_at).toLocaleString()}] ${r.session_name || '会话'}: ${r.content.substring(0, 50)}`);
    return `🔍 搜索结果 (${results.length}条):\n${lines.join('\n')}`;
  } catch (e) {
    return `搜索出错: ${e.message}`;
  }
}

function handleWeights(args) {
  if (!args) return '请提供 token 关键词，例如: /weights 你';
  try {
    const like = `%${args}%`;
    const results = db.query(
      `SELECT token, layer, context, count, weight
       FROM token_weights
       WHERE token LIKE ? OR context LIKE ?
       ORDER BY count DESC LIMIT 15`,
      [like, like]
    );
    if (!results.length) return `没找到包含「${args}」的 token 权重`;
    const lines = results.map(r => `  [${r.layer}] "${r.token}" ctx="${r.context}" count=${r.count} w=${r.weight.toFixed(2)}`);
    return `🔤 Token 权重 (${results.length}条):\n${lines.join('\n')}`;
  } catch (e) {
    return `查询出错: ${e.message}`;
  }
}

function handleSnapshots() {
  const snaps = db.query('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 10');
  if (!snaps.length) return '暂无快照';
  const lines = snaps.map(s => `  #${s.id} [${new Date(s.created_at).toLocaleString()}] ${s.label || '(无描述)'} ${s.task_id ? 'task=' + s.task_id : ''}`);
  return `📸 快照列表:\n${lines.join('\n')}`;
}

function handleRollback() {
  const snaps = db.query('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1');
  if (!snaps.length) return '⚠️ 没有可用的快照';
  const snap = snaps[0];
  if (!require('fs').existsSync(snap.file_path)) {
    return '❌ 快照文件不存在';
  }
  try {
    const data = require('fs').readFileSync(snap.file_path);
    db.importDatabase(data);
    return `✅ 已恢复到快照 #${snap.id}`;
  } catch (e) {
    return `❌ 恢复失败: ${e.message}`;
  }
}

function handleConfig() {
  const config = require('../config');
  return [
    '⚙️ 当前配置:',
    `  保存策略: ${config.saveStrategy.mode}`,
    `  错误策略: ${config.fallbackStrategy.mode}`,
    `  默认AI供应商: ${config.defaultAI}`,
    `  训练窗口: ${config.simulate.contextWindowSize}轮`,
    `  温度: ${config.simulate.temperature}`,
    `  N-gram大小: ${config.simulate.ngramSize}`,
  ].join('\n');
}

module.exports = {
  parseCommand,
  executeCommand,
  COMMANDS,
};
