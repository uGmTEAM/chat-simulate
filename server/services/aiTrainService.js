// 云训练服务：调用 AI API 生成回复，自动训练
// 支持并行多任务，每个任务独立快照
const aiProvider = require('./aiProvider');
const ngram = require('../utils/ngram');
const tokenizer = require('../utils/tokenizer');
const db = require('../models/db');
const snapshotService = require('./snapshotService');
const config = require('../config');
const logger = require('../middlewares/logger');
const { EventEmitter } = require('events');

// 全局任务注册表
const activeTasks = new Map(); // taskId -> taskInfo

class CloudTrainTask extends EventEmitter {
  constructor(taskId, options) {
    super();
    this.taskId = taskId;
    this.provider = options.provider || config.defaultAI;
    this.mode = options.mode || 'generate'; // generate | analyze | hybrid
    this.contextWindowSize = options.contextWindowSize || config.simulate.contextWindowSize;
    this.maxRounds = options.maxRounds || 50;
    this.status = 'created'; // created | running | completed | interrupted | failed
    this.progress = 0;
    this.logs = [];
    this.snapshotId = null;
    this.startedAt = null;
    this.completedAt = null;
  }

  addLog(level, msg) {
    const log = { time: Date.now(), level, msg };
    this.logs.push(log);
    // 保留最近 200 条
    if (this.logs.length > 200) this.logs.shift();
    this.emit('log', log);
  }

  toJSON() {
    return {
      taskId: this.taskId,
      provider: this.provider,
      mode: this.mode,
      status: this.status,
      progress: this.progress,
      snapshotId: this.snapshotId,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      recentLogs: this.logs.slice(-10),
    };
  }
}

// 启动云训练任务
async function startCloudTrain(options = {}) {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const task = new CloudTrainTask(taskId, options);
  activeTasks.set(taskId, task);

  // 异步执行，立即返回
  task.status = 'running';
  task.startedAt = Date.now();
  task.addLog('info', `🚀 云训练任务启动: provider=${task.provider}, mode=${task.mode}`);

  // 创建独立快照（中断保护）
  try {
    const snap = snapshotService.createSnapshot(`云训练前快照`, taskId);
    task.snapshotId = snap.id;
    task.addLog('info', `📸 快照已创建 #${snap.id}`);
  } catch (err) {
    task.addLog('warn', `快照创建失败，继续训练: ${err.message}`);
  }

  // 异步运行训练循环
  runTrainLoop(task).catch(err => {
    task.status = 'failed';
    task.completedAt = Date.now();
    task.addLog('error', `训练异常: ${err.message}`);
    logger.error('云训练异常', err);
  });

  return task.toJSON();
}

