// N-gram 概率计算 — 多模型版
// 所有函数接受 modelDirPath 参数（模型目录路径），替代原来的全局 db.query
// 默认 fallback 到 modelService 的 default 模型

const modelService = require('../services/modelService');
const tokenizer = require('./tokenizer');
const logger = require('../middlewares/logger');
const path = require('path');
const fs = require('fs');

// 获取权重数组（带缓存）
const _cache = new Map();
const CACHE_TTL = 5000; // 5 秒

function getWeightsCached(modelDirPath) {
  if (!modelDirPath) {
    // 默认用 default 模型
    modelDirPath = modelService.modelDir('default');
  }
  const key = modelDirPath;
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && now - cached.time < CACHE_TTL) return cached.data;

  const weights = modelService.readWeights(modelDirPath);
  _cache.set(key, { data: weights, time: now });
  return weights;
}

function invalidateCache(modelDirPath) {
  if (modelDirPath) _cache.delete(modelDirPath);
  else _cache.clear();
}

// 从模型权重获取某个 layer + context 下所有可能的下一个 token 及其概率
function getNextTokenProbs(layer, context, opts = {}) {
  const { allowUnconditional = true, modelDir } = opts;
  if (!context) return null;

  const weights = getWeightsCached(modelDir);

  // 精确匹配
  let rows = weights.filter(w => w.layer === layer && w.context === context);

  // Fallback: context 拆成数组，逐步缩短尝试
  if (rows.length === 0 && context.includes('|')) {
    const parts = context.split('|').filter(Boolean);
    for (let len = parts.length - 1; len >= 1; len--) {
      const shorter = parts.slice(-len).join('|');
      rows = weights.filter(w => w.layer === layer && w.context === shorter);
      if (rows.length) break;
      const shorter2 = parts.slice(0, len).join('|');
      rows = weights.filter(w => w.layer === layer && w.context === shorter2);
      if (rows.length) break;
    }
  }

  // 终极 fallback: 无条件概率
  if (rows.length === 0 && allowUnconditional) {
    rows = weights.filter(w => w.layer === layer).sort((a, b) => b.count - a.count).slice(0, 30);
  }

  // ✨ 零权重终极兜底：模型完全空时用常用汉字池乱输出（1C 要求）
  if (rows.length === 0 && allowUnconditional && weights.length === 0) {
    const HAN = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心你明看原又么利比或质气第向道命此变条没结解问意建月公无系军很情最代但坚什居治死己节怎车非吧此' + '，。！？、；：\u201C\u201D\u2018\u2019（）《》';
    const pool = [];
    for (let i = 0; i < 10; i++) {
      const c = HAN[Math.floor(Math.random() * HAN.length)];
      if (!pool.includes(c)) pool.push(c);
    }
    rows = pool.map(c => ({ token: c, count: 1, weight: 1 }));
  }

  if (!rows.length) return null;

  const totalWeighted = rows.reduce((sum, r) => sum + (r.count * (r.weight || 1.0)), 0);
  return rows.map(r => ({
    token: r.token,
    prob: totalWeighted > 0 ? (r.count * (r.weight || 1.0)) / totalWeighted : 0,
    count: r.count,
  }));
}

// 从候选中按概率采样（支持 temperature 调节随机性）
function sampleToken(candidates, temperature = 1.0) {
  if (!candidates || !candidates.length) return null;

  if (temperature <= 0) {
    return candidates.reduce((best, c) => c.prob > best.prob ? c : best).token;
  }

  const logits = candidates.map(c => {
    const p = Math.max(c.prob, 1e-10);
    return Math.log(p) / temperature;
  });
  const maxLogit = Math.max(...logits);
  const expSum = logits.reduce((s, l) => s + Math.exp(l - maxLogit), 0);
  const probs = logits.map(l => Math.exp(l - maxLogit) / expSum);

  const r = Math.random();
  let accum = 0;
  for (let i = 0; i < probs.length; i++) {
    accum += probs[i];
    if (r <= accum) return candidates[i].token;
  }
  return candidates[candidates.length - 1].token;
}

