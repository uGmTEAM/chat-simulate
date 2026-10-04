// 核心模拟服务 v2：上下文记忆 + 思考生成 + 自动记忆训练
//
// 上下文记忆实现：
//   1. 接收历史对话（history），从中提取关键记忆（实体、关系、事实）
//   2. 生成时把历史对话也作为输入的一部分（拼到 context）
//   3. 每轮对话结束后，自动把 {上下文 → 最新回复} 训练进权重表
//
// 思考过程实现：
//   生成回复时，同步生成 step-by-step reasoning（基于 history + 当前输入）
//   思考过程 = 先匹配历史记忆 → 确定回复策略 → 生成 token
//
// 训练模式：自监督，每轮对话自动积累

const ngram = require('../utils/ngram');
const tokenizer = require('../utils/tokenizer');
const trainService = require('./trainService');
const db = require('../models/db');
const config = require('../config');
const logger = require('../middlewares/logger');

// ===== 1. 记忆提取 =====
// 从历史对话中提取"事实记忆"：谁是谁、什么是什么、关系、偏好等
// 用简单规则 + 模式匹配（LLM 内部也常这么做）
function extractFacts(history) {
  const facts = [];
  if (!history || history.length < 2) return facts;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const text = (msg.content || '').trim();
    if (!text) continue;

    // "我是XX" / "我叫XX" / "我名字是XX"
    const m1 = text.match(/我(?:是|叫|名字是|叫做)([\u4e00-\u9fa5A-Za-z0-9_]{2,15})/);
    if (m1 && msg.role === 'user') {
      facts.push({ type: 'identity', subject: '我', value: m1[1], original: text });
    }
    // "你是XX"
    const m2 = text.match(/你(?:是|叫)([\u4e00-\u9fa5A-Za-z0-9_]{2,15})/);
    if (m2 && msg.role === 'user') {
      facts.push({ type: 'identity', subject: '你', value: m2[1], original: text });
    }
    // "我喜欢XX" / "我爱XX"
    const m3 = text.match(/我(?:喜欢|爱|讨厌|想要)([\u4e00-\u9fa5A-Za-z0-9_]{1,15})/);
    if (m3 && msg.role === 'user') {
      facts.push({ type: 'preference', subject: '我', value: m3[0], original: text });
    }
    // "今天天气XX" / "现在XX" — 状态类
    // "因为XX所以YY" — 因果类
  }

  return facts;
}

// 查找与当前问题相关的记忆
function findRelevantFacts(facts, currentInput) {
  const relevant = [];
  const lower = currentInput.toLowerCase();
  for (const f of facts) {
    // 关键词匹配：谁、什么、怎么、为什么 + 记忆内容中的词
    if (f.value && lower.includes(f.value.toLowerCase())) {
      relevant.push({ ...f, matched: true });
      continue;
    }
    if (f.subject && lower.includes(f.subject)) {
      relevant.push({ ...f, matched: true });
      continue;
    }
    // "我是谁" → 匹配所有 identity 类
    if (f.type === 'identity' && (lower.includes('谁') || lower.includes('叫什么'))) {
      relevant.push({ ...f, matched: false });
    }
  }
  return relevant;
}