// 训练主循环
async function runTrainLoop(task) {
  try {
    // 从语料库中选一些 seed 对话作为起点
    const seedCorpus = db.query('SELECT input, output FROM corpus ORDER BY RANDOM() LIMIT 20');
    if (seedCorpus.length === 0) {
      task.addLog('warn', '语料库为空，生成 synthetic 对话');
    }

    const trainingSamples = [];

    // 策略：让 AI 自己生成对话并训练
    for (let round = 0; round < task.maxRounds; round++) {
      // 检查是否被中断
      if (task.status === 'interrupted') {
        task.addLog('warn', '训练被用户中断，回滚到快照');
        if (task.snapshotId) {
          try {
            snapshotService.restoreSnapshot(task.snapshotId);
            task.addLog('info', '✅ 已回滚到训练前快照');
          } catch (e) {
            task.addLog('error', `回滚失败: ${e.message}`);
          }
        }
        task.completedAt = Date.now();
        return;
      }

      // 随机选一个 seed 作为上下文
      const seed = seedCorpus[Math.floor(Math.random() * Math.max(seedCorpus.length, 1))];
      const contextInput = seed?.input || getRandomPrompt();

      // 构建 AI 消息
      const messages = buildTrainMessages(task.mode, contextInput);

      task.addLog('info', `[${round + 1}/${task.maxRounds}] 训练 ${task.mode}: "${contextInput.substring(0, 30)}..."`);

      try {
        const result = await aiProvider.chatCompletion(task.provider, messages, { maxTokens: 256 });
        const aiOutput = result.content;

        // 根据模式处理
        if (task.mode === 'generate') {
          // 直接训练 AI 生成的对话
          const changes = ngram.trainFromPair(contextInput, aiOutput);
          task.addLog('info', `  📥 训练: "${aiOutput.substring(0, 30)}..." -> +${changes}权重`);
          trainingSamples.push({ input: contextInput, output: aiOutput });
        } else if (task.mode === 'analyze') {
          // AI 分析并给出指导，按指导调整
          // 简化：直接用 AI 输出作为训练
          const changes = ngram.trainFromPair(contextInput, aiOutput);
          task.addLog('info', `  🔍 分析训练 -> +${changes}权重`);
        } else {
          // hybrid: 两种都做
          const changes = ngram.trainFromPair(contextInput, aiOutput);
          task.addLog('info', `  🔀 混合训练 -> +${changes}权重`);
        }

        task.progress = Math.round(((round + 1) / task.maxRounds) * 100);

        // 节流，避免 API 爆
        await sleep(300);
      } catch (err) {
        task.addLog('error', `  AI API 失败: ${err.message}`);
        await sleep(1000);
      }
    }

    task.status = 'completed';
    task.completedAt = Date.now();
    task.progress = 100;
    task.addLog('info', `✅ 训练完成！共生成 ${trainingSamples.length} 个样本`);

    // 训练完重建 FTS
  } catch (err) {
    task.status = 'failed';
    task.completedAt = Date.now();
    task.addLog('error', `训练失败: ${err.message}`);
  }
}

// 构建训练提示
function buildTrainMessages(mode, input) {
  if (mode === 'generate') {
    return [
      {
        role: 'system',
        content: '你是一个中文对话伴侣。请针对用户的输入，给出自然、温暖、简短（不超过50字）的回复。不要用markdown格式。只回复回复本身，不要加引号或解释。',
      },
      { role: 'user', content: input },
    ];
  } else if (mode === 'analyze') {
    return [
      {
        role: 'system',
        content: '你是一个对话训练专家。请分析以下用户输入，给出最自然的回复（不超过30字）。只输出回复，不要解释。',
      },
      { role: 'user', content: input },
    ];
  } else {
    return [
      {
        role: 'system',
        content: '你是一个有趣的中文聊天伙伴。简短回复用户（20-50字），保持口语化。直接回复，不要格式。',
      },
      { role: 'user', content: input },
    ];
  }
}

function getRandomPrompt() {
  const prompts = [
    '今天天气怎么样？',
    '你好呀',
    '最近在忙什么',
    '推荐一部好看的电影',
    '心情不好怎么办',
    '晚上吃什么好',
    '给我讲个笑话',
    '周末有空吗',
    '工作好累啊',
    '你觉得人生的意义是什么',
  ];
  return prompts[Math.floor(Math.random() * prompts.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 停止（中断）任务
function stopCloudTrain(taskId) {
  const task = activeTasks.get(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'completed' || task.status === 'failed') {
    throw new Error('任务已结束');
  }
  task.status = 'interrupted';
  task.addLog('warn', '收到停止信号');
  return task.toJSON();
}

// 查询任务状态
function getCloudTrainStatus(taskId) {
  const task = activeTasks.get(taskId);
  if (!task) throw new Error('任务不存在');
  return task.toJSON();
}

// 获取任务日志
function getCloudTrainLogs(taskId, limit = 50) {
  const task = activeTasks.get(taskId);
  if (!task) throw new Error('任务不存在');
  return task.logs.slice(-limit);
}

// 列出所有活跃任务
function listActiveTasks() {
  return Array.from(activeTasks.values()).map(t => t.toJSON());
}

module.exports = {
  startCloudTrain,
  stopCloudTrain,
  getCloudTrainStatus,
  getCloudTrainLogs,
  listActiveTasks,
};
