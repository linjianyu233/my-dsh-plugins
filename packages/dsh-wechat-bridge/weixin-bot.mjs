#!/usr/bin/env node
/**
 * weixin-bot.mjs —— 微信「龙虾」(ClawBot) 直连版：把 DSH 接到你的微信。
 *
 * 基于腾讯官方 iLink Bot 协议（参考 @tencent-weixin/openclaw-weixin@2.4.6），
 * 不需要 OpenClaw、不需要公网服务器、不需要网关：
 *   扫码配对 → 长轮询收消息 → 调 DSH → 回复微信。
 *
 * 用法:
 *   node weixin-bot.mjs login   扫码登录微信（保存凭证）
 *   node weixin-bot.mjs run     启动监听循环（默认命令）
 *   node weixin-bot.mjs status  查看连接状态
 *   node weixin-bot.mjs logout  注销
 *   node weixin-bot.mjs probe   对腾讯 iLink 端点做冒烟测试（取真实二维码）
 */

import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION, buildConfig, runChat, clearHistory, loadHistory, safeKey, withLock, log, resolveWorkspaceDir } from "./lib/core.mjs";
import { ResidentPool } from "./lib/resident.mjs";
import { createIlinkClient, extractText, DEFAULT_BASE_URL, STALE_TOKEN_ERRCODE, LONG_POLL_TIMEOUT_MS } from "./lib/ilink.mjs";
import { sendMediaFile, downloadMediaFromItem, formatBytes, MEDIA_MAX_BYTES } from "./lib/ilink-media.mjs";
import {
  chatIdFor,
  contactKeyFor,
  createAnonymousSession,
  createSession,
  findSession,
  getRegistry,
  listSessionInfos,
  nameOk,
  normalizeName,
  PERMISSION_LEVELS,
  resolveChatId,
  resolveResidentSessionId,
  resolveSessionState,
  rotateResidentSession,
  switchToSession,
  updateSessionConfig,
} from "./lib/sessions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `weixin-bot —— DSH ⇄ 微信「龙虾」直连

用法:
  node weixin-bot.mjs login    扫码登录微信（保存凭证，24h 有效）
  node weixin-bot.mjs run      启动监听（收微信消息 → DSH → 回复）
  node weixin-bot.mjs status   查看连接状态与剩余时间
  node weixin-bot.mjs logout   注销并清除凭证
  node weixin-bot.mjs probe    对腾讯 iLink 端点冒烟测试（取真实二维码，不登录）
  node weixin-bot.mjs chats    列出所有微信对话（联系人/轮数/DSH 会话数）
  node weixin-bot.mjs history [--chat <ID>] [--last N]   查看微信↔DSH 对话记录
  node weixin-bot.mjs sessions [--chat <ID>]             查看某对话的 DSH 完整轨迹清单

选项:
      --base-url <url>         iLink 端点（默认 https://ilinkai.weixin.qq.com）
      --channel-version <v>    base_info.channel_version（默认 2.4.6）
      --bot-agent <s>          base_info.bot_agent（默认 dsh-wechat-bridge）
      --auth-file <path>       凭证文件（默认 <data-dir>/weixin-auth.json）
      --sync-buf-file <path>   消息游标持久化文件
      --allow-from <ids>       只响应这些用户（逗号分隔，默认全部）
      --reply-max-chars <n>    单条回复上限字符（默认 3800，超出自动分段，不再截断）
      --no-typing              不发送"正在输入"状态
      --session-ms <n>         本地会话计时（默认 7 天；实际有效性由腾讯服务器决定，失效时自动重扫）
      --relogin-before-ms <n>  计时到期前多久提醒（默认 24h）
      --qr-timeout-ms <n>      等待扫码最长时间（默认 8 分钟）
      --headless               回退旧 headless 路径（默认用常驻 DSH agent session）
  以及 DSH 相关: --data-dir --dsh-bin --timeout-ms --max-turns --max-history-chars

环境变量: DSH_BRIDGE_MOCK_DSH=1 可让 DSH 层回显任务（测试用）。
          DSH_BRIDGE_RESIDENT=0 等价于 --headless（回退 headless）。
