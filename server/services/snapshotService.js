// 快照服务：每个训练任务独立快照
const db = require('../models/db');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../middlewares/logger');

// 创建快照（整个数据库导出为文件）
function createSnapshot(label = '', taskId = null) {
  try {
    const dir = config.snapshot.dir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const timestamp = Date.now();
    const fileName = `snapshot_${taskId || 'global'}_${timestamp}.db`;
    const filePath = path.join(dir, fileName);

    const data = db.exportDatabase();
    fs.writeFileSync(filePath, Buffer.from(data));

    // 记录到快照表
    db.run(
      'INSERT INTO snapshots (task_id, label, created_at, file_path) VALUES (?, ?, ?, ?)',
      [taskId, label, timestamp, filePath]
    );

    const snapId = db.lastInsertRowId();
    logger.info(`📸 快照已创建: #${snapId} -> ${fileName}`);

    // 清理旧快照（保留最近 20 个）
    cleanupOldSnapshots(20);

    return { id: snapId, label, taskId, filePath, created_at: timestamp };
  } catch (err) {
    logger.error('❌ 创建快照失败', err);
    throw err;
  }
}

// 从快照恢复
function restoreSnapshot(snapshotId) {
  const snaps = db.query('SELECT * FROM snapshots WHERE id = ?', [snapshotId]);
  if (!snaps.length) throw new Error('快照不存在');

  const snap = snaps[0];
  if (!fs.existsSync(snap.file_path)) {
    throw new Error('快照文件已丢失');
  }

  const data = fs.readFileSync(snap.file_path);
  db.importDatabase(data);

  logger.info(`🔄 已恢复快照 #${snapshotId}`);
  return true;
}

// 列出所有快照
function listSnapshots(taskId = null) {
  if (taskId) {
    return db.query('SELECT * FROM snapshots WHERE task_id = ? ORDER BY created_at DESC', [taskId]);
  }
  return db.query('SELECT * FROM snapshots ORDER BY created_at DESC');
}

// 删除快照
function deleteSnapshot(snapshotId) {
  const snaps = db.query('SELECT * FROM snapshots WHERE id = ?', [snapshotId]);
  if (!snaps.length) return false;

  const snap = snaps[0];
  try {
    if (fs.existsSync(snap.file_path)) fs.unlinkSync(snap.file_path);
  } catch (e) {
    logger.warn('删除快照文件失败', e);
  }
  db.run('DELETE FROM snapshots WHERE id = ?', [snapshotId]);
  return true;
}

// 清理旧快照
function cleanupOldSnapshots(keepCount) {
  const all = db.query('SELECT * FROM snapshots ORDER BY created_at DESC');
  if (all.length > keepCount) {
    const toDelete = all.slice(keepCount);
    for (const s of toDelete) {
      try {
        if (fs.existsSync(s.file_path)) fs.unlinkSync(s.file_path);
      } catch (e) {}
      db.run('DELETE FROM snapshots WHERE id = ?', [s.id]);
    }
  }
}

// 回滚到最新快照（全局）
function rollbackToLatest() {
  const snaps = listSnapshots();
  if (!snaps.length) throw new Error('没有可用的快照');
  return restoreSnapshot(snaps[0].id);
}

module.exports = {
  createSnapshot,
  restoreSnapshot,
  listSnapshots,
  deleteSnapshot,
  rollbackToLatest,
};
