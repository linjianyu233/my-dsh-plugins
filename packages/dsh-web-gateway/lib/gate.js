// lib/gate.js — 把 registry + proxy + spawn + idle 组装成一个常驻服务。
//
// `init`：拉起初始 active（若还没有）→ 启动网关 proxy（HTTP+WS）→ 返回。
// 对外提供 status() / openUpdate() 供 CLI 使用。

import { createGateway } from "./proxy.js";
import { Registry } from "./registry.js";
import { spawnBackend, allocPort, logDir } from "./spawn.js";
import { singleProbe, waitUntil } from "./prober.js";
import { openUpdate } from "./orchestrate.js";
import { createIdleMonitor } from "./idle.js";
import { Watchdog } from "./watchdog.js";
import { diagnoseLog } from "./doctor.js";
import { askFix } from "./ai.js";
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 控制端端口 = 网关端口 + 0x1000（仅 127.0.0.1）。 */
export function controlPort(gatewayPort) {
  return gatewayPort + 0x1000;
}

export class Gate {
  constructor({ gatewayPort = 8181, readyTimeoutMs = 45000 } = {}) {
    this.registry = new Registry();
    this.gatewayPort = gatewayPort;
    this.readyTimeoutMs = readyTimeoutMs;
    this.server = null;
    this.proxyCore = null;
    this.logs = [];
  }

  _log(msg) {
    this.logs.push({ t: new Date().toISOString(), msg });
    if (this.logs.length > 200) this.logs.shift();
    process.stdout.write(`[gateway] ${msg}\n`);
  }

  /** active 后端解析：registry.active() 有 port 才可达。 */
  _backend() {
    const a = this.registry.active();
    return a && a.port != null ? { port: a.port } : null;
  }

