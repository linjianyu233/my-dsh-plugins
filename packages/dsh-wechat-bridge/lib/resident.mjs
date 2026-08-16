/**
 * lib/resident.mjs —— 常驻 DSH agent 进程池（真·会话复用）。
 *
 * 为每个 sessionId（= 微信联系人会话的稳定标识）维护一个常驻的
 * `dsh --profile resident --session-id <id>` 子进程：
 *   - 首次使用该 sessionId 时 spawn，之后复用同一子进程与其持久 session；
 *   - 子进程崩溃/退出后，下次调用自动重启（凭 sessionId resume 记忆）；
 *   - stdin 逐行喂用户消息，stdout 逐行读 JSON 回复帧。
 *
 * 依赖：已通过 `dsh plugin --profile resident add @linjianyu/dsh-bridge-runner`
 * 把 runner 插件 + resident profile 装入 DSH_HOME（默认 ~/.dsh）。若 profile 未就绪，
 * spawn 会失败并抛错——调用方（weixin-bot.mjs）据此回退到 lib/core.mjs 的 headless 路径。
 */

import { spawn } from "node:child_process";
import { resolveDsh, log } from "./core.mjs";

/** 一个 resident 子进程的唯一键：sessionId + 生效配置（work/permission/model/provider）。 */
function residentKey(sessionId, opts = {}) {
  return `${sessionId}|${opts.workspace ?? ""}|${opts.permission ?? ""}|${opts.model ?? ""}|${opts.provider ?? ""}`;
}

/**
 * 一个常驻 runner 子进程及其 stdin/stdout 缓冲。
 * 帧协议：stdout 每行一个 JSON {id, ok, reply|error}；id 单调递增，与请求一一对应。
 * @param {object} opts.workspace / permission / model / provider —— 经 CLI 透传给 runner。
 */