// ===== 2. 意图分类器 =====
// 识别用户输入的意图类型，驱动思考分支
function classifyIntent(input, history) {
  const t = input.trim();
  const len = t.length;

  // 问候类（短、无实质内容、寒暄关键词）
  const greetings = ['你好', '您好', '嗨', 'hi', 'hello', '哈喽', 'morning', '早上好', '下午好', '晚上好', '晚安', '在吗', '在么', '在不在', '嗯', '哦', '哈哈', '嘿嘿', 'hey'];
  if (len <= 6 && greetings.some(g => t.toLowerCase() === g.toLowerCase() || t.includes(g))) {
    return { type: 'greeting', confidence: 0.9 };
  }
  // 纯测试/打招呼变体（只有标点或单字）
  if (len <= 2 && /^[\s\p{P}]*$/u.test(t) === false) {
    // 不是纯标点，且没命中任何模式 → 可能是奇怪输入
  }

  // 身份查询类（必须在 identity_set 之前！因为 "我是谁" 包含 "我是"）
  if (/我(?:是|叫|的名字|名字叫)/.test(t) && /谁|什么|哪|么/.test(t)) {
    return { type: 'identity_query', confidence: 0.9 };
  }
  if (/我是谁|我叫什么|我的名字是什么/.test(t)) {
    return { type: 'identity_query', confidence: 0.9 };
  }
  if (/你(?:是|叫|的名字|是谁|是谁啊)/.test(t)) {
    return { type: 'bot_identity', confidence: 0.9 };
  }
  // 身份建立类（陈述式，不含疑问词）
  if (/我(?:是|叫|名字是|叫做|姓)/.test(t) && !/谁|什么|哪|吗|？|\?/.test(t)) {
    return { type: 'identity_set', confidence: 0.95 };
  }

  // 问题咨询类（推荐/怎么/为什么/能...吗/有什么/如何）
  if (/(推荐|介绍|什么是|怎么|怎样|如何|为什么|能不能|可以吗|有什么|好吗|行吗|吗|呢|？|\?)$/.test(t) || /^(怎么|为什么|如何|推荐|请问)/.test(t)) {
    return { type: 'question', confidence: 0.85 };
  }

  // 指令类（帮我/请/做/生成/写/给我）
  if (/(帮我|帮我|请给|帮.*做|做.*一下|生成|写一个|给我)/.test(t)) {
    return { type: 'command', confidence: 0.8 };
  }

  // 偏好表达类（我喜欢/我讨厌/我想要/我想吃/我想去）
  if (/我(?:喜欢|讨厌|想|爱|想吃|想喝|想去|想买|需要)/.test(t)) {
    return { type: 'preference', confidence: 0.85 };
  }

  // 闲聊状态类（今天/最近/我/好/坏/开心/难过）
  if (/(今天|最近|昨天|刚才|我.*很|天气|好累|好开心|好难过|哈哈|呵呵)/.test(t)) {
    return { type: 'chat', confidence: 0.7 };
  }

  // 结束类
  if (/(再见|拜拜|bye|goodbye|下次聊|晚安)/i.test(t)) {
    return { type: 'farewell', confidence: 0.9 };
  }

  // 模糊/兜底
  return { type: 'unknown', confidence: 0.3 };
}

