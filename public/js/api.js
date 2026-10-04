// 公共 API 工具
const API = {
  async request(path, options = {}) {
    const url = path.startsWith('/') ? path : '/' + path;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
      body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // SSE 流式请求
  stream(path, body, callbacks = {}) {
    const url = path.startsWith('/') ? path : '/' + path;
    const evtSource = new EventSource(url.replace(/^https?:/, window.location.protocol));

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('event:')) {
            const event = line.substring(6).trim();
            const nextLine = lines.shift() || '';
            if (nextLine.startsWith('data:')) {
              const data = nextLine.substring(5).trim();
              if (callbacks[event]) callbacks[event](data);
            }
          } else if (line.startsWith('data:')) {
            const data = line.substring(5);
            if (callbacks.onData) callbacks.onData(data);
          }
        }
      }
      if (callbacks.onDone) callbacks.onDone();
    }).catch(err => {
      if (callbacks.onError) callbacks.onError(err);
    });

    return { abort: () => evtSource.close() };
  },

  // 对话
  chat: (message, sessionId) => API.request('/api/chat', { method: 'POST', body: { message, sessionId } }),
  chatRegenerate: (sessionId) => API.request('/api/chat/regenerate', { method: 'POST', body: { sessionId } }),

  // 训练
  train: (input, output) => API.request('/api/train', { method: 'POST', body: { input, output } }),
  trainProviders: () => API.request('/api/train/providers'),
  testProvider: (provider) => API.request('/api/train/providers/test', { method: 'POST', body: { provider } }),

  // 云训练
  cloudTrainStart: (opts) => API.request('/api/train/cloud/start', { method: 'POST', body: opts }),
  cloudTrainStop: (taskId) => API.request('/api/train/cloud/stop', { method: 'POST', body: { taskId } }),
  cloudTrainStatus: (taskId) => API.request(taskId ? `/api/train/cloud/status/${taskId}` : '/api/train/cloud/status'),
  cloudTrainLogs: (taskId, limit = 50) => API.request(`/api/train/cloud/logs/${taskId}?limit=${limit}`),

  // 权重
  weights: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return API.request('/api/weights' + (qs ? '?' + qs : ''));
  },
  adjustWeight: (data) => API.request('/api/weights/adjust', { method: 'POST', body: data }),
  deleteToken: (id) => API.request(`/api/tokens/${id}`, { method: 'DELETE' }),
  weightsStats: () => API.request('/api/weights/stats'),

  // 模型
  exportModel: () => window.location.href = '/api/model',
  importModel: (data) => API.request('/api/model', { method: 'POST', body: data }),
  saveModel: () => API.request('/api/model/save', { method: 'POST', body: {} }),
  createSnapshot: (label, taskId) => API.request('/api/model/snapshot', { method: 'POST', body: { label, taskId } }),
  listSnapshots: (taskId) => API.request('/api/model/snapshots' + (taskId ? '?taskId=' + taskId : '')),
  deleteSnapshot: (id) => API.request(`/api/model/snapshots/${id}`, { method: 'DELETE' }),
  restoreSnapshot: (id) => API.request(`/api/model/restore/${id}`, { method: 'POST', body: {} }),

  // 模型
  models: () => API.request('/api/models'),
  model: (id) => API.request('/api/models/' + id),
  createModel: (body) => API.request('/api/models', { method: 'POST', body }),
  deleteModel: (id) => API.request('/api/models/' + id, { method: 'DELETE' }),
  updateModel: (id, body) => API.request('/api/models/' + id, { method: 'PUT', body }),

  // 会话
  sessions: () => API.request('/api/sessions'),
  createSession: (body) => API.request('/api/sessions', { method: 'POST', body: typeof body === 'string' ? { name: body } : body }),
  renameSession: (id, name) => API.request(`/api/sessions/${id}`, { method: 'PUT', body: { name } }),
  deleteSession: (id) => API.request(`/api/sessions/${id}`, { method: 'DELETE' }),
  updateSession: (id, body) => API.request(`/api/sessions/${id}`, { method: 'PATCH', body }),
  sessionHistory: (id) => API.request(`/api/history/${id}`),
  exportSession: (id) => API.request(`/api/sessions/${id}/export`, { method: 'POST' }),

  // 搜索
  searchHistory: (q, limit = 20) => API.request(`/api/search/history?q=${encodeURIComponent(q)}&limit=${limit}`),
  searchWeights: (q, limit = 50) => API.request(`/api/search/weights?q=${encodeURIComponent(q)}&limit=${limit}`),
  searchCorpus: (q, limit = 20) => API.request(`/api/search/corpus?q=${encodeURIComponent(q)}&limit=${limit}`),

  // 统计
  stats: () => API.request('/api/stats'),
  commands: () => API.request('/api/stats/commands'),

  // 数据/配置
  datasetStatus: () => API.request('/api/dataset/status'),
  datasetImportBuiltin: () => API.request('/api/dataset/download', { method: 'POST', body: {} }),
  datasetImportCustom: (data) => API.request('/api/dataset/import', { method: 'POST', body: data }),
  clearDataset: () => API.request('/api/dataset', { method: 'DELETE' }),
  config: () => API.request('/api/config'),
  updateConfig: (data) => API.request('/api/config', { method: 'POST', body: data }),
  updateKeys: (keys) => API.request('/api/config/keys', { method: 'POST', body: keys }),
};

// Toast 提示
function toast(msg, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(100%)';
    el.style.transition = 'all 0.3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// 格式化时间戳
function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString();
}