function spawnResident(dsh, sessionId, opts = {}) {
  const args = [...dsh.argsPrefix, "--profile", "resident", "--session-id", sessionId];
  if (opts.workspace) args.push("--workspace", opts.workspace);
  if (opts.permission) args.push("--permission", opts.permission);
  if (opts.model) args.push("--model", opts.model);
  if (opts.provider) args.push("--provider", opts.provider);
  // 关键：permission 必须在 spawn 时就注入 DSH_PERMISSION_MODE，
  // 因为 DSH 的 sandbox-policy 在插件树挂载时（进程启动瞬间）读取该 env，
  // 事后（runner 内部）再设 process.env 不会影响沙箱配置。
  const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  if (opts.permission) env.DSH_PERMISSION_MODE = opts.permission;
  const child = spawn(dsh.cmd, args, {
    shell: dsh.shell,
    // 继承 DSH_HOME：让 resident profile 用真实凭证与持久 session 目录
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state = {
    child,
    sessionId,
    seq: 0, // 下一个要写的请求 id
    // 已写入但尚未收到回复帧的请求，按 id 排队等待
    pending: new Map(),
    // 已收到的回复帧，按 id 暂存，供消费
    buffer: new Map(),
    // 未完整读出的行片段
    lineBuf: "",
    exited: false,
    exitCode: null,
    exitErr: null,
  };

  child.stdout.on("data", (chunk) => {
    state.lineBuf += chunk.toString("utf8");
    let idx;
    while ((idx = state.lineBuf.indexOf("\n")) >= 0) {
      const line = state.lineBuf.slice(0, idx).trim();
      state.lineBuf = state.lineBuf.slice(idx + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        log(`[resident] 忽略非 JSON 帧: ${line.slice(0, 100)}`);
        continue;
      }
      if (typeof frame.id === "number" && state.pending.has(frame.id)) {
        const waiter = state.pending.get(frame.id);
        state.pending.delete(frame.id);
        waiter.resolve(frame);
      }
    }
  });

  child.stderr.on("data", (d) => {
    const text = d.toString("utf8").trim();
    if (text) log(`[resident ${sessionId.slice(0, 12)}] ${text.slice(0, 300)}`);
  });

  const rejectAll = (err) => {
    for (const waiter of state.pending.values()) {
      waiter.resolve({ id: waiter.id, ok: false, error: err });
    }
    state.pending.clear();
  };

  child.on("error", (err) => {
    state.exited = true;
    state.exitErr = err;
    rejectAll(`resident 进程启动失败: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    rejectAll(`resident 进程退出 (code=${code}${signal ? ` signal=${signal}` : ""})`);
  });

  return state;
}

/**
 * 常驻进程池：sessionId -> resident 子进程。
 * 单进程内同一 sessionId 串行喂消息（await 上一帧后再写下一帧），天然免并发锁。
 */
export class ResidentPool {
  #cfg;
  #dshPromise;
  #residents = new Map();
  /** 关闭标志：destroy 后不再重启。 */
  #closed = false;

  constructor(cfg) {
    this.#cfg = cfg;
  }

  async #dsh() {
    if (!this.#dshPromise) this.#dshPromise = resolveDsh(this.#cfg);
    return this.#dshPromise;
  }

  /** 取（或重建）某 sessionId+config 的常驻子进程。config 变化时重启进程。 */
  async #resident(sessionId, opts = {}) {
    const key = residentKey(sessionId, opts);
    let r = this.#residents.get(key);
    if (r && !r.exited) return r;
    if (this.#closed) throw new Error("resident 池已关闭");
    const dsh = await this.#dsh();
    r = spawnResident(dsh, sessionId, opts);
    this.#residents.set(key, r);
    log(`[resident] 启动常驻进程 sessionId=${sessionId}${opts.workspace ? ` workspace=${opts.workspace}` : ""}${opts.permission ? ` permission=${opts.permission}` : ""}${opts.model ? ` model=${opts.model}` : ""}`);
    return r;
  }

  /**
   * 给某 sessionId 发一条用户消息，返回其最终回复。
   * @param {object} opts.workspace/permission/model/provider —— 该会话生效配置（/config 结果）。
   * @returns {Promise<{ok:boolean, reply?:string, error?:string}>}
   */
  async send(sessionId, text, opts = {}) {
    const r = await this.#resident(sessionId, opts);
    const id = ++r.seq;
    const promise = new Promise((resolvePromise) => {
      r.pending.set(id, { id, resolve: resolvePromise });
    });
    // 写消息（strip 掉换行，保证单行帧）
    const safeText = String(text).replace(/[\r\n]+/g, " ");
    r.child.stdin.write(safeText + "\n");
    const frame = await promise;
    if (frame.ok) {
      return { ok: true, reply: frame.reply ?? "" };
    }
    // 子进程出错：丢弃该 resident 以便下次重建
    this.#residents.delete(residentKey(sessionId, opts));
    return { ok: false, error: frame.error ?? "resident 返回错误" };
  }

  /** 主动关闭某会话的常驻进程（/clear 或 /new 切走时用）。 */
  async close(sessionId) {
    for (const [key, r] of this.#residents) {
      if (r.sessionId !== sessionId) continue;
      this.#residents.delete(key);
      if (!r.exited) {
        r.child.stdin.end();
        r.child.kill();
      }
    }
  }

  /**
   * 后台预热某会话的常驻进程（不阻塞、不发送消息）。
   * 在 /switch、/new 后调用，让切换后的第一条消息跳过 DSH 冷启动。
   * @returns {Promise<void>} 立即返回；预热在后台进行。
   */
  warmUp(sessionId, opts = {}) {
    this.#resident(sessionId, opts).catch((e) => {
      log(`[resident] 预热失败 sessionId=${sessionId}: ${e?.message ?? e}`);
    });
  }

  /** 关闭所有常驻进程。 */
  async destroy() {
    this.#closed = true;
    const all = [...this.#residents.values()];
    this.#residents.clear();
    for (const r of all) {
      if (!r.exited) {
        r.child.stdin.end();
        r.child.kill();
      }
    }
  }
}

/** 判断是否可用 resident 模式：profile 装入与否由 spawn 结果决定，这里仅透传开关。 */
export function residentEnabled(cfg) {
  return cfg.resident === true;
}
