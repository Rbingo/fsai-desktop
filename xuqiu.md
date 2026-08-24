# FSAI Desktop 产品需求文档（PRD）

## 1. 产品概述

### 1.1 产品名称

**FSAI Desktop**

全称：

**Feishu AI Bot Desktop Launcher**

### 1.2 产品定位

FSAI Desktop 是一个桌面端 AI Bot 管理工具，用于将：

* 飞书 Bot
* cc-switch 模型配置
* Claude Code 等 Agent Runtime
* 本地项目目录

进行绑定，并通过桌面界面一键启动和管理。

用户无需手动修改环境变量、切换模型配置或维护多个终端进程，只需要在桌面端完成配置，即可运行多个不同模型、不同工作目录的飞书 AI Bot。

### 1.3 核心价值

产品需要实现：

> 配一次 Bot，选一个模型，选一个目录，点击启动，即可在飞书中使用本地 AI Coding Agent。

目标体验：

```text
飞书 Bot
   +
cc-switch Model
   +
Claude Code Runtime
   +
本地 Workspace
   ↓
FSAI Desktop
   ↓
一键启动
```

---

# 2. 产品背景

当前使用 Claude Code、cc-switch、飞书 Bot 时，用户需要分别维护：

```text
飞书 App ID / Secret
模型 API Key
模型 Base URL
cc-switch Provider
Claude Code 配置
工作目录
终端进程
```

如果需要多个 Bot，例如：

```text
代码助手 → Kimi
代码审查 → Claude
前端助手 → GLM
后端助手 → DeepSeek
```

则需要重复配置大量环境，并且容易发生：

* Provider 相互覆盖
* Claude 配置冲突
* API Key 重复配置
* 工作目录混乱
* Bot 进程难以管理
* 更换电脑后难以恢复配置

FSAI Desktop 的目标是将这些能力统一到一个 GUI 中。

---

# 3. 目标用户

主要用户为：

* 开发者
* 独立开发者
* AI Coding Agent 重度用户
* 使用 Claude Code 的开发团队
* 使用 cc-switch 管理多个模型的用户
* 希望通过飞书调用本地 AI Agent 的用户

第一阶段主要面向：

> 单机、多 Bot、个人或小团队使用场景。

---

# 4. 产品核心原则

## 4.1 Bot 不等于模型

Bot 和模型必须解耦。

```text
Bot
↓
Model Profile
```

允许后续随时更换模型。

---

## 4.2 模型配置优先复用 cc-switch

如果模型已经通过 cc-switch 配置，则 FSAI 不要求用户重复输入：

* API Key
* Base URL
* Model
* Provider 参数

FSAI 只引用：

```text
cc-switch Profile
```

---

## 4.3 Bot 不直接依赖 cc-switch 全局状态

FSAI 必须避免：

```text
Bot A 切换 Kimi
↓
Bot B 又切换 Claude
↓
Bot A 被影响
```

每个 Bot 的 Runtime 环境必须独立。

---

## 4.4 Workspace 独立管理

Bot 绑定 Workspace。

例如：

```text
Backend Bot
→ backend

Frontend Bot
→ frontend
```

Workspace 在系统中使用逻辑名称管理，不直接和绝对路径强绑定。

---

## 4.5 GUI 优先

V1 不要求用户掌握 CLI。

主要操作通过桌面 GUI 完成。

CLI 可以作为后续能力。

---

# 5. 核心使用场景

## 场景一：创建代码助手

用户打开 FSAI Desktop。

点击：

```text
+ New Bot
```

配置：

```text
Bot Name:
Backend Coder

Feishu:
App ID
App Secret

Model:
cc-switch
→ Kimi

Runtime:
Claude Code

Workspace:
~/Projects/backend
```

点击：

```text
Save & Start
```

系统显示：

```text
🟢 Backend Coder
Feishu Connected
Kimi
Claude Code
~/Projects/backend
```

之后用户即可在飞书：

```text
@Backend Coder
检查今天修改的代码
```

---

# 6. 多 Bot 场景

用户可以同时创建：

```text
Backend Coder
Frontend Coder
Reviewer
Architect
```

配置分别为：

```text
Backend Coder
→ Kimi
→ backend

Frontend Coder
→ GLM
→ frontend

Reviewer
→ Claude
→ backend

Architect
→ Claude
→ root project
```

所有 Bot 可以同时运行。

---

# 7. 产品整体架构

```text
┌───────────────────────────────┐
│         FSAI Desktop          │
│                               │
│  Bots   Models   Runtime      │
│  Logs   Settings              │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│           FSAI Core           │
│                               │
│ Bot Manager                   │
│ Model Resolver                │
│ Workspace Manager             │
│ Runtime Manager               │
│ Session Manager               │
│ Feishu Adapter                │
└──────────────┬────────────────┘
               │
      ┌────────┼────────┐
      ▼        ▼        ▼
 cc-switch   Claude    Feishu
             Code
```

---

# 8. 核心数据模型

一个 Bot 定义为：

