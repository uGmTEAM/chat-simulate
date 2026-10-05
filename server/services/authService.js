// Auth Service — 明文密码 + 内存 session
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_PATH = path.resolve(__dirname, '../../data/users.json');
const SESSIONS = new Map();  // token -> { username, createdAt }

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_PATH, 'utf-8');
    return JSON.parse(raw).users || {};
  } catch (e) { return {}; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify({ users }, null, 2), 'utf-8');
}

// 第一步：验证用户名存在 + 未锁定
function verifyUsername(username) {
  const users = loadUsers();
  const u = users[username];
  if (!u) return { ok: false, code: 404, msg: 'User not found' };
  if (u.locked) return { ok: false, code: 423, msg: 'Account is locked' };
  return { ok: true };
}

// 第二步：登录（含 locked 检查）
function login(username, password) {
  const users = loadUsers();
  const u = users[username];
  if (!u) return { ok: false, code: 401, msg: 'Invalid credentials' };
  if (u.locked) return { ok: false, code: 423, msg: 'Account is locked' };
  if (u.password !== password) return { ok: false, code: 401, msg: 'Invalid credentials' };
  const token = crypto.randomBytes(16).toString('hex');
  SESSIONS.set(token, { username, createdAt: Date.now() });
  return { ok: true, token, username, role: u.role };
}

function getUserByToken(token) {
  if (!token) return null;
  const sess = SESSIONS.get(token);
  if (!sess) return null;
  const users = loadUsers();
  const u = users[sess.username];
  if (!u) return null;
  return { username: sess.username, role: u.role, createdAt: sess.createdAt };
}

function logout(token) {
  if (!token) return false;
  return SESSIONS.delete(token);
}

// ===== account 管理（admin only）=====
// add: username, password, confirm, role='trainer'
function addAccount(actor, username, password, confirm, role) {
  const users = loadUsers();
  if (users[username]) return { ok: false, code: 409, msg: 'Account already exists' };
  if (!username || !password) return { ok: false, code: 400, msg: 'Username and password required' };
  if (password !== confirm) return { ok: false, code: 400, msg: 'Passwords do not match' };
  if (password.length < 4) return { ok: false, code: 400, msg: 'Password too short (min 4)' };
  const r = (role || 'trainer').toLowerCase();
  if (!['admin', 'trainer'].includes(r)) return { ok: false, code: 400, msg: 'Invalid role (admin|trainer)' };
  users[username] = { password, role: r, locked: false, created_at: Date.now() };
  saveUsers(users);
  return { ok: true, msg: 'Account '+username+' ['+r+'] created' };
}

// del: username, confirm=true/false
function delAccount(actor, username, confirm) {
  const users = loadUsers();
  if (!users[username]) return { ok: false, code: 404, msg: 'Account not found' };
  if (username === actor) return { ok: false, code: 400, msg: 'Cannot delete yourself' };
  if (!confirm) return { ok: false, code: 400, msg: 'Confirm required (T/F)' };
  delete users[username];
  saveUsers(users);
  // 登出该用户所有 session
  for (const [t, s] of SESSIONS) { if (s.username === username) SESSIONS.delete(t); }
  return { ok: true, msg: 'Account '+username+' deleted' };
}

function lockAccount(actor, username) {
  const users = loadUsers();
  const u = users[username];
  if (!u) return { ok: false, code: 404, msg: 'Account not found' };
  if (username === actor) return { ok: false, code: 400, msg: 'Cannot lock yourself' };
  u.locked = true;
  saveUsers(users);
  // 强制登出
  for (const [t, s] of SESSIONS) { if (s.username === username) SESSIONS.delete(t); }
  return { ok: true, msg: 'Account '+username+' locked' };
}

function unlockAccount(actor, username) {
  const users = loadUsers();
  const u = users[username];
  if (!u) return { ok: false, code: 404, msg: 'Account not found' };
  u.locked = false;
  saveUsers(users);
  return { ok: true, msg: 'Account '+username+' unlocked' };
}

function renameAccount(actor, oldUsername, newUsername) {
  const users = loadUsers();
  if (!users[oldUsername]) return { ok: false, code: 404, msg: 'Old account not found' };
  if (users[newUsername]) return { ok: false, code: 409, msg: 'New username already taken' };
  if (!newUsername || !newUsername.trim()) return { ok: false, code: 400, msg: 'New username required' };
  const oldData = users[oldUsername];
  delete users[oldUsername];
  users[newUsername] = oldData;
  saveUsers(users);
  // 登出旧用户名所有 session
  for (const [t, s] of SESSIONS) { if (s.username === oldUsername) SESSIONS.delete(t); }
  return { ok: true, msg: 'Account renamed: '+oldUsername+' → '+newUsername };
}

function listAccounts() {
  const users = loadUsers();
  return Object.keys(users).map(n => ({
    username: n, role: users[n].role,
    locked: !!users[n].locked,
    created_at: users[n].created_at || null,
  }));
}

// ===== changepwd =====
function changePassword(actorUsername, oldPwd, newPwd, confirmNewPwd, targetUsername) {
  const users = loadUsers();
  const actor = users[actorUsername];
  if (!actor) return { ok: false, code: 401, msg: 'Actor not found' };
  const isAdmin = actor.role === 'admin';
  if (!isAdmin && targetUsername) {
    return { ok: false, code: 403, msg: 'Permission denied: non-admin cannot change other user\'s password' };
  }
  const target = targetUsername ? users[targetUsername] : actor;
  const targetName = targetUsername || actorUsername;
  if (!target) return { ok: false, code: 404, msg: 'Target user not found' };
  if (newPwd !== confirmNewPwd) return { ok: false, code: 400, msg: 'New passwords do not match' };
  if (!newPwd) return { ok: false, code: 400, msg: 'New password cannot be empty' };
  if (newPwd.length < 4) return { ok: false, code: 400, msg: 'New password too short (min 4 chars)' };
  if (target.password !== oldPwd) return { ok: false, code: 401, msg: 'Old password incorrect' };
  target.password = newPwd;
  saveUsers(users);
  return { ok: true, msg: 'Password changed for ' + targetName };
}

function ensureDefaults() {
  const users = loadUsers();
  let dirty = false;
  if (!users.admin) { users.admin = { password: '12345678', role: 'admin', locked: false, created_at: Date.now() }; dirty = true; }
  // 确保所有账号都有 locked 字段（兼容旧数据）
  for (const k of Object.keys(users)) { if (users[k].locked === undefined) { users[k].locked = false; dirty = true; } }
  if (dirty) saveUsers(users);
}

module.exports = {
  verifyUsername, login, getUserByToken, logout,
  addAccount, delAccount, lockAccount, unlockAccount, renameAccount, listAccounts,
  changePassword, ensureDefaults,
};
