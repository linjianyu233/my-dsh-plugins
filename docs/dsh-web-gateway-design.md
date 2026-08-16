# dsh web gateway / 监督器 设计文档

> 目标：在**服务器部署、浏览器在别处**的拓扑下，为 `dsh web` 提供「蓝绿 + 稳定地址 + 端口切换 + doctor 自愈」，让插件变更/崩溃重拉时**新访问者（或刷新后的已打开页面）无感知**。
>
> 明确边界：**不做**浏览器客户端「断线自愈」（已打开的 tab 断连后需手动刷新一次），这是有意的范围裁剪。

---

## 0. 前提事实（已对 DSH 源码核实）

以下结论决定方案可行性，先写死。

| 项 | 结论 | 依据 |
|---|---|---|
| `dsh web` 运行模型 | 一个 **node 进程**跑 `web` profile（cordis 组合树），进程内既有 host/agent 侧，也有一个 HTTP server | `dsh` CLI → `runProfile` → `@deepseek-ai/dsh-host-webserver` |
| 会话持久化 | **进程外共享**：`dsh-session-persistence-jsonl`（`$DSH_HOME/...` 下按 session id 的 JSONL 文件，可配 sqlite）。**换新进程后可用同一 id 打开/续读同一会话** | `dsh-session-persistence-jsonl/lib/index.js` |
| 关键约束 | **正在进行的 live turn 是进程内存态**。旧进程被杀时未 checkpoint 的尾部可能撕裂（"torn tail"），新进程打开该会话会 truncate 到最近完整前缀 | `dsh-session-persistence` 的 `truncate any torn tail (NOT the open turn)` 逻辑 |
| 监听端口 | `dsh-host-webserver` 用 `node:http.createServer`，`[Service.init]` 里 `listen(port, host)`；绑定失败（如 EADDRINUSE）= **failed fiber = fail-loud 终止进程** | `dsh-host-webserver/lib/index.js` |
| 健康检查端点 | **没有内置 health/ping 端点**。但 SPA fallback（`frontend-static`）会对任意未匹配路径返回 index；进程健康时 `GET /` 应 200 | `dsh-web-app/lib/index.js` + `dsh-host-webserver` 的 registerFallback |
| HMR vs 重启 | 改 `cordis.patch.yml` / home patch 的**配置行** = 同进程 HMR（`watchUserPatches` → `entry.update()`），**不需要重启**；改**插件代码 / externals / decline HMR 的条目**才必须重启进程 | `dsh-app-boot` 的 `watchUserPatches` + `cordis-plugin-hmr` |
| 浏览器↔agent 传输 | **WebSocket upgrade**（非 SSE）：`dsh-client-connection` 在 `/api` 前缀注册 RPC + upgrade 事件流（`dsh-host-apiproxy` + `dsh-client-connection`），浏览器经 WebSocket 与后端通信 | `dsh-client-connection/lib/index.js` 的 `Upgrade` carrier |
| 主机信任围栏 | `--trusted-host` 是 `/api` 浏览器信任名单；gateway 从 `127.0.0.1` 转发时后端视角是 loopback，天然通过围栏。但**浏览器 Origin 是网关域名**，需确认围栏按 Host/Origin 判定不误伤转发后的 /api WS | `dsh-client-connection` 的 `api-request-trust` |

**可行性结论**：蓝绿 + 换进程**不会丢会话**（持久化在外），代价是**运行中的 turn 尾部可能撕裂**。方案的「无感」是**服务地址层无感**，不是「会话状态零丢失」。

---

## 1. 架构总览

