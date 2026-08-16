// lib/gate.js — 把 registry + proxy + spawn + idle 组装成一个常驻服务。
//
// `init`：拉起初始 active（若还没有）→ 启动网关 proxy（HTTP+WS）→ 返回。
// 对外提供 status() / openUpdate() 供 CLI 使用。

import { createGateway } from "./proxy.js";
import { Registry } from "./registry.js";
import { spawnBackend, allocPort } from "./spawn.js";
import { singleProbe, waitUntil } from "./prober.js";
import { openUpdate } from "./orchestrate.js";
import { createIdleMonitor } from "./idle.js";
import { createServer } from "node:http";

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
   */
  async init({ profile = "web", patches = [] } = {}) {
    if (!this.registry.active().port) {
      await this._bootstrapActive({ profile, patches });
    }
    await this._startProxy();
    return this;
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
    return openUpdate(
      {
        registry: this.registry,
        proxy: this.proxyCore,
        isIdle,
        capture: (m) => this._log(m),
      },
      { patches, force, idleTimeoutMs, readyTimeoutMs: this.readyTimeoutMs }
    );
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
