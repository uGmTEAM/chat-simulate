// Chat Simulate - Express 入口
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const logger = require('./middlewares/logger');
const db = require('./models/db');
const trainService = require('./services/trainService');
const authService = require('./services/authService');
const fs = require('fs');

async function bootstrap() {
  logger.info('🚀 Chat Simulate 启动中...');

  // 0. Auth 默认账号
  authService.ensureDefaults();
  logger.info('✅ Auth 模块就绪');

  // 1. 初始化数据库
  await db.initDatabase();
  logger.info('✅ 数据库就绪');

  // 2. 检查是否有内置语料库，首次启动自动导入
  const corpusPath = config.corpus.path;
  const corpusCount = db.query('SELECT COUNT(*) as c FROM corpus')[0].c;

  if (fs.existsSync(corpusPath) && corpusCount === 0) {
    logger.info('📚 首次启动，导入内置语料库...');
    try {
      const data = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));
      if (Array.isArray(data) && data.length > 0) {
        const now = Date.now();
        for (const item of data) {
          if (!item.input || !item.output) continue;
          db.run(
            'INSERT OR IGNORE INTO corpus (input, output, source, created_at) VALUES (?, ?, ?, ?)',
            [item.input, item.output, 'builtin', now]
          );
          trainService.manualTrain(item.input, item.output);
        }
        db.save();
        logger.info(`✅ 内置语料库导入完成: ${data.length} 组对话已训练`);
      }
    } catch (err) {
      logger.error('❌ 语料库导入失败', err);
    }
  } else {
    logger.info(`📚 语料库已存在: ${corpusCount} 组`);
  }

  // 3. 确保 default 模型存在（首次启动时从 sqlite.db 迁移权重）
  const modelService = require('./services/modelService');
  modelService.ensureDefaultModel(db);

  // 4. 初始化默认会话
  const sessionCount = db.query('SELECT COUNT(*) as c FROM sessions')[0].c;
  if (sessionCount === 0) {
    const now = Date.now();
    // 创建聊天会话，绑定 default 模型
    const chatDir = require('path').join(modelService.CHATS_DIR, `sess_default_${now.toString(36)}`);
    const modelDir = require('path').join(chatDir, 'model');
    modelService.copyModel('default', modelDir);
    db.run(
      'INSERT INTO sessions (name, type, model_id, model_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['默认会话', 'chat', 'default', modelDir, now, now]
    );
    logger.info('✅ 创建默认会话（聊天+default模型副本）');
  }

  // 5. 初始化 Express
  const app = express();

  // 中间件
  app.use(cors({origin:true,credentials:true}));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  // 请求日志
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.path.startsWith('/api')) {
        logger.debug(`${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
      }
    });
    next();
  });

  // 静态文件 + 根路径
  app.get('/', (req, res) => { res.setHeader('Cache-Control','no-cache, no-store, must-revalidate'); res.setHeader('Pragma','no-cache'); res.setHeader('Expires','0'); res.sendFile(path.resolve(__dirname, '../public/terminal.html')); });
  const authMW = require('./middlewares/auth');
  // /skills 需登录
  app.use('/skills', authMW.requireAuth);
  // /api/* 需登录（白名单除外），放在 static 前拦截
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    authMW.requireAuth(req, res, next);
  });
  // HTML 页面仅允许从 terminal 应用内访问，直接浏览器打开拒绝
  app.use((req, res, next) => {
    if (!req.path.endsWith('.html') || req.headers['x-app-source'] === 'terminal') return next();
    return res.status(403).json({ error: 'Direct browser access to HTML pages is not allowed' });
  });
  // 通过 API 提供页面内容（带认证）
  const publicDir = path.resolve(__dirname, '../public');
  app.get('/api/pages/:name', authMW.requireAuth, (req, res) => {
    const fileName = req.params.name + '.html';
    const filePath = path.join(publicDir, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Page not found' });
    const html = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
  app.use(express.static(path.resolve(__dirname, '../public'), { maxAge: 0, etag: false }));

  // Auth 路由
  app.use('/api/auth', authMW.router);

  // API 路由
  app.use('/api/chat', require('./controllers/chatController'));
  app.use('/api/train', require('./controllers/trainController'));
  app.use('/api/weights', require('./controllers/weightController'));
  app.use('/api/models', require('./controllers/modelController'));
  app.use('/api/model', require('./controllers/modelController')); // 兼容旧前端
  app.use('/api/sessions', require('./controllers/sessionController'));
  app.use('/api/history', require('./controllers/historyController'));
  app.use('/api/search', require('./controllers/searchController'));
  app.use('/api/stats', require('./controllers/statsController'));
  app.use('/api/dataset', require('./controllers/dataController'));
  app.use('/api/config', require('./controllers/dataController')); // 配置接口复用
  app.use('/api/providers', require('./controllers/trainController'));
  app.use('/api/cloud-train', require('./controllers/trainController'));

  // ===== Skills API =====
  const skillsDir = path.resolve(__dirname, '../public/skills');
  const fsSkills = require('fs');
  const pathNode = require('path');
  app.get('/api/skills', (req, res) => {
    try {
      if (!fsSkills.existsSync(skillsDir)) return res.json({ skills: [] });
      const files = fsSkills.readdirSync(skillsDir);
      const htmlFiles = files.filter(f => f.endsWith('.html'));
      const skiFiles = files.filter(f => f.endsWith('.ski'));
      const skills = [];
      for (const f of htmlFiles) {
        const name = f.replace('.html', '');
        if (!skills.find(s => s.id === name))
          skills.push({ id: name, name, file: f, type: 'html' });
      }
      for (const f of skiFiles) {
        try {
          const meta = JSON.parse(fsSkills.readFileSync(pathNode.join(skillsDir, f), 'utf8'));
          if (!meta.name) continue;
          if (!skills.find(s => s.id === meta.name))
            skills.push({ id: meta.name, name: meta.name || f.replace('.ski',''), file: f, type: 'ski', description: meta.description, commands: meta.commands||[] });
        } catch(e) {}
      }
      res.json({ skills });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/api/skills/:name', (req, res) => {
    const baseName = req.params.name;
    // Try .ski first
    const skiPath = pathNode.join(skillsDir, baseName + '.ski');
    if (fsSkills.existsSync(skiPath)) {
      try {
        const meta = JSON.parse(fsSkills.readFileSync(skiPath, 'utf8'));
        let html = meta.html || '';
        if (!html && meta.htmlFile) {
          const extPath = pathNode.join(skillsDir, meta.htmlFile);
          if (fsSkills.existsSync(extPath))
            html = fsSkills.readFileSync(extPath, 'utf8');
        }
        return res.json({ id: meta.name || baseName, html, meta });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    // Fallback to .html
    const filePath = pathNode.join(skillsDir, baseName + '.html');
    if (!fsSkills.existsSync(filePath)) return res.status(404).json({ error: 'Skill not found' });
    const content = fsSkills.readFileSync(filePath, 'utf8');
    res.json({ id: baseName, html: content, meta: null });
  });

  // ===== Web Search API =====
  app.get('/api/web-search', async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'q 参数必填' });
      const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&count=10';
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      const text = await r.text();
      const results = [];
      const re = /<li class="b_algo"><h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        const snippet = m[3].replace(/<[^>]+>/g, '').trim().substring(0, 200);
        results.push({ title, url: m[1], snippet });
        if (results.length >= 10) break;
      }
      res.json({ query: q, results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const os = require('os');
// 健康检查
app.get('/api/health', (req, res) => {
  let username = 'user';
  try { username = os.userInfo().username || 'user'; } catch (e) {}
  const info = {
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    sysinfo: {
      username,
      hostname: os.hostname(),
      platform: os.platform(),
    },
  };
  res.json(info);
});

  // 404
  app.use((req, res) => {
    res.status(404).json({ error: `Not Found: ${req.path}` });
  });

  // 错误处理
  app.use((err, req, res, next) => {
    logger.error('Express 错误', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  });

  // 5. 启动服务
  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info('');
    logger.info('╔══════════════════════════════════════════╗');
    logger.info('║   💬 Chat Simulate 启动成功               ║');
    logger.info(`║   🌐 http://localhost:${config.server.port}         ║`);
    logger.info('║   📖 API: /api/health                    ║');
    logger.info('╚══════════════════════════════════════════╝');
    logger.info('');
  });

  // 优雅关闭
  const shutdown = async (signal) => {
    logger.info(`\n📴 收到 ${signal}，正在优雅关闭...`);
    server.close(() => {
      db.close();
      logger.info('👋 服务已关闭');
      process.exit(0);
    });
    // 5 秒强制退出
    setTimeout(() => {
      logger.error('⚠️ 超时强制退出');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('未捕获异常', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理 Promise rejection', reason);
  });
}

bootstrap().catch(err => {
  logger.error('❌ 启动失败', err);
  process.exit(1);
});


