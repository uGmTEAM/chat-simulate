// 模型管理服务
// 每个模型是独立目录: data/models/{model_id}/
//   config.json       — 模型配置（ngramSize, temperature, layerWeights 等）
//   token_weights.json — token 权重数据
//   meta.json         — 元信息（创建时间、描述、训练统计）
//
// 聊天会话: data/chats/{session_id}/model/  ← 所选模型的副本
// 训练会话: 直接操作 data/models/{model_id}/  ← 原模型

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data');
const MODELS_DIR = path.join(DATA_DIR, 'models');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const TRAININGS_DIR = path.join(DATA_DIR, 'trainings');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');

// 默认模型配置（与 server/config/index.js 里的 simulate 配置对齐）
const DEFAULT_CONFIG = {
  ngramSize: 3,
  temperature: 0.7,
  maxTokens: 60,
  layerWeights: { char: 0.3, word: 0.5, sentence: 0.2 },
  botName: '',
  botPersona: '友好、热情、愿意帮助用户的 AI 助手',
};

// ============ 工具函数 ============

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function genId(prefix = 'model') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${ts}${rand}`;
}

function modelDir(modelId, baseDir = MODELS_DIR) {
  return path.join(baseDir, modelId);
}

function modelConfigPath(modelDir) { return path.join(modelDir, 'config.json'); }
function modelWeightsPath(modelDir) { return path.join(modelDir, 'token_weights.json'); }
function modelMetaPath(modelDir) { return path.join(modelDir, 'meta.json'); }

// ============ 模型 CRUD ============

// 创建新模型
function createModel(name, description = '', baseConfig = {}) {
  const id = genId('model');
  const dir = modelDir(id);
  ensureDir(dir);

  const config = { ...DEFAULT_CONFIG, ...baseConfig };
  const meta = {
    id,
    name: name || `模型 ${id.slice(-6)}`,
    description,
    created_at: Date.now(),
    updated_at: Date.now(),
    total_trainings: 0,
    total_weight_changes: 0,
  };
  const weights = []; // [{ layer, context, token, count, weight }]

  fs.writeFileSync(modelConfigPath(dir), JSON.stringify(config, null, 2), 'utf8');
  fs.writeFileSync(modelMetaPath(dir), JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(modelWeightsPath(dir), JSON.stringify(weights, null, 2), 'utf8');

  return { id, ...meta, config };
}

// 列出所有模型
function listModels() {
  ensureDir(MODELS_DIR);
  if (!fs.existsSync(MODELS_DIR)) return [];
  return fs.readdirSync(MODELS_DIR)
    .filter(name => fs.statSync(path.join(MODELS_DIR, name)).isDirectory())
    .map(id => {
      const meta = readJson(modelMetaPath(modelDir(id)));
      const config = readJson(modelConfigPath(modelDir(id)));
      const weights = readJson(modelWeightsPath(modelDir(id))) || [];
      const byLayer = { char: 0, word: 0, sentence: 0 };
      let totalCount = 0;
      for (const w of weights) { byLayer[w.layer] = (byLayer[w.layer] || 0) + 1; totalCount += (w.count || 0); }
      return {
        id,
        ...meta,
        config,
        weight_count: weights.length,
        weight_total_count: totalCount,
        weight_list_by_layer: byLayer,
      };
    })
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

// 读取模型（元信息+配置，不含权重）
function getModel(modelId) {
  const dir = modelDir(modelId);
  if (!fs.existsSync(dir)) return null;
  const meta = readJson(modelMetaPath(dir));
  const config = readJson(modelConfigPath(dir));
  const weights = readJson(modelWeightsPath(dir)) || [];
  return { id: modelId, ...meta, config, weight_count: weights.length };
}

// 读权重数据
function readWeights(modelDirPath) {
  if (!fs.existsSync(modelWeightsPath(modelDirPath))) return [];
  return readJson(modelWeightsPath(modelDirPath)) || [];
}

// 写权重数据
function writeWeights(modelDirPath, weights) {
  ensureDir(modelDirPath);
  fs.writeFileSync(modelWeightsPath(modelDirPath), JSON.stringify(weights, null, 2), 'utf8');
}

// 读 config
function readConfig(modelDirPath) {
  if (!fs.existsSync(modelConfigPath(modelDirPath))) return { ...DEFAULT_CONFIG };
  return readJson(modelConfigPath(modelDirPath));
}

// 写 config
function writeConfig(modelDirPath, config) {
  ensureDir(modelDirPath);
  fs.writeFileSync(modelConfigPath(modelDirPath), JSON.stringify(config, null, 2), 'utf8');
}

// 读 meta
function readMeta(modelDirPath) {
  if (!fs.existsSync(modelMetaPath(modelDirPath))) return {};
  return readJson(modelMetaPath(modelDirPath));
}

// 写 meta
function writeMeta(modelDirPath, meta) {
  ensureDir(modelDirPath);
  fs.writeFileSync(modelMetaPath(modelDirPath), JSON.stringify(meta, null, 2), 'utf8');
}

function updateMeta(modelDirPath, patch) {
  const meta = readMeta(modelDirPath);
  const updated = { ...meta, ...patch, updated_at: Date.now() };
  writeMeta(modelDirPath, updated);
  return updated;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// 更新模型信息
function updateModel(modelId, patch = {}) {
  const dir = modelDir(modelId);
  if (!fs.existsSync(dir)) return null;
  if (patch.config) writeConfig(dir, patch.config);
  const metaPatch = { ...patch };
  delete metaPatch.config;
  if (Object.keys(metaPatch).length > 0) updateMeta(dir, metaPatch);
  return getModel(modelId);
}

// 删除模型
function deleteModel(modelId) {
  const dir = modelDir(modelId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ============ 模型复制（用于聊天会话隔离） ============

// 复制模型到目标目录（聊天会话绑定）
function copyModel(sourceModelId, targetDir) {
  const srcDir = modelDir(sourceModelId);
  if (!fs.existsSync(srcDir)) return null;
  ensureDir(targetDir);

  // 复制三个文件
  for (const fname of ['config.json', 'token_weights.json', 'meta.json']) {
    const src = path.join(srcDir, fname);
    const dst = path.join(targetDir, fname);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  // 更新 meta
  const meta = readMeta(targetDir);
  meta.source_model_id = sourceModelId;
  meta.copied_at = Date.now();
  writeMeta(targetDir, meta);

  return targetDir;
}

// ============ 权重查询（替代原来的 db.query） ============
// 所有操作都是同步的，直接对 JSON 数组做处理

function getNextTokenProbs(layer, ctxKey, modelDirPath) {
  const weights = readWeights(modelDirPath);
  const rows = weights.filter(w => w.layer === layer && w.context === ctxKey);
  if (rows.length === 0) return null;
  const total = rows.reduce((s, w) => s + w.count, 0);
  return rows
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(w => ({ token: w.token, prob: w.count / total }));
}

// 精确短语查询
function getExactPhraseOutput(userInput, modelDirPath) {
  const weights = readWeights(modelDirPath);
  const tokenizer = require('../utils/tokenizer');

  // sentence 层优先
  const sToks = tokenizer.tokenizeAll(userInput).sentence || [];
  if (sToks.length > 0) {
    const ctx = sToks.join('|');
    const ctxLen = userInput.length;
    const rows = weights.filter(w => w.layer === 'sentence' && w.context === ctx && w.token.length > ctxLen);
    if (rows.length > 0) {
      rows.sort((a, b) => b.count - a.count || b.token.length - a.token.length);
      return rows[0].token;
    }
  }
  // word 层
  const wToks = tokenizer.tokenizeAll(userInput).word || [];
  if (wToks.length > 0 && wToks.length <= 4) {
    const ctx = wToks.join('|');
    const ctxLen = userInput.length;
    const rows = weights.filter(w => w.layer === 'word' && w.context === ctx && w.token.length > ctxLen);
    if (rows.length > 0) {
      rows.sort((a, b) => b.count - a.count || b.token.length - a.token.length);
      return rows[0].token;
    }
  }
  // char 层兜底
  const cToks = tokenizer.tokenizeAll(userInput).char || [];
  if (cToks.length > 0 && cToks.length <= 4) {
    const ctx = cToks.join('|');
    const ctxLen = userInput.length;
    const rows = weights.filter(w => w.layer === 'char' && w.context === ctx && w.token.length > ctxLen);
    if (rows.length > 0) {
      rows.sort((a, b) => b.count - a.count || b.token.length - a.token.length);
      return rows[0].token;
    }
  }
  return null;
}

// 训练：往权重表里加条目（用于 trainFromPair）
// 返回新增/更新的条数
function trainWeight(layer, context, token, modelDirPath) {
  const weights = readWeights(modelDirPath);
  const idx = weights.findIndex(w => w.layer === layer && w.context === context && w.token === token);
  if (idx >= 0) {
    weights[idx].count += 1;
  } else {
    weights.push({ layer, context, token, count: 1, weight: 1.0 });
  }
  writeWeights(modelDirPath, weights);
  // 更新 meta
  const meta = updateMeta(modelDirPath, { total_weight_changes: (readMeta(modelDirPath).total_weight_changes || 0) + 1 });
  return { changed: 1, meta };
}

// 批量训练（一次性加多条）
function batchTrainWeights(entries, modelDirPath) {
  let changed = 0;
  const weights = readWeights(modelDirPath);
  const keyMap = new Map();
  weights.forEach((w, i) => keyMap.set(`${w.layer}|${w.context}|${w.token}`, i));

  for (const e of entries) {
    const key = `${e.layer}|${e.context}|${e.token}`;
    const idx = keyMap.get(key);
    if (idx !== undefined) {
      weights[idx].count += e.count || 1;
    } else {
      weights.push({ layer: e.layer, context: e.context, token: e.token, count: e.count || 1, weight: 1.0 });
      keyMap.set(key, weights.length - 1);
    }
    changed++;
  }

  writeWeights(modelDirPath, weights);
  const meta = updateMeta(modelDirPath, {
    total_weight_changes: (readMeta(modelDirPath).total_weight_changes || 0) + changed,
    total_trainings: (readMeta(modelDirPath).total_trainings || 0) + 1,
  });
  return { changed, meta };
}

// ============ 聊天会话模型副本 ============

// 为聊天会话准备模型副本
function prepareChatModelCopy(sessionId, sourceModelId) {
  const chatDir = path.join(CHATS_DIR, sessionId);
  const modelCopyDir = path.join(chatDir, 'model');
  copyModel(sourceModelId, modelCopyDir);
  return modelCopyDir;
}

// 为训练会话绑定模型（不复制，直接用原模型）
function getTrainModelDir(modelId) {
  return modelDir(modelId);
}

// ============ 从旧 sqlite.db 迁移 ============

// 把全局 sqlite.db 的 token_weights 导出为新模型格式
function migrateFromSqliteDb(db, targetModelId = 'default') {
  const rows = db.query('SELECT layer, context, token, count, weight FROM token_weights');
  const dir = modelDir(targetModelId);
  ensureDir(dir);
  const weights = rows.map(r => ({
    layer: r.layer, context: r.context, token: r.token,
    count: r.count || 1, weight: r.weight || 1.0,
  }));
  writeWeights(dir, weights);
  // 确保有 config 和 meta
  if (!fs.existsSync(modelConfigPath(dir))) writeConfig(dir, { ...DEFAULT_CONFIG });
  if (!fs.existsSync(modelMetaPath(dir))) {
    writeMeta(dir, {
      id: targetModelId,
      name: '默认模型 (从 sqlite.db 迁移)',
      description: '迁移自旧 sqlite.db 数据库',
      created_at: Date.now(),
      updated_at: Date.now(),
      total_trainings: 0,
      total_weight_changes: weights.length,
    });
  }
  return { dir, weightCount: weights.length };
}

// ============ 统计 ============

function modelStats(modelDirPath) {
  const weights = readWeights(modelDirPath);
  const byLayer = { char: 0, word: 0, sentence: 0 };
  for (const w of weights) byLayer[w.layer] = (byLayer[w.layer] || 0) + 1;
  return { total: weights.length, byLayer };
}

// ============ 导出 ============

function exportModel(modelId, exportPath) {
  const dir = modelDir(modelId);
  if (!fs.existsSync(dir)) return null;
  ensureDir(path.dirname(exportPath));
  const weights = readWeights(dir);
  const stats = modelStats(dir);
  // 尝试从 db 读 corpus（如果存在）
  let corpus = [];
  try {
    const db = require('../models/db');
    if (db.query) corpus = db.query('SELECT * FROM corpus ORDER BY id');
  } catch(e) { /* ignore */ }
  const bundle = {
    version: 1,
    model_id: modelId,
    meta: readMeta(dir),
    config: readConfig(dir),
    stats: {
      weightsCount: stats.total,
      weightsByLayer: stats.byLayer,
      weightsTotalCount: weights.reduce((s,w) => s + (w.count||0), 0),
      corpusCount: corpus.length,
      exportedAt: Date.now(),
    },
    weights: weights,
    corpus: corpus,
    exported_at: Date.now(),
  };
  fs.writeFileSync(exportPath, JSON.stringify(bundle, null, 2), 'utf8');
  return exportPath;
}

// ============ 初始化：启动时确保有一个默认模型 ============

function ensureDefaultModel(dbForMigration) {
  ensureDir(MODELS_DIR);
  const existing = listModels();
  if (existing.length > 0) return existing[0].id;

  // 从旧 sqlite.db 迁移
  if (dbForMigration) {
    const migrated = migrateFromSqliteDb(dbForMigration, 'default');
    console.log(`📦 从 sqlite.db 迁移 ${migrated.weightCount} 条权重到 default 模型`);
    return 'default';
  }

  // 创建空模型
  const m = createModel('默认模型', '系统初始化的空模型');
  return m.id;
}

module.exports = {
  // 目录
  DATA_DIR, MODELS_DIR, CHATS_DIR, TRAININGS_DIR, EXPORTS_DIR,
  modelDir, getTrainModelDir,
  // 模型 CRUD
  createModel, listModels, getModel, updateModel, deleteModel,
  // 读写
  readWeights, writeWeights,
  readConfig, writeConfig,
  readMeta, writeMeta, updateMeta,
  // 查询/训练
  getNextTokenProbs, getExactPhraseOutput, trainWeight, batchTrainWeights,
  // 复制
  copyModel, prepareChatModelCopy,
  // 迁移/初始化
  migrateFromSqliteDb, ensureDefaultModel,
  // 工具
  modelStats, exportModel,
};