// 融合三层概率：字/词/句
function getNextToken(contexts, opts = {}) {
  const { modelDir, configOverrides } = opts;
  let layerWeights = { char: 0.3, word: 0.5, sentence: 0.2 };
  let ngramSize = 3;
  let temperature = 0.7;

  // 尝试从模型 config 读取
  if (modelDir && fs.existsSync(path.join(modelDir, 'config.json'))) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf8'));
      if (cfg.layerWeights) layerWeights = cfg.layerWeights;
      if (cfg.ngramSize) ngramSize = cfg.ngramSize;
      if (cfg.temperature) temperature = cfg.temperature;
    } catch (e) {}
  }
  if (configOverrides) {
    layerWeights = { ...layerWeights, ...(configOverrides.layerWeights || {}) };
    if (configOverrides.ngramSize) ngramSize = configOverrides.ngramSize;
    if (configOverrides.temperature) temperature = configOverrides.temperature;
  }

  const layers = ['char', 'word', 'sentence'];
  const allCandidates = {};

  for (const layer of layers) {
    const layerCtx = contexts[layer];
    if (!layerCtx || layerCtx.length === 0) continue;

    const ctxKey = layerCtx.slice(-ngramSize).join('|');
    const probs = getNextTokenProbs(layer, ctxKey, { modelDir });

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
    token,
    prob: v.weightSum,
  }));

  if (!candidates.length) return null;

  const total = candidates.reduce((s, c) => s + c.prob, 0);
  candidates.forEach(c => c.prob = c.prob / total);

  return sampleToken(candidates, temperature);
}

// 训练：从一组输入→输出对话更新 N-gram 权重
function trainFromPair(input, output, opts = {}) {
  const { modelDir, layers = ['char', 'word', 'sentence'] } = opts;
  const dir = modelDir || modelService.modelDir('default');
  let weightChanges = 0;

  // 读取模型 config 获取 ngramSize
  let n = 3;
  if (fs.existsSync(path.join(dir, 'config.json'))) {
    try {
      n = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).ngramSize || 3;
    } catch (e) {}
  }

  const entries = [];

  for (const layer of layers) {
    let inputTokens, outputTokens;

    if (layer === 'char') {
      inputTokens = tokenizer.charTokenize(input);
      outputTokens = tokenizer.charTokenize(output);
    } else if (layer === 'word') {
      inputTokens = tokenizer.wordTokenize(input);
      outputTokens = tokenizer.wordTokenize(output);
    } else {
      // sentence layer: 输入按句号切（上下文需要），但输出**完整句子不切分**
      // 这样训练出的权重是 context=你好 → token=你好呀！很高兴见到你～（完整回复）
      inputTokens = tokenizer.sentenceTokenize(input);
      outputTokens = [output];
    }

    if (!outputTokens.length) continue;

    const ctxKey = inputTokens.slice(-n).join('|');

    for (const token of outputTokens) {
      if (!token || !token.trim()) continue;
      entries.push({ layer, context: ctxKey, token, count: 1 });
      weightChanges++;
    }
  }

  if (entries.length > 0) {
    modelService.batchTrainWeights(entries, dir);
    invalidateCache(dir);
  }

  logger.debug(`训练完成(model=${path.basename(path.dirname(dir))}): ${weightChanges} 个权重`);
  return weightChanges;
}

// 精确短语模板查询
function getExactPhraseOutput(userInput, opts = {}) {
  const { modelDir } = opts;
  const dir = modelDir || modelService.modelDir('default');
  return modelService.getExactPhraseOutput(userInput, dir);
}

module.exports = {
  getNextToken,
  getNextTokenProbs,
  sampleToken,
  trainFromPair,
  getExactPhraseOutput,
  invalidateCache,
  getWeightsCached,
};
