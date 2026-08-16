// lib/orchestrate.js — 蓝绿切换编排。
//
// open-update（滚动蓝绿）：
//   0. 校验 current active 存在且健康；
//   1. 拉起 staging（挑空闲端口，注入新 patch/插件）；
//   2. 轮询探活直到 staging ready（失败 → 销毁 staging，保留 active，回滚完成）；
//   3. 等 active 空闲（无 in-flight，D3/D5；---force 可跳过强制等待）；
//   4. 切流：代理上游 active→staging；
//   5. drain 旧 active（SIGTERM → 等待退出 → 超时 SIGKILL）；
//   6. 角色翻转：staging 成为 active，旧 active 槽位释放。
//
// 回滚：open-update 全程持有一份「上一代 active」引用；若任何一步失败，
// 确保 active 仍是旧实例，删掉 staging 即完成回滚。e2e 通过逐个断言确认。

import { spawnBackend, allocPort, logDir } from "./spawn.js";
import { singleProbe, waitUntil, sleep } from "./prober.js";
import { waitIdle } from "./idle.js";
import { HEALTH } from "./registry.js";

/** 等待子进程自然退出。 */
function waitExit(child, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** 向子进程发信号；返回是否已退出。 */
async function terminate(child, timeoutMs = 6000) {
  if (child.exitCode !== null) return true;
  child.kill("SIGTERM");
  if (await waitExit(child, timeoutMs)) return true;
  if (child.exitCode === null) child.kill("SIGKILL");
  await waitExit(child, 2000);
  return child.exitCode !== null;
}

/**
 * 执行一次蓝绿切换。
 * @param {object} deps — 运行时依赖
 * @param deps.registry Registry
 * @param deps.proxy 网关 proxy 对象（需有 setGetBackend / getInflight）
 * @param deps.isIdle 空闲谓词（gate.js 注入；缺省退化用 proxy.getInflight）
 * @param deps.capture 回调 (msg)=>void 记录日志
 * @param {object} opts
 * @param {string[]} opts.patches 新插件/覆盖的 --patch 路径
 * @param {boolean} [opts.force] 是否跳过「等 active 空闲」
 * @param {number} [opts.idleTimeoutMs]
 * @param {number} [opts.readyTimeoutMs]
 */
export async function openUpdate(deps, opts) {
  const { registry, proxy, isIdle, capture = () => {} } = deps;
  const {
    patches = [],
    force = false,
    idleTimeoutMs = 15000,
    readyTimeoutMs = 45000,
  } = opts;

  const active = registry.active();
  if (!active || active.port == null || !active.child) {
    throw new Error("open-update: no active backend to update from (run `gateway up` first)");
  }

  capture(`open-update: active on :${active.port} pid=${active.pid}`);
  capture(`  patches=${JSON.stringify(patches)} force=${force}`);

  // 1. 拉起 staging
  const staging = registry.claim("staging");
  staging.child = null;
  try {
    const port = await allocPort("127.0.0.1");
    const spawned = spawnBackend({ role: "staging", port, patches });
    staging.port = port;
    staging.child = spawned.child;
    staging.pid = spawned.child.pid;
    registry.setState(staging, "booting");
    capture(`open-update: staging spawned pid=${staging.pid} on :${port}`);
  } catch (e) {
    registry.release("staging");
    throw new Error(`open-update: failed to spawn staging: ${e.message}`);
  }

  // 2. 等 staging ready（子进程退出=提前失败，不必等满超时）
  const ready = await waitUntil(
    () => singleProbe(staging),
    {
      intervalMs: 400,
      timeoutMs: readyTimeoutMs,
      abort: () => staging.child.exitCode !== null || staging.child.signalCode !== null,
    }
  );
  if (!ready.ok) {
    capture(`open-update: staging not ready after ${ready.waitedMs}ms, rolling back`);
    await terminate(staging.child, 4000);
    registry.release("staging");
    return { switched: false, reason: "staging-failed" };
  }
  registry.setState(staging, "ready", HEALTH.OK);
  capture(`open-update: staging ready after ${ready.waitedMs}ms`);

  // 3. 等 active 空闲（D3/D5）。除非 --force。
  //    isIdle 是 gate.js 注入的「连续安静窗口」谓词；缺省回退到 proxy.getInflight
  //    的即时 0/0 判定（注意不能把 getInflight 本身当谓词——它返回对象恒真）。
  if (!force && (isIdle || proxy.getInflight)) {
    const idlePredicate = isIdle
      ? isIdle
      : async () => {
          const { http, ws } = proxy.getInflight();
          return http === 0 && ws === 0;
        };
    const idle = await waitIdle(idlePredicate, { timeoutMs: idleTimeoutMs });
    if (!idle.ok) {
      capture(`open-update: active not idle after ${idle.waitedMs}ms; ` +
        `(connections still present) — use --force to cut over anyway`);
      await terminate(staging.child, 4000);
      registry.release("staging");
      return { switched: false, reason: "active-busy" };
    }
    capture(`open-update: active idle after ${idle.waitedMs}ms`);
  }

  // 4. 切流：代理上游 → staging。为避免 promote 后 staging 槽位被清空，
  //    让 getBackend 动态读 registry.active()（角色翻转后自然指向新 active）。
  const oldPort = active.port;
  proxy.setGetBackend(() => {
    const a = registry.active();
    return a && a.port != null ? { port: a.port } : null;
  });
  registry.setState(staging, "active");
  capture(`open-update: cutover to :${staging.port}`);

  // 5. drain 旧 active（先释放 active 槽，再 terminate 进程；失败不阻断 promote）
  if (active.child) {
    await terminate(active.child, 6000);
  }
  registry.release("active");

  // 6. 角色翻转：staging -> active 槽
  const promoted = registry.promote();
  capture(`open-update: done, active now on :${promoted.port} (old :${oldPort} drained)`);

  return { switched: true, oldPort, newPort: promoted.port };
}
