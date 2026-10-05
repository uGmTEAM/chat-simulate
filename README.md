# Chat Simulate — 对话模拟训练平台

**混合架构**：轻量 Transformer（字符级，16万参数）+ Token 权重 N-gram 概率融合。无需外部 LLM API，纯本地运行。新建模型自动初始化 Transformer（优先使用），旧模型回退 N-gram 路径。通过训练（`用户输入 → 期望输出`）pair 让模型学会回复，支持 think 阶段逐 token 生成 + reply 阶段逐 token 打字机效果。

## ✨ 特色

- **零依赖外部 API**：纯 Node.js，不调用任何 LLM
- **Transformer + N-gram 双路径**：新建模型自动初始化 2-layer / 64-dim embed / 2-head Transformer，旧模型回退 N-gram
- **16 万参数纯 JS Transformer**：字符级 tokenization，teacher-forcing 训练，greedy 自回归生成，~4.2MB JSON 存储
- **多模型隔离**：chat 会话自动 copyModel 副本，不会污染原模型
- **空白模型自由乱输出**：0 权重时从常用汉字池采样
- **两阶段生成**：thinking（思考过程）+ reply（回复）均逐 token 输出
- **N-gram 三层融合**：char(字) + word(词) + sentence(句) 加权采样
- **可训练**：任何模型都可以通过训练 pair 学会新回复（Transformer + N-gram 同时更新）
- **导出/导入**：完整 JSON 格式（stats + weights + corpus + transformer.json）
- **会话锁定**：绑定会话后自动锁定，其他人无法交互
- **Skill 系统**：通过 `./gui` 加载内置 HTML 面板，`/skill <name>` 加载扩展 skill（需登录）
- **Cookie 持久化登录**：登录状态保存在本地 cookie，刷新页面自动恢复；quit 命令清理 cookie

## 📋 环境要求

| 组件 | 要求 |
|------|------|
| Node.js | >= 18（推荐 v20+） |
| 操作系统 | Windows 10/11 |
| 端口 | 55440（可在 `server/config.yaml` 修改） |

## 🚀 快速开始（Windows）

### 步骤 1：安装 Node.js

