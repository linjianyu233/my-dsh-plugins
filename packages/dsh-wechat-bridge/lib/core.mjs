/**
 * dsh-wechat-bridge 核心库：DSH headless 调用 + 会话记忆。
 * 被 bridge.mjs（CLI/HTTP 桥接）与 gateway.mjs（OpenClaw 协议兼容网关）共用。
 * 零依赖，Node 18+。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const VERSION = "1.3.1";
export const MAX_TEXT_CHARS = 32000;

/**
 * 默认数据目录（凭证/记忆/registry）：固定用户级 ~/.dsh/dsh-wechat-bridge，
 * 与 DSH 把凭证/会话固定放 ~/.dsh 一致——换目录运行、或用全局命令都不丢登录。
 * 注意：这跟「工作区」不同，工作区(cwd)在 buildConfig 之外由 workspaceDir 决定。
 */
export function defaultDataDir() {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  return path.join(home, "dsh-wechat-bridge");
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export function buildConfig(values = {}) {
  return {
    dshBin: values.dshBin ?? process.env.DSH_BRIDGE_DSH ?? null,
    dataDir: values.dataDir ?? process.env.DSH_BRIDGE_DATA_DIR ?? defaultDataDir(),
    host: values.host ?? process.env.DSH_BRIDGE_HOST ?? "127.0.0.1",
    port: values.port ?? Number(process.env.DSH_BRIDGE_PORT ?? 8317),
    token: values.token ?? process.env.DSH_BRIDGE_TOKEN ?? null,
    timeoutMs: values.timeoutMs ?? Number(process.env.DSH_BRIDGE_TIMEOUT_MS ?? 30 * 60 * 1000),
    maxTurns: values.maxTurns ?? Number(process.env.DSH_BRIDGE_MAX_TURNS ?? 24),
    maxHistoryChars: values.maxHistoryChars ?? Number(process.env.DSH_BRIDGE_MAX_HISTORY_CHARS ?? 8000),
    // 真·会话复用：为每个会话维护常驻 dsh resident 进程。
    // 默认启用（DSH_BRIDGE_RESIDENT=0 才回退纯 headless 路径）。
    resident: values.resident ?? process.env.DSH_BRIDGE_RESIDENT !== "0",
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
export const safeKey = (chatId) => createHash("sha1").update(String(chatId)).digest("hex").slice(0, 16);

/**
 * 把 dsh 子进程的失败输出整理成可读摘要（发给微信/日志用）。
 * Node 崩溃时 stderr 末尾常是 `} | } | Node.js v22.23.2` 这类栈尾/对象转储，
 * 只取最后三行对用户毫无信息量；这里优先提取真正的错误标题
 * （Error: / Cannot… / MISSING_CREDENTIAL 等首条问题行）与退出码，再附末尾几行佐证。
 * @param {string} stderrText 原始 stderr（可含 ANSI 颜色码）
 * @param {number|string} code 子进程退出码
 * @returns {string} 一行的可读摘要
 */
export function summarizeDshFailure(stderrText, code) {
  const errStrip = stripAnsi(String(stderrText ?? "")).trim();
  const lines = errStrip.split("\n").filter(Boolean).map((l) => l.trim()).filter(Boolean);
  const headRe = /^(Error|TypeError|ReferenceError|SyntaxError|RangeError|AggregateError|URIError|AssertionError|Uncaught|Cannot find|Failed|ENOENT|EACCES|EPERM|EROFS|MISSING_CREDENTIAL|NO_ADAPTER|fetch failed|任务超时|已取消)/i;
  const causeRe = /Cannot find (module|the native)|failed to load|missing native|not found|no api key|no adapter|is not valid json|unexpected token/i;
  const notFrame = (l) => !/^(at\s|\^|node:|file:|internal\/)/.test(l) && !/^Node\.js v\d/.test(l) && l !== "{";
  const head = lines.find((l) => headRe.test(l)) ?? lines.find((l) => notFrame(l) && /[ :]/.test(l) && !/^[\]}],?$/.test(l)) ?? lines[0] ?? "";
  const cause = lines.find((l) => l !== head && causeRe.test(l)) ?? "";
  const tailLines = lines.slice(-3);
  const bits = [
    (head || cause || "").slice(0, 400),
    cause ? `深层原因：${cause.slice(0, 300)}` : "",
    `退出码 ${code}`,
    tailLines.length ? `末尾：${tailLines.join(" | ")}` : "",
  ].filter(Boolean).join("；");
  return bits || `退出码 ${code}`;
}

export const cleanChatId = (chatId) => String(chatId).replace(/[\r\n\t]/g, " ").slice(0, 64);
export const tail = (s, n = 400) => (s.length > n ? "…" + s.slice(-n) : s);
export const log = (...a) => process.stderr.write(`[bridge ${new Date().toISOString()}] ${a.join(" ")}\n`);

const locks = new Map(); // 每个对话一把锁，串行执行避免工作目录互相踩踏
export function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

// ---------------------------------------------------------------------------
// DSH 命令解析（Windows 上绕过 shell，直接 node 跑 bin.js）
// ---------------------------------------------------------------------------

let dshResolved = null;

export async function resolveDsh(cfg) {
  if (dshResolved) return dshResolved;
  if (process.platform === "win32" && !cfg.dshBin) {
    // npm 全局安装会在 %APPDATA%\npm\dsh.cmd 留下 shim，
    // 内容形如: node "...\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
    const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null;
    const shim = npmDir ? path.join(npmDir, "dsh.cmd") : null;
    if (shim && existsSync(shim)) {
      const text = await readFile(shim, "utf8");
      const m = text.match(/node_modules\\[^"\s]+/);
      if (m) {
        const entry = path.join(npmDir, m[0]);
        if (existsSync(entry)) {
          dshResolved = { cmd: process.execPath, argsPrefix: [entry], shell: false };
          return dshResolved;
        }
      }
    }
    // 找不到 shim 时退回 shell 调用（此时消息会经 cmd 传递，建议显式给出 --dsh-bin）
    dshResolved = { cmd: cfg.dshBin ?? "dsh", argsPrefix: [], shell: true };
    return dshResolved;
  }
  dshResolved = { cmd: cfg.dshBin ?? "dsh", argsPrefix: [], shell: false };
  return dshResolved;
}

// ---------------------------------------------------------------------------
// 记忆（对话历史）
// ---------------------------------------------------------------------------

export function historyFile(cfg, key) {
  return path.join(cfg.dataDir, "history", `${key}.json`);
}

export function workspaceDir(cfg, key) {
  // 缺省工作区 = 运行命令时的 cwd（与 DSH 的 workspaceRoot: process.cwd() 一致）；
  // 保留 key 派生目录作为显式落点之一，但默认用 cwd。
  return process.cwd();
}

/** 解析最终工作目录：workspace 覆盖为准（绝对路径直接用；相对路径相对 cwd），否则用 cwd。 */
export function resolveWorkspaceDir(cfg, key, workspace) {
  if (typeof workspace === "string" && workspace.trim()) {
    const ws = workspace.trim();
    return path.isAbsolute(ws) ? ws : path.resolve(process.cwd(), ws);
  }
  return workspaceDir(cfg, key);
}

export async function ensureWorkspace(cfg, key, workspace) {
  const dir = resolveWorkspaceDir(cfg, key, workspace);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function loadHistory(cfg, key, chatId) {
  try {
    const raw = JSON.parse(await readFile(historyFile(cfg, key), "utf8"));
    if (!Array.isArray(raw.turns)) throw new Error("bad shape");
    return { chatId: raw.chatId ?? chatId, turns: raw.turns };
  } catch {
    return { chatId, turns: [] };
  }
}

export async function saveHistory(cfg, key, history) {
  await mkdir(path.dirname(historyFile(cfg, key)), { recursive: true });
  await writeFile(historyFile(cfg, key), JSON.stringify({ ...history, updatedAt: Date.now() }, null, 2), "utf8");
}

export async function clearHistory(cfg, key) {
  await rm(historyFile(cfg, key), { force: true });
}

/** 按条数与字符数双重上限裁剪记忆，但永远保留最近两条（最后一条用户消息）。 */
export function pruneHistory(cfg, history) {
  let turns = history.turns;
  if (turns.length > cfg.maxTurns) turns = turns.slice(-cfg.maxTurns);
  let total = turns.reduce((s, t) => s + t.text.length, 0);
  let start = 0;
  while (total > cfg.maxHistoryChars && turns.length - start > 2) {
    total -= turns[start].text.length;
    start++;
  }
  history.turns = turns.slice(start);
}

/** 把历史拼进任务，让一次性的 headless 会话看起来像在延续对话。 */
export function buildTask(chatId, history) {
  const turns = history.turns;
  if (turns.length <= 1) return turns[0].text;
  const lines = [
    `【桥接上下文】以下是微信对话「${chatId}」的最近记录（从旧到新）。你正在通过桥接持续服务这个用户；你的工作目录为该对话单独保留，之前轮次创建的文件仍然存在。`,
    "",
  ];
  for (const t of turns) {
    const who = t.role === "user" ? "[用户]" : "[助手]";
    lines.push(`${who} ${t.text}`);
  }
  lines.push("", "请以助手的身份直接回复上面最后一条 [用户] 消息，继续你们的对话。");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 模型 patch overlay（覆盖 DSH headless 的 agent-default-model）
// ---------------------------------------------------------------------------

const patchCache = new Map(); // "provider|model" -> patch 文件绝对路径

/**
 * 生成（并缓存）一个 --patch yml 覆盖 agent-default-model。
 * 返回文件绝对路径；model/provider 为 null/空时返回 null（不注入 patch）。
 */
export async function modelPatchFile(cfg, provider, model) {
  const m = String(model ?? "").trim();
  if (!m) return null;
  const p = String(provider ?? "deepseek-official").trim() || "deepseek-official";
  const cacheKey = `${p}|${m}`;
  const hit = patchCache.get(cacheKey);
  if (hit) return hit;
  const dir = path.join(cfg.dataDir, "patches");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeKey(cacheKey)}-model.yml`);
  const yaml = `- id: agent-default-model\n  config:\n    provider: ${p}\n    model: ${m}\n`;
  await writeFile(file, yaml, "utf8");
  patchCache.set(cacheKey, file);
  return file;
}

// ---------------------------------------------------------------------------
// DSH 子进程
// ---------------------------------------------------------------------------

export function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false }).on("error", () => {});
    } else if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

/**
 * 运行一次 dsh headless。可选 onProgress(events) 回调用于网关向客户端推送过程事件。
 * 事件: {type:"start"|"log"|"exit", data}
 * opts.permission: DSH_PERMISSION_MODE 三档之一，缺省不注入（用 DSH 环境默认）。
 * opts.patchFile: --patch 覆盖文件（模型 overlay），缺省不注入。
 */
export function spawnDsh(dsh, task, cwd, timeoutMs, { signal, onProgress, permission, patchFile } = {}) {
  return new Promise((resolve) => {
    // 测试模式：不真正启动 DSH，回显任务。由环境变量 DSH_BRIDGE_MOCK_DSH=1 启用。
    if (process.env.DSH_BRIDGE_MOCK_DSH === "1") {
      onProgress?.({ type: "start", pid: 0, cmd: "mock-dsh", args: [] });
      setTimeout(() => {
        onProgress?.({ type: "exit", code: 0, error: null });
        resolve({ ok: true, stdout: `[mock-dsh] 收到任务: ${task.slice(0, 120)}${task.length > 120 ? "…" : ""}` });
      }, 50);
      return;
    }
    const args = [...dsh.argsPrefix, "--profile", "headless"];
    if (patchFile) args.push("--patch", patchFile);
    args.push(task);
    const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
    if (typeof permission === "string" && permission.trim()) env.DSH_PERMISSION_MODE = permission.trim();
    const child = spawn(dsh.cmd, args, {
      cwd,
      shell: dsh.shell,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, error: `任务超时（${timeoutMs} ms，已终止）`, stderrTail: tail(stripAnsi(stderr)) });
    }, timeoutMs);
    onProgress?.({ type: "start", pid: child.pid, cmd: dsh.cmd, args });
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => {
      const text = d.toString("utf8");
      stderr += text;
      onProgress?.({ type: "log", stream: "stderr", text });
    });
    child.on("error", (err) => {
      onProgress?.({ type: "log", stream: "stderr", text: `无法启动 dsh: ${err.message}\n` });
      finish({ ok: false, error: `无法启动 dsh: ${err.message}` });
    });
    child.on("exit", (code) => {
      const out = stripAnsi(stdout);
      const err = stripAnsi(stderr);
      onProgress?.({ type: "exit", code, error: code !== 0 ? err : null });
      if (code === 0) {
        finish({ ok: true, stdout: out });
      } else {
        const detail = summarizeDshFailure(stderr, code);
        finish({ ok: false, error: detail, exitCode: code, stderrTail: tail(stripAnsi(stderr), 800) });
      }
    });
    if (signal) {
      signal.addEventListener("abort", () => {
        killTree(child);
        finish({ ok: false, error: "已取消" });
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 核心：跑一次带记忆的 DSH 对话
// ---------------------------------------------------------------------------

/**
 * @param {object} opts.workspace  自定义工作目录（绝对或相对 data/workspaces）；缺省按 chatId 派生
 * @param {object} opts.permission DSH 权限级别（read-only/workspace-write/danger-full-access）；缺省不注入
 * @param {object} opts.provider   模型 provider（配合 model 使用）
 * @param {object} opts.model      模型名（如 deepseek-v4-pro）；缺省用 DSH 默认
 * @returns {Promise<object>} 成功: {ok:true, chatId, reply, durationMs}
 *                            失败: {ok:false, chatId, error, exitCode, durationMs}
 *                            dryRun: {ok:true, dryRun:true, chatId, task, command, cwd}
 */
export async function runChat(cfg, { chatId, text, workspace, permission, provider, model, dryRun = false, signal, onProgress } = {}) {
  const cid = cleanChatId(chatId || "default");
  const key = safeKey(cid);
  const history = await loadHistory(cfg, key, cid);
  history.turns.push({ role: "user", text, ts: Date.now() });
  pruneHistory(cfg, history);
  const task = buildTask(cid, history);
  const cwd = await ensureWorkspace(cfg, key, workspace);
  const patchFile = model ? await modelPatchFile(cfg, provider, model) : null;

  if (dryRun) {
    const dsh = await resolveDsh(cfg);
    const args = [...dsh.argsPrefix, "--profile", "headless"];
    if (patchFile) args.push("--patch", patchFile);
    args.push(task);
    return {
      ok: true,
      dryRun: true,
      chatId: cid,
      task,
      command: [dsh.cmd, ...args].join(" "),
      cwd,
      shell: dsh.shell,
      permission,
      model,
      patchFile,
    };
  }

  const dsh = await resolveDsh(cfg);
  const startedAt = Date.now();
  const result = await spawnDsh(dsh, task, cwd, cfg.timeoutMs, { signal, onProgress, permission, patchFile });
  const durationMs = Date.now() - startedAt;

  if (result.ok) {
    const reply = result.stdout.trim() || "(无文本回复)";
    history.turns.push({ role: "assistant", text: reply, ts: Date.now() });
    await saveHistory(cfg, key, history);
    return { ok: true, chatId: cid, reply, exitCode: 0, durationMs };
  }
  return {
    ok: false,
    chatId: cid,
    error: result.error,
    exitCode: result.exitCode ?? null,
    durationMs,
  };
}