```text
Bot
├── Identity
├── Feishu Config
├── Model Binding
├── Runtime
├── Workspace
├── Runtime Isolation
└── State
```

建议结构：

```yaml
id: backend-coder

name: Backend Coder

feishu:
  app_id: xxx
  secret_ref: feishu-backend

model:
  source: cc-switch
  profile: kimi-company

runtime:
  type: claude-code

workspace:
  id: backend

status:
  auto_start: true
```

---

# 9. Desktop 信息架构

V1 建议包含五个主要页面：

```text
Bots
Models
Workspaces
Logs
Settings
```

其中：

**Bots 是核心页面。**

---

# 10. Bots 页面

整体布局：

```text
┌───────────────────────────────────────────────────┐
│ FSAI Desktop                              Settings │
├─────────────┬─────────────────────────────────────┤
│ Bots        │ Backend Coder                       │
│             │                                     │
│ 🟢 Backend  │ Feishu                              │
│ 🟢 Review   │ App ID         cli_xxxxxx           │
│ ⚪ Frontend │ App Secret     ••••••••••           │
│             │                                     │
│ + New Bot   │ Model                               │
│             │ Source         cc-switch            │
│             │ Profile        Kimi Company         │
│             │                                     │
│             │ Runtime                             │
│             │ Claude Code                         │
│             │                                     │
│             │ Workspace                           │
│             │ backend                             │
│             │ /Users/.../backend                  │
│             │                                     │
│             │ [Stop] [Restart]                    │
└─────────────┴─────────────────────────────────────┘
```

---

# 11. Bot 列表

Bot Card 显示：

```text
Bot Name

Status

Model

Runtime

Workspace
```

例如：

```text
🟢 Backend Coder

Kimi
Claude Code
backend
```

状态颜色：

```text
🟢 Running

🟡 Starting

🔴 Error

⚪ Stopped
```

---

# 12. 创建 Bot

点击：

```text
+ New Bot
```

进入创建流程。

建议采用单页 Form，而不是复杂 Wizard。

字段：

## 基本信息

```text
Bot Name
```

例如：

```text
Backend Coder
```

---

## 飞书配置

```text
App ID

App Secret
```

提供：

```text
Test Connection
```

按钮。

成功：

```text
✓ Feishu connection successful
```

失败：

```text
✗ Invalid App ID or Secret
```

---

# 13. Model 配置

字段：

```text
Model Source
```

V1：

```text
cc-switch
```

后续：

```text
Direct API
```

选择 cc-switch 后：

```text
Profile
```

通过下拉框显示系统发现的 Profile。

例如：

```text
Kimi Company

Claude

GLM

DeepSeek
```

用户不需要输入 API Key。

---

# 14. Model Profile 展示

Profile 下拉项建议显示：

```text
Kimi Company

Provider: Kimi
Model: kimi-k2.x
```

而不是只显示：

```text
kimi-company
```

这样用户更容易理解正在使用哪个模型。

---

# 15. Runtime 配置

V1 Runtime：

```text
Claude Code
```

显示：

```text
Runtime

Claude Code

Status:
✓ Installed

Path:
/usr/local/bin/claude
```

如果未安装：

```text
Claude Code

⚠ Not detected
```

Bot 不允许启动。

---

# 16. Workspace 配置

用户可以：

```text
Choose Folder
```

选择本地目录。

例如：

```text
/Users/user/projects/backend
```

系统自动创建 Workspace：

```text
Name:
backend

Path:
/Users/user/projects/backend
```

Bot 实际绑定：

```text
workspace_id = backend
```

---

# 17. Workspace 页面

Workspace 页面显示：

```text
NAME         PATH

backend      /Users/user/projects/backend

frontend     /Users/user/projects/frontend

platform     /Users/user/projects/platform
```

支持：

```text
Add

Edit

Remove

Open Folder
```

---

# 18. Workspace 设计原则

Bot 不直接长期依赖绝对路径。

例如：

```text
Backend Coder
→ workspace: backend
```

Workspace Registry：

```text
backend
→ /Users/user/projects/backend
```

换电脑后：

```text
backend
→ /home/user/projects/backend
```

Bot 配置无需改变。

---

# 19. Models 页面

Models 页面主要用于查看 cc-switch 状态。

示例：

```text
Models

cc-switch

Status:
✓ Detected

Path:
/usr/local/bin/cc-switch

Profiles:

Kimi Company
Kimi
kimi-k2.x

Claude
Anthropic
Claude Sonnet

GLM
Zhipu
GLM
```

---

# 20. cc-switch Refresh

提供：

```text
Refresh
```

按钮。

用户在 cc-switch 中添加模型后：

```text
Refresh
```

即可同步。

---

# 21. cc-switch 不由 FSAI V1 管理 Key

V1 明确：

FSAI 不负责编辑 cc-switch API Key。

模型相关 Key：

```text
API Key

Base URL

Provider Credentials
```

仍然由 cc-switch 管理。

FSAI 负责：

```text
Discover Profile

Select Profile

Use Profile

Validate Profile
```

---

# 22. Runtime Isolation

这是 V1 核心技术需求。

