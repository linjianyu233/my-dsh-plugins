# @linjianyu/dsh-bridge-runner —— 面向 bridge/客户端的通用常驻会话运行层

把 DSH 变成一个**常驻进程**，用固定 `sessionId` 维护同一条持久 agent session，
跨进程重启也能凭 `sessionId` 恢复（resume），从 stdin 逐行喂 followup、把最终回复写回 stdout。

## 定位：介于 headless 与 web 之间的「会话运行层」

| 层次 | 会话持久 | 接口 | 面向 |
|---|---|---|---|
| `dsh-headless` | ❌ 每次全新 session | 一次性子进程 + CLI 参数 | 脚本、单发任务 |
| **dsh-bridge-runner**（本包） | ✅ 固定 sessionId + resume | 常驻子进程 + stdio 帧协议 | **bridge/客户端**（微信、IM、桌面壳…） |
| DSH Web | ✅ session | HTTP/WebSocket BFF | 浏览器 UI |

相比 headless，本层额外提供：**会话管理**（固定 id、create/resume、换新）、
**工作区**（`--workspace` 指定 cwd）、**模型切换**（热切，不丢上下文）、
**权限切换**（`--permission` 热切 + 运行时指令）、**agent 编排**（followup/whenIdle，未来 extend subagent）。

相比 web，本层**无 HTTP/Host/浏览器层**，只有一个 stdio 帧协议，任何外部组件
（wechat-bridge、telegram bridge、桌面客户端……）都能用 `spawn` 一个子进程的方式接入。

## 为什么需要它

`dsh --profile headless` 每次运行都硬编码 `session-${randomUUID()}`（见
`@deepseek-ai/dsh-headless/lib/index.js`），即每条消息都是**全新 session**。
本层复用 DSH 底层的 `agents.create` / `agents.resume` / `agent.followup()` 真实 API
（`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-agent-loop`，web 的 host BFF 也走同一套），
让一条 agent session 真正跨消息、跨进程延续。

## 目录结构

```
packages/dsh-bridge-runner/
  package.json              插件包清单（dsh.bundle.patch + devDeps）
  cordis.patch.yml          bundle patch：插入 resident-startup + resident-runner
  lib/startup.js            解析 --session-id，发布 residentStartup 服务
  lib/index.js              常驻 runner：create/resume + stdin 循环 + stdout 帧输出
  lib/types/*.d.ts          类型声明
  test-resident.mjs         POC 验证脚本
```

## stdio 帧协议（UTF-8，逐行）

- **输入**（stdin 每行 = 一条用户消息）：
  ```
  <文本>\n
  ```
  空行视为心跳/分隔（回一帧 `ok` 但 `reply` 为空、`skipped:true`）。
- **输出**（每条消息处理后输出一行 JSON）：
  ```json
  {"id":1,"ok":true,"reply":"<最终 assistant 文本>"}
  {"id":2,"ok":false,"error":"..."}
  ```
- stdin 关闭（EOF）→ 优雅退出；SIGINT/SIGTERM → 优雅退出。

## 安装（走 DSH 官方插件机制，远程 npm）

本包已发布到 npm（`@linjianyu/dsh-bridge-runner`），直接远程安装：

```powershell
# 远程拉取 @linjianyu/dsh-bridge-runner 并 reconcile 进 resident profile 的 bundles
dsh plugin --profile resident add @linjianyu/dsh-bridge-runner
```

`dsh plugin add` 内部转发到 pnpm，在 profile 目录 `pnpm add <pkg>`；随后自动 reconcile
（检测到插件声明了 `dsh.bundle`，便把它追加进 profile 的 `dsh.profile.bundles` 层列表）。
pnpm 把 plugin 与 `commander` 装入 `.pnpm` 虚拟仓库，`@deepseek-ai/*` peer 经 profile
父目录向上在 `$DSH_HOME/profiles/node_modules`（DSH 内置包扁平回退）解析。

前置依赖：`dsh` 已安装、pnpm 可用（未装用 `npm i -g pnpm` 或 `corepack enable pnpm`）。

## 使用

```powershell
$env:DSH_HOME = "$env:USERPROFILE\.dsh"
dsh --profile resident --session-id wx:o9cq80...@im.wechat
```

之后保持进程常驻，把消息按行写进 stdin、从 stdout 读回复帧即可。
`weixin-bot.mjs` 的 `--resident` 模式会为每个微信会话维护一个这样的常驻子进程。

## 关键实现机制

- **固定 sessionId**：`agents.create({ sessionId })` 首次建立；进程内 `agents.get(id)` 直接复用 live agent。
- **跨重启恢复**：`session-persistence-jsonl`（dsh-base 默认装载，落盘 `$DSH_HOME/sessions/`）持久化 session；
  runner 启动时先 `agents.resume({ resumeSessionId })`，失败（session 不存在）才 `create`。
- **喂 followup**：`agent.followup(createUserMessage(...))` → `await agent.whenIdle()` →
  聚合本轮的 `assistant/message` 文本 → `sessions.flush()` 落盘 → 回帧。
- **模型热切**：`--model`/`--provider` 初始化 `selection.current`；`@model` 指令帧 / `set_model`
  tool 运行时改 `selection.current`，下一次请求即用新模型（复用 session，不丢上下文）。
- **模型图片能力优雅降级**（多模态切回 text-only 模型）：若一次多模态交互把 `type:"image"`
  块写进了持久 session 历史，之后热切到一个只声明 `input: ["text"]` 的模型（如
  `opencode-go/deepseek-v4-flash`），每个请求都会把含图历史发给 LLM，`dsh-llm-pi-ai`
  会抛 `UNSUPPORTED_CONTENT` 导致空返回。runner 在 `lib/image-compat.mjs` 按
  `llm.resolveModelInfo` 缓存各模型图片能力，**仅当当前模型已确认不支持图片时**，对
  `session.deriveMessages()` 的投影剥离图片块（保留文本信封），不改动持久 session，也不影响
  真正支持图片的模型（kimi-k3 等）。
- **权限热切**：`permissionPresets.set(session, preset)` 下 sandbox/mode + approval/policy 事件。
- **工作区**：`--workspace` 决定 `SessionHeader.cwd`（不可变），换工作区由桥侧 rotate 新 session 实现。
- **换新会话（/clear）**：桥接侧用 `<chatId>@<epoch>` 作为 sessionId，`/clear` 时 epoch+1，
  旧 DSH session 归档保留、新 session 从零开始（不清除、不删除文件）。

## 验证结果

`test-resident.mjs` 实测（DSH `0.1.0-rc.6`，`deepseek-v4-pro`）：

- 进程内两轮：第二条回复正确反映第一条（"你的名字是张三"）。
- **跨进程重启**：新进程 `resume` 同一 session，问"我上一轮说的名字"回答"你叫张三"——证明真·持久复用。
- **/clear 换新 session**：epoch 轮换后新 session 不再记得旧上下文。

```
P1: 我的名字叫张三。请复述我的名字。            → "你的名字是张三。"
P2(新进程): 我在上一轮对话里告诉过你我的名字…  → "你叫张三。"   ← 跨进程记住
/clear → 换 sessionId@+1 → 问"我叫什么" → "我不知道。"      ← 上下文已清空
```