```
                         ┌────────────────────────────────────────────┐
  浏览器 (别处)           │             dsh-web-gateway (常驻, node)       │
 ┌──────────┐            │                                            │
 │ 刷新后拉  │──HTTPS──▶│  稳定地址 :8080  (TLS 在 proxy 层终结)       │
 │ 页面+传输 │            │   │                                        │
 └──────────┘            │   ├─ 路由/反向代理 (ws+http)               │
                         │   │     http-proxy / 手写转发              │
                         │   ├─ 后端注册表: active + staging           │
                         │   ├─ 健康检查 (prober)                     │
                         │   ├─ 切换编排 (blue/green + drain)         │
                         │   ├─ Doctor (诊断 + AI 修复)               │
                         │   └─ 状态/日志面 (CLI + HTTP debug)        │
                         │        │                                   │
                         └────────┼───────────────────────────────────┘
                                  │
                 ┌────────────────┴───────────────┐
                 ▼                                ▼
        active: dsh web --port A          staging: dsh web --port D
        $DSH_HOME=<同一home>              $DSH_HOME=<同一home>
        (同一个 profile & 会话库)           (同一会话库，仅热更新期短暂并存)
```

三个并存的**不同性质**进程：

1. **`dsh-web-gateway`（本项目）**：常驻、无状态代理 + 编排 + 监督。不随 `dsh web` 死。
2. **`dsh web` active**：对外服务中的后端实例。
3. **`dsh web` staging**：热更新时临时拉起的候选后端，健康后成为新 active。

`dsh-web-gateway` 用 systemd / supervisor 保证自身常驻；`dsh web` 实例由 gateway 作为子进程拉起并守护。

---

## 2. 组件设计

### 2.1 网络与端口分配

- **稳定入口**：gateway 固定监听端口（如 `8080`）。对外浏览器只认这一个地址。
- **后端端口**：`dsh web --port <A>`。为避免 EADDRINUSE，建议 **gateway 分配端口**：服务启动前由 gateway 挑一个空闲端口传给 `--port`，并做成可复用（见 `4.2 端口冲突`）。
- **传输**：外层 `http`/`ws`（或 TLS）。内部 `dsh web` 不要开 0.0.0.0，**始终 `127.0.0.1`**，由 gateway 对外做唯一暴露面 —— 沿用 DSH 的安全立场（`0.0.0.0` 对 `dsh web` 是禁用的）。

实现要点：转发必须同时支持 **HTTP** 与 **WebSocket/upgrade**（`dsh web` 的 `trustedHosts` 与浏览器↔agent 传输可能走 upgrade，`dsh-host-webserver` 有单独 `registerUpgrade`）。若用 `http-proxy`/`http-proxy-middleware` 需确认 websocket 透传；否则手写 `net/http` 转发 + 命中 `upgrade` 事件的 socket 透传。

### 2.2 后端注册表（Backend Registry）

一张表记录每个后端实例槽位：

```ts
type BackendSlot =
  | { role: 'active'; pid: number; port: number; health: 'ok'|'degraded'|'down'; since: number }
  | { role: 'staging'; pid: number; port: number; status: 'starting'|'ready'|'failed'; error?: string; since: number }
```

- 所有对后端的写/起都经网关统一入口，禁止外部直接摸到内部端口。
- 同一时刻**至多一个 active + 0..1 个 staging**。

### 2.3 健康检查（Prober）

因为没有内置端点，用组合探针：

1. **进程存活**：`process.kill(pid, 0)` 不抛错。
2. **TCP 可连**：对 `127.0.0.1:<port>` 建立连接成功。
3. **HTTP 就绪**：`GET /` 期望 `2xx`（SPA fallback 返回 index 即健康）。设置超时与重试。

`staging` 从 `ready` 才可切换；`active` 连续 N 次探活失败 → 触发自动重拉（见 4.1）。

### 2.4 切换编排（Blue/Green + Drain）

一次 `open-update`（部署新插件/新 profile）的完整流程：

1. **下发清单**：`gateway apply --patch <新插件包> [--profile-patch file.yml]`，指定目标 profile 与要 load 的新 `dsh.profile.bundles` / patch 覆盖。
2. **拉起 staging**：网关**挑空闲端口 D** → `dsh web --profile web --port D`，并注入「新 bundles / 覆盖 patch」。（覆盖机制用 `dsh --patch <overlay>` 即可，无需改动 profile 本体。）
3. **等待 ready**：探活直到 `GET /` 200 且保持稳定（探 N 次无抖动）。
4. **切流**：把 gateway 的流量目标由 active(A) 改为 staging(D)。**已有连接断开是预期的**（用户刷新一次即可）。
5. **排空旧进程**：给 active(A) 发 `SIGTERM`，等待退出（`dsh` 有 5s 的 bounded shutdown 宽限）。超时再 `SIGKILL`。
6. **角色翻转**：D 成为新 active；释放 A 的槽位与端口。

