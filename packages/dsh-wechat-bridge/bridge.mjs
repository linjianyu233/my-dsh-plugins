#!/usr/bin/env node
/**
 * dsh-wechat-bridge —— 把 DSH（DeepSeek Harness）接到微信/OpenClaw 的桥接脚本（CLI + HTTP 壳）。
 * 核心逻辑在 lib/core.mjs；微信「龙虾」(ClawBot) 直连版见 weixin-bot.mjs。
 *
 * 用法:
 *   node bridge.mjs send --chat <id> --text "任务内容"
 *   node bridge.mjs serve [--port 8317] [--token xxx]
 */

import { createServer } from "node:http";
import {
  VERSION,
  MAX_TEXT_CHARS,
  buildConfig,
  runChat,
  loadHistory,
  clearHistory,
  safeKey,
  cleanChatId,
  log,
  withLock,
} from "./lib/core.mjs";

const MAX_BODY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

const HELP = `dsh-wechat-bridge —— DSH ⇄ 微信(OpenClaw/龙虾) 桥接脚本

用法:
  node bridge.mjs send --chat <id> --text "任务内容"    单发一条消息（带对话记忆）
  node bridge.mjs send "任务内容"                        聊天 ID 默认 "default"
  node bridge.mjs serve [--port 8317] [--token xxx]     启动 HTTP 桥接服务
  node bridge.mjs history --chat <id>                    查看某对话的记忆
  node bridge.mjs clear --chat <id>                      清除某对话的记忆
  node bridge.mjs test [--dry-run]                       端到端自检（跑一次极小任务）

直连微信龙虾(ClawBot)的方式: node weixin-bot.mjs login / run（见 README 快速开始）

常用选项:
  -c, --chat <id>              对话 ID（不同微信会话/群用不同 ID）
  -m, --text <文本>            要发给 DSH 的内容
      --dry-run                只打印将执行的命令与提示词，不真正调用 DSH
      --json                   send 结果以 JSON 输出
      --port <n>               HTTP 端口（默认 8317）
      --host <addr>            HTTP 绑定地址（默认 127.0.0.1，请勿随意改成 0.0.0.0）
      --token <secret>         要求调用方携带 token（建议启用）
      --data-dir <dir>         记忆与工作目录根（默认 <脚本目录>/data）
      --dsh-bin <cmd>          覆盖 dsh 命令（默认自动解析/使用 "dsh"）
      --timeout-ms <n>         单次 DSH 任务超时（默认 1800000 = 30 分钟）
      --max-turns <n>          注入提示词的记忆条数上限（默认 24）
      --max-history-chars <n>  注入提示词的记忆字符上限（默认 8000）

环境变量（等价于上面同名选项）:
  DSH_BRIDGE_DSH, DSH_BRIDGE_DATA_DIR, DSH_BRIDGE_HOST, DSH_BRIDGE_PORT,
  DSH_BRIDGE_TOKEN, DSH_BRIDGE_TIMEOUT_MS, DSH_BRIDGE_MAX_TURNS,
  DSH_BRIDGE_MAX_HISTORY_CHARS
`;

const COMMANDS = new Set(["send", "serve", "history", "clear", "test"]);

function parseArgs(argv) {
  const o = {
    command: null,
    help: false,
    chatId: null,
    text: null,
    json: false,
    dryRun: false,
    values: {},
  };
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
      case "--json":
        o.json = true;
        break;
      case "--dry-run":
        o.dryRun = true;
        break;
      case "-c":
      case "--chat":
        o.chatId = take(a);
        break;
      case "-m":
      case "--text":
        o.text = take(a);
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
      default:
        if (a.startsWith("-")) throw new Error(`未知参数: ${a}`);
        if (o.command === null && COMMANDS.has(a)) {
          o.command = a;
        } else {
          positional.push(a);
        }
    }
  }
  return { o, positional };
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function checkAuth(cfg, req, url) {
  if (!cfg.token) return true;
  const header = req.headers["authorization"] ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (bearer === cfg.token) return true;
  if (req.headers["x-dsh-bridge-token"] === cfg.token) return true;
  if (url.searchParams.get("token") === cfg.token) return true;
  return false;
}

