// 核心模拟服务 v2：上下文记忆 + 思考生成 + 自动记忆训练
//
// 上下文记忆实现：
//   1. 接收历史对话（history），从中提取关键记忆（实体、关系、事实）
//   2. 生成时把历史对话也作为输入的一部分（拼到 context）
//   3. 每轮对话结束后，自动把 {上下文 → 最新回复} 训练进权重表
//
// 思考过程实现：
//   纯训练驱动：thinking 完全由 ngram 权重采样生成，无任何硬编码模板
//
// 训练模式：自监督，每轮对话自动积累

const ngram = require('../utils/ngram');
const tokenizer = require('../utils/tokenizer');
const { Transformer } = require('../utils/transformer');
const trainService = require('./trainService');
const db = require('../models/db');
const config = require('../config');
const logger = require('../middlewares/logger');
const fs = require('fs');
const path = require('path');

// ===== Transformer 辅助函数 =====
function loadTransformer(modelDir) {
  try {
    const t = Transformer.load(modelDir);
    if (t) return t;
  } catch(e) {}
  return null;
}

function initTransformer(modelDir) {
  try {
    if (fs.existsSync(path.join(modelDir, 'transformer.json'))) return loadTransformer(modelDir);
  } catch(e) {}
  const t = new Transformer(3000);
  t.save(modelDir);
  return t;
}

function transformTrainPair(input, output, modelDir) {
  try {
    const t = initTransformer(modelDir);
    const loss = t.trainStep(input, output, 0.002);
    t.save(modelDir);
    return loss;
  } catch(e) {
    logger.warn('Transformer训练失败: ' + e.message);
    return null;
  }
}

function generateThinkingFromTransformer(userInput, modelDir) {
  try {
    const t = loadTransformer(modelDir);
    if (!t) return '';
    const ctx = `think|${userInput}`;
    const result = t.generate(ctx, 50, '。！？!?');
    return result || '';
  } catch(e) { return ''; }
}

function generateReplyFromTransformer(contextStr, modelDir, maxTokens = 80) {
  try {
    const t = loadTransformer(modelDir);
    if (!t) return null;
    return t.generate(contextStr, maxTokens, '。！？!?');
  } catch(e) { return null; }
}

// ===== 1. 记忆提取 =====
function extractFacts(history) {
  const facts = [];
  if (!history || history.length < 2) return facts;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const text = (msg.content || '').trim();
    if (!text) continue;

    const m1 = text.match(/我(?:是|叫|名字是|叫做)([\u4e00-\u9fa5A-Za-z0-9_]{2,15})/);
    if (m1 && msg.role === 'user') {
      facts.push({ type: 'identity', subject: '我', value: m1[1], original: text });
    }
    const m2 = text.match(/你(?:是|叫)([\u4e00-\u9fa5A-Za-z0-9_]{2,15})/);
    if (m2 && msg.role === 'user') {
      facts.push({ type: 'identity', subject: '你', value: m2[1], original: text });
    }
    const m3 = text.match(/我(?:喜欢|爱|讨厌|想要)([\u4e00-\u9fa5A-Za-z0-9_]{1,15})/);
    if (m3 && msg.role === 'user') {
      facts.push({ type: 'preference', subject: '我', value: m3[0], original: text });
    }
  }

  return facts;
}

function findRelevantFacts(facts, currentInput) {
  const relevant = [];
  const lower = currentInput.toLowerCase();
  for (const f of facts) {
    if (f.value && lower.includes(f.value.toLowerCase())) {
      relevant.push({ ...f, matched: true });
      continue;
    }
    if (f.subject && lower.includes(f.subject)) {
      relevant.push({ ...f, matched: true });
      continue;
    }
    if (f.type === 'identity' && (lower.includes('谁') || lower.includes('叫什么'))) {
      relevant.push({ ...f, matched: false });
    }
  }
  return relevant;
}