`;

const COMMANDS = new Set(["login", "run", "status", "logout", "probe", "help", "chats", "history", "sessions"]);

function parseArgs(argv) {
  const o = { command: "run", help: false, values: {} };
  const positional = [];
  const take = (name) => {
    const v = argv[++i];
    if (v === undefined) throw new Error(`缺少 ${name} 的值`);
    return v;
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        o.help = true;
        break;
      case "-c":
      case "--chat":
        o.chatId = take(a);
        break;
      case "--base-url":
        o.values.baseUrl = take(a);
        break;
      case "--channel-version":
        o.values.channelVersion = take(a);
        break;
      case "--bot-agent":
        o.values.botAgent = take(a);
        break;
      case "--auth-file":
        o.values.authFile = take(a);
        break;
      case "--sync-buf-file":
        o.values.syncBufFile = take(a);
        break;
      case "--allow-from":
        o.values.allowFrom = take(a).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--reply-max-chars":
        o.values.replyMaxChars = Number(take(a));
        break;
      case "--no-typing":
        o.values.noTyping = true;
        break;
      case "--session-ms":
        o.values.sessionMs = Number(take(a));
        break;
      case "--relogin-before-ms":
        o.values.reloginBeforeMs = Number(take(a));
        break;
      case "--qr-timeout-ms":
        o.values.qrTimeoutMs = Number(take(a));
        break;
      case "--last":
        o.values.last = Number(take(a));
        break;
      case "--port":
        o.values.port = Number(take(a));
        break;
      case "--host":
        o.values.host = take(a);
        break;
      case "--token":
        o.values.token = take(a);
        break;
      case "--data-dir":
        o.values.dataDir = take(a);
        break;
      case "--dsh-bin":
        o.values.dshBin = take(a);
        break;
      case "--timeout-ms":
        o.values.timeoutMs = Number(take(a));
        break;
      case "--max-turns":
        o.values.maxTurns = Number(take(a));
        break;
      case "--max-history-chars":
        o.values.maxHistoryChars = Number(take(a));
        break;
      case "--headless":
        o.values.resident = false;
        break;
      default:
        if (a.startsWith("-")) throw new Error(`未知参数: ${a}`);
        if (o.command === "run" && COMMANDS.has(a)) {
          o.command = a;
        } else {
          positional.push(a);
        }
    }
  }
  return { o, positional };
}

// ---------------------------------------------------------------------------
// 配置与凭证
// ---------------------------------------------------------------------------

function buildBotOpts(values) {
  return {
    baseUrl: values.baseUrl ?? process.env.DSH_WXBOT_BASE_URL ?? DEFAULT_BASE_URL,
    channelVersion: values.channelVersion ?? process.env.DSH_WXBOT_CHANNEL_VERSION ?? "2.4.6",
    botAgent: values.botAgent ?? process.env.DSH_WXBOT_AGENT ?? `dsh-wechat-bridge/${VERSION}`,
    authFile: values.authFile ?? process.env.DSH_WXBOT_AUTH_FILE ?? null,
    syncBufFile: values.syncBufFile ?? process.env.DSH_WXBOT_SYNC_BUF ?? null,
    allowFrom: values.allowFrom ?? (process.env.DSH_WXBOT_ALLOW_FROM?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
    replyMaxChars: values.replyMaxChars ?? Number(process.env.DSH_WXBOT_REPLY_MAX ?? 3800),
    noTyping: values.noTyping ?? process.env.DSH_WXBOT_NO_TYPING === "1",
    sessionMs: values.sessionMs ?? Number(process.env.DSH_WXBOT_SESSION_MS ?? 7 * 24 * 3600 * 1000),
    reloginBeforeMs: values.reloginBeforeMs ?? Number(process.env.DSH_WXBOT_RELOGIN_BEFORE_MS ?? 24 * 3600 * 1000),
    qrTimeoutMs: values.qrTimeoutMs ?? Number(process.env.DSH_WXBOT_QR_TIMEOUT_MS ?? 8 * 60 * 1000),
  };
}

function resolveFiles(botOpts, cfg) {
  return {
    authFile: botOpts.authFile ?? path.join(cfg.dataDir, "weixin-auth.json"),
    syncBufFile: botOpts.syncBufFile ?? path.join(cfg.dataDir, "weixin-syncbuf.txt"),
  };
}

async function loadAuth(file) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!raw.token) throw new Error("bad shape");
    return raw;
  } catch {
    return null;
  }
}

async function saveAuth(file, auth) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...auth, savedAt: Date.now() }, null, 2), "utf8");
}

async function loadSyncBuf(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

async function saveSyncBuf(file, buf) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, String(buf ?? ""), "utf8");
}

const mask = (s, n = 6) =>
  typeof s === "string" && s.length > 0 ? (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s) : "(空)";

function readLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function displayQr(qrcodeImgContent) {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeImgContent, { small: true });
  } catch {
    // 无 qrcode-terminal 依赖，直接给链接
  }
  console.log(`\n📱 二维码链接（在手机微信里打开）:\n${qrcodeImgContent}\n`);
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/**
 * 扫码登录。返回 {token, baseUrl, botId, userId}；失败抛错。
 * 流程与官方 SDK login-qr.ts 一致（含配对码、IDC 跳转、二维码刷新）。
 */
async function doLogin(botOpts, cfg, { files, interactive = true } = {}) {
  const client = createIlinkClient({
    baseUrl: botOpts.baseUrl || DEFAULT_BASE_URL, // 默认主域；--base-url 可指向 mock/测试端点
    channelVersion: botOpts.channelVersion,
    botAgent: botOpts.botAgent,
    log: (m) => log(m),
  });

  console.log("正在向微信 iLink 申请登录二维码…");
  let qr = await client.getBotQrcode();
  if (!qr.qrcode) throw new Error("获取二维码失败：响应中缺少 qrcode");
  console.log(`✅ 已获得二维码 (id=${mask(qr.qrcode, 10)})`);
  await displayQr(qr.qrcodeImgContent);

  let verifyCode;
  let refreshCount = 1;
  const MAX_REFRESH = 3;
  const deadline = Date.now() + botOpts.qrTimeoutMs;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    let st;
    try {
      st = await client.pollQrcodeStatus(qr.qrcode, verifyCode);
    } catch (e) {
      st = { status: "wait" };
    }

    switch (st.status) {
      case "wait":
        if (interactive) process.stdout.write(".");
        break;
      case "scaned":
        if (verifyCode) verifyCode = undefined; // 配对码已接受
        if (!scannedPrinted) {
          console.log("\n✅ 已扫码，请在手机上确认…");
          scannedPrinted = true;
        }
        break;
      case "need_verifycode": {
        const prompt = verifyCode ? "❌ 数字不匹配，请重新输入手机上显示的数字：" : "🔢 输入手机微信显示的数字配对码：";
        verifyCode = await readLine(prompt);
        continue; // 立即带码重试，不等待
      }
      case "verify_code_blocked":
        console.log("⛔ 配对码多次错误，刷新二维码重试…");
        verifyCode = undefined;
        if (++refreshCount > MAX_REFRESH) throw new Error("配对码多次错误且二维码刷新次数超限，请稍后再试");
        qr = await client.getBotQrcode();
        await displayQr(qr.qrcodeImgContent);
        scannedPrinted = false;
        break;
      case "expired":
        console.log("⏳ 二维码已过期，正在刷新…");
        if (++refreshCount > MAX_REFRESH) throw new Error("二维码多次过期，请重新运行 login");
        qr = await client.getBotQrcode();
        await displayQr(qr.qrcodeImgContent);
        scannedPrinted = false;
        break;
      case "scaned_but_redirect":
        if (st.redirectHost) {
          console.log(`🔀 服务器要求切换节点: ${st.redirectHost}`);
          client.setBaseUrl(`https://${st.redirectHost}`);
        }
        break;
      case "binded_redirect":
        console.log("✅ 该微信已连接过本机，无需重复连接。");
        return null;
      case "confirmed": {
        if (!st.botId) throw new Error("登录确认但服务器未返回 ilink_bot_id");
        console.log(`\n🎉 登录成功！botId=${st.botId} userId=${st.userId ? mask(st.userId) : "?"}`);
        return {
          token: st.botToken,
          baseUrl: st.baseUrl || DEFAULT_BASE_URL,
          botId: st.botId,
          userId: st.userId ?? null,
          channelVersion: botOpts.channelVersion,
          loggedInAt: Date.now(),
        };
      }
      default:
        console.log(`未知扫码状态: ${st.status}，继续轮询`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("等待扫码超时");
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

const COMMANDS_HELP = `可用指令：
/help    查看指令
/status  连接与记忆状态
/time    本次连接剩余时间
/sessions  列出我的会话
/new [名字]   新建会话并切换（不带名字 = 开一个全新匿名会话）
/switch <名字> 切换会话（/switch main 回默认）
/clear [名字]  清除当前（或指定）会话的记忆
/config  查看/设置当前会话的工作区、权限、模型
/reconnect  手动重新连接
/send <文件路径> [说明]  发送电脑上的文件给你（相对路径按当前会话的工作目录算）
其他消息将交给本机 DSH 处理。`;

function splitForWechat(text, max) {
  // 按段落/换行边界切分，避免切断中文字符与 markdown 结构；超长单行才硬切。
  const chunks = [];
  const paragraphs = text.split(/\n{2,}/);
  let cur = "";
  for (const para of paragraphs) {
    if (cur && cur.length + 2 + para.length <= max) {
      cur += "\n\n" + para;
      continue;
    }
    if (cur) chunks.push(cur);
    if (para.length <= max) {
      cur = para;
      continue;
    }
    // 段落本身超长：先按行，再硬切
    const lines = para.split("\n");
    cur = "";
    for (const line of lines) {
      if (cur && cur.length + 1 + line.length <= max) {
        cur += "\n" + line;
        continue;
      }
      if (cur) chunks.push(cur);
      if (line.length <= max) {
        cur = line;
      } else {
        let rest = line;
        while (rest.length > max) {
          chunks.push(rest.slice(0, max));
          rest = rest.slice(max);
        }
        cur = rest;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [""];
}

/** 把长文本按 max 分段，逐段发消息；仅单段时直接返回该段。返回发送的段数。 */
async function sendChunked(bot, to, ctxToken, text, max, attempt = 0) {
  const chunks = splitForWechat(text, max);
  const sendAll = async () => {
    if (chunks.length === 1) {
      await bot.sendMessage({ to, text: chunks[0], contextToken: ctxToken });
      return 1;
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = `(${i + 1}/${chunks.length})\n`;
      await bot.sendMessage({ to, text: prefix + chunks[i], contextToken: ctxToken });
    }
    return chunks.length;
  };
  try {
    return await sendAll();
  } catch (e) {
    // 回发微信偶尔因网络抖动(代理长连接被重置)失败；小退避重试一次，避免直接丢回复。
    const retries = Number(process.env.DSH_WXBOT_SEND_RETRIES ?? 2);
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      return sendChunked(bot, to, ctxToken, text, max, attempt + 1);
    }
    throw e;
  }
}

/**
 * 把 DSH 失败信息友好化后回传微信：识别多模态切换相关的错误给出引导，
 * 其余剥 ANSI + 去换行/控制字符 + 按长度截断，避免刷屏、破坏单行帧。
 * @param {unknown} err raw error（string / Error / 任意）
 * @param {number} max 输出最大字符数
 * @returns {string} 可直接发给微信的文本
 */
function formatErrorForWechat(err, max = 800) {
  const raw = (() => {
    if (err == null) return "";
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.message ?? String(err);
    if (typeof err === "object" && typeof err.message === "string") return err.message;
    return String(err);
  })();
  const plain = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

  // 多模态切换：切到 text-only 模型后，历史里的图片块让底层抛 UNSUPPORTED_CONTENT。
  // 给出可操作的引导，而不是把 pi-ai 的错误串原样丢给用户。
  if (/UNSUPPORTED_CONTENT|does not support image input|cannot represent .* image/i.test(plain)) {
    return (
      "⚠️ 当前模型不支持图片输入：这次对话里已经有图片内容，而这个模型只接受文本。\n" +
      "💡 处理办法（任选其一）：\n" +
      "· 用 /config model <支持图片的模型> 切回多模态模型（例如 opencode-go/kimi-k3、minimax-m3、qwen3.7-plus）；\n" +
      "· 或 /clear 清除含图片的对话记忆后继续。"
    );
  }

  if (plain === "") return "⚠️ DSH 任务失败（无更多信息）。";

  const cap = Math.max(60, Math.floor(max));
  const text = plain.length > cap ? `⚠️ DSH 任务失败：${plain.slice(0, cap)}…` : `⚠️ DSH 任务失败：${plain}`;
  return text;
}

/**
 * /send <文件路径> [说明] —— 把电脑上的文件上传微信 CDN 后发给对方。
 * 绝对路径原样使用；相对路径相对该联系人的工作目录（data/workspaces/<key>）。
 * 图片/视频按媒体类型发送，其余按文件发送；可选"说明"会作为一条文本先行发出。
 */
async function handleSendCommand(bot, cfg, state, from, ctxToken, text) {
  const argLine = text.slice("/send".length).trim();
  if (!argLine) {
    await bot.sendMessage({ to: from, text: "📎 用法：/send <文件路径> [可选说明]\n例：/send D:\\下载\\报告.pdf", contextToken: ctxToken });
    return;
  }
  const m = argLine.match(/^"([^"]+)"\s*(.*)$/s) ?? argLine.match(/^(\S+)\s*(.*)$/s);
  const rawPath = m?.[1] ?? argLine;
  const caption = (m?.[2] ?? "").trim() || undefined;
  const currentChatId = await resolveChatId(cfg, from, contactKeyFor(from));
  const filePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.join(cfg.dataDir, "workspaces", safeKey(currentChatId), rawPath);

  let st;
  try {
    st = await stat(filePath);
  } catch {
    await bot.sendMessage({ to: from, text: `❌ 找不到文件：${filePath}`, contextToken: ctxToken });
    return;
  }
  if (!st.isFile()) {
    await bot.sendMessage({ to: from, text: `❌ 不是普通文件：${filePath}`, contextToken: ctxToken });
    return;
  }
  if (st.size > MEDIA_MAX_BYTES) {
    await bot.sendMessage({ to: from, text: `❌ 文件过大：${formatBytes(st.size)}（上限 ${formatBytes(MEDIA_MAX_BYTES)}）`, contextToken: ctxToken });
    return;
  }

  const typingTicket = await bot.getTypingTicket(from, ctxToken);
  if (typingTicket) await bot.sendTyping(from, typingTicket, 1);
  try {
    await bot.sendMessage({ to: from, text: `⏳ 正在发送 ${path.basename(filePath)}（${formatBytes(st.size)}）…`, contextToken: ctxToken });
    const r = await sendMediaFile({ client: bot, filePath, to: from, caption, contextToken: ctxToken, log: (m) => log(m) });
    log(`/send 完成: user=${mask(from)} file=${filePath} kind=${r.kind} clientId=${r.clientId}`);
    await bot.sendMessage({ to: from, text: `✅ 已发送${r.kind}：${r.fileName}（${formatBytes(r.fileSize)}）`, contextToken: ctxToken });
  } catch (e) {
    log(`/send 失败: user=${mask(from)} file=${filePath} err=${e?.message ?? e}`);
    await bot.sendMessage({ to: from, text: `❌ 发送失败：${e?.message ?? e}`.slice(0, 500), contextToken: ctxToken });
  } finally {
    if (typingTicket) await bot.sendTyping(from, typingTicket, 2).catch(() => {});
  }
}

/**
 * /config —— 查看/设置当前会话的工作区、访问权限、模型。
 *   /config                     显示当前生效值
 *   /config workspace <路径>     设置工作区（绝对或相对 data/workspaces）
 *   /config permission <级别>    read-only | workspace-write | danger-full-access
 *   /config model <模型名>       如 deepseek-v4-pro（provider 固定 deepseek-official）
 */
async function handleConfigCommand(bot, cfg, state, from, ctxToken, text) {
  const contactKey = contactKeyFor(from);
  const reg = await getRegistry(cfg, contactKey);
  const argLine = text.slice("/config".length).trim();
  const regName = reg.current;

  if (!argLine) {
    const s = await resolveSessionState(cfg, from, contactKey, regName);
    const ws = s.workspace ?? "（默认：按会话自动分配）";
    const perm = s.permission ?? "（默认：沿用 DSH 全局）";
    const model = s.model ?? "（默认：DSH 内置默认模型）";
    const msg = `⚙️ 当前会话「${regName}」配置：
- 工作区: ${ws}
- 权限: ${perm}
- 模型: ${model}

设置方法：
/config workspace <路径>
/config permission <read-only|workspace-write|danger-full-access>
/config model <模型名>`;
    await bot.sendMessage({ to: from, text: msg, contextToken: ctxToken });
    return;
  }

  const m = argLine.match(/^(workspace|permission|model)\s+(.+)$/s);
  if (!m) {
    await bot.sendMessage({ to: from, text: "❌ 用法：/config workspace <路径> | /config permission <级别> | /config model <模型名>", contextToken: ctxToken });
    return;
  }
  const kind = m[1];
  const value = m[2].trim();

  // 仅 workspace(cwd) 需要 rotate 换新 session（DSH SessionHeader.cwd 不可变）。
  // model / permission 走「热切」：发指令帧给 resident，复用同一 session、不丢上下文。
  const rotateAfterChange = async () => {
    if (!state.residentPool) return;
    const ck = contactKeyFor(from);
    const { sessionId } = await resolveResidentSessionId(cfg, from, ck, regName);
    await state.residentPool.close(sessionId).catch(() => {});
    await rotateResidentSession(cfg, from, ck, regName);
  };
  const hotSwitch = async (frame) => {
    if (!state.residentPool) return;
    const ck = contactKeyFor(from);
    const { sessionId } = await resolveResidentSessionId(cfg, from, ck, regName);
    // 发指令帧（runner 热切，不 followup）；若 resident 尚未启动，下一条消息 spawn 时也会带上新配置。
    await state.residentPool.send(sessionId, frame).catch(() => {});
  };

  if (kind === "permission") {
    const p = value.toLowerCase();
    if (!PERMISSION_LEVELS.includes(p)) {
      await bot.sendMessage({ to: from, text: `❌ 权限级别必须是: ${PERMISSION_LEVELS.join(" / ")}（当前给的是「${value}」）`, contextToken: ctxToken });
      return;
    }
    await updateSessionConfig(cfg, from, contactKey, regName, { permission: p });
    await hotSwitch(`@permission ${p}`);
    const warn = p === "danger-full-access" ? "\n\n⚠️ 已授予完全访问权：DSH 将以你本机账号的完整权限执行，请仅在自己可控的前提下使用。" : "";
    await bot.sendMessage({ to: from, text: `✅ 已把会话「${regName}」的权限设为 ${p}，立即生效（对话记忆保留）。${warn}`, contextToken: ctxToken });
    return;
  }

  if (kind === "workspace") {
    if (value.length > 512) {
      await bot.sendMessage({ to: from, text: "❌ 工作区路径过长（上限 512 字符）", contextToken: ctxToken });
      return;
    }
    await updateSessionConfig(cfg, from, contactKey, regName, { workspace: value });
    await rotateAfterChange();
    await bot.sendMessage({ to: from, text: `✅ 已把会话「${regName}」的工作区设为 ${value}，下一条消息生效（工作区是会话固定属性，已切换到新的 DSH 会话）。`, contextToken: ctxToken });
    return;
  }

  if (kind === "model") {
    if (value.length > 80 || /[\r\n]/.test(value)) {
      await bot.sendMessage({ to: from, text: "❌ 模型名不合法（长度或含换行）", contextToken: ctxToken });
      return;
    }
    // 兼容 "provider/model" 拼接串：拆出 provider 与 model 分别存
    const slashParts = value.split("/");
    let providerPart;
    let modelPart = value;
    if (slashParts.length === 2 && !value.includes(" ") && slashParts.every((s) => s.length > 0)) {
      providerPart = slashParts[0];
      modelPart = slashParts[1];
    }
    const patch = { model: modelPart };
    if (providerPart) patch.provider = providerPart;
    await updateSessionConfig(cfg, from, contactKey, regName, patch);
    const frameModel = providerPart ? `${providerPart}/${modelPart}` : modelPart;
    await hotSwitch(`@model ${frameModel}`);
    const shown = providerPart ? `${providerPart}/${modelPart}` : modelPart;
    await bot.sendMessage({ to: from, text: `✅ 已把会话「${regName}」的模型设为 ${shown}，立即生效（对话记忆保留）。`, contextToken: ctxToken });
    return;
  }
}

async function processMessage(bot, cfg, files, state, msg) {
  const from = msg.from_user_id ?? "";
  const ctxToken = msg.context_token ?? state.contextTokens.get(from);
  if (ctxToken) state.contextTokens.set(from, ctxToken);

  if (state.allowFrom.length && !state.allowFrom.includes(from)) {
    log(`忽略未授权用户: ${from}`);
    return;
  }

  const text = extractText(msg);
  state.lastSender = from;
  state.lastSenderAt = Date.now();

  // ---- 内置指令 ----
  const cmd = text.trim().toLowerCase();
  if (cmd === "/help" || cmd === "/指令" || cmd === "help") {
    await bot.sendMessage({ to: from, text: COMMANDS_HELP, contextToken: ctxToken });
    return;
  }
  if (cmd === "/status" || cmd === "/status ") {
    const chatId = await resolveChatId(cfg, from, contactKeyFor(from));
    const h = await loadHistory(cfg, safeKey(chatId), chatId);
    const reg = await getRegistry(cfg, contactKeyFor(from));
    const s = await resolveSessionState(cfg, from, contactKeyFor(from), reg.current);
    const remaining = state.auth.loggedInAt + bot.sessionMs - Date.now();
    const text = `🤖 DSH 微信桥接
- 本地计时剩余: ${Math.max(0, Math.round(remaining / 360000) / 10)} 小时（实际有效性由腾讯服务器决定，失效时自动重扫续连）
- 当前会话: ${reg.current}（记忆 ${h.turns.length} 条）
- 工作区: ${s.workspace ?? "（默认）"}
- 权限: ${s.permission ?? "（默认）"}
- 模型: ${s.model ?? "DSH 内置默认模型"}`;
    await bot.sendMessage({ to: from, text, contextToken: ctxToken });
    return;
  }
  if (cmd === "/time") {
    const remaining = state.auth.loggedInAt + bot.sessionMs - Date.now();
    const mins = Math.max(0, Math.round(remaining / 60000));
    await bot.sendMessage({ to: from, text: `⏱ 本地计时剩余约 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟（实际由服务器决定，失效自动重扫）`, contextToken: ctxToken });
    return;
  }
  if (cmd === "/clear" || cmd.startsWith("/clear ")) {
    const arg = normalizeName(text.slice("/clear".length).trim());
    const ck = contactKeyFor(from);
    if (!arg) {
      const chatId = await resolveChatId(cfg, from, ck);
      await clearHistory(cfg, safeKey(chatId));
      if (state.residentPool) {
        const reg = await getRegistry(cfg, ck);
        const { sessionId } = await resolveResidentSessionId(cfg, from, ck, reg.current);
        await state.residentPool.close(sessionId).catch(() => {});
        await rotateResidentSession(cfg, from, ck, reg.current);
      }
      const reg = await getRegistry(cfg, ck);
      await bot.sendMessage({ to: from, text: `🧹 已清除会话「${reg.current}」的对话记忆（工作目录文件保留）`, contextToken: ctxToken });
      return;
    }
    const reg = await getRegistry(cfg, ck);
    const target = findSession(reg, arg);
    if (!target) {
      await bot.sendMessage({ to: from, text: `❌ 会话「${arg}」不存在（/sessions 查看列表）`, contextToken: ctxToken });
      return;
    }
    const targetChatId = chatIdFor(from, target.name);
    await clearHistory(cfg, safeKey(targetChatId));
    if (state.residentPool) {
      const { sessionId } = await resolveResidentSessionId(cfg, from, ck, target.name);
      await state.residentPool.close(sessionId).catch(() => {});
      await rotateResidentSession(cfg, from, ck, target.name);
    }
    await bot.sendMessage({ to: from, text: `🧹 已清除会话「${target.name}」的对话记忆（工作目录文件保留）`, contextToken: ctxToken });
    return;
  }
  if (cmd === "/reconnect") {
    await bot.sendMessage({ to: from, text: "🔁 正在重新连接，请留意运行终端（或稍后收到的新二维码链接）…", contextToken: ctxToken });
    state.reloginRequested = true;
    return;
  }
  if (cmd === "/sessions") {
    const infos = await listSessionInfos(cfg, from, contactKeyFor(from));
    const lines = infos.map((s) => `${s.isCurrent ? "👉" : "   "}${s.name}（${s.turns} 轮）${s.isCurrent ? " ← 当前" : ""}`);
    await bot.sendMessage({
      to: from,
      text: `你的会话列表:\n${lines.join("\n")}\n\n/new <名字> 新建并切换 | /switch <名字> 切换 | /clear [名字] 清除记忆`,
      contextToken: ctxToken,
    });
    return;
  }
  if (cmd === "/new" || cmd.startsWith("/new ")) {
    const name = normalizeName(text.slice("/new".length).trim());
    if (!name) {
      // 无参 /new：开一个全新匿名会话并切换，之后记忆与文件互不影响
      try {
        const { name: anon, chatId: anonChatId } = await createAnonymousSession(cfg, from, contactKeyFor(from));
        if (state.residentPool) {
          const ck = contactKeyFor(from);
          const { sessionId } = await resolveResidentSessionId(cfg, from, ck, anon);
          state.residentPool.warmUp(sessionId, {});
        }
        await bot.sendMessage({ to: from, text: `✅ 已开启新会话「${anon}」。之前的对话记忆与文件都保留在旧会话，这里从零开始。`, contextToken: ctxToken });
      } catch (e) {
        await bot.sendMessage({ to: from, text: `❌ ${e?.message ?? e}`.slice(0, 400), contextToken: ctxToken });
      }
      return;
    }
    if (!nameOk(name)) {
      await bot.sendMessage({ to: from, text: "❌ 会话名不合法：仅限中英文/数字/._-，1-20 字符", contextToken: ctxToken });
      return;
    }
    try {
      await createSession(cfg, from, contactKeyFor(from), name);
      if (state.residentPool) {
        const ck = contactKeyFor(from);
        const { sessionId } = await resolveResidentSessionId(cfg, from, ck, name);
        state.residentPool.warmUp(sessionId, {});
      }
      await bot.sendMessage({ to: from, text: `✅ 已新建会话「${name}」并切换过去。之后的对话记忆与文件都在这个会话里，互不影响。`, contextToken: ctxToken });
    } catch (e) {
      await bot.sendMessage({ to: from, text: `❌ ${e?.message ?? e}`.slice(0, 400), contextToken: ctxToken });
    }
    return;
  }
  if (cmd === "/config" || cmd.startsWith("/config ")) {
    await handleConfigCommand(bot, cfg, state, from, ctxToken, text);
    return;
  }
  if (cmd === "/switch" || cmd.startsWith("/switch ")) {
    const name = normalizeName(text.slice("/switch".length).trim());
    if (!name) {
      await bot.sendMessage({ to: from, text: "🔄 用法：/switch <名字>（/sessions 查看列表；/switch main 回默认会话）", contextToken: ctxToken });
      return;
    }
    try {
      const { chatId, name: realName } = await switchToSession(cfg, from, contactKeyFor(from), name);
      const h = await loadHistory(cfg, safeKey(chatId), chatId);
      // 后台预热该会话的 resident 进程，切过去第一条消息秒回
      if (state.residentPool) {
        const ck = contactKeyFor(from);
        const s = await resolveSessionState(cfg, from, ck, realName);
        const { sessionId } = await resolveResidentSessionId(cfg, from, ck, realName);
        state.residentPool.warmUp(sessionId, {
          workspace: s.workspace ? resolveWorkspaceDir(cfg, safeKey(chatId), s.workspace) : undefined,
          permission: s.permission,
          model: s.model,
          provider: s.provider,
        });
      }
      await bot.sendMessage({ to: from, text: `✅ 已切到会话「${realName}」（记忆 ${h.turns.length} 轮）。直接发消息即可继续。`, contextToken: ctxToken });
    } catch (e) {
      await bot.sendMessage({ to: from, text: `❌ ${e?.message ?? e}`.slice(0, 400), contextToken: ctxToken });
    }
    return;
  }
  if (cmd === "/send" || cmd.startsWith("/send ")) {
    await handleSendCommand(bot, cfg, state, from, ctxToken, text);
    return;
  }

  // ---- 媒体消息：下载 + AES 解密 + 落盘到该联系人的 media 目录 ----
  const mediaItems = (msg.item_list ?? []).filter((i) => [2, 3, 4, 5].includes(i.type));
  const savedMedia = mediaItems.length
    ? (
        await Promise.all(
          mediaItems.map((item) =>
            downloadMediaFromItem({ item, saveDir: path.join(cfg.dataDir, "media", safeKey(`wx:${from}`)), log: (m) => log(m) }),
          ),
        )
      ).filter(Boolean)
    : [];

  if (mediaItems.length && !text) {
    if (savedMedia.length) {
      const lines = savedMedia.map((s) => `- ${s.savedPath}（${s.kind}）`).join("\n");
      await bot.sendMessage({ to: from, text: `📥 已保存你发来的 ${savedMedia.length} 个文件到电脑：\n${lines}`, contextToken: ctxToken });
    } else {
      await bot.sendMessage({ to: from, text: "⚠️ 收到媒体消息但下载失败，请稍后再试。", contextToken: ctxToken });
    }
    return;
  }
  if (!text) return;

  // ---- 交给 DSH ----
  const contactKey = contactKeyFor(from);
  const chatId = await resolveChatId(cfg, from, contactKey);
  const reg = await getRegistry(cfg, contactKey);
  const sstate = await resolveSessionState(cfg, from, contactKey, reg.current);
  // 真·复用：resident 用带 epoch 的稳定 sessionId（/clear 时 +1 换新 session）
  const residentSessionId = state.residentPool
    ? (await resolveResidentSessionId(cfg, from, contactKey, reg.current)).sessionId
    : null;
  // resident 工作区：/config workspace 显式指定时才传（绝对/相对 cwd 解析）；
  // 缺省 null → resident 子进程继承桥的 cwd（= 运行目录 = DSH 的 workspaceRoot）。
  const residentWorkspace = state.residentPool && sstate.workspace
    ? resolveWorkspaceDir(cfg, safeKey(chatId), sstate.workspace)
    : null;
  const dshText = savedMedia.length
    ? `（用户刚发来 ${savedMedia.length} 个媒体文件，已保存到电脑：${savedMedia.map((s) => s.savedPath).join("；")}）\n${text}`
    : text;
  const typingTicket = await bot.getTypingTicket(from, ctxToken);
  if (typingTicket) await bot.sendTyping(from, typingTicket, 1);
  try {
    log(
      `DSH 开始处理: user=${mask(from)} chat=${chatId} mode=${state.residentPool ? "resident" : "headless"} workspace=${sstate.workspace ?? "(默认)"} permission=${sstate.permission ?? "(默认)"} model=${sstate.model ?? "(默认)"} text=${text.slice(0, 60)}…`,
    );
    let result;
    if (state.residentPool) {
      // 真·会话复用：常驻 DSH agent session，用带 epoch 的稳定 sessionId；
      // 同时把 /config 的 workspace/permission/model 透传给 resident 进程。
      const startedAt = Date.now();
      try {
        const r = await withLock(contactKey, () =>
          state.residentPool.send(residentSessionId, dshText, {
            workspace: residentWorkspace ?? undefined,
            permission: sstate.permission,
            model: sstate.model,
            provider: sstate.provider,
          }),
        );
        result = r.ok
          ? { ok: true, reply: r.reply || "(无文本回复)", durationMs: Date.now() - startedAt }
          : { ok: false, error: r.error, durationMs: Date.now() - startedAt };
      } catch (e) {
        // resident 不可用（profile 未就绪等）→ 回退 headless 历史注入
        log(`[resident] 回退 headless: ${e?.message ?? e}`);
        result = await withLock(contactKey, () =>
          runChat(cfg, {
            chatId,
            text: dshText,
            workspace: sstate.workspace,
            permission: sstate.permission,
            model: sstate.model,
          }),
        );
      }
    } else {
      result = await withLock(contactKey, () =>
        runChat(cfg, {
          chatId,
          text: dshText,
          workspace: sstate.workspace,
          permission: sstate.permission,
          model: sstate.model,
        }),
      );
    }
    const reply = result.ok ? result.reply : formatErrorForWechat(result.error, Math.min(state.replyMaxChars, 800));
    const segments = await sendChunked(bot, from, ctxToken, reply, state.replyMaxChars);
    log(`已回复 user=${mask(from)} len=${reply.length} 段=${segments} 用时=${result.durationMs ?? "-"}ms`);
  } catch (e) {
    log(`处理消息出错: ${e?.message ?? e}`);
    const em = e instanceof Error ? e.message : String(e ?? "");
    const msg = formatErrorForWechat(em, 500).replace(/^⚠️ DSH 任务失败：/, "⚠️ 处理出错：");
    await bot.sendMessage({ to: from, text: msg, contextToken: ctxToken }).catch(() => {});
  } finally {
    if (typingTicket) await bot.sendTyping(from, typingTicket, 2).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 续连
// ---------------------------------------------------------------------------

async function doRelogin(bot, cfg, files, state, reason) {
  log(`开始重新连接（原因: ${reason}）…`);
  const client = createIlinkClient({
    baseUrl: state.botOpts.baseUrl || DEFAULT_BASE_URL,
    channelVersion: state.botOpts.channelVersion,
    botAgent: state.botOpts.botAgent,
    log: (m) => log(m),
  });
  // 携带现有 token：让服务器认出这是同一连接的重连（否则旧绑定会触发 binded_redirect/快速过期）
  const qr = await client.getBotQrcode("3", state.auth?.token ? [state.auth.token] : []);
  console.log(`\n🔁 连接即将/已经过期，请重新扫码续连。\n📱 二维码链接: ${qr.qrcodeImgContent}\n`);
  await displayQr(qr.qrcodeImgContent);

  // 尽力把链接发给最近的联系人（token 失效时可能失败，仅作提示）
  if (state.lastSender) {
    const ctx = state.contextTokens.get(state.lastSender);
    await bot.sendMessage({ to: state.lastSender, text: `🔁 连接即将到期，请在手机微信打开此链接完成续连：\n${qr.qrcodeImgContent}`, contextToken: ctx }).catch(() => {});
  }

  let verifyCode;
  let scannedPrinted = false;
  const deadline = Date.now() + state.botOpts.qrTimeoutMs;
  while (Date.now() < deadline) {
    const st = await client.pollQrcodeStatus(qr.qrcode, verifyCode).catch(() => ({ status: "wait" }));

    if (st.status === "need_verifycode") {
      verifyCode = await readLine("🔢 输入手机微信显示的数字配对码：");
      continue;
    }
    if (st.status === "scaned") {
      if (!scannedPrinted) {
        console.log("\n✅ 已扫码，请在手机上确认…");
        scannedPrinted = true;
      }
    } else if (st.status === "scaned_but_redirect" && st.redirectHost) {
      console.log(`🔀 服务器要求切换节点: ${st.redirectHost}`);
      client.setBaseUrl(`https://${st.redirectHost}`);
    } else if (st.status === "verify_code_blocked") {
      console.log("⛔ 配对码多次错误，重新申请二维码…");
      verifyCode = undefined;
      const qr2 = await client.getBotQrcode("3", state.auth?.token ? [state.auth.token] : []);
      await displayQr(qr2.qrcodeImgContent);
      Object.assign(qr, qr2);
      scannedPrinted = false;
      continue;
    } else if (st.status === "confirmed" && st.botToken && st.botId) {
      state.auth = {
        token: st.botToken,
        baseUrl: st.baseUrl || DEFAULT_BASE_URL,
        botId: st.botId,
        userId: st.userId ?? state.auth.userId,
        channelVersion: state.botOpts.channelVersion,
        loggedInAt: Date.now(),
      };
      await saveAuth(files.authFile, state.auth);
      bot.setToken(st.botToken);
      bot.setBaseUrl(state.auth.baseUrl);
      state.reloginRequested = false;
      state.expiryWarned = false;
      log(`✅ 续连成功 botId=${st.botId}`);
      await bot.notifyStart().catch(() => {});
      if (state.lastSender) {
        await bot
          .sendMessage({ to: state.lastSender, text: "✅ 续连成功，继续使用即可。", contextToken: state.contextTokens.get(state.lastSender) })
          .catch(() => {});
      }
      return true;
    } else if (st.status === "binded_redirect") {
      // 官方语义：服务器确认当前连接仍然有效（"重连时沿用当前 token"）——取消重连，无需重新扫码
      state.auth.loggedInAt = Date.now(); // 本地会话计时刷新，避免立即再次触发
      await saveAuth(files.authFile, state.auth);
      state.reloginRequested = false;
      log(`✅ 服务器确认当前连接仍然有效（binded_redirect），沿用现有 token，无需重新扫码`);
      if (state.lastSender) {
        await bot
          .sendMessage({ to: state.lastSender, text: "✅ 你的连接仍然有效，无需重新扫码，继续使用即可。", contextToken: state.contextTokens.get(state.lastSender) })
          .catch(() => {});
      }
      return true;
    } else if (st.status === "expired") {
      console.log("二维码过期，重新申请…");
      const qr2 = await client.getBotQrcode("3", state.auth?.token ? [state.auth.token] : []);
      await displayQr(qr2.qrcodeImgContent);
      if (state.lastSender) {
        await bot.sendMessage({ to: state.lastSender, text: `🔁 新的续连链接：\n${qr2.qrcodeImgContent}`, contextToken: state.contextTokens.get(state.lastSender) }).catch(() => {});
      }
      Object.assign(qr, qr2);
      scannedPrinted = false;
      continue;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("续连等待超时");
  return false;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

async function doRun(botOpts, cfg, files) {
  let auth = await loadAuth(files.authFile);
  if (!auth) {
    console.error("❌ 尚未登录。请先运行: node weixin-bot.mjs login");
    process.exitCode = 1;
    return;
  }

  const client = createIlinkClient({
    baseUrl: auth.baseUrl || botOpts.baseUrl,
    token: auth.token,
    channelVersion: auth.channelVersion ?? botOpts.channelVersion,
    botAgent: botOpts.botAgent,
    log: (m) => log(m),
  });

  const state = {
    auth,
    botOpts,
    allowFrom: botOpts.allowFrom,
    replyMaxChars: botOpts.replyMaxChars,
    contextTokens: new Map(),
    typingTickets: new Map(),
    lastSender: auth.userId ?? null,
    lastSenderAt: 0,
    reloginRequested: false,
    expiryWarned: false,
    // 真·会话复用：常驻 DSH agent 进程池（默认启用；--headless 才回退纯 headless）
    residentPool: cfg.resident ? new ResidentPool(cfg) : null,
  };

  /** 包装 client，附带 botOpts 参数（供 processMessage 使用）。 */
  const bot = {
    sessionMs: botOpts.sessionMs,
    ...client,
    async getTypingTicket(userId, ctxToken) {
      if (botOpts.noTyping) return "";
      const cached = state.typingTickets.get(userId);
      if (cached && Date.now() - cached.at < 23 * 3600 * 1000) return cached.ticket;
      try {
        const { typingTicket } = await client.getConfig(userId, ctxToken);
        if (typingTicket) state.typingTickets.set(userId, { ticket: typingTicket, at: Date.now() });
        return typingTicket;
      } catch (e) {
        log(`getConfig 失败（忽略 typing）: ${e.message}`);
        return "";
      }
    },
    setToken: (t) => client.setToken(t),
    setBaseUrl: (u) => client.setBaseUrl(u),
  };

  log(`已加载凭证 botId=${auth.botId ?? "?"} baseUrl=${auth.baseUrl}`);
  await client.notifyStart().catch(() => {});

  let buf = await loadSyncBuf(files.syncBufFile);
  if (buf) log(`恢复消息游标（${buf.length} 字节）`);
  let longPollMs = LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  log("开始监听微信消息…（Ctrl+C 退出）");

  const abort = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n正在退出…");
    abort.abort();
  });

  // 测试钩子：DSH_WXBOT_MAX_MSGS=N 时处理 N 条消息后自动退出
  const maxMsgs = Number(process.env.DSH_WXBOT_MAX_MSGS ?? 0);
  let processedMsgs = 0;

  while (!abort.signal.aborted) {
    // 会话到期检查
    const age = Date.now() - state.auth.loggedInAt;
    if (age > botOpts.sessionMs - botOpts.reloginBeforeMs && !state.expiryWarned && age < botOpts.sessionMs) {
      state.expiryWarned = true;
      log(`⚠️ 连接将在 ${Math.round(botOpts.reloginBeforeMs / 60000)} 分钟后到期`);
      if (state.lastSender) {
        await client
          .sendMessage({
            to: state.lastSender,
            text: `⚠️ 与微信的连接预计 ${Math.round(botOpts.reloginBeforeMs / 60000)} 分钟后到期，现在无需操作；到期后我会自动生成新的续连二维码（也可随时发送 /reconnect 检查）`,
            contextToken: state.contextTokens.get(state.lastSender),
          })
          .catch(() => {});
      }
    }
    if (age >= botOpts.sessionMs || state.reloginRequested) {
      const ok = await doRelogin(bot, cfg, files, state, state.reloginRequested ? "用户请求" : "会话到期");
      if (ok) continue;
      log("续连失败，等待 5 分钟后重试…");
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
      state.expiryWarned = false;
      continue;
    }

    let resp;
    try {
      resp = await client.getUpdates(buf, longPollMs, abort.signal);
    } catch (e) {
      // 网络层错误（fetch 连接被中断/重置，常见于经代理长轮询被隧道重置）：
      // 长轮询本就该持续挂起，连接被重置时并未丢消息，应快速重试而非长退避。
      consecutiveFailures += 1;
      const backoffMs = Math.min(1_500 * Math.max(1, consecutiveFailures - 1), 15_000);
      log(`getUpdates 网络错误 (${consecutiveFailures}/6): ${e.message}（${backoffMs}ms 后重试）`);
      await new Promise((r) => setTimeout(r, backoffMs));
      if (consecutiveFailures >= 6) consecutiveFailures = 0;
      continue;
    }

    if (resp.ret !== 0 || (resp.errcode !== undefined && resp.errcode !== 0)) {
      if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
        log(`⚠️ token 已失效 (errcode=${resp.errcode ?? resp.ret})，开始续连…`);
        await doRelogin(bot, cfg, files, state, "token 失效");
        continue;
      }
      // 业务/API 层错误（服务端明确返回错误）仍按其严重度退避，避免打爆接口。
      consecutiveFailures += 1;
      const apiBackoffMs = consecutiveFailures >= 6 ? 30_000 : 2_000;
      log(`getUpdates 错误 ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/6)`);
      await new Promise((r) => setTimeout(r, apiBackoffMs));
      if (consecutiveFailures >= 6) consecutiveFailures = 0;
      continue;
    }

    consecutiveFailures = 0;
    if (resp.longpolling_timeout_ms > 0) longPollMs = resp.longpolling_timeout_ms;
    if (resp.get_updates_buf && resp.get_updates_buf !== buf) {
      buf = resp.get_updates_buf;
      await saveSyncBuf(files.syncBufFile, buf).catch(() => {});
    }

    for (const msg of resp.msgs ?? []) {
      if (msg.message_type !== 1) continue; // 只处理用户消息
      await processMessage(bot, cfg, files, state, msg).catch((e) => log(`消息处理异常: ${e.stack ?? e}`));
      if (maxMsgs > 0 && ++processedMsgs >= maxMsgs) {
        log(`测试钩子：已处理 ${processedMsgs} 条消息，退出`);
        abort.abort();
        break;
      }
    }
  }

  await client.notifyStop().catch(() => {});
  await state.residentPool?.destroy().catch(() => {});
  log("已退出");
}

// ---------------------------------------------------------------------------
// 历史查看（chats / history / sessions）
// ---------------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** DSH 用工作目录路径编码会话目录名：'--' + path(冒号删除、分隔符→'-') + '--'（与 DSH 存储插件实测一致） */
function sessionsDirForWorkspace(ws) {
  const encoded = "--" + ws.replace(/[\\/]/g, "-").replace(/:/g, "") + "--";
  return path.join(dshHome(), "sessions", encoded);
}

async function listChats(cfg) {
  const dir = path.join(cfg.dataDir, "history");
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const chats = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      const key = f.slice(0, -5);
      let sessionCount = 0;
      try {
        sessionCount = (await readdir(sessionsDirForWorkspace(path.join(cfg.dataDir, "workspaces", key)))).length;
      } catch {}
      chats.push({
        key,
        chatId: raw.chatId ?? "?",
        turns: Array.isArray(raw.turns) ? raw.turns.length : 0,
        updatedAt: raw.updatedAt ?? 0,
        sessionCount,
      });
    } catch {}
  }
  return chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function resolveChat(cfg, chatRef) {
  const chats = await listChats(cfg);
  if (!chatRef) return chats[0] ?? null;
  return (
    chats.find((c) => c.key === chatRef || c.chatId === chatRef || c.chatId === `wx:${chatRef}` || c.chatId.endsWith(chatRef)) ?? null
  );
}

async function cmdChats(cfg) {
  const chats = await listChats(cfg);
  if (!chats.length) {
    console.log("（暂无对话记录）");
    return;
  }
  console.log("微信对话列表（按最近活跃排序）:\n");
  for (const c of chats) {
    const time = c.updatedAt ? new Date(c.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "-";
    console.log(`  对话: ${c.chatId}`);
    console.log(`    记忆轮数: ${c.turns} | DSH 会话数: ${c.sessionCount} | 最近活跃: ${time}`);
    console.log(`    键: ${c.key}\n`);
  }
}

async function cmdHistory(cfg, chatRef, lastN) {
  const chat = await resolveChat(cfg, chatRef);
  if (!chat) {
    console.error(`未找到对话「${chatRef ?? ""}」（用 chats 命令查看列表）`);
    process.exitCode = 1;
    return;
  }
  const raw = JSON.parse(await readFile(path.join(cfg.dataDir, "history", `${chat.key}.json`), "utf8"));
  let turns = raw.turns ?? [];
  if (lastN > 0) turns = turns.slice(-lastN);
  console.log(`对话: ${chat.chatId}（共 ${raw.turns.length} 轮，显示 ${turns.length} 轮）`);
  for (const t of turns) {
    const who = t.role === "user" ? "🧑 微信" : "🤖 DSH";
    const time = t.ts ? new Date(t.ts).toLocaleString("zh-CN", { hour12: false }) : "-";
    console.log(`\n[${time}] ${who}`);
    console.log(t.text);
  }
  console.log("");
}

async function cmdSessions(cfg, chatRef) {
  const chat = await resolveChat(cfg, chatRef);
  if (!chat) {
    console.error(`未找到对话「${chatRef ?? ""}」（用 chats 命令查看列表）`);
    process.exitCode = 1;
    return;
  }
  const ws = path.join(cfg.dataDir, "workspaces", chat.key);
  const dir = sessionsDirForWorkspace(ws);
  console.log(`对话: ${chat.chatId}`);
  console.log(`工作目录: ${ws}`);
  console.log(`DSH 会话目录: ${dir}\n`);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    console.log("（无 DSH 会话记录）");
    return;
  }
  const rows = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      const logFile = path.join(full, "session.jsonl.zstd");
      let size = 0;
      try {
        size = (await stat(logFile)).size;
      } catch {}
      rows.push({ name, mtime: st.mtime, size });
    } catch {}
  }
  rows.sort((a, b) => a.mtime - b.mtime);
  console.log(`共 ${rows.length} 次 DSH 运行（每次 = 一条微信消息的完整 agent 轨迹）:\n`);
  for (const r of rows) {
    console.log(`  ${r.mtime.toLocaleString("zh-CN", { hour12: false })}  ${(r.size / 1024).toFixed(0)} KB  ${r.name}`);
  }
  console.log(`\n查看某次完整轨迹（含工具调用、中间过程）:`);
  console.log(`  zstd -d -c "${path.join(dir, "<会话名>", "session.jsonl.zstd")}" | more`);
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

async function main() {
  const { o } = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(HELP);
    return;
  }
  const cfg = buildConfig(o.values);
  const botOpts = buildBotOpts(o.values);
  const files = resolveFiles(botOpts, cfg);

  switch (o.command) {
    case "help":
      console.log(HELP);
      break;

    case "login": {
      const auth = await doLogin(botOpts, cfg, { files });
      if (auth) {
        await saveAuth(files.authFile, auth);
        console.log(`\n凭证已保存: ${files.authFile}`);
        console.log(`现在运行 node weixin-bot.mjs run 开始接微信消息。`);
      }
      break;
    }

    case "run":
      await doRun(botOpts, cfg, files);
      break;

    case "status": {
      const auth = await loadAuth(files.authFile);
      if (!auth) {
        console.log("尚未登录。运行: node weixin-bot.mjs login");
        break;
      }
      const age = Date.now() - auth.loggedInAt;
      const remain = Math.max(0, botOpts.sessionMs - age);
      console.log(JSON.stringify(
        {
          botId: auth.botId,
          baseUrl: auth.baseUrl,
          token: mask(auth.token, 8),
          loggedInAt: new Date(auth.loggedInAt).toISOString(),
          remainingHours: Math.round(remain / 360000) / 10,
          authFile: files.authFile,
        },
        null,
        2,
      ));
      break;
    }

    case "logout":
      await rm(files.authFile, { force: true });
      console.log(`已注销（凭证已删除: ${files.authFile}）。重新连接请运行 login。`);
      break;

    case "probe": {
      console.log("对腾讯 iLink 端点冒烟测试…");
      const client = createIlinkClient({
        baseUrl: botOpts.baseUrl,
        channelVersion: botOpts.channelVersion,
        botAgent: botOpts.botAgent,
        log: (m) => log(m),
      });
      const qr = await client.getBotQrcode();
      console.log(`✅ 二维码申请成功: id=${mask(qr.qrcode, 10)}`);
      console.log(`📱 链接: ${qr.qrcodeImgContent}`);
      const st = await client.pollQrcodeStatus(qr.qrcode);
      console.log(`✅ 首次状态轮询: ${st.status}（未扫码时预期 wait）`);
      console.log("冒烟测试通过 —— 端点、请求头、TLS 均正常。");
      break;
    }

    case "chats":
      await cmdChats(cfg);
      break;

    case "history":
      await cmdHistory(cfg, o.chatId, o.values.last ?? 0);
      break;

    case "sessions":
      await cmdSessions(cfg, o.chatId);
      break;

    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`错误: ${e?.message ?? e}`);
  process.exitCode = 1;
});