> 为什么是「拉起新进程」而非「在 active 上 HMR/重启」：`dsh` 不支持把「新 plugins/patch」热注入已运行的进程（HMR 只监听**本地文件**的 patch 变化，且对插件代码/decline 的改动无效）。要换插件集，只能 `dsh plugin add` + 重启进程。网关用蓝绿把这次「必归的进程重启」变成**可逆、可回滚、地址不变**的操作。

**回滚**：若 staging 探活失败，保留 active 继续服务，仅销毁 staging。可加「上一份 active 作为 rollback 槽」进一步加固。

### 2.5 Doctor（诊断 + AI 修复 + 自拉起）

职责是**进程监督与启动失败自愈**，与热更新解耦，但共享同一网关进程。

- **触发源**：
  - `active` 探活失败达到阈值 → 自动重拉；
  - 用户手动 `gateway doctor --fix`；
  - 事件(如 `dsh web` 非预期退出) → 自动重拉。
- **诊断流程**：
  1. 读该实例的 `stdout/stderr`（网关捕获启动日志，追加到 `logs/<role>.log`）。
  2. 读会话态与 `dsh --dump-config` 对比 profile bundles 是否受损。
  3. 匹配已知错误模式：
     - `EADDRINUSE` / 端口被占 → 4.2；
     - patch 解析/加载失败 → 回滚到上一份可用 patch，或定位出错行;
     - 插件 declined HMR / externals 错误 → 需要重启（本就是重启场景）。
  4. **未能识别时进入 AI 修复**：把日志尾 + `--dump-config` 出错段发给 LLM，LLM 给出**结构化的修复指令**（改哪个 patch 文件、改什么），网关**应用在 staging** 上先验证，再决定是否替换 active。**永不直接改 active**。
- **拉起**：以正确端口/profile 重新 spawn，回到健康检查流程。

### 2.6 Gateway 自身的常驻与暴露

- **自身保活**：systemd unit（`Restart=always`）或 supervisor 管理。
- **管理面**：`gateway` CLI（`status` / `open-update` / `doctor` / `rollback`）+ 一个本机 debug HTTP 端口（`127.0.0.1`，不给对外），方便脚本/浏览器访问 `status`。
- **恢复语义**：gateway 自身重启后，扫描后台探活，能把仍活的 `dsh web` 实例重新纳管，而不是误认为是孤儿。

---

## 3. 目录结构与模块划分（建议）

```
packages/dsh-web-gateway/
  index.js                 # 入口：读配置，拉起 prober/proxy/orchestrator
  lib/
    registry.js            # 后端槽位状态机
    prober.js              # 健康检查
    proxy.js               # http+ws 转发，指向当前 active
    orchestrate.js         # 蓝绿切换 / drain / 回滚
    spawn.js               # spawn dsh web 子进程，捕获日志、定端口
    doctor.js              # 诊断 + AI 修复 + 自拉起（LLM 客户端）
    ai.js                  # 把诊断喂给 LLM，解析结构化修复指令（复用 dsh 的 LLM 能力可选）
    lifecycle.js           # gateway 自身 systemd/supervisor 配合、重启重纳管
    cli.js                 # status / open-update / doctor / rollback
  cordis.patch.yml         # 若网关自身也想以 dsh 插件形态装（可选）
  README.md
```

> 定位：这是一个**独立常驻进程**，不是 `dsh web profile` 的插件。它站在 `dsh` CLI 之上操作后端实例。

---

## 4. 关键技术决策与风险