// ===== 2. 纯训练生成思考（无模板，完全依赖 ngram 权重） =====
function generateThinkingFromNgram(userInput, modelDir) {
  const maxTokens = 60;
  let thinkingText = '';
  let currentCtx = `think|${userInput}`;
  let emptyFails = 0;

  // 先尝试 sentence 层完整采样
  const thinkProbs = ngram.getNextTokenProbs('sentence', currentCtx, { modelDir, allowUnconditional: false });
  if (thinkProbs && thinkProbs.length > 0) {
    const sampled = ngram.sampleToken(thinkProbs, 1.5);
    if (sampled && sampled.length > 2) {
      thinkingText = sampled;
    }
  }

  // 若无完整句子，逐 token 采样
  if (!thinkingText || thinkingText.length < 2) {
    emptyFails = 0;
    for (let i = 0; i < maxTokens; i++) {
      const layers = tokenizer.tokenizeAll(currentCtx);
      const layerWeights = { char: 0.8, word: 0.2, sentence: 0 };
      const allCandidates = {};
      for (const layer of ['char', 'word']) {
        const ctxSlice = (layers[layer] || []).slice(-3);
        if (ctxSlice.length === 0) continue;
        const ctxKey = ctxSlice.join('|');
        const probs = ngram.getNextTokenProbs(layer, ctxKey, { modelDir, allowUnconditional: true });
        if (probs) for (const p of probs) {
          if (!allCandidates[p.token]) allCandidates[p.token] = { weightSum: 0 };
          allCandidates[p.token].weightSum += p.prob * layerWeights[layer];
        }
      }
      const candidates = Object.entries(allCandidates).map(([t, v]) => ({ token: t, score: v.weightSum }));
      if (candidates.length === 0) { emptyFails++; if (emptyFails >= 3) break; continue; }
      candidates.forEach(c => c.prob = c.score / candidates.reduce((s, x) => s + x.score, 0));
      const ch = ngram.sampleToken(candidates, 1.8);
      if (!ch || !ch.trim()) { emptyFails++; if (emptyFails >= 3) break; continue; }
      emptyFails = 0;
      thinkingText += ch;
      currentCtx = currentCtx + ch;
      if (/[。！？!?]/.test(ch) && i > 10) break;
    }
  }

  return thinkingText || '';
}

// ===== 3. 上下文增强的 token 查找 =====
function buildContextualInput(userInput, history, relevantFacts) {
  const parts = [];

  if (relevantFacts && relevantFacts.length > 0) {
    const memoryStr = relevantFacts.map(f => {
      if (f.type === 'identity') return `${f.subject}是${f.value}`;
      return f.original;
    }).join('，');
    parts.push(`[记忆]${memoryStr}`);
  }

  if (history && history.length > 0) {
    const recent = history.slice(-4);
    for (const h of recent) {
      const content = (h.content || '').slice(0, 60);
      if (h.role === 'user') parts.push(`用户:${content}`);
      else parts.push(`AI:${content}`);
    }
  }

  parts.push(`当前:${userInput}`);
  return parts.join(' ');
}

// ===== 4. 下一个 token 查找（上下文融合版） =====
function pickNextToken(contextualInput, modelDir) {
  const layers = tokenizer.tokenizeAll(contextualInput);
  let layerWeights = { char: 0.3, word: 0.5, sentence: 0.2 };
  let ngramSize = 3;
  try {
    const cfg = JSON.parse(require('fs').readFileSync(require('path').join(modelDir, 'config.json'), 'utf8'));
    if (cfg.layerWeights) layerWeights = cfg.layerWeights;
    if (cfg.ngramSize) ngramSize = cfg.ngramSize;
  } catch(e) {
    layerWeights = config.simulate.layerWeights;
    ngramSize = config.simulate.ngramSize;
  }

  const allCandidates = {};

  for (const layer of ['char', 'word', 'sentence']) {
    const layerTokens = layers[layer] || [];
    if (layerTokens.length === 0) continue;

    const ctxSlice = layerTokens.slice(-ngramSize);
    const ctxKey = ctxSlice.join('|');

    const probs = ngram.getNextTokenProbs(layer, ctxKey, { modelDir });
    if (probs) {
      for (const p of probs) {
        if (!allCandidates[p.token]) {
          allCandidates[p.token] = { weightSum: 0, hitLayers: 0 };
        }
        allCandidates[p.token].weightSum += p.prob * (layerWeights[layer] || 0.33);
        allCandidates[p.token].hitLayers++;
      }
    }
  }

  const candidates = Object.entries(allCandidates).map(([token, v]) => ({
    token, score: v.weightSum, hits: v.hitLayers,
  }));

  if (candidates.length === 0) return null;

  const total = candidates.reduce((s, c) => s + c.score, 0);
  if (total === 0) return candidates[0].token;
  candidates.forEach(c => c.prob = c.score / total);

  let temperature = 0.7;
  try {
    temperature = JSON.parse(require('fs').readFileSync(require('path').join(modelDir, 'config.json'), 'utf8')).temperature || 0.7;
  } catch(e) {
    temperature = config.simulate.temperature;
  }
  return ngram.sampleToken(candidates, temperature);
}

