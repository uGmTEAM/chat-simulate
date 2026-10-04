// AI Provider - 可插拔多供应商统一调用层
// 所有供应商都走 OpenAI Chat Completions 兼容格式
const http = require('http');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const config = require('../config');
const aiProviders = require('../config/ai-providers');
const logger = require('../middlewares/logger');
const { URL } = require('url');

// 获取代理 Agent
function getProxyAgent(url) {
  const proxy = config.proxy.https || config.proxy.http;
  if (!proxy) return null;

  if (url.startsWith('https:')) {
    return new HttpsProxyAgent(proxy);
  } else {
    return new HttpProxyAgent(proxy);
  }
}

// 发送请求到 AI API
async function chatCompletion(providerName, messages, options = {}) {
  const provider = aiProviders[providerName];
  if (!provider) {
    throw new Error(`未知的 AI 供应商: ${providerName}`);
  }

  // 优先用环境变量中的 key
  const apiKey = config.aiKeys[providerName] || process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`AI 供应商 ${providerName} 未配置 API Key，请在前端配置或环境变量中设置`);
  }

  const model = options.model || provider.model;
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens ?? 512;

  const url = `${provider.baseURL}/chat/completions`;
  const urlObj = new URL(url);

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const agent = getProxyAgent(url);

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    if (agent) {
      reqOptions.agent = agent;
    }

    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`AI API 错误 [${res.statusCode}]: ${result.error?.message || data}`));
          } else if (result.choices && result.choices.length) {
            resolve({
              content: result.choices[0].message.content,
              usage: result.usage,
              model: result.model,
            });
          } else {
            reject(new Error('AI API 返回格式异常'));
          }
        } catch (e) {
          reject(new Error(`AI API 解析失败: ${e.message}\n原始响应: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('AI API 请求超时 (30s)'));
    });

    req.write(body);
    req.end();
  });
}

// 列出所有可用供应商
function listProviders() {
  const result = [];
  for (const [key, p] of Object.entries(aiProviders)) {
    const hasKey = config.aiKeys[key] || process.env[p.apiKeyEnv];
    result.push({
      id: key,
      name: p.name,
      description: p.description,
      model: p.model,
      baseURL: p.baseURL,
      hasKey: !!hasKey,
    });
  }
  return result;
}

// 测试供应商连通性
async function testProvider(providerName) {
  // 兼容 display name → id 映射
  if (!aiProviders[providerName]) {
    for (const [id, p] of Object.entries(aiProviders)) {
      if (p.name === providerName) { providerName = id; break; }
    }
  }
  try {
    const result = await chatCompletion(providerName, [
      { role: 'user', content: '回复一个字：好' },
    ], { maxTokens: 5 });
    return { success: true, content: result.content };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  chatCompletion,
  listProviders,
  testProvider,
};