// ===== 3. 深度思考生成（DeepSeek 风格） =====
// 模仿 deepseek 内部推理过程：意图识别 → 用户心理分析 → 策略决策 → 措辞斟酌
function generateThinking(currentInput, history, relevantFacts) {
  const intent = classifyIntent(currentInput, history);
  const hasHistory = history && history.length > 0;
  const hasMemory = relevantFacts && relevantFacts.length > 0;
  const histLen = history?.length || 0;
  const recentSummary = hasHistory
    ? history.slice(-3).map(h => `${h.role === 'user' ? '用户' : 'AI'}:"${(h.content || '').slice(0, 25)}"`).join(' → ')
    : '';

  // 根据意图类型生成自然语言思考
  const thoughts = [];

  // —— 第一层：感知输入 + 判断意图 ——
  switch (intent.type) {
    case 'greeting':
      thoughts.push(
        `嗯，用户发来一个简单的问候"${currentInput}"。`,
        `这是一个非常常见的开场白，没有具体问题或指令。`,
        hasHistory
          ? `当前对话已有 ${histLen} 条历史，用户可能是延续之前的话题，也可能是想重新开始。`
          : `这是对话的开始，用户可能只是想测试对话是否正常，或者准备后续提问。`,
        `我需要用友好、热情的方式回应，同时保持开放，引导用户说出实际需求。`,
        `不能过度解读，但可以主动提供帮助方向。想到了用问候加...`,
      );
      if (!hasHistory) {
        thoughts.push(`先回一个温暖的问候，让对话气氛好起来，再看用户接下来要说什么。`);
      } else {
        thoughts.push(`因为有历史上下文，回应里可以稍微提到之前的话题，让用户感觉有记忆感。`);
      }
      break;

    case 'identity_set':
      thoughts.push(
        `用户说"${currentInput}"，这是在建立身份信息。`,
        `他想让我记住他是谁，这样后续对话才有"人味"。`,
        `这是一个很重要的记忆点，我必须把这个名字牢牢记住，后面用户问"我是谁"时要能答出来。`,
        `回应应该温暖、确认收到，比如"好的我记住了"开头，让用户感觉被重视。`,
      );
      break;

    case 'identity_query':
      if (hasMemory) {
        const idFact = relevantFacts.find(f => f.type === 'identity');
        if (idFact) {
          thoughts.push(
            `用户问"${currentInput}"，是在测试我的记忆能力。`,
            `好消息是我从历史里确实找到了相关记忆：用户之前说过他是"${idFact.value}"。`,
            `这时候要自信地说出来，证明我有在认真听他说话，让他惊喜一下。`,
          );
        } else {
          thoughts.push(
            `用户问"${currentInput}"，但我在记忆库里没找到任何关于他身份的记录。`,
            `可能是他之前没告诉过我，或者对话历史被清空了。`,
            `诚实回答"我还不知道呢，你能告诉我吗？"比瞎编一个好。`,
          );
        }
      } else {
        thoughts.push(
          `用户问"${currentInput}"，但这是冷启动对话，没有任何历史记忆。`,
          `我确实不知道他是谁，得坦诚说出来，让他告诉我他的名字。`,
        );
      }
      break;

    case 'bot_identity':
      thoughts.push(
        `用户问我是谁——这是个经典问题。`,
        `我得简洁说明自己还没有名字，等用户告诉我后再记住，然后用一句话点明我能做什么，引导用户进入话题。`,
        `自我介绍完最好加个反问，推动对话继续下去。`,
      );
      break;

    case 'question':
      thoughts.push(
        `用户问了一个具体问题："${currentInput}"。`,
        `首先得准确理解他到底在问什么，有没有潜台词。`,
        hasMemory
          ? `我从历史里找到了一些相关记忆，可以结合起来回答，这样更有上下文感。`
          : `没有相关的历史记忆可以参考，得完全靠内置知识库来回答。`,
        `回答要务实、有信息量，别光说漂亮话。如果问题有多个方向，选最实用的那个先讲。`,
      );
      break;

    case 'preference':
      thoughts.push(
        `用户表达了一个偏好："${currentInput}"。`,
        `他可能是想找建议、找共鸣，或者只是随口一说。`,
        `先回应他的情绪（"好品味！" / "我也喜欢！"），再给点实际建议会比较好。`,
      );
      break;

    case 'command':
      thoughts.push(
        `用户发了一个指令："${currentInput}"。`,
        `得仔细看清楚他具体想要什么，别偏题。`,
        `优先把他明确要求的事情做好，有额外价值的可以顺便提一嘴，但别喧宾夺主。`,
      );
      break;

    case 'chat':
      thoughts.push(
        `用户在闲聊："${currentInput}"。`,
        `这种轻松的对话别太严肃，回应要像朋友聊天一样自然。`,
        `接他的话茬，或者顺着话题延展一下，让气氛保持轻松愉快。`,
      );
      break;

    case 'farewell':
      thoughts.push(
        `用户说再见了："${currentInput}"。`,
        `回应要温暖、友好，给对话留个好印象。`,
        `可以用"下次聊"、"拜拜"之类的，简洁不啰嗦。`,
      );
      break;

    default:
      thoughts.push(
        `用户说了："${currentInput}"。`,
        `这句话有点模糊，不太确定他具体想表达什么。`,
        `先把表面意思接住，再用开放式问题引导他说清楚，比如"你能详细说说吗？"`,
      );
  }

  // —— 第二层：记忆与上下文融合分析 ——
  if (hasMemory && relevantFacts.length > 0 && intent.type !== 'identity_query') {
    const memDesc = relevantFacts.slice(0, 3).map(f =>
      f.type === 'identity' ? `他是${f.value}` : f.type === 'preference' ? `他提到"${f.value}"` : f.original
    ).join('；');
    thoughts.push(`补充：我记得一些关于他的事——${memDesc}，可以在回复里自然融入。`);
  }
  if (histLen > 2 && intent.type === 'greeting') {
    thoughts.push(`补充：我们之前聊过几轮（${histLen}条历史），所以也不能把他当完全陌生人。`);
  }

  return thoughts.join('\n');
}