// ===== 5. 生成完整回复（带上下文 + 思考） =====
function generateWithContext(userInput, history, shouldStop, modelDir) {
  const facts = extractFacts(history);
  const relevantFacts = findRelevantFacts(facts, userInput);

  // 优先使用 Transformer
  const t = loadTransformer(modelDir);
  if (t) {
    logger.info(`🧠 Transformer 生成: 记忆${relevantFacts.length}条, 上下文${history?.length || 0}条`);
    const thinking = generateThinkingFromTransformer(userInput, modelDir);
    const contextualInput = buildContextualInput(userInput, history, relevantFacts);
    const reply = generateReplyFromTransformer(
      `[思考]${thinking} ${contextualInput}`, modelDir, config.simulate.maxTokens
    );
    return { reply: cleanReply(reply || ''), thinking, facts };
  }

  // 回退到 ngram
  const thinking = generateThinkingFromNgram(userInput, modelDir);
  const contextualInput = buildContextualInput(userInput, history, relevantFacts);
  logger.info(`🧠 生成思考: 记忆${relevantFacts.length}条, 上下文${history?.length || 0}条`);

  const maxTokens = config.simulate.maxTokens;
  let generated = [];
  let consecutiveFails = 0;
  let currentCtx = `[思考]${thinking} ${contextualInput}`;

  for (let i = 0; i < maxTokens; i++) {
    if (shouldStop && shouldStop()) break;

    const nextToken = pickNextToken(currentCtx, modelDir);
    if (!nextToken) {
      consecutiveFails++;
      if (consecutiveFails >= 2) break;
      continue;
    }
    consecutiveFails = 0;
    generated.push(nextToken);
    currentCtx = currentCtx + nextToken;

    if (/[。！？!?]/.test(nextToken) && generated.length > 8 && i > 5) break;
  }

  let reply = generated.join('');
  reply = cleanReply(reply);
  return { reply, thinking, facts };
}

