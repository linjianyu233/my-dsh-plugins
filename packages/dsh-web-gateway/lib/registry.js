// lib/registry.js — active/staging 后端槽位状态机。
//
// 网关纳管最多 1 个 active + 0..1 个 staging。每个槽位持有该后端实例
// （spawn 出的 dsh web 子进程）的进程信息与健康状态。切换编排通过这里读写。

export const HEALTH = {
  DOWN: "down",
  DEGRADED: "degraded",
  OK: "ok",
};

const empty = () => ({
  role: null, // 'active' | 'staging' | null
  pid: null,
  port: null,
  health: HEALTH.DOWN,
  since: 0,
  state: "idle", // process-level: spawned/booting/ready/failed/stopped
  child: null, // ChildProcess ref (owned by spawn.js)
  error: null,
  meta: {}, // goal: staging 起始时间戳等
});

export class Registry {
  #active = empty();
  #staging = empty();

  slots() {
    return { active: this.#active, staging: this.#staging };
  }

  active() {
    return this.#active;
  }

  staging() {
    return this.#staging;
  }

  /** 占用一个空槽位，返回槽位对象。role 为 'active'|'staging'。 */
  claim(role) {
    const slot = role === "active" ? this.#active : role === "staging" ? this.#staging : null;
    if (!slot) throw new Error(`registry: bad role ${role}`);
    if (slot.pid !== null) throw new Error(`registry: ${role} slot already occupied (pid=${slot.pid})`);
    slot.role = role;
    slot.since = Date.now();
    slot.error = null;
    return slot;
  }

  /** 释放一个槽位（进程已终止）。 */
  release(role) {
    const slot = role === "active" ? this.#active : role === "staging" ? this.#staging : null;
    if (!slot) throw new Error(`registry: bad role ${role}`);
    const snapshot = { ...slot };
    Object.assign(slot, empty());
    slot.role = role;
    return snapshot;
  }

  /**
   * 把 staging 晋升为 active：切流已完成且旧 active 已 drain。
   * 拷贝 staging 槽位数据到 active 槽，然后清空 staging 槽。
   */
  promote() {
    const staging = this.#staging;
    if (staging.role !== "staging" || staging.pid == null)
      throw new Error("registry: promote requires an occupied staging slot");
    const active = this.#active;
    if (active.pid != null) throw new Error("registry: promote requires empty active slot");
    active.role = "active";
    active.pid = staging.pid;
    active.port = staging.port;
    active.health = staging.health;
    active.since = staging.since;
    active.state = staging.state;
    active.child = staging.child;
    active.error = staging.error;
    active.meta = staging.meta;
    Object.assign(staging, empty());
    staging.role = "staging";
    return active;
  }

  setState(slot, state, health = HEALTH.OK, extra = {}) {
    Object.assign(slot, { state, health, ...extra });
  }
}
