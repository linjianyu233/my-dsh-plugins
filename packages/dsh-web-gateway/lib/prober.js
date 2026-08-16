// lib/prober.js — 一个后端实例的健康检查。
//
// 组合探针（因为 dsh web 无内置 health 端点）：
//   1. 进程存活：process.kill(pid, 0) 不抛
//   2. TCP 可连：对 127.0.0.1:<port> 建连
//   3. HTTP 就绪：GET / 期望 2xx（SPA fallback 返回 index 即认为 web 已就绪）
// 对外暴露 ready() 与 singleProbe()。

import { connect } from "node:net";
import { request } from "node:http";

export function pidAlive(pid) {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM" ? true : false;
  }
}

function tcpProbe(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

function httpProbe(port, host = "127.0.0.1", timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = request(
      { host, port, path: "/", method: "GET", timeout: timeoutMs },
      (res) => {
        // 读到响应头即算可服务；SPA fallback 应 200
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * 对 pid+port 组合做一次探活。全通过返回 true。
 * @param {{pid?:number, port?:number}} backend
 */
export async function singleProbe(backend) {
  if (!backend || backend.port == null) return false;
  if (backend.pid != null && !pidAlive(backend.pid)) return false;
  if (!(await tcpProbe(backend.port))) return false;
  return await httpProbe(backend.port);
}

/**
 * 轮询直到 ready 或超时。
 * @param {function():Promise<boolean>} probe
 * @param {{intervalMs?:number, timeoutMs?:number, abort?:function():Promise<boolean>|boolean}} opts
 *   abort 返回 true 视为「提前失败」（如子进程已退出）。
 * @returns {Promise<{ok:boolean, waitedMs:number}>}
 */
export async function waitUntil(probe, { intervalMs = 400, timeoutMs = 30000, abort, onTick } = {}) {
  const start = Date.now();
  for (;;) {
    if (abort && (typeof abort === "function" ? await abort() : abort)) {
      return { ok: false, waitedMs: Date.now() - start, aborted: true };
    }
    if (await probe()) return { ok: true, waitedMs: Date.now() - start };
    if (typeof onTick === "function") onTick(Date.now() - start);
    if (Date.now() - start >= timeoutMs) return { ok: false, waitedMs: Date.now() - start };
    await sleep(intervalMs);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
