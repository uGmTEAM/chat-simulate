// 模型控制器 - /api/models  (复数)
// 多模型管理：CRUD + 复制 + 导出
const express = require('express');
const modelService = require('../services/modelService');
const ngram = require('../utils/ngram');
const path = require('path');

const router = express.Router();

// GET /api/models - 列出所有模型
router.get('/', (req, res) => {
  try {
    const models = modelService.listModels();
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/models - 创建新模型
// body: { name, description, config }
router.post('/', (req, res) => {
  try {
    const { name, description, config } = req.body || {};
    const model = modelService.createModel(name, description || '', config);
    res.json(model);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/models/:id - 获取模型详情
router.get('/:id', (req, res) => {
  try {
    const model = modelService.getModel(req.params.id);
    if (!model) return res.status(404).json({ error: '模型不存在' });
    const dir = modelService.modelDir(req.params.id);
    const stats = modelService.modelStats(dir);
    const weight_list = modelService.readWeights(dir).sort((a,b)=>b.count-a.count);
    res.json({ ...model, stats, weight_list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/models/:id - 更新模型（名称、配置等）
router.put('/:id', (req, res) => {
  try {
    const model = modelService.updateModel(req.params.id, req.body || {});
    if (!model) return res.status(404).json({ error: '模型不存在' });
    res.json(model);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/models/:id - 删除模型
router.delete('/:id', (req, res) => {
  try {
    if (req.params.id === 'default') {
      return res.status(400).json({ error: 'default 模型受保护，不能删除' });
    }
    const ok = modelService.deleteModel(req.params.id);
    ngram.invalidateCache();
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/models/:id/train - 训练模型（给指定模型加训练对）
// body: { input, output, layers }
router.post('/:id/train', (req, res) => {
  try {
    const { input, output, layers } = req.body || {};
    if (!input || !output) return res.status(400).json({ error: 'input 和 output 必填' });
    const dir = modelService.modelDir(req.params.id);
    const changes = ngram.trainFromPair(input, output, { modelDir: dir, layers });
    res.json({ success: true, weightChanges: changes, model_id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/models/:id/train-batch - 批量训练
// body: { pairs: [{input, output}] }
router.post('/:id/train-batch', (req, res) => {
  try {
    const pairs = req.body?.pairs || [];
    if (!pairs.length) return res.status(400).json({ error: 'pairs 不能为空' });
    const dir = modelService.modelDir(req.params.id);
    let total = 0;
    for (const p of pairs) {
      total += ngram.trainFromPair(p.input, p.output, { modelDir: dir });
    }
    res.json({ success: true, pairs: pairs.length, totalWeightChanges: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/models/:id/export - 导出模型为 JSON 文件下载
router.get('/:id/export', (req, res) => {
  try {
    const dir = modelService.modelDir(req.params.id);
    const fname = `model_${req.params.id}_${Date.now()}.json`;
    const fpath = path.join(modelService.EXPORTS_DIR, fname);
    modelService.exportModel(req.params.id, fpath);
    res.download(fpath, fname);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/models/:id/test - 测试模型对指定输入的回复（不用开 chat 会话）
// query: ?input=你好
router.get('/:id/test', (req, res) => {
  try {
    const input = req.query.input;
    if (!input) return res.status(400).json({ error: 'input query 必填' });
    const dir = modelService.modelDir(req.params.id);
    const exact = ngram.getExactPhraseOutput(input, { modelDir: dir });
    const stats = modelService.modelStats(dir);
    res.json({
      model_id: req.params.id,
      input,
      exact_match: exact,
      stats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