如果没装，去 [nodejs.org](https://nodejs.org/) 下载 **LTS 版本**（当前 v22 LTS），安装时勾选 "Add to PATH"。

验证：
```powershell
node --version    # 应输出 v20.x.x 或 v22.x.x
npm --version     # 应输出 10.x.x 或更高
```

### 步骤 2：下载项目

把整个 `chat-simulate` 文件夹复制到目标电脑任意位置（比如 `D:\chat-simulate`）。

### 步骤 3：安装依赖（首次）

```powershell
cd D:\chat-simulate
npm install
```

> 如果下载慢，可以换国内镜像：
> ```powershell
> npm config set registry https://registry.npmmirror.com
> npm install
> ```

依赖清单（`package.json`）：
- `express` — Web 服务器
- `cors` — 跨域
- `sql.js` — SQLite（纯 JS，不用装原生 SQLite）
- `winston` — 日志
- `natural` — 分词/NLP
- `dotenv` — 环境变量
- `cookie-parser` — Cookie 解析

### 步骤 4：启动

```powershell
npm start
```

或直接：
```powershell
node server/app.js
```

看到这行就成功了：
```
╔══════════════════════════════════════════╗
║   💬 Chat Simulate 启动成功               ║
║   🌐 http://localhost:55440             ║
║   📖 API: /api/health                    ║
╚══════════════════════════════════════════╝
```

浏览器打开 **http://localhost:55440** 即可使用。

### 步骤 5（可选）：导入已有模型

如果要从旧电脑迁移训练好的模型：

```powershell
# 方式 A：直接复制 data 目录
复制 G:\旧电脑\chat-simulate\data\models → 新电脑同位置
复制 G:\旧电脑\chat-simulate\data\sqlite.db → 新电脑同位置

# 方式 B：通过导出/导入 API
# 旧电脑浏览器 → 模型管理 → ⬇️ 导出 → 下载 JSON
# 新电脑浏览器 → 模型管理 → 导入 JSON（或左侧栏 📥 导入模型）
```

### 一键启动脚本（可选）

创建 `start.bat`，双击即可启动：
```bat
@echo off
cd /d "%~dp0"
echo === Chat Simulate ===
node server/app.js
pause
```

## 🔐 登录与认证

### 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| `admin` | `Run629449768` | admin |
| `User` | `Run629449768` | admin |
| `trainer` | `trainer123` | trainer |

> **安全提示**：首次登录后请立即修改密码（`/changepwd`）或删除默认账号。

### Cookie 登录机制

系统使用双 Cookie 管理登录状态：

| Cookie | 类型 | 作用 |
|--------|------|------|
| `csim_session` | HttpOnly（服务端设置） | 会话令牌，服务端验证用 |
| `csim_u` | 客户端（localStorage 替代） | 用户名缓存，用于预填和快速恢复 |

**启动流程**：
1. 页面加载时调用 `/api/health` 检查服务状态
2. 读取本地 `csim_u` cookie，若存在则调用 `/api/auth/me` 验证服务端会话
3. 验证通过 → 自动进入终端，无需重复登录
4. 验证失败或无 cookie → 显示登录表单（用户名已预填）

**退出登录**：
- 执行 `/quit` 命令 → 调用服务端登出接口 + 清除 `csim_u` cookie → 页面重新加载到登录页

**会话超时**：`csim_session` 有效期 30 天，过期后需重新登录。

**Skill 访问限制**：`/skills/*` 路径需要登录才能访问，未登录时会被重定向到登录页。

## 🧠 自动训练机制详解

### 当前状态：**已关闭**

`server/controllers/chatController.js` 里：
```javascript
// 自动训练暂时关闭 — 需要先有足够干净的种子数据才能自我学习
// simulateService.autoTrainFromDialogue(history, message, reply, modelDir);
```

### 为什么关闭

模型基于 **N-gram token 权重概率采样**，没有"理解"能力。如果让它自动把自己生成的回复当作训练样本学回去，会发生：

1. **早期模型瞎编 → 自动训练把瞎编当真** → 权重被污染
2. **错误累积** → 每次生成的 token 越来越偏离正常语言
3. **不可逆** → 一旦污染，越训越烂，只能删模型重训

### 自动训练逻辑（代码在 `server/services/simulateService.js`）

如果要开启，它做了 4 件事：

| 步骤 | 逻辑 | 问题 |
|------|------|------|
| 1 | `userInput → aiReply` 直接训练一条 pair | reply 是自己生成的，质量没保证 |
| 2 | 拼历史上下文 `h1 h2 h3 → aiReply` 再训一条 | 上下文拼接格式不固定 |
| 3 | 正则识别"我是XX" → 额外训"我是谁 → 你是XX" | 只覆盖身份场景 |
| 4 | `logger.info` 记录权重变化数 | - |

### 正确的训练方式

手动训练（推荐）：
- **前端模型管理页底部** → 填 👤输入 / 🤖输出 → ▶ 训练
- 或 `POST /api/models/:id/train` 单条训练
- 或 `POST /api/models/:id/train-batch` 批量训练

训练脚本（`scripts/` 目录）：
```powershell
node scripts/train-greetings.js     # 训练问候语
node scripts/train-thinking.js      # 训练思考过程
```

## 🧬 轻量 Transformer 架构详解（v1.1 新增）

### 为什么做

N-gram 本质是查表（`A B C → D` 概率），没有"泛化"能力。训练数据覆盖不到的组合只能靠零权重兜底瞎输出。引入 Transformer 后，模型可以学到输入到输出的非线性映射，训练数据越多泛化越好。

### 架构参数

| 项目 | 值 |
|------|------|
| 层数 | 2 |
| Embedding 维度 | 64 |
| Hidden 维度 | 128 |
| Attention 头数 | 2 |
| 词表大小 | 276（常用汉字 + 标点 + 数字 + 符号） |
| 最大序列长度 | 32 |
| **总参数量** | **~163,200** |
| 存储大小 | ~4.2MB JSON |
| 训练方式 | Teacher-forcing + 梯度裁剪 |
| 生成方式 | Greedy decode（自回归） |

### 数据流

```
字符输入
  ↓
char → id lookup（W_emb）
  ↓
+ Positional Encoding
  ↓
LayerNorm → QKV → Multi-Head Causal Attention → Residual
  ↓
LayerNorm → FFN(GELU) → Residual
  ↓
× 2 layers
  ↓
Linear(W_out) → Softmax → 预测下一字符 id → 查表输出
```

### 训练

```javascript
// input = "你好", target = "您好呀"
// step 0: ctx = [你,好],              target = 您
// step 1: ctx = [你,好,您],            target = 好
// step 2: ctx = [你,好,您,好],         target = 呀
// 每个 step 跑 forward，计算 cross-entropy loss，手动算梯度 + clip(5.0) 更新权重
```

### 双路径共存

- **有 transformer.json** → 优先走 Transformer（思考 + 回复都用 Transformer）
- **无 transformer.json** → 回退 N-gram（旧模型自动兼容）
- **训练时** → 两个模型同时更新（Transformer + N-gram 权重）
- **创建新模型** → 自动初始化 Transformer 并保存

### 性能参考

| 指标 | 数值 |
|------|------|
| 初始 loss | ~5.62（ln(276)） |
| 2000 epochs 训练后 loss | ~1.86 |
| 单步 forward 耗时 | ~1ms |
| 单次生成（10 字） | ~20ms |
| 训练一条 pair（含多步） | ~10ms |

## 🔒 会话锁定机制

当用户绑定（bind）会话或向未绑定的会话发送消息时，会话会自动锁定给该用户。

- **锁定行为**：锁定后，其他用户无法向该会话发送消息（返回 403），但可以查看会话内容（观看模式）
- **自动恢复**：用户下次登录时，如果之前有锁定会话，会自动恢复到该会话（通过 `csim_sid` cookie）
- **解锁方式**：
  - 用户执行 `exit` 命令主动解锁并离开会话
  - Admin 执行 `unlock <sessionId>` 强制解锁
- **数据持久化**：锁定信息存储在 SQLite 数据库（sessions 表的 `locked`、`locked_by`、`locked_at` 列），即使会话中断也不会丢失

### 会话锁定示例

```
# 用户 A 绑定会话
> bind 1
✓ 已绑定会话 1（已锁定）

# 用户 B 尝试向同一会话发送消息
> hello
LOCKED: 会话 1 已被 userA 锁定

# Admin 强制解锁
> unlock 1
OK: 会话 1 已解锁
```

## 🛠 Skill 系统

Skill 分为两类加载方式，职责分离：

| 前缀 | 加载方式 | 说明 |
|------|---------|------|
| `./gui <name>` | 直接加载 `public/skills/<name>.html` | 内置 HTML 面板，无需 .ski 描述文件 |
| `/skill <name>` | 通过 `/api/skills/<name>` 加载 | 扩展 skill，需 .ski 描述文件 + HTML 界面 |

### 内置 Skill（`./gui`）

| 命令 | 说明 |
|------|------|
| `./gui` | 打开内置 GUI 管理面板 |
| `./gui export` | 打开会话导出面板 |

### 扩展 Skill（`/skill`，需登录）

| 命令 | 说明 |
|------|------|
| `/skill web-search` | 联网搜索（Bing） |
| `/skill batch-train` | 批量训练助手 |
| `/skill model-inspect` | 模型详情/权重/Top Token |
| `/skill corpus-browser` | 语料库搜索/导入 |
| `/skill stats-dashboard` | 统计总览面板 |
| `/skill account-mgr` | 账号管理（admin only） |

### .ski 文件格式

`.ski` 文件是 JSON 格式的 Skill 描述文件，放在 `public/skills/` 目录下。

**格式规范**：
```json
{
  "name": "web-search",
  "version": "1.0.0",
  "description": "联网搜索 — 通过搜索引擎查询信息",
  "author": "chat-simulate",
  "tags": ["search", "web"],
  "commands": ["search", "web"],
  "capabilities": ["web-search"],
  "requiresAuth": false,
  "html": "",
  "htmlFile": "skills/web-search.html"
}
```

**字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Skill 唯一标识（也作为文件名去掉 .ski） |
| `version` | string | 版本号 |
| `description` | string | 描述文本，显示在 skill 标题栏 |
| `commands` | string[] | 提供的终端命令列表 |
| `html` | string | 内嵌 HTML（可选，优先于 htmlFile） |
| `htmlFile` | string | 引用外部 HTML 文件路径（相对于 skills 目录） |

**创建新 Skill**：
1. 在 `public/skills/` 创建 `.ski` 描述文件
2. 如有需要，创建对应的 `.html` 文件作为界面
3. 通过 `/skill <name>` 加载

## 📁 目录结构

```
chat-simulate/
├── server/                    # 后端
│   ├── app.js                # 入口（HTTP 55440）
│   ├── config.yaml           # 配置文件
│   ├── controllers/          # API 控制器
│   │   ├── chatController.js     # 聊天 + 会话锁定逻辑
│   │   ├── modelController.js
│   │   ├── sessionController.js  # 会话 CRUD + unlock 接口
│   │   └── historyController.js
│   ├── services/             # 业务逻辑
│   │   ├── simulateService.js  # ⭐ 核心：N-gram 生成 + 自动训练
│   │   ├── modelService.js     # ⭐ 模型 CRUD + 导入导出
│   │   ├── authService.js      # ⭐ 用户认证 + 账号管理
│   │   ├── sessionService.js
│   │   ├── trainService.js
│   │   └── historyService.js
│   ├── middlewares/
│   │   ├── auth.js           # ⭐ 认证中间件 + 路由（含 Cookie 处理）
│   │   └── logger.js
│   ├── utils/                # 工具
│   │   ├── transformer.js    # ⭐ 轻量 Transformer（2层 / 16万参数 / 纯JS）
│   │   ├── ngram.js          # N-gram 概率 + 零权重兜底
│   │   ├── tokenizer.js      # char/word/sentence 三层分词
│   │   └── stream.js         # SSE 流式输出
│   └── models/
│       └── db.js             # SQLite 连接（含锁定辅助函数）
├── public/                    # 前端
│   ├── terminal.html         # ⭐ 终端界面（cookie 登录、skills 加载、锁定状态显示）
│   ├── index.html            # 单页壳（左侧导航 + iframe 路由）
│   ├── chat.html             # 对话页
│   ├── models.html           # 模型管理页
│   ├── weights.html          # 权重可视化
│   ├── train.html            # 训练中心
│   ├── data.html             # 语料库
│   ├── search.html           # 搜索
│   ├── snapshot.html         # 快照
│   ├── config.html           # 配置
│   ├── skills/               # ⭐ Skills 目录
│   │   ├── gui.html
│   │   ├── gui.ski
│   │   ├── export.html
│   │   ├── export.ski
│   │   ├── web-search.html
│   │   ├── web-search.ski
│   │   ├── batch-train.html
│   │   ├── batch-train.ski
│   │   ├── model-inspect.html
│   │   ├── model-inspect.ski
│   │   ├── corpus-browser.html
│   │   ├── corpus-browser.ski
│   │   ├── stats-dashboard.html
│   │   ├── stats-dashboard.ski
│   │   ├── account-mgr.html
│   │   └── account-mgr.ski
│   ├── css/style.css
│   └── js/api.js
├── scripts/                   # 训练脚本
│   ├── train-greetings.js    # 问候语训练
│   ├── train-thinking.js     # 思考过程训练
│   ├── test-greetings.js
│   └── ...
├── data/                      # ⭐ 运行时数据（启动时自动创建）
│   ├── sqlite.db             # 会话/消息/锁定元数据库
│   ├── users.json            # 用户信息（明文密码）
│   ├── models/               # 模型存储
│   │   └── model_xxx/
│   │       ├── config.json
│   │       ├── meta.json
│   │       ├── token_weights.json
│   │       └── transformer.json  # ⭐ 新建模型自动生成（~4.2MB，16万参数）
│   ├── chats/                # 聊天会话的模型副本
│   ├── exports/              # 导出文件
│   └── *.log                 # 日志
├── seed/                      # 种子语料
│   └── corpus.json
└── package.json
```

## 🔧 配置

编辑 `server/config.yaml`：
```yaml
server:
  port: 55440              # 改端口

simulate:
  ngramSize: 3             # N-gram 大小
  temperature: 0.7          # 采样温度（越高越随机）
  maxTokens: 80            # 最多生成 token 数
  layerWeights:
    char: 0.3
    word: 0.5
    sentence: 0.2
```

## 📡 API 速查

| API | 方法 | 说明 |
|-----|------|------|
| `/api/auth/login` | POST | 登录 `{username, password}`，返回 `csim_session` cookie |
| `/api/auth/logout` | POST | 登出，清除 cookie |
| `/api/auth/me` | GET | 获取当前用户信息（用于 cookie 验证） |
| `/api/auth/accounts` | GET | 列出所有账号（admin only） |
| `/api/auth/accounts/add` | POST | 创建账号（admin only） |
| `/api/auth/accounts/del` | POST | 删除账号（admin only） |
| `/api/auth/accounts/lock` | POST | 锁定账号（admin only） |
| `/api/auth/accounts/unlock` | POST | 解锁账号（admin only） |
| `/api/auth/changepwd` | POST | 修改密码 |
| `/api/auth/verify-user` | POST | 验证用户名是否存在 |
| `/api/models` | GET | 模型列表 |
| `/api/models/:id` | GET | 模型详情 + 权重 |
| `/api/models` | POST | 创建新模型 `{name, description, config}` |
| `/api/models/:id` | DELETE | 删除模型 |
| `/api/models/:id/train` | POST | 单条训练 `{input, output}` |
| `/api/models/:id/train-batch` | POST | 批量训练 `{pairs:[{input,output}]}` |
| `/api/models/:id/test?input=你好` | GET | 测试模型 |
| `/api/models/:id/export` | GET | 导出模型 JSON |
| `/api/sessions` | GET/POST | 会话列表 / 创建（返回 locked/locked_by） |
| `/api/sessions/:id/unlock` | POST | 用户自行解锁 |
| `/api/sessions/unlock` | POST | Admin 强制解锁 `{session_id}` |
| `/api/sessions/:id/export` | POST | 导出会话 JSON |
| `/api/chat` | POST | 发送消息（SSE 流式，锁定检查） |
| `/api/skills` | GET | 列出所有 skills（需登录） |
| `/api/skills/:name` | GET | 获取 skill HTML 内容（需登录） |
| `/skills/<name>.html` | GET | 直接加载 skill HTML（需登录） |
| `/api/health` | GET | 健康检查 |

## 🖥 Terminal 命令速查

| 命令 | 说明 |
|------|------|
| `session new [n]` | 创建新会话（可选指定模型索引） |
| `session list` | 列出所有会话（显示锁定状态 🔒） |
| `bind <id>` | 绑定/切换到会话（自动锁定） |
| `exit` | 离开会话并解锁 |
| `unlock <id>` | **Admin** 强制解锁会话 |
| `./gui` | 打开内置 GUI 管理面板 |
| `./gui <name>` | 直接加载 `skills/<name>.html` |
| `/skill <name>` | 通过 skill 系统加载（含 .ski 元数据） |
| `change-mode terminal/gui` | 切换界面模式（兼容旧命令） |
| `send <text>` | 发送消息到当前会话 |
| `model list` | 列出可用模型 |
| `model set <id>` | 设置默认模型 |
| `help` | 显示帮助 |
| `quit` | 退出登录（清除 cookie 并刷新页面） |

## ❓ 常见问题

**Q: 换电脑启动报错 "Cannot find module xxx"**
A: 没跑 `npm install`。到项目根目录执行一次就行。

**Q: 端口被占用**
A: 编辑 `server/config.yaml` 改 `port`，或 `netstat -ano | findstr 55440` 找到占用进程 kill 掉。

**Q: data/ 目录空的？**
A: 首次启动会自动创建 models/chats/exports 子目录。第一次运行 `scripts/train-greetings.js` 种子模型才会有权重。

**Q: 如何删除所有数据重来？**
A: 停服务 → 删 `data/` 目录（或只删 `data/models/`）→ 重启。注意 `data/chats/` 里的会话引用了 `model_id`，删模型前先删会话。

**Q: 模型导出比旧版本小很多？**
A: 新版模型只存你当前训练的权重数。旧版 sqlite.db 里有 3257 条历史权重 + 96 条语料库。导出格式已恢复完整（stats + weights + corpus），但模型本身数据量要看你训练了多少。

**Q: 会话被锁定了怎么办？**
A: 如果你是锁定者，执行 `exit` 解锁。如果是 admin，执行 `unlock <id>`。其他人查看会话时会看到 🔒 标记但无法发送消息。

**Q: Skill 系统怎么用？如何添加新的？**
A: Skill 分为两类：
- `./gui <name>` — 直接把 HTML 放到 `public/skills/` 目录，无需 .ski 文件即可通过 `./gui <name>` 加载
- `/skill <name>` — 需要 .ski 描述文件 + HTML 界面，通过 skill 系统加载（含元数据）
- 添加新 Skill：在 `public/skills/` 创建 `.html` 文件（内置）或同时创建 `.ski` + `.html`（扩展）

**Q: 登录后刷新页面还要重新登录？**
A: 正常情况下不需要。系统使用 `csim_u` cookie（30天有效期）自动预填用户名，并调用 `/api/auth/me` 验证服务端会话。如果服务端会话已过期（30天未活动），则需要重新登录。

**Q: 如何修改默认密码？**
A: 登录后在 GUI 管理界面 → 账号管理 → 修改密码；或通过 API `POST /api/auth/changepwd`。

## 🔒 可移植性

| 需要复制 | 内容 |
|---------|------|
| ✅ **必须** | `server/`, `public/`, `package.json` |
| ⚠️ 首次运行会生成 | `node_modules/`（跑 `npm install`）, `data/`（自动创建） |
| 📦 要保留模型的话 | 复制整个 `data/models/` 目录 |
| 📦 要保留会话的话 | 复制 `data/sqlite.db` + `data/chats/` |
| 📦 要保留 skills 的话 | 复制 `public/skills/` 目录 |

整个项目 **不需要装 SQLite / 不需要 Python / 不需要任何原生编译**，理论上任何 Windows + Node >= 18 的机器直接 `npm install && npm start` 就能跑。