// ===== 6. 两阶段流式（先逐字思考 → 再逐字回复，DeepSeek 风格） =====
async function* streamGenerateWithContext(userInput, history, shouldStop, modelDir) {
  const facts = extractFacts(history);
  const relevantFacts = findRelevantFacts(facts, userInput);
  const contextualInput = buildContextualInput(userInput, history, relevantFacts);

  const t = loadTransformer(modelDir);
  if (t) {
    logger.info('🧠 Transformer 流式生成: 记忆' + relevantFacts.length + '条');
    yield { type: 'thinking_start' };
    const thinkingText = generateThinkingFromTransformer(userInput, modelDir);
    for (const ch of thinkingText.split('')) {
      if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }
      yield { type: 'thinking_token', text: ch };
      await new Promise(r => setTimeout(r, 4));
    }
    yield { type: 'thinking_done', text: thinkingText };
    yield { type: 'reply_start' };
    const replyText = generateReplyFromTransformer(
      `[思考]${thinkingText} ${contextualInput}`, modelDir, config.simulate.maxTokens
    ) || '';
    for (const ch of replyText.split('')) {
      if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }
      yield { type: 'token', text: ch };
      await new Promise(r => setTimeout(r, 10));
    }
    yield { type: 'done', thinking: thinkingText, reply: cleanReply(replyText) };
    return;
  }

  logger.info('🧠 两阶段生成: 记忆' + relevantFacts.length + '条, 上下文' + (history?.length || 0) + '条');

  yield { type: 'thinking_start' };

  // —— 阶段 1: thinking 逐 token 生成（无降级到模板！）——
  // 有 think|输入 权重 → 从训练样本里采样完整思考
  // 没有 → char 层无条件采样（允许乱输出）
  let thinkingText = '';

  const thinkProbs = ngram.getNextTokenProbs('sentence', `think|${userInput}`, { modelDir, allowUnconditional: false });

  if (thinkProbs && thinkProbs.length > 0) {
    const sampledThink = ngram.sampleToken(thinkProbs, 1.5);
    if (sampledThink && sampledThink.length > 2) {
      for (const ch of sampledThink.split('')) {
        if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }
        thinkingText += ch;
        yield { type: 'thinking_token', text: ch };
        await new Promise(r => setTimeout(r, 6));
      }
    }
  } else {
    const fallbackCtx = `think|${userInput}`;
    let currentCtx = fallbackCtx;
    let emptyFails = 0;
    for (let i = 0; i < 60; i++) {
      if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }
      const layers = tokenizer.tokenizeAll(currentCtx);
      const layerWeights = { char: 0.8, word: 0.2, sentence: 0 };
      const allCandidates = {};
      for (const layer of ['char', 'word']) {
        const ctxSlice = (layers[layer] || []).slice(-3);
        if (ctxSlice.length === 0) continue;
        const ctxKey = ctxSlice.join('|');
        const probs = ngram.getNextTokenProbs(layer, ctxKey, { modelDir, allowUnconditional: true });
        if (probs) for (const p of probs) {
          if (!allCandidates[p.token]) allCandidates[p.token] = { weightSum: 0 };
          allCandidates[p.token].weightSum += p.prob * layerWeights[layer];
        }
      }
      const candidates = Object.entries(allCandidates).map(([t, v]) => ({ token: t, score: v.weightSum }));
      if (candidates.length === 0) { emptyFails++; if (emptyFails >= 3) break; continue; }
      candidates.forEach(c => c.prob = c.score / candidates.reduce((s,x)=>s+x.score,0));
      const ch = ngram.sampleToken(candidates, 1.8);
      if (!ch || !ch.trim()) { emptyFails++; if (emptyFails >= 3) break; continue; }
      emptyFails = 0;
      thinkingText += ch;
      yield { type: 'thinking_token', text: ch };
      await new Promise(r => setTimeout(r, 6));
      currentCtx = currentCtx + ch;
      if (/[。！？!?]/.test(ch) && i > 10) break;
    }
  }

  yield { type: 'thinking_done', text: thinkingText };

  yield { type: 'reply_start' };

  // 从模型 config 读参数
  let layerWeights = { char: 0.3, word: 0.5, sentence: 0.2 };
  let ngramSize = 3;
  let temperature = 0.7;
  const fs = require('fs'), path = require('path');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf8'));
    if (cfg.layerWeights) layerWeights = cfg.layerWeights;
    if (cfg.ngramSize) ngramSize = cfg.ngramSize;
    if (cfg.temperature) temperature = cfg.temperature;
  } catch(e) {
    layerWeights = config.simulate.layerWeights;
    ngramSize = config.simulate.ngramSize;
    temperature = config.simulate.temperature;
  }

  const maxTokens = config.simulate.maxTokens;
  let generated = [];
  let consecutiveFails = 0;
  let currentCtx = `[思考]${thinkingText} ${contextualInput}`;
  let replyText = '';

  for (let i = 0; i < maxTokens; i++) {
    if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }

    const layers = tokenizer.tokenizeAll(currentCtx);
    const allCandidates = {};

    const userInputToks = tokenizer.tokenizeAll(userInput);
    if (userInputToks.sentence && userInputToks.sentence.length > 0) {
      const cleanCtx = userInputToks.sentence.slice(-ngramSize).join('|');
      const cleanProbs = ngram.getNextTokenProbs('sentence', cleanCtx, { modelDir, allowUnconditional: false });
      if (cleanProbs && cleanProbs.length > 0) {
        const topSample = ngram.sampleToken(cleanProbs, temperature);
        if (topSample) {
          for (const ch of topSample.split('')) {
            if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }
            replyText += ch;
            yield { type: 'token', text: ch };
            await new Promise(r => setTimeout(r, 12));
          }
          generated.push(topSample);
          currentCtx = currentCtx + topSample;
          break;
        }
      }
    }

    for (const layer of ['char', 'word', 'sentence']) {
      const ctxSlice = (layers[layer] || []).slice(-ngramSize);
      if (ctxSlice.length === 0) continue;
      const ctxKey = ctxSlice.join('|');
      const probs = ngram.getNextTokenProbs(layer, ctxKey, { modelDir });
      if (probs) {
        for (const p of probs) {
          if (!allCandidates[p.token]) allCandidates[p.token] = { weightSum: 0 };
          allCandidates[p.token].weightSum += p.prob * (layerWeights[layer] || 0.33);
        }
      }
    }

    const candidates = Object.entries(allCandidates).map(([token, v]) => ({ token, score: v.weightSum }));
    let nextToken = null;
    if (candidates.length > 0) {
      const total = candidates.reduce((s, c) => s + c.score, 0);
      if (total > 0) {
        candidates.forEach(c => c.prob = c.score / total);
        nextToken = ngram.sampleToken(candidates, temperature);
      }
    }

    if (!nextToken) {
      consecutiveFails++;
      if (consecutiveFails < 5) {
        const charCtxSlice = (layers.char || []).slice(-3);
        if (charCtxSlice.length > 0) {
          const charProbs = ngram.getNextTokenProbs('char', charCtxSlice.join('|'), { modelDir, allowUnconditional: true });
          if (charProbs && charProbs.length) {
            nextToken = ngram.sampleToken(charProbs, 1.8);
            consecutiveFails = 0;
          }
        }
      }
      if (!nextToken && consecutiveFails >= 5) break;
      if (!nextToken) continue;
    }
    consecutiveFails = 0;
    generated.push(nextToken);
    currentCtx = currentCtx + nextToken;

    const chars = nextToken.split('');
    for (const ch of chars) {
      if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }
      replyText += ch;
      yield { type: 'token', text: ch };
      await new Promise(r => setTimeout(r, 15));
    }

    if (nextToken.length > 6 && layerWeights.sentence > layerWeights.char) break;
    if (/[。！？!?]/.test(nextToken) && generated.length > 8 && i > 5) break;
  }
  yield { type: 'done', thinking: thinkingText, reply: cleanReply(replyText) };
}