### 4.1 「无感」的真实边界
- **益处**：网关地址 `8080` 不变；用户刷新一次就回到新后端，会话仍在（持久化在外）。
- **代价**：更新瞬间正在跑的那一轮 agent 尾部可能撕裂/丢弃。**trade-off**：若期望「零中断」，必须有 checkpoint 机制兜住未完成的 turn，或等待空闲窗口切换。**建议**：做「切换前让 active 静默（无 in-flight turn）再切」的最低成本保护，高级的在会话 checkpoint 层面做。

### 4.2 端口冲突（EADDRINUSE）
`dsh web listen` 失败 = fail-loud 退出。**对策**：
- 网关**统一分配端口**，分配前探测空闲，且记录到 registry（`:0` 让 OS 分配也可，但切换后需回读实际端口）。
- 后端**只绑 127.0.0.1**，规避端口在局域网上的误冲突。

### 4.3 两个后端共享会话/日志根
蓝绿并存时 active 与 staging **指向同一 `$DSH_HOME` / 会话库**。风险：
- 会话 id 相同 → 若不小心双写会冲突。缓解：staging 期间**只读沙箱化**或至少不 open 活跃会话的写路径；只在 ready 判定（不影响写）与手动冒烟时触碰页面。若你更保守，可让 staging 用**只读 LD_PRELOAD / 副本根**做验证，切换时才切到真实根。

### 4.4 build 产物 / profile 更新
`dsh plugin --profile web add <pkg>` 改的是 profile 清单与 node_modules，属于**启动期读取**；蓝绿天然覆盖。前端 dist 也随进程读固定目录，同样被覆盖。

### 4.5 AI 修复的信任边界
- OOD 修复指令必须先 apply 到 **staging**，探活通过才上线；LLM 永远不能直接操作 active 或改 profile 本体，只能产出「应修改的文件 + 修改内容」交给编排层执行。
- 与 `dsh` 的 LLM/agent 能力可复用（`dsh-agent-tool-presentation` 等），但要小心别让修复 agent 拿到的上下文泄露到公网。

### 4.6 P0 实测结论：转发即可穿透信任围栏，无需 `--trusted-host`（已验证 ✅）

实测环境：`dsh web --port 5188 --host 127.0.0.1` 起后端，手写 http+ws 转发网关占 `:5190`。后端自带 fence（`dsh-client-connection` 的 `isTrustedApiRequest`）同时闸住 **`/api` HTTP RPC 与 `/api/events.mux`、`/api/events.host` 两个 WebSocket upgrade**。

**fence 判定逻辑（已读源码确认）**：
1. 取 `Host` 头，hostname 必须是 **loopback**（`localhost` / `[::1]` / `127/8`）或在 `trustedHosts` 里；
2. 若带 `Origin`，必须满足 `new URL(Origin).host === Host.host`（同源）；
3. `sec-fetch-site: cross-site` 直接拒。

**实测矩阵**（对 `/api` HTTP 与 WS upgrade 一致）：

| 转发姿势 | `/api/...` 结果 | 判定 |
|---|---|---|
| `Host` 保持公网域名 | 403 | fence 拦截（expected） |
| `Host: 127.0.0.1:<port>`，**不带 Origin** | 404 / 426 / **WS 101** | **✅ 穿透，无需信任名单** |
| `Host: 127.0.0.1:<port>` + `Origin: https://公网` | 403 | 同源陷阱拦截 |
| `Host: 127.0.0.1:<port>` + `Origin:` 空串 | 403 | **空值 ≠ 移除**，必须 `delete` 该头 |

**最终网关转发配方（端到端已验证）**：
- 转发时把入站 `Host` 重写为 `127.0.0.1:<backendPort>`（loopback authority）；
- **删除** `Origin` 头（空串不够，必须删除），顺带删除 `sec-fetch-site`；
- 三条路径全部通过：静态 SPA（`GET /` → 200）、`/api` RPC（`GET /api/events.mux` → 426=进入 bridge）、**浏览器↔agent WebSocket（upgrade → 101）**。