不同 Bot 必须使用独立 Runtime 环境。

例如：

```text
FSAI Runtime

runtime/
├── backend-coder/
│   └── home/
│
├── reviewer/
│   └── home/
│
└── frontend/
    └── home/
```

执行 Backend Bot：

```text
HOME=runtime/backend-coder/home
```

执行 Reviewer：

```text
HOME=runtime/reviewer/home
```

---

# 23. Runtime Isolation 目标

必须实现：

```text
Backend Bot
→ Kimi

Reviewer Bot
→ Claude
```

同时运行时：

```text
互不影响
```

即使 cc-switch 底层需要修改：

```text
~/.claude/settings.json
```

也应该修改 Bot 自己的 HOME。

---

# 24. Bot 启动

用户点击：

```text
Start
```

系统执行：

```text
Validate Bot
↓
Validate Feishu
↓
Resolve cc-switch Profile
↓
Prepare isolated Runtime
↓
Start Claude Code Runtime
↓
Connect Feishu
↓
Running
```

---

# 25. Bot 启动状态

启动时 UI：

```text
Starting Backend Coder

✓ Validate configuration

✓ cc-switch profile: Kimi

✓ Workspace: backend

✓ Claude Code

◉ Connecting Feishu

○ Ready
```

完成：

```text
🟢 Running
```

---

# 26. Bot Stop

点击：

```text
Stop
```

系统：

```text
Stop accepting new messages

Cancel/finish current process

Close Feishu connection

Stop Runtime

Update status
```

状态：

```text
⚪ Stopped
```

---

# 27. Restart

支持：

```text
Restart
```

用于：

```text
修改模型

修改工作目录

异常恢复
```

---

# 28. Duplicate Bot

Bot 菜单提供：

```text
Duplicate
```

复制：

```text
Runtime

Workspace

Model

Settings
```

默认不复制：

```text
Feishu Secret
```

用户需要重新配置飞书身份。

---

# 29. Delete Bot

删除 Bot 时需要确认。

例如：

```text
Delete "Backend Coder"?

Bot configuration will be removed.
Workspace files will NOT be deleted.
```

必须明确：

> 删除 Bot 永远不得删除 Workspace 内容。

---

# 30. Bot 状态页

运行 Bot 显示：

```text
Backend Coder

Status
🟢 Running

Feishu
🟢 Connected

Model
Kimi

Runtime
Claude Code
🟢 Healthy

Workspace
backend

Sessions
3

Started
10:32
```

---

# 31. Logs 页面

支持查看：

```text
Application

Bot

Runtime
```

日志。

过滤：

```text
Bot

Level

Time
```

---

# 32. 日志安全

日志禁止记录：

```text
Feishu App Secret

API Key

Authorization Header

完整模型 Token
```

必须进行 Secret Redaction。

例如：

```text
sk-1234567890abcdef
```

显示：

```text
sk-****cdef
```

---

# 33. Settings 页面

包含：

## General

```text
Start FSAI on login

Minimize to tray

Start configured Bots automatically
```

## Runtime

```text
Claude Code path

cc-switch path
```

## Storage

```text
FSAI Data Directory
```

## Diagnostics

```text
Run Environment Check
```

---

# 34. System Tray

建议 V1 支持系统托盘。

关闭窗口：

```text
不退出 Bot
```

而是进入系统托盘。

Tray 菜单：

```text
Open FSAI

Bots

Backend Coder ✓

Reviewer ✓

Start All

Stop All

Quit
```

---

# 35. Quit 行为

点击：

```text
Quit FSAI
```

如果存在运行 Bot，需要提示：

```text
2 bots are currently running.

Quit FSAI and stop all bots?

[Cancel]

[Quit]
```

---

# 36. 自动启动

每个 Bot 有：

```text
Start automatically
```

开关。

电脑启动 → FSAI 启动 → Bot 自动恢复。

例如：

```text
Backend Coder ✓ Auto Start

Reviewer ✓ Auto Start

Testing Bot ✗
```

---

# 37. Environment Detection

FSAI 启动后自动检查：

```text
Operating System

Claude Code

cc-switch

Git
```

例如：

```text
Environment

✓ Claude Code
  /opt/homebrew/bin/claude

✓ cc-switch
  /opt/homebrew/bin/cc-switch

✓ Git
  /usr/bin/git
```

---

# 38. Doctor

在 Settings 中提供：

```text
Run Diagnostics
```

结果：

```text
System

✓ macOS arm64

Runtime

✓ Claude Code

Models

✓ cc-switch
✓ 4 profiles found

Storage

✓ Writable

Bot

✓ Feishu connection

✓ Workspace accessible
```

---

# 39. Error Handling

需要定义统一错误状态。

例如：

## cc-switch 不存在

```text
cc-switch was not detected.

Configure cc-switch before selecting a model.
```

---

## Profile 消失

```text
Model profile "kimi-company" no longer exists.

Select another model profile.
```

Bot 状态：

```text
🔴 Configuration Error
```

---

## Workspace 丢失

```text
Workspace not
```
