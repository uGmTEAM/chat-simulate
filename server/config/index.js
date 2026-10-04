// 全局配置 - 从环境变量 + 配置文件读取
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

module.exports = {
  server: {
    port: parseInt(process.env.PORT || '55440', 10),
    host: process.env.HOST || '0.0.0.0',
  },

  proxy: {
    http: process.env.HTTP_PROXY || null,
    https: process.env.HTTPS_PROXY || null,
  },

  database: {
    path: path.resolve(__dirname, '../../data/sqlite.db'),
  },

  snapshot: {
    dir: path.resolve(__dirname, '../../data/snapshots'),
  },

  corpus: {
    path: path.resolve(__dirname, '../../seed/corpus.json'),
  },

  // 默认 AI 供应商
  defaultAI: process.env.CHAT_SIM_DEFAULT_AI || 'agnes',

  // AI API Keys（环境变量优先）
  aiKeys: {
    agnes: process.env.CHAT_SIM_AI_AGNES_KEY || '',
    deepseek: process.env.CHAT_SIM_AI_DEEPSEEK_KEY || '',
    openai: process.env.CHAT_SIM_AI_OPENAI_KEY || '',
    doubao: process.env.CHAT_SIM_AI_DOUBAO_KEY || '',
    qwen: process.env.CHAT_SIM_AI_QWEN_KEY || '',
  },

  // 模拟算法参数
  simulate: {
    // 三层 N-gram 权重（字/词/句）
    layerWeights: {
      char: 0.3,   // 字符级
      word: 0.5,   // 词级
      sentence: 0.2, // 句级
    },
    // N-gram 的 N 值
    ngramSize: 3,
    // 生成最大 token 数
    maxTokens: 100,
    // 温度参数（0-2，越高越随机）
    temperature: 0.7,
    // 训练上下文窗口长度
    contextWindowSize: 10,
  },

  // 保存策略（可在前端配置切换）
  saveStrategy: {
    mode: 'manual',           // manual | interval | realtime
    intervalSeconds: 30,       // interval 模式下的间隔
  },

  // 错误处理策略（可在前端配置切换）
  fallbackStrategy: {
    mode: 'fallback',          // fallback | error | external_ai | empty
    fallbackMessages: [
      '嗯嗯，我想想该怎么说...',
      '这个问题有点难住我了，能再说清楚一点吗？',
      '我还在学习中，换个话题聊聊？',
      '好的，我记下了。',
      '原来是这样啊~',
      '有意思，继续说说？',
    ],
  },
};