**安全性说明（为何是正确委托而非绕过）**：`dsh web` 只绑 `127.0.0.1`，**能触达后端的只有网关本身**。DSH 的 fence 把「谁能访问 loopback API」让渡给网关——网关成为唯一对外暴露面，DSH 的 DNS-rebinding 护栏在此形态下由网关自己接管（网关须自行 Origin/CSRF/鉴权，见 §2.6、§4.5）。这是有意、可辩护的架构授权。

**对 `--trusted-host` 的结论**：默认**不需要**传。仅当想同时允许多个网关/直连域名时才作为补充（非必经）。

---

## 5. 分阶段验收（里程碑）

| 阶段 | 内容 | 验收标准 | 依赖 |
|---|---|---|---|
| **P0｜探活 + 稳定地址单后端** | gateway 常驻 + proxy + prober；管一个 `dsh web`（127.0.0.1 + 分配端口） | ✅ **已完成**：HTTP+WS 穿透配方实测、`up` 拉起 active + 探活 | 无 |
| **P1｜蓝绿切换** | `open-update` 拉起 staging → 探活 → **等服务空闲(无 in-flight turn)** → 切流 → drain 旧进程 | ✅ **已完成**（`packages/dsh-web-gateway`，`scripts/e2e.sh` 10/10 绿）：切换地址不变、刷新即用新版、staging 失败自动回滚、持 WS 时拒切（active-busy）、`--force` 强切、会话不丢、5100 未波及 | P0 |
| **P2｜Doctor** | 日志捕获 + 错误模式匹配 + LLM 修复(仅 staging) + 自拉起 | `EADDRINUSE`/patch 错能自动诊断并修/回滚；未知错误走 AI 在 staging 验证后上线 | P0 |
| **P3｜Gateway 自身 HA** | systemd/supervisor 保活 + 重启后重纳管存量实例 | gateway 崩溃后自动恢复并重新纳管仍活着的 `dsh web` | P0 |

每阶段独立可交付、可回滚，避免一次性上整套重型编排。

---

## 6. 待验证项（进入开发前先闭环）

1. **转发穿透 —— ✅ 已实测闭环**（见 §4.6）：传输是 WebSocket（`/api/events.*`）；用「Host 重写为 loopback + 删 Origin」即可无 `--trusted-host` 穿透 fence。**P1 已按此配方实现并通过真实 ws 客户端握手验证**。
2. **staging 与 active 共享 `$DSH_HOME` —— ✅ P1 实证**：staging 探活期间 `GET /` 无副作用；`$DSH_HOME/sessions` 切换前后经 e2e 确认不变。**仍建议** staging 不打开活跃会话的写路径（只探活 + 静态页），切换后才接收写流量，这点 P1 已天然满足（网关切换前把写流量都指向 active）。
3. **`--patch` 注入新 bundles —— ✅ P1 实证**：`dsh --profile web --patch X ...` 可行，但 **`--patch` 必须写在 app 参数（`--host/--port`）之前**，否则被 app 拒收（`unknown option '--patch'`）。网关 spawn 已按正确顺序拼参。
4. AI 修复的模型接入方式（复用 dsh 的 LLM client vs 独立 key），以及 prompt 里给多少日志上下文合适。
5. **静默切换保护（你的决策 #3）—— ✅ P1 实现并实证**：判据=网关代理层 in-flight http/ws 计数连续 1500ms 为 0（进程级空闲采样，零侵入）；实测持 WS 连接时拒切（`active-busy`），`--force` 可强切。

---

## 7. 范围与反对意见（显式不做）

- ❌ **不做**浏览器 client 断线自愈（已明确：刷新一次即可）。
- ❌ **不做**零丢失（in-flight turn 撕裂由 checkpoint 兜底，非本期）。
- ❌ **不做** `dsh web` 的 `0.0.0.0` 暴露；保持 127.0.0.1 + 网关唯一暴露面（延续 DSH 安全立场）。
- ❌ **不做** 多网关/多后端实例的水平扩展（单 active + 单 staging 满足需求）。
