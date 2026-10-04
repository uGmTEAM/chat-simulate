// 多层分词器：字符级 / 词级 / 句级
// natural 8.x 不再提供 Segment，使用自定义分词
const logger = require('../middlewares/logger');

// 字符级分词 - 逐字符切分（中文每个字都是独立 token）
function charTokenize(text) {
  if (!text) return [];
  return text.split('').filter(c => c.trim() !== '');
}

// 词级分词 - 中文逐字，英文按单词，数字合并
function wordTokenize(text) {
  if (!text) return [];

  const tokens = [];
  // 按类型切分：中文 / 英文单词 / 数字 / 标点
  const parts = text.match(/[\u4e00-\u9fa5]+|[a-zA-Z]+|[0-9]+|[\u3000-\u303f\uff00-\uffef]+|[^\u4e00-\u9fa5a-zA-Z0-9]/g) || [];

  for (const part of parts) {
    if (/^[\u4e00-\u9fa5]+$/.test(part)) {
      // 中文：逐字
      for (const c of part) {
        tokens.push(c);
      }
    } else if (/^[a-zA-Z]+$/.test(part)) {
      // 英文：整个单词
      tokens.push(part.toLowerCase());
    } else if (/^[0-9]+$/.test(part)) {
      // 数字：整个
      tokens.push(part);
    } else if (/^[\u3000-\u303f\uff00-\uffef]+$/.test(part)) {
      // 中文标点
      tokens.push(part);
    }
    // 跳过空格和纯 ASCII 标点
  }
  return tokens;
}

// 句级分词 - 按标点分句
function sentenceTokenize(text) {
  if (!text) return [];
  const sentences = text.split(/[。！？!?\n\r]+/);
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
}

// 组合：三层都返回
function tokenizeAll(text) {
  return {
    char: charTokenize(text),
    word: wordTokenize(text),
    sentence: sentenceTokenize(text),
  };
}

// 将 tokens 数组 join 成 context key（用于数据库查询）
function tokensToContext(tokens, n = 3) {
  const len = tokens.length;
  if (len < n) {
    return tokens.join('|');
  }
  return tokens.slice(-n).join('|');
}

module.exports = {
  charTokenize,
  wordTokenize,
  sentenceTokenize,
  tokenizeAll,
  tokensToContext,
};
