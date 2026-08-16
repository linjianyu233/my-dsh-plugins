# 协议调研笔记（RESEARCH）

本文记录 `dsh-wechat-bridge` 的协议调研来源与关键结论，供维护者核对与继续开发。

## 核心结论

微信「龙虾」/ClawBot 的底层是腾讯官方 **iLink Bot 协议**：

- 接入域：`https://ilinkai.weixin.qq.com`（腾讯云，纯 HTTP/JSON，无 SDK 也可直接 fetch）
- 配对：服务端申请二维码 → 用户手机微信确认 → 服务端获得 `bot_token`
- 消息：`getupdates` 长轮询（35s hold）收消息，`sendmessage` 回消息（必须原样带回该消息的 `context_token`）
- 鉴权：`AuthorizationType: ilink_bot_token` + `Authorization: Bearer <bot_token>` + 随机 `X-WECHAT-UIN` 防重放
- 失效：`errcode/ret === -14` 表示 token 失效，需重新扫码
- 腾讯是"管道"：不存消息内容、不提供 AI；AI 后端完全自选（本仓库接的是本机 DSH）

**关键架构事实**：iLink 客户端是纯**出站** HTTPS 程序，本机无需入站监听/公网地址。
"必须公网可达 + wss" 是 **ClawChat 微信小程序**通道（连你自己的 OpenClaw 网关）的要求，与 ClawBot/iLink 通道是两套东西，切勿混淆。

## 权威来源

| 来源 | 说明 |
|---|---|
| [@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（npm，MIT） | 腾讯官方协议实现（OpenClaw 微信 channel 插件）。本仓库 `lib/ilink.mjs` 逐项对照其 2.4.6 版（`src/api/api.ts`、`src/auth/login-qr.ts`、`src/monitor/monitor.ts`、`src/messaging/*`）实现 |
| [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) | 上述包的 GitHub 仓库 |
| [OpenClaw 官方文档·WeChat channel](https://docs.openclaw.ai/channels/wechat) | 官方接入说明（`openclaw channels login --channel openclaw-weixin`） |
| [OpenClaw 网关协议](https://docs.openclaw.ai/zh-CN/gateway/protocol.md) | 网关侧协议（ClawChat 小程序等自托管通道用，与本仓库 iLink 直连无关，备查） |

## 逆向与第三方实现参考

| 来源 | 说明 |
|---|---|
| [SiverKing/weixin-ClawBot-API](https://github.com/SiverKing/weixin-ClawBot-API) | "免 OpenClaw" 的 Python/Node 实现 + 完整踩坑记录（`weixin-openclaw-api-py-docs.md`），对 sendmessage 必填字段、getconfig/typing 前置调用等有实测结论 |
| [hao-ji-xing/openclaw-weixin](https://github.com/hao-ji-xing/openclaw-weixin) | iLink 协议技术解析 + 裸调 Demo（`weixin-bot-api.md`） |
| [zongrongjin/weixin-ilink](https://github.com/zongrongjin/weixin-ilink) | Python SDK（配对 ACL、媒体收发等） |
| [jeffkit/ilink-hub](https://github.com/jeffkit/ilink-hub) / [openilink/openilink-hub](https://github.com/openilink/openilink-hub) | iLink 兼容 hub（多客户端复用/多语言 SDK） |
| [OSCHINA《逆向 iLink 协议剖析》](https://my.oschina.net/u/9487999/blog/19364268) | 能力边界分析 |
| 微信官方条款 | 《微信 ClawBot 功能使用条款》：腾讯仅提供消息通道，保留限速/过滤/中止权利；禁止营销、客服、高频群发 |

## 关键实现细节备忘

- `base_info.channel_version` 对应 SDK 版本号；`iLink-App-ClientVersion` 为 `major<<16|minor<<8|patch`（2.4.6 → 132102）。
- 回复消息结构：`msg.from_user_id` 必须为 `""`、`message_type: 2`（BOT）、`message_state: 2`（FINISH）、`client_id` 客户端唯一。
- `getconfig` 返回的 `typing_ticket` 每用户缓存 24h；`sendtyping` status 1=开始 / 2=结束。
- 文本提取：`item_list` 中 type=1 的 `text_item.text`（含 `ref_msg` 引用拼接）；语音转写字段 `voice_item.text`。
- 媒体发送链路（`lib/ilink-media.mjs`，逐项对照官方 SDK `src/cdn/*` 与 `src/messaging/send.ts` 实现）：
  - `getuploadurl` 请求体：`filekey`(32 hex) / `media_type`(1图 2视频 3文件 4语音) / `to_user_id` / `rawsize` / `rawfilemd5` / `filesize`(PKCS7 补齐后) / `no_need_thumb: true` / `aeskey`(32 hex 字符串)。
  - CDN 上传：响应 `upload_full_url` 优先，否则 `upload_param` 拼 `${cdnBaseUrl}/upload?encrypted_query_param=…&filekey=…`；`POST` 二进制密文（`Content-Type: application/octet-stream`），响应头 `x-encrypted-param` 即下载参数；4xx 立即失败、其余重试 3 次。
  - 消息体 `media` 结构：`{ encrypt_query_param, aes_key: base64(utf8(hex 密钥)), encrypt_type: 1 }`；图片 `mid_size`/视频 `video_size` = 密文字节数，文件 `file_name` + `len`(明文字节数字符串)。
  - 接收：`media.encrypt_query_param`（或 `media.full_url`）→ `${cdnBaseUrl}/download?…` → AES-128-ECB 解密；`aes_key` 两种编码均兼容（base64(raw 16 字节) 图片常见 / base64(hex 字符串) 文件语音视频常见）。
- 消息游标 `get_updates_buf` 必须持久化，重启后继续使用，否则丢消息/重复收。
- 登录状态机：`wait / scaned / confirmed / expired / scaned_but_redirect / need_verifycode / verify_code_blocked / binded_redirect`。
- 会话到期：官方 SDK 以 `-14` 判定；社区实测约 24h。本实现"主动提醒（可配时长）+ 被动重连（-14）"双保险。

## 本仓库与官方 SDK 的差异

- 官方 SDK 是 OpenClaw 的 channel 插件（依赖 OpenClaw 运行时）；本仓库是**零依赖独立客户端**，AI 后端固定为本机 DSH。
- 媒体收发已实现（2026-08 起）：`/send` 指令走官方 CDN 上传链路发文件，收到的图片/语音/文件/视频自动下载解密到 `data/media/`；语音仅存原始 `.silk`（未转码）。
- 长回复不再截断：单条回复超 `--reply-max-chars` 会按段落边界分成多条消息顺序发回（DSH headless 本就不流式，这里做的是"输出后分片"，不做逐 token 流式）。
- 会话可运行期指定工作区/权限/模型：`/config` 设置，通过 DSH headless 的 `--patch` overlay（覆盖 `agent-default-model`）与 `DSH_PERMISSION_MODE` / `cwd`（`sandbox-policy.workspaceRoot`）实现。