// ===== 7. 自动记忆训练 =====
function autoTrainFromDialogue(history, userInput, aiReply, modelDir) {
  try {
    if (!aiReply || aiReply.trim().length < 2) return 0;
    let changes = 0;
    changes += ngram.trainFromPair(userInput, aiReply, { modelDir });

    if (history && history.length >= 2) {
      const recent = history.slice(-4);
      const chainInput = recent.map(h => (h.content || '').slice(0, 50)).join(' ');
      changes += ngram.trainFromPair(chainInput, aiReply, { modelDir });
    }

    const m = userInput.match(/我(?:是|叫|名字是)([\u4e00-\u9fa5A-Za-z0-9_]{2,15})/);
    if (m) {
      changes += ngram.trainFromPair('我是谁', `你是${m[1]}`, { modelDir });
      changes += ngram.trainFromPair('我的名字是', `你的名字是${m[1]}`, { modelDir });
    }

    // 同时训练 Transformer
    const loss = transformTrainPair(userInput, aiReply, modelDir);
    if (loss !== null) logger.info(`🧠 Transformer 训练 loss: ${loss.toFixed(4)}`);

    if (changes > 0) {
      logger.info(`🧠 自动记忆训练: +${changes} 权重`);
    }
    return changes;
  } catch (e) {
    logger.warn('自动训练失败: ' + e.message);
    return 0;
  }
}

function cleanReply(text) {
  if (!text) return '';
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^\[记忆\][^\s]*\s*/, '');
  text = text.replace(/^用户:[^\s]*\s*/, '');
  text = text.replace(/^AI:[^\s]*\s*/, '');
  text = text.replace(/^当前:/, '');
  if (text.length > 0 && !/[。！？!?\.]/.test(text.slice(-1))) {
    text += '。';
  }
  return text;
}

module.exports = {
  generateWithContext,
  streamGenerateWithContext,
  autoTrainFromDialogue,
  extractFacts,
  findRelevantFacts,
  generateThinkingFromNgram,
  generateThinkingFromTransformer,
  generateReplyFromTransformer,
  transformTrainPair,
  loadTransformer,
};
