// AI 供应商配置 - 可插拔设计
// 所有供应商都遵循 OpenAI Chat Completions 兼容格式

module.exports = {
  agnes: {
    name: 'Agnes AI',
    baseURL: 'https://api.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    description: '全免费，ChatGPT兼容',
    apiKeyEnv: 'CHAT_SIM_AI_AGNES_KEY',
  },
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    description: '便宜好用',
    apiKeyEnv: 'CHAT_SIM_AI_DEEPSEEK_KEY',
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    description: '标准GPT接口',
    apiKeyEnv: 'CHAT_SIM_AI_OPENAI_KEY',
  },
  doubao: {
    name: '豆包 Doubao',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro-32k',
    description: '火山引擎',
    apiKeyEnv: 'CHAT_SIM_AI_DOUBAO_KEY',
  },
  qwen: {
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    description: '阿里云百炼',
    apiKeyEnv: 'CHAT_SIM_AI_QWEN_KEY',
  },
};