  /** 组装并监听网关 proxy（HTTP+WS）。 */
  _startProxy() {
    const self = this;
    const core = createGateway({
      getBackend: () => self._backend(),
      onError: (e) => self._log(`proxy upstream error: ${e.message}`),
    });
    this.proxyCore = core;
    const server = core.server;
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.gatewayPort, "127.0.0.1", () => {
        server.on("error", (e) => self._log(`gateway server error: ${e.message}`));
        resolve();
      });
    });
  }

  /**
   * 初始化：拉起初始 active（若还没有）并启动网关。
   * HA：gateway 自身重启后，若发现存量活的 dsh web 实例（孤儿），先纳管再服务，
   * 避免另起一个重复实例。
   */
  async init({ profile = "web", patches = [] } = {}) {
    this.profile = profile;
    this.patches = patches;
    if (!this.registry.active().port) {
      const adopted = await this._adoptExisting({ profile });
      if (!adopted) {
        await this._bootstrapActive({ profile, patches });
      }
    }
    await this._startProxy();
    // 可选 watchdog 自拉起：DSH_GATEWAY_WATCHDOG=1 启用
    if (process.env.DSH_GATEWAY_WATCHDOG === "1") {
      this.watchdog = new Watchdog(
        {
          registry: this.registry,
          proxy: this.proxyCore,
          capture: (m) => this._log(m),
        },
        { profile, patches, readyTimeoutMs: this.readyTimeoutMs }
      );
      this.watchdog.start();
      this._log("watchdog started (DSH_GATEWAY_WATCHDOG=1)");
    }
    return this;
  }

  /**
   * 重纳管存量 dsh web 实例（gateway 重启后孤儿 active）。
   * 扫描系统进程里的 `dsh --profile web`（排除 5100 GUI），
   * 挑一个还活着、HTTP 就绪的实例纳管为 active。
   * @returns {Promise<boolean>} 是否纳管成功
   */
  async _adoptExisting({ profile = "web" } = {}) {
    const { execFileSync } = await import("node:child_process");
    let lines;
    try {
      lines = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).split("\n");
    } catch {
      return false;
    }
    const candidates = [];
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const args = m[2];
      if (!args.includes("dsh") || !args.includes("--profile") || !args.includes(profile)) continue;
      if (/--port\s+5100/.test(args)) continue; // 绝不纳管 GUI 宿主
      const portM = args.match(/--port\s+(\d+)/);
      if (!portM) continue;
      const port = Number(portM[1]);
      candidates.push({ pid, port, args });
    }
    // 从监听端口反查最可信：只信真正 listen 且 probe 通过的
    for (const c of candidates) {
      const probe = await singleProbe({ pid: c.pid, port: c.port });
      if (!probe) continue;
      const slot = this.registry.claim("active");
      slot.pid = c.pid;
      slot.port = c.port;
      slot.child = { exitCode: null, signalCode: null, pid: c.pid, kill: (sig) => { try { process.kill(c.pid, sig); } catch {} } };
      this.registry.setState(slot, "ready");
      this._log(`adopted existing active pid=${c.pid} on :${c.port}`);
      return true;
    }
    return false;
  }

  async _bootstrapActive({ profile, patches }) {
    const slot = this.registry.claim("active");
    const port = await allocPort("127.0.0.1");
    const { child } = spawnBackend({ role: "active", port, patches, profile });
    slot.port = port;
    slot.child = child;
    slot.pid = child.pid;
    this.registry.setState(slot, "booting");
    this._log(`bootstrap active pid=${child.pid} on :${port}`);

    const ready = await waitUntil(() => singleProbe(slot), { timeoutMs: this.readyTimeoutMs });
    if (!ready.ok) {
      this._log(`bootstrap active NOT ready after ${ready.waitedMs}ms`);
      child.kill("SIGKILL");
      slot.child = null;
      this.registry.release("active");
      throw new Error(`active backend failed to become ready (see logs/)`);
    }
    this.registry.setState(slot, "ready");
    this._log(`active ready on :${port} after ${ready.waitedMs}ms`);
  }

  status() {
    const a = this.registry.active();
    const s = this.registry.staging();
    const fmt = (x) => (x && x.port != null ? { port: x.port, pid: x.pid, state: x.state, health: x.health } : null);
    return {
      gatewayPort: this.gatewayPort,
      active: fmt(a),
      staging: fmt(s),
      recentLogs: this.logs.slice(-10),
    };
  }

  async openUpdate({ patches = [], force = false, idleTimeoutMs = 15000 } = {}) {
    // 构造真正的「空闲谓词」：proxy.getInflight() 返回对象（恒真），不能直接当谓词用。
    // 用 createIdleMonitor 包装成「连续安静窗口」判定；orchestrate 端 waitIdle 轮询它。
    const isIdle = createIdleMonitor(
      () => {
        const { http, ws } = this.proxyCore.getInflight();
        return { http, ws };
      },
      { quietWindowMs: 1500 }
    );
    const result = await openUpdate(
      {
        registry: this.registry,
        proxy: this.proxyCore,
        isIdle,
        capture: (m) => this._log(m),
      },
      { patches, force, idleTimeoutMs, readyTimeoutMs: this.readyTimeoutMs }
    );
    // 仅在真正切流成功后短暂暂停 watchdog（新 active 已 ready，给个保守余量）；
    // staging 失败 / active-busy 未动 active，无需暂停。
    if (result.switched && this.watchdog) {
      this.watchdog.pause(15000);
      this._log("watchdog paused 15s after cutover");
    }
    return result;
  }

  /**
   * 取后端实例最近一个日志文件内容。默认角色 active；若 active 无日志/太老，
   * 回退到「最近修改的日志」（覆盖 staging 刚失败的场景）。
   */
  _latestBackendLog(role = "active") {
    const dir = logDir();
    try {
      const all = readdirSync(dir)
        .filter((f) => /^(active|staging)-.+\.log$/.test(f))
        .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (all.length === 0) return "";
      // 默认取「最新修改」的日志：staging 刚失败时应诊断 staging，
      // active 刚崩溃时应诊断 active。role 指定时才严格按角色取。
      const pick = role === "latest" ? all[0] : (all.find((x) => x.f.startsWith(role)) || all[0]);
      return readFileSync(join(dir, pick.f), "utf8").slice(-20000);
    } catch {
      return "";
    }
  }

  /**
   * Doctor：诊断最近一次启动/切换问题。
   * 1) 规则诊断（EADDRINUSE/patch/config 等高频模式）
   * 2) 未命中 => LLM 兜底（askFix），产出结构化修复建议
   * 返回 { diagnosis, ai? }。
   */
  async doctor() {
    const logText = this._latestBackendLog("latest");
    const diagnosis = diagnoseLog(logText, { profile: this.profile });
    const out = { diagnosis };
    if (diagnosis.verdict === "unknown" && logText) {
      const ai = await askFix(logText, { profile: this.profile });
      out.ai = ai;
    }
    return out;
  }

  /**
   * 控制端 JSON API（仅 127.0.0.1:<gatewayPort+0x1000>）。
   * 动作：
   *   {action:'status'}
   *   {action:'open-update', patches:[...], force:false}
   *   {action:'exit'}
   */
  startControlServer() {
    const self = this;
    this._exitPromise = new Promise((r) => (self._exitResolve = r));
    const ctrl = createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", async () => {
        let action = "status";
        let body = {};
        try {
          const msg = buf ? JSON.parse(buf) : {};
          action = msg.action || "status";
          body = msg;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad json" }));
          return;
        }
        res.setHeader("content-type", "application/json");
        try {
          if (action === "status") {
            res.end(JSON.stringify(self.status()));
          } else if (action === "open-update") {
            const out = await self.openUpdate({
              patches: body.patches || [],
              force: !!body.force,
            });
            res.end(JSON.stringify({ message: out.switched ? "switched" : `not-switched:${out.reason}`, ...self.status() }));
          } else if (action === "doctor") {
            const doc = await self.doctor();
            res.end(JSON.stringify(doc));
          } else if (action === "exit") {
            res.end(JSON.stringify({ message: "bye" }));
            self._log("control: exit requested");
            setImmediate(() => self._exitResolve && self._exitResolve());
          } else {
            res.end(JSON.stringify({ error: `unknown action ${action}` }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    return new Promise((resolve, reject) => {
      ctrl.once("error", reject);
      ctrl.listen(controlPort(this.gatewayPort), "127.0.0.1", () => {
        self.controlServer = ctrl;
        resolve(ctrl);
      });
    });
  }

  /** 让 CLI `up` 阻塞直到收到 exit。 */
  async readyToExit() {
    await this._exitPromise;
    await this.shutdown();
  }

  /** 关闭控制端、网关 proxy，并终止仍存活的后端子进程。 */
  async shutdown() {
    if (this.watchdog) this.watchdog.stop();
    for (const role of ["active", "staging"]) {
      const slot = role === "active" ? this.registry.active() : this.registry.staging();
      if (slot && slot.child && slot.child.exitCode === null && slot.child.signalCode === null) {
        try {
          slot.child.kill("SIGTERM");
        } catch {}
      }
    }
    if (this.controlServer) this.controlServer.close();
    if (this.proxyCore) this.proxyCore.server.close();
    this._log("shutdown complete");
  }
}
