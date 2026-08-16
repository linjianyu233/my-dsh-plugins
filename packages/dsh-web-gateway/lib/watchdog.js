// lib/watchdog.js — active 后端健康监控 + 自拉起（P2a）。
//
// 定时对 active 做 probe；连续失败 >= threshold 次触发「自拉起」：
//   1. 记录事件（防抖窗口内不再重复触发）；
//   2. drain 旧 active（如进程还活着）；
//   3. 以**相同配置**（profile + patches）重新拉起一个新 active；
//   4. 探活到 ready 后接回代理；失败则进入退避，等待下一轮重试。
// 避免崩溃循环：连续失败计数、指数退避。

import { allocPort, spawnBackend } from "./spawn.js";
import { singleProbe, waitUntil, sleep } from "./prober.js";

export class Watchdog {
  /**
   * @param {object} deps
   * @param deps.registry Registry
   * @param deps.proxy  网关 proxy 对象（setGetBackend 切换上游）
   * @param deps.capture (msg)=>void
   * @param {object} opts
   * @param {number} [opts.threshold=3] 连续失败次数
   * @param {number} [opts.intervalMs=2000] 探活间隔
   * @param {number} [opts.backoffMs=10000] 自拉起失败后的退避
   * @param {number} [opts.readyTimeoutMs=45000] 新后端 ready 超时
   */
  constructor(deps, opts = {}) {
    this.registry = deps.registry;
    this.proxy = deps.proxy;
    this.capture = deps.capture || (() => {});
    this.threshold = opts.threshold ?? 3;
    this.intervalMs = opts.intervalMs ?? 2000;
    this.backoffMs = opts.backoffMs ?? 10000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 45000;
    this.profile = opts.profile ?? "web";
    this.patches = opts.patches ?? [];
    this.failStreak = 0;
    this.lastRelaunchAt = 0;
    this.running = false;
    this.manualKillUntil = 0; // 手动切流/重启期间暂停监控
  }

  /** 暂停监控（如 open-update 进行中）。 */
  pause(ms) {
    this.manualKillUntil = Date.now() + ms;
  }

  /** tick 一次：检查 active，必要时自拉起。 */
  async tick() {
    const active = this.registry.active();
    if (!active || active.port == null) return; // 无 active 交给初始化/编排
    if (Date.now() < this.manualKillUntil) return;

    const ok = await singleProbe(active);
    if (ok) {
      this.failStreak = 0;
      return;
    }
    this.failStreak += 1;
    this.capture(`watchdog: probe #${this.failStreak}/${this.threshold} failed for active :${active.port}`);

    if (this.failStreak < this.threshold) return;

    // 达到阈值：触发自拉起（带防抖）
    const now = Date.now();
    if (now - this.lastRelaunchAt < this.backoffMs) {
      this.capture(`watchdog: relaunch debounced (backoff ${this.backoffMs}ms)`);
      return;
    }
    this.lastRelaunchAt = now;
    this.failStreak = 0;
    this.capture(`watchdog: THRESHOLD reached, relaunching active :${active.port} (pid=${active.pid})`);
    await this._relaunch(active);
  }

  /** 以相同配置换一个新的 active。 */
  async _relaunch(oldActive) {
    this.capture(`watchdog: relaunching active :${oldActive.port} (pid=${oldActive.pid})`);
    try {
      // 1. 释放旧 active 槽（进程可能已死；仍活着则 terminate）
      if (oldActive.child && oldActive.child.exitCode === null && oldActive.child.signalCode === null) {
        try { oldActive.child.kill("SIGTERM"); } catch {}
      }
      const oldPort = oldActive.port;
      this.registry.release("active");

      // 2. 拉起新 active（相同 profile+patches）
      const slot = this.registry.claim("active");
      const port = await allocPort("127.0.0.1");
      const { child } = spawnBackend({ role: "active", port, patches: this.patches, profile: this.profile });
      slot.port = port;
      slot.child = child;
      slot.pid = child.pid;
      this.registry.setState(slot, "booting");

      // 3. 探活 ready；期间代理无 active（返回 502），直到 ready 接回
      const ready = await waitUntil(() => singleProbe(slot), {
        intervalMs: 400,
        timeoutMs: this.readyTimeoutMs,
        abort: () => child.exitCode !== null || child.signalCode !== null,
      });
      if (!ready.ok) {
        this.capture(`watchdog: relaunch NOT ready after ${ready.waitedMs}ms (child exit=${child.exitCode}); will backoff`);
        try { child.kill("SIGKILL"); } catch {}
        this.registry.release("active");
        return;
      }
      this.registry.setState(slot, "ready");
      // 4. 接回代理
      this.proxy.setGetBackend(() => {
        const a = this.registry.active();
        return a && a.port != null ? { port: a.port } : null;
      });
      this.capture(`watchdog: relaunched active on :${port} (old :${oldPort} replaced)`);
    } catch (e) {
      this.capture(`watchdog: relaunch error: ${e.message}`);
    }
  }

  /** 启动循环（不 await——由调用方决定何时停止）。 */
  start() {
    if (this.running) return;
    this.running = true;
    this._loop = (async () => {
      while (this.running) {
        try {
          await this.tick();
        } catch (e) {
          this.capture(`watchdog: tick error: ${e.message}`);
        }
        await sleep(this.intervalMs);
      }
    })();
    return this;
  }

  stop() {
    this.running = false;
  }
}