async function serve(cfg) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      if (!checkAuth(cfg, req, url)) return json(res, 401, { ok: false, error: "未授权：token 缺失或错误" });
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /" || route === "GET /health") {
        return json(res, 200, { ok: true, service: "dsh-wechat-bridge", version: VERSION });
      }

      if (route === "GET /history") {
        const chatId = cleanChatId(url.searchParams.get("chatId") || "default");
        const key = safeKey(chatId);
        const h = await loadHistory(cfg, key, chatId);
        return json(res, 200, { ok: true, chatId, turns: h.turns });
      }

      if (route === "POST /clear") {
        const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || "{}");
        const chatId = cleanChatId(body.chatId || "default");
        await clearHistory(cfg, safeKey(chatId));
        return json(res, 200, { ok: true, chatId });
      }

      if (route === "POST /chat") {
        const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || "{}");
        if (body.token && body.token !== cfg.token) return json(res, 401, { ok: false, error: "未授权：token 错误" });
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return json(res, 400, { ok: false, error: "缺少 text 字段" });
        if (text.length > MAX_TEXT_CHARS) return json(res, 400, { ok: false, error: "text 过长" });
        const chatId = cleanChatId(body.chatId || "default");
        log(`收到消息 chat=${chatId} len=${text.length}${body.dryRun === true ? " (dry-run)" : ""}`);
        const result = await withLock(safeKey(chatId), () => runChat(cfg, { chatId, text, dryRun: body.dryRun === true }));
        if (!result.ok) {
          log(`任务失败 chat=${chatId}: ${result.error}`);
          return json(res, 500, result);
        }
        log(`回复完成 chat=${chatId} len=${result.reply?.length ?? "-"} 用时=${result.durationMs}ms`);
        return json(res, 200, result);
      }

      return json(res, 404, { ok: false, error: `未知路由: ${route}` });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  log(`桥接服务已启动: http://${cfg.host}:${cfg.port}  (token: ${cfg.token ? "已启用" : "未启用"})`);
  log(`示例: curl -X POST http://${cfg.host}:${cfg.port}/chat -H "Content-Type: application/json" -d "{\\"chatId\\":\\"wx-demo\\",\\"text\\":\\"你好\\"}"`);
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function printSendResult(o, r) {
  if (r.dryRun) {
    console.log(`【dry-run】将执行（shell=${r.shell}）:\n  ${r.command}\n\n工作目录: ${r.cwd}\n\n提示词内容:\n---\n${r.task}\n---`);
    return;
  }
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (r.ok) console.log(r.reply);
  else {
    console.error(`任务失败: ${r.error}`);
    process.exitCode = 1;
  }
}

async function main() {
  const { o, positional } = parseArgs(process.argv.slice(2));
  if (o.help || !o.command) {
    console.log(HELP);
    return;
  }
  const cfg = buildConfig(o.values);

  switch (o.command) {
    case "send": {
      const text = o.text ?? positional.join(" ").trim();
      if (!text) throw new Error("缺少消息内容（--text 或位置参数）");
      const chatId = o.chatId ?? "default";
      const r = await runChat(cfg, { chatId, text, dryRun: o.dryRun });
      printSendResult(o, r);
      break;
    }
    case "test": {
      const r = await runChat(cfg, { chatId: `bridge-test-${Date.now()}`, text: "请只回复两个字：收到", dryRun: o.dryRun });
      printSendResult(o, r);
      break;
    }
    case "history": {
      const chatId = cleanChatId(o.chatId || "default");
      const h = await loadHistory(cfg, safeKey(chatId), chatId);
      console.log(JSON.stringify(h, null, 2));
      break;
    }
    case "clear": {
      const chatId = cleanChatId(o.chatId || "default");
      await clearHistory(cfg, safeKey(chatId));
      console.log(`已清除对话「${chatId}」的记忆`);
      break;
    }
    case "serve":
      await serve(cfg);
      break;
    default:
      throw new Error(`未知命令: ${o.command}`);
  }
}

main().catch((e) => {
  console.error(`错误: ${e?.message ?? e}`);
  process.exitCode = 1;
});
