// lib/idle.js — 判定 active 后端「无 in-flight turn / 空闲」。
//
// 决策点 D3 默认取「进程级空闲采样」：网关自已是唯一入口，所以代理层的
// in-flight http+ws 计数为 0 且持续一个静止窗口，即视为没有进行中的连接。
// 这满足「切流前等 active 空闲」的决策 #3 —— 零侵入，不依赖改 dsh profile。
//
// 注意：它衡量的是「没有经网关的活动连接」，对「单 tab 悬挂的 WS 长连接」，
// WS 连接存在即计为 in-flight（保守）；单 tab 刷开就绪时 WS 是有的，因此
// 本判据在「有常驻 tab」时可能永不空闲 —— 这正是「等空闲窗口」的语义：
// 适合在线用户聊完一轮、无活动连接时切换；有常驻 WS 时走 --force 或在响应
// 结束即非升级的空闲拉长窗口。这里同时允许 caller 传入 quietWindowMs 与
// maxWaitMs。

/** 采样式空闲采样器：只要某次采样 in-flight 全 0 且持续 quietWindow 即空闲。 */
export function createIdleMonitor(getInflight, { quietWindowMs = 1500, sampleMs = 100 } = {}) {
  let cleanStreakStart = null;
  return async function isIdleTick() {
    const { http, ws } = getInflight();
    if (http === 0 && ws === 0) {
      if (cleanStreakStart === null) cleanStreakStart = Date.now();
      return Date.now() - cleanStreakStart >= quietWindowMs;
    }
    cleanStreakStart = null;
    return false;
  };
}

/**
 * 轮询直到 active 空闲或超时。
 * @param {()=>Promise<boolean>} isIdle
 * @param {{intervalMs?:number, timeoutMs?:number}} opts
 */
export async function waitIdle(isIdle, { intervalMs = 150, timeoutMs = 15000 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await isIdle()) return { ok: true, waitedMs: Date.now() - start };
    if (Date.now() - start >= timeoutMs) return { ok: false, waitedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