// ===== 3. 上下文增强的 token 查找 =====
function buildContextualInput(userInput, history, relevantFacts) {
  const parts = [];

  // 把相关记忆拼进输入（作为虚拟"上文"）
  if (relevantFacts && relevantFacts.length > 0) {
    const memoryStr = relevantFacts.map(f => {
      if (f.type === 'identity') return `${f.subject}是${f.value}`;
      return f.original;
    }).join('，');
    parts.push(`[记忆]${memoryStr}`);
  }

  // 把最近几轮历史也拼进去（截断）
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

  // 从模型 config 读 temperature
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
  const thinking = generateThinking(userInput, history, relevantFacts);
  const contextualInput = buildContextualInput(userInput, history, relevantFacts);

  logger.info(`🧠 生成思考: 记忆${relevantFacts.length}条, 上下文${history?.length || 0}条`);

  const maxTokens = config.simulate.maxTokens;
  let generated = [];
  let consecutiveFails = 0;
  let currentCtx = contextualInput;

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
  if (!reply || reply.trim().length < 2) {
    if (relevantFacts.length > 0) {
      const idFact = relevantFacts.find(f => f.type === 'identity' && f.subject === '我');
      if (idFact && /我是谁|我的名字|我叫什么/.test(userInput)) {
        reply = `你是${idFact.value}。`;
      } else {
        reply = handleFallback(userInput);
      }
    } else {
      reply = handleFallback(userInput);
    }
  }

  reply = cleanReply(reply);
  return { reply, thinking, facts };
}

// ===== 6. 两阶段流式（先逐字思考 → 再逐字回复，DeepSeek 风格） =====
async function* streamGenerateWithContext(userInput, history, shouldStop, modelDir) {
  const facts = extractFacts(history);
  const relevantFacts = findRelevantFacts(facts, userInput);
  const contextualInput = buildContextualInput(userInput, history, relevantFacts);

  logger.info('🧠 两阶段生成: 记忆' + relevantFacts.length + '条, 上下文' + (history?.length || 0) + '条');

  yield { type: 'thinking_start' };

  // —— 阶段 1: thinking 逐 token 生成（无降级！）——
  // 有 think|输入 权重 → 从训练样本里采样完整思考
  // 没有 → char 层无条件采样（允许乱输出，不降级到模板）
  let thinkingText = '';

  const thinkProbs = ngram.getNextTokenProbs('sentence', `think|${userInput}`, { modelDir, allowUnconditional: false });

  if (thinkProbs && thinkProbs.length > 0) {
    // 有完整 thinking 训练样本 → 采样一条完整思考，逐字输出
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
    // 没有 thinking 权重 → char 层无条件逐 token 采样（让它自己想）
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
  let currentCtx = contextualInput;
  let replyText = '';

  for (let i = 0; i < maxTokens; i++) {
    if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }

    const layers = tokenizer.tokenizeAll(currentCtx);
    const allCandidates = {};

    // 先尝试 sentence 层精准匹配（用户原始输入，不带上下文前缀）
    const userInputToks = tokenizer.tokenizeAll(userInput);
    if (userInputToks.sentence && userInputToks.sentence.length > 0) {
      const cleanCtx = userInputToks.sentence.slice(-ngramSize).join('|');
      const cleanProbs = ngram.getNextTokenProbs('sentence', cleanCtx, { modelDir, allowUnconditional: false });
      if (cleanProbs && cleanProbs.length > 0) {
        // 找到精准句子匹配，直接用它（优先级最高）
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
      // 主路径（char+word+sentence 条件采样）没找到候选
      // → 降级：char 层无条件采样（允许乱输出，直到连续多次都没候选才停）
      consecutiveFails++;
      if (consecutiveFails < 5) {
        // 走 char 层 unconditional fallback
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

    // 逐字输出：不管 char 还是 sentence 层，都一个字一个字吐，保持打字机效果
    const chars = nextToken.split('');
    for (const ch of chars) {
      if (shouldStop && shouldStop()) { yield { type: 'stop' }; return; }
      replyText += ch;
      yield { type: 'token', text: ch };
      await new Promise(r => setTimeout(r, 15));
    }

    // sentence 层命中完整长回复（>6字）→ 立即结束，不再采样
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

    if (changes > 0) {
      logger.info(`🧠 自动记忆训练: +${changes} 权重`);
    }
    return changes;
  } catch (e) {
    logger.warn('自动训练失败: ' + e.message);
    return 0;
  }
}

function handleFallback(userInput) {
  const mode = config.fallbackStrategy.mode;
  switch (mode) {
    case 'error': return '❌ 当前模型无法生成，请先训练或换个话题。';
    case 'empty': return '';
    case 'fallback':
    default: {
      const msgs = config.fallbackStrategy.fallbackMessages;
      return msgs[Math.floor(Math.random() * msgs.length)];
    }
  }
}

function cleanReply(text) {
  if (!text) return '';
  text = text.replace(/\s+/g, ' ').trim();
  // 去掉开头的虚拟上下文标记（可能被 token 生成带出来）
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
  generateThinking,
};
