# Codex Feishu Bridge

这是本机正在运行的 Codex 飞书桥接代码逻辑的源码快照。

它的职责很窄：Feishu bot 收到消息后，把文本转给本地 `codex exec` / `codex exec resume`，再把 Codex 的文本输出发回当前飞书 chat。

## 设计边界

- 每个 Feishu chat 只保存一个 `chatId -> Codex session/thread id` 绑定。
- 桥接层不保存 assistant/tool transcript。
- 上下文连续性由 Codex 自己的 session 管理。
- 同一个 chat 串行处理，避免并发写乱同一个 Codex 会话。
- 不做复杂 session replay。
- 不做图片、文件、音频转发。
- 不做 Feishu 卡片交互，只发送普通文本。

## 运行机制

新会话使用：

```bash
codex exec --json --skip-git-repo-check -
```

已有会话使用：

```bash
codex exec resume --json --skip-git-repo-check <session-id> -
```

用户消息通过 stdin 写入，并在前面追加桥接提示词：

```text
You are replying through a Feishu bridge.
Anything you output as assistant text will be sent back into the current Feishu chat.
Do not claim that you cannot send messages into the chat when the user is asking you to reply in chat.
```

桥接程序解析 Codex JSONL 事件：

- `thread.started`：记录 Codex session/thread id
- `item.completed` 且 `item.type === "agent_message"`：发送文本到飞书
- `turn.completed`：本轮完成
- `turn.failed`：本轮失败
- `error`：按 Codex 临时错误处理，记录日志但不中断

## 安装要求

- Node.js 20+
- npm
- rsync
- 本机已安装并可运行 `codex`
- 本机 Codex 已登录或已配置可用认证
- 飞书 bot 已开启长连接事件

## 安装

```bash
bash scripts/install.sh
```

安装脚本会：

- 复制项目到 `~/.local/share/codex-feishu-bridge/app`
- 执行 `npm ci` / `npm install`
- 构建 `dist/daemon.mjs`
- 创建命令 `~/.local/bin/codex-feishu-bridge`
- 首次运行时生成 `~/.codex-feishu-bridge/config.env`

确保 `~/.local/bin` 在 PATH 中：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 配置

编辑：

```text
~/.codex-feishu-bridge/config.env
```

最小配置：

```env
CFB_FEISHU_APP_ID=cli_xxx
CFB_FEISHU_APP_SECRET=xxx
CFB_CODEX_WORKDIR=/path/to/workdir
```

常用配置：

```env
CFB_FEISHU_DOMAIN=feishu
CFB_FEISHU_ALLOWED_USERS=
CFB_FEISHU_REQUIRE_MENTION=true
CFB_CODEX_EXECUTABLE=
CFB_CODEX_FULL_ACCESS=true
CFB_CODEX_MODEL=
CFB_CODEX_SANDBOX=workspace-write
CFB_DEFAULT_SESSION_ID=
CFB_NO_EVENT_TIMEOUT_MS=600000
CFB_HARD_TIMEOUT_MS=5400000
CFB_REPLY_MAX_CHARS=3500
```

说明：

- `CFB_FEISHU_ALLOWED_USERS`：可选，用逗号分隔允许访问的 user open_id 或 chat_id。
- `CFB_FEISHU_REQUIRE_MENTION=true`：群聊里要求 `@bot` 才响应。
- `CFB_CODEX_EXECUTABLE`：显式指定 `codex` 可执行文件路径；留空则自动查找。
- `CFB_CODEX_FULL_ACCESS=true`：传给 Codex `--dangerously-bypass-approvals-and-sandbox`。
- `CFB_CODEX_MODEL`：可选，传给 Codex `-m`。
- `CFB_CODEX_SANDBOX`：未开启 full access 时可用 `read-only`、`workspace-write` 或 `danger-full-access`。
- `CFB_DEFAULT_SESSION_ID`：可选，让新 chat 默认接到一个已有 Codex session。

## 启动与管理

```bash
codex-feishu-bridge start
codex-feishu-bridge status
codex-feishu-bridge logs 100
codex-feishu-bridge stop
```

macOS 上会注册为 `launchd` 任务 `com.codex-feishu-bridge`。其他系统使用后台 `nohup node dist/daemon.mjs`。

## 飞书侧要求

飞书应用至少需要：

- 开启机器人能力
- 发布应用
- 订阅事件 `im.message.receive_v1`
- 使用长连接模式
- 允许发送消息

## 聊天命令

- `/new` 或 `/reset`：清空当前 chat 绑定的 Codex session
- `/status`：查看当前 chat 绑定的 session id
- `/help`：查看内置帮助

## 本机当前部署形态

本机当前运行的多个桥接实例使用同一套安装代码：

```text
C:\Users\citarreikee\.local\share\codex-feishu-bridge\app
```

通过不同 `CFB_HOME` 区分实例状态和配置，例如：

```text
C:\Users\citarreikee\.codex-feishu-bridge
C:\Users\citarreikee\.codex-feishu-bridge-entroflow-current
C:\Users\citarreikee\.codex-feishu-bridge-memoflow
```

这些 `CFB_HOME` 目录包含真实配置、日志和运行状态，不应提交到仓库。

## 打包

```bash
npm run package
```

输出：

```text
releases/codex-feishu-bridge-<version>.tar.gz
releases/codex-feishu-bridge-<version>.zip
```
