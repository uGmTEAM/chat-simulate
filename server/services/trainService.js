// 本地训练服务
const ngram = require('../utils/ngram');
const db = require('../models/db');
const logger = require('../middlewares/logger');
const config = require('../config');

// 手动训练：用户提交修正后的回复
function manualTrain(input, output, sessionId) {
  const startTime = Date.now();

  // 记录训练日志
  db.run(
    "INSERT INTO train_logs (type, status, input, output, started_at) VALUES ('manual', 'running', ?, ?, ?)",
    [input, output, startTime]
  );
  const logId = db.lastInsertRowId();

  try {
    const changes = ngram.trainFromPair(input, output);
    const duration = Date.now() - startTime;

    db.run(
      "UPDATE train_logs SET status='completed', weights_changed=?, completed_at=? WHERE id=?",
      [changes, Date.now(), logId]
    );

    logger.info(`✅ 手动训练完成: +${changes}权重, ${duration}ms`);
    return { success: true, weightChanges: changes, duration };
  } catch (err) {
    db.run("UPDATE train_logs SET status='failed', completed_at=? WHERE id=?", [Date.now(), logId]);
    logger.error('❌ 手动训练失败', err);
    return { success: false, error: err.message };
  }
}

// 从语料库批量训练
function trainFromCorpus(corpusItems, source = 'import') {
  const startTime = Date.now();
  let totalChanges = 0;
  let successCount = 0;
  let failCount = 0;

  db.run(
    "INSERT INTO train_logs (type, status, started_at) VALUES ('auto', 'running', ?)",
    [startTime]
  );
  const logId = db.lastInsertRowId();

  for (const item of corpusItems) {
    try {
      if (!item.input || !item.output) continue;
      const changes = ngram.trainFromPair(item.input, item.output);
      totalChanges += changes;
      successCount++;
    } catch (e) {
      failCount++;
    }
  }

  const duration = Date.now() - startTime;
  db.run(
    "UPDATE train_logs SET status='completed', weights_changed=?, completed_at=? WHERE id=?",
    [totalChanges, Date.now(), logId]
  );

  logger.info(`✅ 批量训练完成: ${successCount}/${corpusItems.length}, +${totalChanges}权重, ${duration}ms`);

  return {
    success: true,
    processed: successCount,
    failed: failCount,
    totalChanges,
    duration,
  };
}

// 自动对比训练（对话中自动调整权重方向）
function autoAdjustFromDialog(userMsg, botReply, nextUserMsg) {
  // 如果用户下一条消息是肯定类，加强权重；是否定类则降低
  const positivePatterns = ['好的', '不错', '对', '是的', '嗯嗯', '太棒了', '说得好', '👍', '好棒'];
  const negativePatterns = ['不对', '不是', '不行', '太差', '错', '什么意思', '听不懂', '😅', '🤔'];

  let adjustment = 0;
  for (const p of positivePatterns) {
    if (nextUserMsg.includes(p)) adjustment += 1;
  }
  for (const p of negativePatterns) {
    if (nextUserMsg.includes(p)) adjustment -= 1;
  }

  if (adjustment === 0) return null;

  // 简单策略：按 adjustment 调整 context 下所有 token 的 weight
  const tokenizer = require('../utils/tokenizer');
  const layers = tokenizer.tokenizeAll(userMsg);
  const n = config.simulate.ngramSize;

  for (const layer of ['char', 'word', 'sentence']) {
    const tokens = layers[layer] || [];
    if (tokens.length === 0) continue;
    const ctxKey = tokens.slice(-n).join('|');

    // 更新所有匹配的 token weight
    db.run(
      `UPDATE token_weights SET weight = MAX(0.1, MIN(10, weight + ?)) WHERE layer = ? AND context = ?`,
      [adjustment * 0.05, layer, ctxKey]
    );
  }

  logger.debug(`自动调整权重: ${adjustment > 0 ? '+' : ''}${adjustment}`);
  return { adjustment };
}

module.exports = {
  manualTrain,
  trainFromCorpus,
  autoAdjustFromDialog,
};
