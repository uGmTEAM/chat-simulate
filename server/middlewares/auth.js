// Auth middleware + routes
const express = require('express');
const auth = require('../services/authService');

const router = express.Router();

const WHITELIST = [
  /^\/api\/auth\/verify-user$/,
  /^\/api\/auth\/login$/,
  /^\/api\/health$/,
];

function isWhitelisted(path) {
  return WHITELIST.some(re => re.test(path));
}

// 解析布尔值（on/off, T/F, 1/0, true/false）
function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').trim().toLowerCase();
  if (['on','t','1','true','yes','y'].includes(s)) return true;
  if (['off','f','0','false','no','n'].includes(s)) return false;
  return null;
}

function requireAuth(req, res, next) {
  if (isWhitelisted(req.path)) return next();
  const token = req.cookies && req.cookies.csim_session;
  const user = auth.getUserByToken(token);
  if (!user) {
    if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Authentication required' });
    return res.redirect('/');
  }
  req.user = user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== role) return res.status(403).json({ error: 'Permission denied: role ['+req.user.role+'] requires ['+role+']' });
    next();
  };
}

// ===== Auth Routes =====

// 第一步：验证用户名
router.post('/verify-user', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  const r = auth.verifyUsername(username.trim());
  if (!r.ok) return res.status(r.code).json({ error: r.msg });
  res.json({ ok: true });
});

// 第二步：登录
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const r = auth.login(username.trim(), password);
  if (!r.ok) return res.status(r.code).json({ error: r.msg });
  res.cookie('csim_session', r.token, {
    httpOnly: true, path: '/', maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax',
  });
  res.json({ ok: true, username: r.username, role: r.role });
});

router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies.csim_session;
  auth.logout(token);
  res.clearCookie('csim_session', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies && req.cookies.csim_session;
  const user = auth.getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ ok: true, username: user.username, role: user.role });
});

router.post('/changepwd', (req, res) => {
  const token = req.cookies && req.cookies.csim_session;
  const me = auth.getUserByToken(token);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const { oldpwd, newpwd, confirm, username } = req.body || {};
  if (!oldpwd || !newpwd || !confirm) return res.status(400).json({ error: 'oldpwd, newpwd, confirm required' });
  const r = auth.changePassword(me.username, oldpwd, newpwd, confirm, username);
  if (!r.ok) return res.status(r.code).json({ error: r.msg });
  res.json({ ok: true, msg: r.msg });
});

// ===== Account Routes (admin only) =====
router.get('/accounts', requireRole('admin'), (req, res) => {
  res.json({ ok: true, accounts: auth.listAccounts() });
});

router.post('/accounts/add', requireRole('admin'), (req, res) => {
  const { username, password, confirm, role } = req.body || {};
  if (!username || !password || !confirm) return res.status(400).json({ error: 'username, password, confirm required' });
  const r = auth.addAccount(req.user.username, username.trim(), password, confirm, role);
  if (!r.ok) return res.status(r.code).json({ error: r.msg });
  res.json({ ok: true, msg: r.msg });
});

router.post('/accounts/del', requireRole('admin'), (req, res) => {
  const { username, confirm } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  const cb = toBool(confirm);
  if (cb === null) return res.status(400).json({ error: 'confirm must be T/F/1/0/on/off' });
  const r = auth.delAccount(req.user.username, username.trim(), cb);
  if (!r.ok) return res.status(r.code).json({ error: r.msg });
  res.json({ ok: true, msg: r.msg });
});

router.post('/accounts/lock', requireRole('admin'), (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  const r = auth.lockAccount(req.user.username, username.trim());
  if (!r.ok) return res.status(r.code).json({ error: r.msg });
  res.json({ ok: true, msg: r.msg });
});

router.post('/accounts/unlock', requireRole('admin'), (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  const r = auth.unlockAccount(req.user.username, username.trim());
  if (!r.ok) return res.status(r.code).json({ error: r.msg });
  res.json({ ok: true, msg: r.msg });
});

router.post('/accounts/rename', requireRole('admin'), (req, res) => {
  const { username, newUsername } = req.body || {};
  if (!username || !newUsername) return res.status(400).json({ error: 'username, newUsername required' });
  const r = auth.renameAccount(req.user.username, username.trim(), newUsername.trim());
  if (!r.ok) return res.status(r.code).json({ error: r.msg });
  res.json({ ok: true, msg: r.msg });
});

module.exports = { router, requireAuth };
