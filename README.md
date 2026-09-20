# FSAI Desktop

> 飞书 AI Bot 桌面启动器 —— 把 **飞书 + 模型 + Claude Code/Codex + 本地目录** 粘成一个工具，配一次就能在飞书里调度本地 AI 编程助手。
>
> 支持 **一个 Bot 服务多个群**：每群独立会话、独立目录、独立记忆，同时共享一份可升级的知识内核。

[![GitHub release](https://img.shields.io/github/v/release/Rbingo/fsai-desktop)](https://github.com/Rbingo/fsai-desktop/releases)

## 这是什么

还在手动维护一堆东西吗？飞书 App ID/Secret、模型 API Key、Base URL、工作目录、终端进程……多开几个 Bot（代码助手用 DeepSeek、代码审查用 Claude）更是乱成一团，Provider 互相覆盖、配置冲突、换电脑就得重来。

FSAI Desktop 把它们收进一个桌面 GUI：

```
配一次 Bot → 选一个模型 → 选一个目录 → 点启动 → 飞书里对话
```

![截图](docs/screenshot.png)

## 核心能力

### 🤖 Bot 与模型解耦

- Bot ≠ 模型，随时换模型不用重建配置
- 一个 Bot = 飞书应用 + 模型 Profile + Runtime + 工作目录

### 🧩 多模型来源

- **复用 cc-switch**：自动读取 cc-switch 的 SQLite 数据库，发现已配置的 Claude/Codex Provider，不重复填 Key
- **Direct API 兜底**：没装 cc-switch 也能直接填 Base URL + API Key + Model

### ⚡ 双 Runtime

- **Claude Code**（官方 Agent SDK）
- **Codex CLI**

### 🔒 Runtime 隔离

- 每个 Bot 独立 HOME，多 Bot 同时运行互不影响
- 首次启动自动播种 `~/.claude` / `~/.codex`，保留登录态

### 💬 一个 Bot 服务多个群

把同一个机器人拉进 N 个群，每个群都是**独立的工作台**：

- **会话隔离**：每个群独立的对话上下文，互不串扰
- **目录隔离**：每个群在 Workspace 下有独立的工作目录（`oc_<群ID>/`）
- **记忆隔离**：每个群积累自己的记忆（写在各群工作目录的 `memory/`）
- **重启续接**：`sessionId` 按群持久化，重新打开应用后自动接着聊

### 🧠 知识内核（跨群共享 + 按群隔离，两层合并）

Claude Code 的知识是分层的，FSAI 利用这个机制实现「通用知识共享 + 群记忆独立」：

| 层 | 位置 | 作用 |
|---|---|---|
| **共享层** | Bot 的 `.claude/CLAUDE.md` + `docs/` | 跨群通用规则、投喂的文档 —— **改一次所有群生效** |
| **群专属层** | 各群工作目录的 `CLAUDE.md` + `memory/` | 该群的记忆（项目背景、群内约定、讨论结论） |

Claude 会自动合并读取两层。典型用法：

```
共享层：所有回答用中文；改代码前先跑测试
群A 专属：这个群在讨论支付系统
群B 专属：这个群在讨论登录模块
```

### 📚 在飞书里投喂知识

不用打开电脑，直接在飞书里喂数据：

- **发文件**：群里 `@机器人` 上传文档 → 自动存入知识库
- **说「记住」**：`@机器人 记住：我们项目用 pnpm` → 自动存为知识

投喂内容**全局共享**，所有群立即生效。可在 Bot 卡片的「知识」弹窗里查看和删除。

### 👂 全局监听 + 智能意图判断

默认只在被 @ 时回复。开启「全局监听」后，Bot 会读取群内**所有消息**，按分层策略决定是否插话：

```
① 规则预筛（零成本）
   ├─ 被 @ / 回复机器人 / 命中触发词  → 立即回复
   ├─ @所有人 / 闲聊                  → 静默忽略（但仍记录上下文）
   └─ 问句                            → 交给 ②
② AI 判断（轻量 prompt，可关闭）
```

**单聊（p2p）消息一律回复**，不受此策略影响。

### 📱 飞书审批闭环（核心卖点）

Claude/Codex 执行 `curl`、`npm install`、`git push` 等需授权命令时，**自动发飞书审批卡片**，手机端点「允许一次 / 本会话允许 / 拒绝」，**全程不碰本机控制台**。

- 三级权限策略：SAFE 自动放行、APPROVAL 审批、HIGH RISK 标红警告
- 支持 AskUserQuestion（Claude 提问 → 飞书选择卡）

### 🔐 Secret 脱敏

- App Secret / API Key 在日志和聊天记录中自动打码

### 📜 聊天记录审计

- 每个 Bot 的问答记录按 JSONL 持久化（时间戳、耗时、状态）
- Logs 页按 Bot 查询回溯

### 🔍 环境检测

- 自动检测 Claude Code / Codex / cc-switch / Git，界面显示状态

## 下载

👉 [**下载 Windows 版（免安装，双击即用）**](https://github.com/Rbingo/fsai-desktop/releases/latest)

> 当前仅 Windows x64。首次运行若 Windows SmartScreen 提示「未知发布者」，点「更多信息 → 仍要运行」即可（应用尚未做代码签名）。

## 快速上手（3 步）

### 前置条件

- 已安装 [Claude Code](https://docs.anthropic.com/claude-code)（`claude` 命令可用且已登录）或 [Codex CLI](https://github.com/openai/codex)
- （可选）已安装 [cc-switch](https://github.com/aravhawk/cc-switch) 并配置好模型 Provider。没有 cc-switch 也可以用内置的 Direct API 直接填 Key

### 第 1 步：创建飞书机器人

这是唯一需要「折腾」的一步，之后一劳永逸：

1. 打开 [飞书开放平台](https://open.feishu.cn)，登录后进入「开发者后台」
2. 创建「**企业自建应用**」，起个名字（如「我的代码助手」）
3. 复制 **App ID** 和 **App Secret**（在「凭证与基础信息」页）
4. 左侧「**事件与回调**」→「事件订阅」→ 订阅方式选「**使用长连接接收事件**」
5. 在下方「事件」里添加：**`接收消息 im.message.receive_v1`**
6. 左侧「**添加应用能力**」→ 开启「**机器人**」能力
7. 发布版本（开发者后台右上角「创建版本并发布」，选自己可见即可）

> ⚠️ 每个飞书应用只能被一个 Bot 使用（长连接是集群模式，同一 App 多客户端会随机抢消息）。多个 Bot 请各建各的飞书应用。

### 第 2 步：添加工作目录和模型

- **Workspaces** 页 → `+ Add Workspace` → 起个逻辑名 + 选本地项目目录
- **Models** 页 → 确认 cc-switch 状态（本机没装就直接加一个 Direct API Profile）

### 第 3 步：创建并启动 Bot

- **Bots** 页 → `+ New Bot`：
  - Bot 名（随便起）
  - 飞书 App ID / App Secret（第 1 步拿到的）
  - Runtime：`Claude Code` 或 `Codex CLI`
  - Model Source：`cc-switch`（选 Profile）或 `Direct API`（选你建的）
  - Workspace（第 2 步建的）
  - 可选开关：
    - ☑ **每个飞书群使用独立工作目录** —— 多群场景推荐
    - ☑ **启用知识内核** —— 跨群共享知识 + 按群隔离记忆
    - ☑ **全局监听群消息** —— 不 @ 也读（按意图决定是否回复）
- 点 **Save**，再点 **Start**
- 在飞书里找到你的机器人，`@机器人 你好` 发条消息，几秒后就会收到回复

### 常用操作

| 想做什么 | 怎么做 |
|---|---|
| 喂知识给 Bot | 飞书里 `@机器人 记住：xxx`，或直接发文件 |
| 编辑共享知识 | Bot 卡片 → **知识** 按钮 → 编辑 CLAUDE.md |
| 看各群的独立工作目录 | Bot 卡片 → **群目录** 按钮 |
| 看聊天记录 | 左侧 **Logs** 页 → 下拉选 Bot |
| 测消息链路 | Bot 卡片 → **Test** 按钮（不经过飞书） |

### 飞书应用权限补充

基础功能只需「接收消息」。用到以下能力时需要额外权限：

| 能力 | 需要的权限 |
|---|---|
| 投喂文件（发文件给 Bot） | `im:resource`（获取与上传图片或文件资源） |
| 全局监听群消息 | `im:message.group_msg`（获取群组中所有消息） |
| 卡片审批（按钮点击） | 在「事件与回调」→「回调订阅」里添加「卡片回传交互」，并选长连接方式 |

---

## 开发者

### 本地开发

```bash
pnpm install
pnpm start     # 启动
pnpm smoke     # 冒烟测试
pnpm dist      # 打包 Windows exe
```

环境：Node.js ≥ 20、pnpm。

### 目录结构

```
main.js                 Electron 主进程
preload.js              contextBridge IPC 桥
src/
  models.js             数据模型（含 workspaceMode/chatWorkspaces/knowledge/listen）
  store.js              JSON 配置存储 + 老配置归一化
  logger.js             日志 + Secret 脱敏
  doctor.js             环境检测 + .cmd shim 解析
  cc-switch.js          cc-switch SQLite 解析（claude/codex）
  model-resolver.js     模型解析（cc-switch / direct）
  runtime-manager.js    隔离 Runtime + claude/codex 执行
  knowledge.js          知识内核（共享 CLAUDE.md/docs + 投喂 + 同步）
  intent.js             意图判断（规则预筛 + AI 判断）
  feishu-adapter.js     飞书长连接 + 卡片回调 + 文件下载
  feishu-sdk-patch.js   飞书 SDK 补丁（卡片回调超时修复）
  chat-log.js           聊天记录审计
  bot-manager.js        Bot 编排 + 群会话/目录/记忆隔离 + 投喂接入
  agents/claude/        Claude Agent SDK 适配器
  approvals/            审批管理器 + 权限策略 + 卡片构建
renderer/               单页 5 页面 UI
scripts/
  smoke.js              冒烟测试
  test-approval.js      审批测试
  test-intent.js        意图判断测试
  test-ingest.js        知识投喂测试
```

### 测试

```bash
pnpm smoke           # 冒烟测试
pnpm test:approval   # 审批管理器
pnpm test:intent     # 意图判断
pnpm test:ingest     # 知识投喂
```

### 技术栈

Electron + 原生 Node（无框架），飞书官方 `@larksuiteoapi/node-sdk` 长连接，`node:sqlite` 读 cc-switch 数据库。

### MVP 边界（已知未实现）

- 系统托盘、开机自启、最小化到托盘（UI 有开关占位，主进程未接）
- 同一 Bot 单条消息串行处理（同群消息会排队）
- 全局监听 + AI 判断在小群里成本可控，活跃大群建议关闭「AI 判断意图」
- cc-switch 各 fork 存储格式差异较大，解析做了容错，按需调优
- 会话上下文存在本地 `config.json` + 隔离 HOME；换电脑/删除 runtime 目录后历史会话不可恢复
- 群工作目录用「子目录」实现，未使用 git worktree（分支级隔离留待后续）

## 数据存储位置

**应用数据**存于 `%APPDATA%\fsai-desktop\`：

| 路径 | 内容 |
|---|---|
| `config.json` | Bot 配置、飞书 App ID/Secret、模型绑定、Workspace、各群 sessionId |
| `chatlog/<botId>/chat.jsonl` | 聊天记录（JSONL，含脱敏） |
| `fsai.log` | 运行日志 |
| `runtime/<botId>/home/` | Claude Code 隔离 HOME |
| `runtime/<botId>/codex-home/` | Codex 隔离 HOME |

**知识内核**（该 Bot 所有群共享）：

| 路径 | 内容 |
|---|---|
| `runtime/<botId>/home/.claude/CLAUDE.md` | 共享知识（跨群通用规则） |
| `runtime/<botId>/home/.claude/docs/` | 投喂的文档 |
| `runtime/<botId>/home/.claude/skills/` | 技能 |

**群工作目录**（每个群独立，位于你配置的 Workspace 目录下）：

| 路径 | 内容 |
|---|---|
| `<workspace>/oc_<群ID>-<hash>/` | 该群的工作目录（AI 产出物） |
| `<workspace>/oc_<群ID>-<hash>/CLAUDE.md` | 该群专属知识（自动生成） |
| `<workspace>/oc_<群ID>-<hash>/memory/` | **该群独立的记忆** |

> ⚠️ `config.json` 里的 App Secret / API Key 为明文存储（程序运行需要），请勿将此文件分享给他人。

## License

MIT
