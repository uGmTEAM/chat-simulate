// sql.js SQLite 数据库封装层
// sql.js 是 SQLite 的 WASM 版本，异步初始化
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../middlewares/logger');

let SQL = null;
let db = null;
let saveTimer = null;
let pendingChanges = false;

// 初始化数据库
async function initDatabase() {
  SQL = await initSqlJs({
    // sql.js 需要 WASM 文件
    locateFile: (file) => {
      return path.join(__dirname, '../../node_modules/sql.js/dist/', file);
    },
  });

  // 尝试加载已有数据库文件
  const dbPath = config.database.path;
  if (fs.existsSync(dbPath)) {
    const data = fs.readFileSync(dbPath);
    db = new SQL.Database(data);
    logger.info('✅ 数据库加载成功', { path: dbPath });
  } else {
    db = new SQL.Database();
    logger.info('🆕 创建新的内存数据库');
  }

  // 初始化表结构
  initTables();

  // 启动定时保存（如果配置了 interval 模式）
  startAutoSave();

  return db;
}

// 初始化所有表
function initTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '新会话',
      type TEXT NOT NULL DEFAULT 'chat',   -- 'chat' 或 'train'
      model_id TEXT NOT NULL DEFAULT 'default',  -- 绑定的模型ID
      model_dir TEXT,                         -- 聊天会话的模型副本目录
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  // ===== 向后兼容迁移 =====
  ensureColumn('messages', 'thinking', 'TEXT');
  ensureColumn('sessions', 'type', "TEXT NOT NULL DEFAULT 'chat'");
  ensureColumn('sessions', 'model_id', "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn('sessions', 'model_dir', 'TEXT');
  ensureColumn('sessions', 'locked', "INTEGER DEFAULT 0");
  ensureColumn('sessions', 'locked_by', 'TEXT DEFAULT NULL');
  ensureColumn('sessions', 'locked_at', 'INTEGER DEFAULT NULL');

  // 会话锁定表
  db.run(`
    CREATE TABLE IF NOT EXISTS session_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      locked_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  // Token 权重表（多层级：char/word/sentence）
  db.run(`
    CREATE TABLE IF NOT EXISTS token_weights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layer TEXT NOT NULL CHECK(layer IN ('char','word','sentence')),
      context TEXT NOT NULL,        -- 前面的 N-gram 上下文（JSON数组或空格分隔）
      token TEXT NOT NULL,          -- 下一个 token
      count INTEGER NOT NULL DEFAULT 1,  -- 出现次数
      weight REAL NOT NULL DEFAULT 1.0,  -- 权重（训练后调整）
      UNIQUE(layer, context, token)
    );
  `);

  // 训练日志
  db.run(`
    CREATE TABLE IF NOT EXISTS train_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('manual','auto','ai_cloud')),
      provider TEXT,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
      input TEXT,
      output TEXT,
      weights_changed INTEGER DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);

  // 快照表（记录每个快照时的内存状态位置）
  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,              -- 关联训练任务ID（并行训练各自独立）
      label TEXT,                -- 快照描述
      created_at INTEGER NOT NULL,
      file_path TEXT NOT NULL    -- 快照文件路径（二进制导出）
    );
  `);

  // 导入的语料库
  db.run(`
    CREATE TABLE IF NOT EXISTS corpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      source TEXT DEFAULT 'builtin',
      tags TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
  `);

  // 配置持久化（前端设置的保存策略、错误策略等）
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  logger.info('✅ 数据库表初始化完成 (FTS5 未启用，使用 LIKE 检索)');
}

// 标记有待保存变更
function markDirty() {
  pendingChanges = true;
}

// 立即保存到磁盘
function save() {
  if (!db) return false;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    // 确保目录存在
    const dir = path.dirname(config.database.path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config.database.path, buffer);
    pendingChanges = false;
    logger.debug('💾 数据库已保存到磁盘');
    return true;
  } catch (err) {
    logger.error('❌ 数据库保存失败', err);
    return false;
  }
}

// 定时自动保存
function startAutoSave() {
  const strategy = config.saveStrategy.mode;
  if (strategy === 'interval') {
    const interval = (config.saveStrategy.intervalSeconds || 30) * 1000;
    saveTimer = setInterval(() => {
      if (pendingChanges) {
        save();
      }
    }, interval);
    logger.info(`⏰ 定时保存已启动 (每${config.saveStrategy.intervalSeconds}秒)`);
  }
}

// 更改保存策略
function setSaveStrategy(mode, intervalSeconds) {
  config.saveStrategy.mode = mode;
  if (intervalSeconds) config.saveStrategy.intervalSeconds = intervalSeconds;
  // 清除旧定时器
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  if (mode === 'interval') {
    startAutoSave();
  } else if (mode === 'realtime') {
    // realtime 模式需要在每次 markDirty 后自动 save
    // 但为了性能，改为每次 run 后自动保存
  }
  return { mode, intervalSeconds: config.saveStrategy.intervalSeconds };
}

// 通用查询：执行 SQL 并返回结果数组
function query(sql, params = []) {
  if (!db) throw new Error('数据库未初始化');
  markDirty();
  try {
    const stmt = db.prepare(sql);
    if (params && params.length) stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (err) {
    logger.error('SQL 执行错误', { sql, params, error: err.message });
    throw err;
  }
}

// 执行写操作
function run(sql, params = []) {
  if (!db) throw new Error('数据库未初始化');
  if (config.saveStrategy.mode === 'realtime') {
    markDirty();
  } else {
    markDirty();
  }
  try {
    db.run(sql, params);
    if (config.saveStrategy.mode === 'realtime') {
      save();
    }
    return true;
  } catch (err) {
    logger.error('SQL 执行错误', { sql, params, error: err.message });
    throw err;
  }
}

// 获取最后插入的 ID
function lastInsertRowId() {
  return query('SELECT last_insert_rowid() as id')[0]?.id || 0;
}

// 导出整个数据库（用于快照）
function exportDatabase() {
  if (!db) throw new Error('数据库未初始化');
  return db.export();  // Uint8Array
}

// 从快照恢复数据库
function importDatabase(uint8Array) {
  if (!SQL) throw new Error('SQL 未初始化');
  if (db) db.close();
  db = new SQL.Database(uint8Array);
  logger.info('🔄 数据库已从快照恢复');
  save();
}

// 获取原始 db 对象（用于复杂操作）
function getDb() {
  return db;
}

// 向后兼容：检查列是否存在，不存在则 ADD COLUMN
function ensureColumn(table, column, type) {
  try {
    const colsRaw = db.exec('PRAGMA table_info(' + table + ')');
    const cols = colsRaw && colsRaw[0] ? colsRaw[0].values.map(row => ({ name: row[1] })) : [];
    const exists = cols.some(c => c.name === column);
    if (!exists) {
      db.run('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
      logger.info('🔧 迁移: ' + table + ' 添加列 ' + column);
    }
  } catch (e) {
    logger.warn('ensureColumn failed: ' + e.message);
  }
}

// 会话锁定管理
function getLock(sessionId) {
  try {
    const rows = db.query('SELECT * FROM session_locks WHERE session_id = ?', [sessionId]);
    return rows[0] || null;
  } catch (e) { return null; }
}
function lockSession(sessionId, userId) {
  try {
    const now = Date.now();
    db.run('INSERT OR REPLACE INTO session_locks (session_id, user_id, locked_at) VALUES (?, ?, ?)', [sessionId, userId, now]);
    db.run('UPDATE sessions SET locked = 1, locked_by = ?, locked_at = ? WHERE id = ?', [userId, now, sessionId]);
  } catch (e) { logger?.warn?.('lockSession error: ' + e.message); }
}
function unlockSession(sessionId) {
  try {
    db.run('DELETE FROM session_locks WHERE session_id = ?', [sessionId]);
    db.run('UPDATE sessions SET locked = 0, locked_by = NULL, locked_at = NULL WHERE id = ?', [sessionId]);
  } catch (e) { logger?.warn?.('unlockSession error: ' + e.message); }
}
function unlockSessionByUser(userId) {
  try {
    const rows = db.query('SELECT session_id FROM session_locks WHERE user_id = ?', [userId]);
    for (const r of rows) unlockSession(r.session_id);
  } catch (e) { logger?.warn?.('unlockSessionByUser error: ' + e.message); }
}

function close() {
  if (pendingChanges) save();
  if (saveTimer) clearInterval(saveTimer);
  if (db) db.close();
  logger.info('👋 数据库已关闭');
}

module.exports = {
  initDatabase,
  save,
  markDirty,
  setSaveStrategy,
  query,
  run,
  lastInsertRowId,
  exportDatabase,
  importDatabase,
  getDb,
  close,
  getLock,
  lockSession,
  unlockSession,
  unlockSessionByUser,
};


