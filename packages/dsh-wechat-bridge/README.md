# dsh-wechat-bridge —— 把 DSH 接到你的微信（含「龙虾」直连版）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-linjianyu233%2Fdsh--wechat--bridge-181717.svg?logo=github)](https://github.com/linjianyu233/dsh-wechat-bridge)
[![Gitee 镜像](https://img.shields.io/badge/Gitee-linjianyu233%2Fdsh--wechat--bridge-red.svg)](https://gitee.com/linjianyu233/dsh-wechat-bridge)

把本机 **DSH（DeepSeek Harness）** 变成你微信里的一只「龙虾」🦞：
微信发消息 → DSH 干活 → 回复回微信。**不需要 OpenClaw、不需要公网服务器、不需要网关。**

```
手机微信 ──► 腾讯 iLink 官方通道 (ilinkai.weixin.qq.com) ──► weixin-bot.mjs ──► 本机 DSH
    ▲                                                              │
    └────────────────────────── 回复 ──────────────────────────────┘
```

## Overview

**解决什么问题？** 把微信变成 DSH 的移动终端：人在外面用手机微信发一条消息，家里/办公室电脑上的 DSH 就替你查资料、写代码、跑脚本、处理文件，结果直接回微信。任何能跑 `dsh web` 的机器都能挂上。

**适合谁？** 已经会装 DSH 的开发者与重度用户；想要一个「随时在微信里」的私有 AI 助理、又不想搭公网服务器的人。

**怎么做？** 直接实现腾讯官方 **iLink Bot 协议**（微信 ClawBot/「龙虾」的同款官方通道）——扫码配对 → 长轮询收消息 → 调用本机 DSH → 发回微信。官方 OpenClaw 插件本身也只是这套协议的客户端，AI 后端（OpenClaw/DeepSeek/…/DSH）完全自选，腾讯只是"管道"。本仓库 `weixin-bot.mjs` 即完整实现（协议依据腾讯官方开源 SDK `@tencent-weixin/openclaw-weixin`，对照版本 2.4.6，详见 [RESEARCH.md](https://github.com/linjianyu233/dsh-wechat-bridge/blob/main/RESEARCH.md)）。

特性一览：

- **零运行时依赖**：只用到 Node 内建模块，无需任何 npm 依赖、无需 daemon、无需 OpenClaw 全家桶；
- **扫码即用**：个人微信免申请/免白名单，登录凭证自动续期（到期前提醒 + `-14` 自动重扫码）；
- **一人一上下文**：每个微信联系人有独立的 DSH 对话记忆、工作目录与多个命名会话，连续对话持续累积直到 `/new`；
- **长回复分段**：单条回复超过上限自动切成多条消息顺序返回，不再截断丢内容；
- **按会话指定工作区/权限/模型**：`/config` 给当前会话单独指定 DSH 工作目录、沙箱权限与模型；
- **双向文件**：`/send` 发电脑文件到微信；微信发来的图片/文件/视频自动下载解密落盘；
- **可审计**：聊天记录、DSH 完整运行轨迹、运行日志三层可查。

## Compatibility

| 依赖 | 支持/已验证 | 最后验证日期 |
|---|---|---|
| Node.js | `>= 18` | 2026-08-14 |
| DSH | `dsh@0.1.0-rc.6`（npm） | 2026-08-14 |
| 腾讯 iLink | 对照官方 SDK `2.4.6` | 2026-08-14 |
| 操作系统 | Windows / macOS / Linux（核心为纯 Node） | 2026-08-14 |

- 以上组合是本仓库**声明支持的验证基线**；新版本 DSH 一般向后兼容（本桥接只调用 `dsh` headless 子命令），但升级 DSH 或官方 SDK 后，请先跑一遍 [Quick start](#quick-start) 里的「本地闭环测试」再连真实微信。
- 腾讯可能随时变更协议端点或字段；变更造成的失效属协议漂移，升级本仓库到最新版并重新验证即可。
- npm 包名 `@linjianyu/dsh-wechat-bridge` 使用作者自有命名空间（未占用任何第三方 org 或保留命名空间）。

### 已验证

- ✅ 协议头与官方规范逐项一致（AuthorizationType / X-WECHAT-UIN / iLink-App-Id=bot / ClientVersion=132102 / Bearer）
- ✅ 扫码登录全流程（wait→scaned→confirmed、配对码、二维码刷新、节点跳转分支）
- ✅ 消息环：getupdates 游标持久化 → getconfig → sendtyping → sendmessage（context_token 逐条原样回传）→ 记忆注入
- ✅ 腾讯真实端点冒烟：真实二维码签发、状态轮询正常（`probe`）
- ✅ 真实 DSH 端到端：mock iLink + 真 headless，agent 回复经微信协议送达
- ✅ 登录续期/失效自动重连逻辑（代码路径，24h 周期需实机观察）
- ✅ 多会话闭环：mock iLink + DSH 回显，/new → 会话内对话 → /switch → /sessions → /clear 全链路 10 项断言通过
- ✅ 消费端安装实测（git 源等价版，2026-08-14）：`npm install -g --prefix <dir> github:linjianyu233/dsh-wechat-bridge#main` → `added 1 package`、**0 运行时依赖**；产物为 `files` 白名单 6 项（`lib/`、`bridge.mjs`、`weixin-bot.mjs`、`dsh-weixin.cmd`、`LICENSE`、`README.md`）+ npm 自动附带的 `package.json`（`npm pack --dry-run` 复核：`lib/` 展开后共 11 个文件），无 test/、data/、研究笔记
- ✅ 包外 bin 冒烟：`dsh-weixin --help` 正常；真实 DSH 任务：`node bridge.mjs test` → 回复「收到」、exit 0
- ⏳ npm 发布后按包名复跑：`npm install -g @linjianyu/dsh-wechat-bridge` → 同款三连（install → bin 冒烟 → `bridge.mjs test`），作为纯 npm 包名的消费端闭环证据

### 已知限制

- 媒体消息自动下载解密到 `data/media/<hash>/` 并告知路径；语音存为官方原始 `.silk` 格式（未转码），图片/视频/文件按原格式保存。
- 群聊：官方插件当前声明仅 direct chat，群消息不保证。
- 凭证有效期由腾讯服务器决定（社区实测约 24h），到期自动重扫续连（自动提醒 + `-14` 自动重连，见「工作原理」）。
- 同一时刻只有一条 DSH 任务在跑（不同联系人串行排队）。

## Install / Uninstall

### 安装

方式 A（npm 全局安装，npm 发布后可用）：

```powershell
npm install -g @linjianyu/dsh-wechat-bridge
```

方式 B（Git 源码安装，当前即可用，零依赖秒装）：

```powershell
git clone https://github.com/linjianyu233/dsh-wechat-bridge.git
cd dsh-wechat-bridge
npm install -g .          # 把 dsh-weixin 命令注册到全局
```

Windows 下也可以不安装：双击/运行仓库里的 `dsh-weixin.cmd`，或直接 `node weixin-bot.mjs <子命令>`。

### 升级

```powershell
npm update -g @linjianyu/dsh-wechat-bridge                              # 方式 A
cd dsh-wechat-bridge; git pull; npm install -g .             # 方式 B
```

### 禁用

- 停止接收消息：在运行 `dsh-weixin run` 的终端按 `Ctrl+C`（不再启动即禁用）；
- 清除本机登录凭证：`dsh-weixin logout`；
- 不删除任何历史数据，随时可重新 `login` 恢复。

### 彻底移除

```powershell
npm uninstall -g @linjianyu/dsh-wechat-bridge    # 移除命令（方式 B 同样按包名卸载）
Remove-Item -Recurse -Force .\data    # 删除凭证/记忆/工作目录/媒体（默认 <仓库>/data）
```

> DSH 自身的运行轨迹在 `~/.dsh/sessions/`（由 DSH 管理，与本插件独立），如需一并清除请自行处理。

## Quick start

环境：Node 18+；DSH 已安装且 `dsh web` 能跑；零 npm 依赖。

### 最小配置：连真实微信

```powershell
dsh-weixin login     # 1) 扫码登录（凭证有效期由腾讯决定，本地自动续连）
dsh-weixin run       # 2) 开始监听（保持终端开着）
```

1. 登录时终端会打印二维码链接：**在手机微信里打开该链接并确认**，几秒后配对成功；
2. 微信「我 → 设置 → 插件」中添加「ClawBot/龙虾」插件即可（个人用户免白名单）；
3. 配对成功后，直接在微信里给 Bot 发消息，DSH 就会收到并干活。

常用内置指令：

| 指令 | 作用 |
|---|---|
| `/help` | 指令列表 |
| `/status` | 连接剩余时间 + 当前会话、工作区、权限、模型与记忆条数 |
| `/time` | 本次连接剩余时间 |
| `/sessions` | 列出你的会话（记忆轮数 + 当前标记） |
| `/new [名字]` | 新建会话并切换；不带名字则开一个全新匿名会话 |
| `/switch <名字>` | 切换会话（`main` 为默认会话） |
| `/clear [名字]` | 清除当前（或指定）会话的对话记忆（工作目录文件保留） |
| `/config` | 查看/设置当前会话的工作区、访问权限、模型 |
| `/reconnect` | 手动重新连接 |
| `/send <文件路径> [说明]` | 把电脑上的文件发给你（绝对路径直接用；相对路径按当前会话的工作目录算；图片/视频按媒体发送，其余按文件发送） |

> 每个微信联系人（`from_user_id`）有独立的 DSH 对话记忆与工作目录（`data/workspaces/`），
> 跨轮次的文件操作结果持续保留；记忆按条数/字符双上限滚动裁剪。
>
> 每个联系人还可拥有多个**命名会话**：默认会话 `main`（chatId = `wx:<ID>`，与旧版完全兼容）。
> `/new <名字>` 新建并切换、`/switch <名字>` 切换、`/sessions` 列出；每个会话有独立的记忆流与工作目录，
> "当前会话"指针存于 `data/sessions-registry/<hash>.json`（缺失或损坏时自动回落 `main`）。
>
> **会话复用**：连续发消息会一直复用"当前会话"（记忆与工作目录持续累积），直到你发送 `/new`（有参或无参）
> 或 `/switch` 才会切换到另一个会话。

### 指定工作区 / 权限 / 模型

用 `/config` 给当前会话单独指定 DSH 的工作区、文件访问权限与模型：

```
/config                                  显示当前会话的配置
/config workspace <路径>                  设置工作区（绝对路径直接用；相对路径相对 data/workspaces/）
/config permission <级别>                 read-only | workspace-write | danger-full-access
/config model <模型名>                    如 deepseek-v4-pro（provider 固定 deepseek-official）
```

三项均为「按会话」生效，保存于会话注册表，对其它会话/联系人无影响；`/config permission danger-full-access`
会授予 DSH 以你本机账号的完整权限，请谨慎使用（回复里会附带风险提醒）。工作区可指定任意目录（由所选
权限级别决定 DSH 能否真的写进去）；对话记忆仍按会话存放在 `data/history/`，不会因工作区改动而丢失。

### 可复现示例：本地闭环（无需真实微信）

```powershell
# 终端 A：mock iLink 服务器
node test-mock-ilink.mjs --port 8899

# 终端 B：完整流程（DSH 层回显，不消耗模型）
$env:DSH_BRIDGE_MOCK_DSH="1"
node weixin-bot.mjs login --base-url http://127.0.0.1:8899 --data-dir .\test-data
$env:DSH_WXBOT_MAX_MSGS="2"
node weixin-bot.mjs run  --base-url http://127.0.0.1:8899 --data-dir .\test-data

# 检查 mock 捕获的收发记录与协议头
Invoke-RestMethod http://127.0.0.1:8899/__captured
Invoke-RestMethod http://127.0.0.1:8899/__headers

# 对腾讯真实端点冒烟（取真实二维码，不登录）
node weixin-bot.mjs probe
```

## Configuration

所有选项为命令行参数，均有 `DSH_WXBOT_*` / `DSH_BRIDGE_*` 环境变量等价项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--base-url` | `https://ilinkai.weixin.qq.com` | iLink 端点（测试时可指向 mock） |
| `--channel-version` | `2.4.6` | base_info.channel_version |
| `--bot-agent` | `dsh-wechat-bridge/…` | base_info.bot_agent（仅观测用途） |
| `--data-dir` | `./data` | 凭证/记忆/工作目录根 |
| `--auth-file` | `<data-dir>/weixin-auth.json` | 🔒 登录凭证（含 bot token，勿外传） |
| `--allow-from` | 全部 | 🔒 只响应指定用户 ID（逗号分隔，强烈建议设置） |
| `--reply-max-chars` | `3800` | 单条回复上限字符；超过自动分段成多条顺序返回 |
| `--no-typing` | 关 | 不发"正在输入"状态 |
| `--session-ms` / `--relogin-before-ms` | 7 天 / 24h | 本地会话计时 / 计时到期前提醒提前量（实际有效性由腾讯服务器决定） |
| `--dsh-bin` | 自动解析 | DSH 可执行文件路径（找不到 `dsh` 时用） |
| `--headless` | 关 | 回退旧 headless 路径（默认用常驻 DSH agent session，详见下文） |
| `--timeout-ms` / `--max-turns` / `--max-history-chars` | 同 bridge | DSH 调用超时 / 记忆条数上限 / 记忆字符上限 |

环境变量等价项：`DSH_WXBOT_BASE_URL`、`DSH_WXBOT_AUTH_FILE`、`DSH_WXBOT_ALLOW_FROM`、
`DSH_WXBOT_REPLY_MAX`、`DSH_WXBOT_NO_TYPING`、`DSH_BRIDGE_*`（DSH 层）、`DSH_BRIDGE_RESIDENT=0`（等价 `--headless`）。

### 真·会话复用（默认行为）

默认情况下，桥接为每个会话维护一个**常驻 DSH agent 进程**（由 `@linjianyu/dsh-bridge-runner` 提供），
凭固定的 `sessionId`（= 会话 chatId + epoch，见下）复用同一条持久 DSH session：

- 同进程内连续消息 → `agent.followup()` 真续接，工具调用/目标/子代理状态跨消息存活；
- 桥接/DSH 进程重启后 → 凭 `sessionId` 经 `session-persistence-jsonl` 自动 `resume` 记忆；
- runner 不可用（profile 未装等）时自动**回退**到 headless 历史注入，不中断服务。

启用前需先把 runner 安装进 DSH（走 DSH 官方 `dsh plugin` 插件机制，需 pnpm），远程拉取：

```powershell
dsh plugin --profile resident add @linjianyu/dsh-bridge-runner
dsh-weixin run                  # 默认即常驻会话复用
```

> 详见 `@linjianyu/dsh-bridge-runner` 包的 README。常驻模式下 `/clear` 会关停该会话的常驻进程，
> 并把其 session 换成一个全新 session（epoch+1；旧 DSH session 归档保留、不删除文件），
> 从而"清掉上下文"。每个会话的 sessionId 形如 `<chatId>@<epoch>`。

通用桥接 `bridge.mjs` 另有 `serve` 子命令（HTTP 壳，端口默认 8317、绑定 127.0.0.1、可选 `--token` 🔒 鉴权），供 OpenClaw exec 工具、wechaty 等外部程序调用，详见 `node bridge.mjs` 帮助。

## Permissions & data

本插件在本机运行，不涉及云服务。它访问/写入以下内容：

| 类别 | 内容 |
|---|---|
| **网络** | 仅 HTTPS 访问 `ilinkai.weixin.qq.com`（登录/收发）与腾讯 CDN（媒体上传下载）；闭环测试时指向本地 mock。不访问其他任何公网地址。 |
| **文件（读写）** | `data/`（默认，含凭证、历史、会话注册表、工作目录、媒体）；`test-data/`（测试）。 |
| **文件（只读）** | `~/.dsh/sessions/`（`sessions` 命令读取 DSH 运行轨迹）。 |
| **凭据** | `weixin-auth.json` 含 bot token——即"以你的微信身份收发消息"的凭据，🔒 切勿提交版本控制或外传（`.gitignore` 已覆盖）。 |
| **用户数据** | 所有往来消息原文 + 时间戳存于 `data/history/`（本地明文 JSON）；媒体文件解密后存于 `data/media/`。数据只在你机器与腾讯通道之间流动，不发给任何第三方。 |
| **执行权限** | 任何能给你微信发消息的人都能触发本机 DSH 执行任务（等于你本机账号的操作权）→ 务必用 `--allow-from` 只放行自己的微信号，并维持 DSH 自身的沙箱/审批配置。 |

## Troubleshooting

### 常见错误

| 现象 | 原因与处理 |
|---|---|
| 回复 `errcode -14` / 提示 token 失效 | 凭证过期：实现会自动重新扫码续连；也可手动 `dsh-weixin login` |
| 二维码过期 / 扫了没反应 | 重新 `dsh-weixin login`，并确认手机微信打开的是**最新**打印的链接 |
| 收不到消息 | 确认 `run` 进程在跑；`/status` 看连接剩余时间；看终端有无 `[bridge …]` 报错 |
| `dsh: command not found` | 安装 DSH，或用 `--dsh-bin` 指定可执行文件路径 |
| 媒体下载/上传失败（如 `x-encrypted-param` 缺失） | 腾讯协议变更或端点被代理改写：升级本仓库、确认 `--base-url` 为官方地址 |
| `bridge.mjs serve` 端口被占用 | `--port` 换端口 |
| 查看 DSH 轨迹提示 `zstd` 不存在 | 安装 zstd，或改用 DSH WebUI 查看对应 session |
| 扫码成功后无法配对（节点跳转） | 网络环境问题：换网络重试；实现已覆盖节点跳转分支 |

### 日志位置

- **运行日志**：`weixin-bot.mjs run` 的终端输出（stderr，`[bridge …]` 行，含收发/耗时/错误）；
- **对话记忆**：`data/history/<hash>.json`；
- **DSH 完整轨迹**：`~/.dsh/sessions/--<工作目录编码>--/session-*/session.jsonl.zstd`。

三层均可命令直达：

```powershell
node weixin-bot.mjs chats                              # 所有微信对话（联系人/轮数/DSH 会话数）
node weixin-bot.mjs history --chat <ID> --last 20      # 微信消息与 DSH 回复的对话原文
node weixin-bot.mjs sessions --chat <ID>               # 每条消息对应的 DSH 完整运行轨迹清单
```

> `<chat>` 可用完整 chatId（如 `wx:o9cq80…@im.wechat`）、用户 ID 或 `chats` 显示的 hash 键。
> 查看某次 DSH 完整轨迹：`zstd -d -c "<轨迹目录>\session.jsonl.zstd" | more`
> 每个联系人的工作目录 `data/workspaces/<hash>/` 保留 DSH 创建/修改的全部文件。

### 回滚

```powershell
cd dsh-wechat-bridge; git checkout <上一个稳定 tag>; npm install -g .   # 源码安装
npm install -g @linjianyu/dsh-wechat-bridge@<旧版本>                               # npm 安装
```

回滚不影响 `data/` 下的历史与工作目录；重大操作前建议先备份 `data/`。

## Development

**构建**：无需构建、零依赖，改完即跑（`node weixin-bot.mjs …`）。

**测试**：

```powershell
npm test                # 单元测试：WS 帧编解码 6 项断言（node test-ws.mjs）
npm run test:loop       # 起 mock iLink 服务器（配合 Quick start 的本地闭环）
```

**程序化入口**：package.json `main` 指向 `lib/core.mjs`（导出 `buildConfig` / `runChat` / `loadHistory` / `clearHistory` / `safeKey` 等，供嵌入调用）；CLI 入口为 `bin: dsh-weixin` → `weixin-bot.mjs`。

**贡献**：fork → 新分支 → 跑通 `npm test` 与本地闭环 → 提交 PR。提交前确认不包含 `data/`、`weixin-auth.json` 或任何研究笔记（`.gitignore` 已覆盖）；仓库保持 `dsh-plugin` topic 以便雷达收录。

### 工作原理

- **协议**：iLink Bot API（端点 `https://ilinkai.weixin.qq.com/ilink/bot/...`），与官方 SDK 2.4.6 行为一致：
  - 请求头：`AuthorizationType: ilink_bot_token`、随机 `X-WECHAT-UIN`、`iLink-App-Id: bot`、`iLink-App-ClientVersion: 132102`、`Authorization: Bearer <token>`
  - 登录：`get_bot_qrcode`（POST）→ `get_qrcode_status`（长轮询，支持配对码/二维码刷新/节点跳转）
  - 收消息：`getupdates` 长轮询 35s，`get_updates_buf` 游标持久化到磁盘（重启不丢）
  - 回复：`getconfig`（取 typing_ticket，缓存 24h）→ `sendtyping(1)` → `sendmessage`（**必须原样带回该消息的 `context_token`**）→ `sendtyping(2)`
  - 发文件：`getuploadurl`（filekey/md5/AES 密钥/加密后大小）→ CDN 上传 AES-128-ECB 密文（响应头 `x-encrypted-param`）→ `sendmessage` 携带 `file_item`/`image_item`/`video_item`
  - 收文件：媒体 item 的 `media.encrypt_query_param` → CDN 下载 → AES-128-ECB 解密 → 落盘 `data/media/<hash>/`
  - `errcode/ret === -14` 视为 token 失效，自动重新扫码续连
- **DSH 后端**：复用 `lib/core.mjs`——headless 一次性会话 + 历史注入 + 独立工作目录；默认改走 `lib/resident.mjs` 的常驻 agent session（真·复用，跨重启 resume，见上方「真·会话复用」），runner 未就绪时自动回退 headless。
- **会话续期**：本地计时默认 7 天（`--session-ms` 可调，提前 24h 提醒）；但**实际有效性由腾讯服务器决定**（官方 SDK 以 `errcode -14` 判定失效，社区实测约 24h，官方无承诺时长）。本实现双保险：
  ① 本地计时到期前主动发微信提醒并生成新二维码；② 任何时候收到 `-14` 都自动重新扫码续连，无缝换 token —— 服务器什么时候真踢，就什么时候自动续。

### 仓库文件

| 文件 | 说明 |
|---|---|
| `weixin-bot.mjs` | **龙虾直连版**：iLink 客户端 + DSH 后端（login/run/status/logout/probe/chats/history/sessions） |
| `bridge.mjs` | 通用桥接（CLI/HTTP），供 OpenClaw exec 工具、wechaty 等调用 |
| `lib/core.mjs` | 共享核心：DSH headless 调用、对话记忆、工作目录 |
| `lib/resident.mjs` | 常驻 DSH agent 进程池（默认会话复用，含 headless 回退） |
| `lib/ilink.mjs` | iLink 协议客户端（对照官方 SDK 2.4.6 实现，含 `getuploadurl`/通用 `sendMessageItems`） |
| `lib/ilink-media.mjs` | 媒体通道：CDN 上传（AES-128-ECB）+ 下载解密落盘 + MIME/密钥工具 |
| `lib/sessions.mjs` | 多会话管理：每联系人命名会话（/new /switch /sessions）、当前会话指针注册表 |
| `lib/ws.mjs` | 零依赖 WebSocket 服务端（备用：未来 ClawChat 小程序直连网关用） |
| （常驻 runner 插件见 `@linjianyu/dsh-bridge-runner` 独立包） | 常驻 agent runner 插件：会话管理/工作区/模型切换，经 `dsh plugin` 远程安装 |
| `test-mock-ilink.mjs` | mock iLink 服务器（闭环测试） |
| `test-ws.mjs` | ws 帧编解码单元测试 |
| `dsh-weixin.cmd` | Windows 启动器（任意目录运行 `dsh-weixin login/run/…`） |
| `RESEARCH.md` | 协议调研笔记（来源清单、实现备忘） |
| `LICENSE` / `package.json` / `SECURITY.md` | MIT 许可证 / 包信息 / 安全策略 |

### 参考资料与替代实现

- 协议调研笔记（来源清单、实现备忘、与官方 SDK 的差异）：[RESEARCH.md](https://github.com/linjianyu233/dsh-wechat-bridge/blob/main/RESEARCH.md)
- 同类"免 OpenClaw"实现（若想换 Python/Go 或参考配对细节）：`zongrongjin/weixin-ilink`（Python SDK）、`jeffkit/ilink-hub`、`openilink/openilink-hub`（Go + 多语言 SDK）、`liiiiwh/weixin-clawbot-skill`、`minibear2021/wechat_clawbot_sdk`

## License & security

- **许可证**：MIT，见 [LICENSE](./LICENSE)。
- **报告安全问题**：请**私下**报告（GitHub Security → Report a vulnerability，或 `[SECURITY]` 前缀 issue），详见 [SECURITY.md](https://github.com/linjianyu233/dsh-wechat-bridge/blob/main/SECURITY.md)；不要在公开 issue 贴 token 或复现细节。
- **这是腾讯官方通道**（《微信 ClawBot 功能使用条款》背书），与逆向个人微信协议的封号风险方案本质不同；但条款明确：腾讯只是"管道"、有权限速/过滤/中止服务，**不得用于营销、客服、高频群发**。
- 凭证 `weixin-auth.json` 含 bot token，**不要提交到版本控制或外传**（`.gitignore` 已覆盖；npm 发布包不含 `data/`）。
- 任何能给你微信发消息的人都能触发本机 DSH 执行（等于你电脑的操作权）：建议 `--allow-from` 只放行自己的微信号；bot 指令也仅在你自己的对话生效。
- DSH 以你本机账号权限执行任务，请维持本机 DSH 自身的沙箱/审批配置。
