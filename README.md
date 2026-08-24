# FSAI Desktop

飞书 AI Bot 桌面启动器。把 **飞书 Bot + 模型（cc-switch / Direct API）+ Claude Code + 本地目录** 绑定，一键启动管理多个 AI Coding Agent。

## 核心能力

- **Bot ≠ 模型**：Bot 与模型解耦，随时换模型
- **模型复用 cc-switch**：自动发现 cc-switch Profile，不重复填 Key；本机没装 cc-switch 时可用 **Direct API** 兜底
- **Runtime 隔离**：每个 Bot 独立 `HOME`（`runtime/<bot-id>/home`），多 Bot 同时运行互不影响；首次启动把真实 `~/.claude` 播种进隔离 HOME，保留登录态，之后 provider 配置只在副本上叠加
- **飞书长连接**：使用官方 SDK WebSocket 长连接，本地无需公网/内网穿透
- **Secret 脱敏**：App Secret / API Key 在日志与 UI 状态中均打码，原始 key 不进 renderer
- **环境检测（Doctor）**：Claude Code / cc-switch / Git 检测

## 环境要求

- Node.js ≥ 20
- pnpm
- Claude Code（`claude` 命令已安装并登录）

## 快速开始

```bash
pnpm install
pnpm start
```

## 使用流程

1. **Workspaces** 页 → 添加工作目录（逻辑名 + 本地路径）
2. **Models** 页 → 确认 cc-switch 状态，或添加 Direct API Profile
3. **Bots** 页 → `+ New Bot`：
   - 填 Bot 名
   - 填飞书 App ID / Secret（[飞书开放平台](https://open.feishu.cn) 自建应用，开启长连接/事件订阅）
   - 选模型来源 + Profile
   - 选 Workspace
4. 点击 **Start**，在飞书里 `@你的机器人` 发消息即可

## 冒烟测试

```bash
pnpm smoke
```

验证数据模型、存储、日志脱敏、环境检测、模型解析、Runtime 隔离等核心逻辑。

## 目录结构

```
main.js                 Electron 主进程
preload.js              contextBridge IPC 桥
src/
  models.js             数据模型
  store.js              JSON 配置存储
  logger.js             日志 + Secret 脱敏
  doctor.js             环境检测
  cc-switch.js          cc-switch 发现/解析
  model-resolver.js     模型解析（cc-switch / direct）
  runtime-manager.js    隔离 Runtime + claude -p 执行
  feishu-adapter.js     飞书长连接
  console-test.js       离线测试控制台
  bot-manager.js        Bot 生命周期编排
renderer/
  index.html / app.js / styles.css   单页 5 页面 UI
scripts/smoke.js        冒烟测试
```

## MVP 边界（已知未实现 / 后续）

- 系统托盘、开机自启、最小化到托盘（PRD 第 33-36 节）——UI 有开关占位，主进程逻辑未接
- 单条消息串行处理（同一 Bot 同时只处理一条消息，避免进程混乱）
- 飞书消息 3 秒内需处理完：当前 Claude Code 执行是异步的，长任务需后续改为「先回执 + 异步回复」
- cc-switch 各 fork 存储格式差异较大，解析做了容错但需按你实际使用的 fork 调优
- Direct API 仅注入 `ANTHROPIC_*` 环境变量，适合兼容 Anthropic 协议的网关

## 技术要点（开发中踩过的坑）

- **Windows `.cmd` shim**：npm 全局安装的 `claude` 是 `.cmd` 批处理，`spawn` 直接执行会 `EINVAL`，`shell:true` 又会吞掉 stdin。已用 `resolveExecutable()` 把 `.cmd` 解析到底层 `claude.exe` 直接 spawn。
- **prompt 走 stdin**：`claude -p` 支持 stdin 输入，比命令行参数更稳（中文/空格/引号都不会被 Windows 拆坏）。
- **隔离 HOME 与登录态**：`HOME` 隔离后新目录是空的，Claude Code 会报 `Not logged in`。解决办法是首次启动从真实 `~/.claude` 播种配置副本，登录凭据/cc-switch 的 `settings.json` 都在其中。

## 注意事项

- 删除 Bot **永不删除** Workspace 文件
- 复制 Bot 默认**不复制**飞书 Secret，需重新配置
