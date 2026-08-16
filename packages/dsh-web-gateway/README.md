# @linjianyu/dsh-web-gateway —— DSH Web 蓝绿切换网关

常驻网关（HTTP + WebSocket 代理）+ active/staging 双后端 + 探活 + 切流/drain/回滚。
让 `dsh web` 的插件/配置更新变成「入口地址不变、刷新一次即用上新版本」的蓝绿发布。

**零 npm 依赖**（纯 node 内置模块），独立常驻进程，不是 dsh profile 插件。

---

## 它解决什么

`dsh web` 是一个节点进程；很多插件改动（代码 / externals / decline-HMR）**必须重启进程**才能生效。
直接杀进程重启会让所有浏览器连接断掉且入口地址失效。本网关：

1. 提供**稳定入口地址**（`127.0.0.1:<gatewayPort>`），转发 HTTP + WebSocket 到当前 active 后端；
2. `open-update` 拉起一个 **staging** 新实例（注入新 `--patch`）→ 探活 ready →
   **等 active 空闲**（无 in-flight 连接）→ 切流 → drain 旧实例；
3. 若 staging 起不来 → **自动回滚**，active 不受影响。

> 已打开页面会断连，**刷新一次**即连上新实例；会话持久化在进程外（JSONL/sqlite），
> 同 session id 可续读，**会话不丢**。

---

## 转发配方（P0 实测闭环，无需 --trusted-host）

转发时把入站 `Host` 重写为 `127.0.0.1:<backendPort>`，并 **删除** `Origin`（含 `sec-fetch-site`）。
这样能同时穿透 `dsh-client-connection` 的信任围栏：

- 静态 SPA：`GET /` → 200
- `/api` RPC：→ 426/404（进入 bridge）
- `/api/events.mux|host` WebSocket upgrade → **101**（真实 ws 握手，含正确 Sec-WebSocket-Accept）

---

## 用法

```sh
# 1) 启动常驻网关（自动拉起初始 active，绑定 127.0.0.1:8181；控制端 :12277=8181+0x1000）
dsh-gateway up --port 8181 --profile web

# 2) 查询状态
dsh-gateway status --port 8181

# 3) 蓝绿切换（复用新插件/patch；--patch 必须写在 launcher 区，见下）
dsh-gateway open-update --port 8181 -p /path/to/new-patch.yml
#    默认等待 active 空闲；有连接时拒绝切换（active-busy）。
#    强制跳过空闲等待：
dsh-gateway open-update --port 8181 --force

# 4) 诊断（P2 Doctor：规则 + LLM 兜底）
dsh-gateway doctor --port 8181

# 5) 停止
dsh-gateway exit --port 8181
```

### Doctor（P2）

- **规则诊断**：覆盖 `EADDRINUSE`、patch/overlay 文件缺失、patch 引用不存在条目（YAML 结构错）、`--patch` 参数顺序错、`--host 0.0.0.0` 被拒等高频错误，输出结构化 `{verdict, detail, fix}`。
- **LLM 兜底**：未命中规则时，把最近实例日志（+ 可选 dump-config）喂给 DeepSeek（`DEEPSEEK_API_KEY`，读环境变量或 `~/.dsh/.credentials.yaml`），要求返回 JSON 修复指令 `{file, change, reason}`。修复指令由编排层 apply 到 **staging** 验证后才上线，模型绝不直接改 active/profile。
- 凭据缺失/无效 → 优雅降级返回 `{ok:false, reason}`，不阻塞。

### Watchdog 自拉起（P2a，可选）

`DSH_GATEWAY_WATCHDOG=1` 启用：定时探活 active，连续失败 3 次自动以**相同配置**重拉新实例（探活到 ready 后接回代理），带退避防抖（默认 10s，防崩溃循环）。open-update 期间自动暂停监控。

### 网关自身 HA（P3）

- **systemd 保活**：`~/.config/systemd/user/dsh-gateway.service`（`Restart=always`，自动拉起）。注意 systemd user 环境 PATH 窄，unit 里必须显式带 nvm bin 的 `PATH`，否则 `dsh`（`#!/usr/bin/env node`）起不来。
- **重启重纳管**：gateway 重启后若发现存量存活的原 active（孤儿），`_adoptExisting()` 直接纳管（pid/port 进 registry），不另起重复实例；绝不纳管 5100（GUI 宿主）。
- **adopt 兼容**：被纳管的 active 的 `child` 是 shim（无真实 exit 事件）；`terminate()`/`waitExit()` 对 shim 回退到 `pidAlive` 轮询，保证 open-update 的 drain 对纳管实例同样有效。
- 完整闭环已验证：`kill -9 gateway` → systemd 拉起 → 恢复 200 → 可继续蓝绿切换 → tailscale 不变。

浏览器访问：`http://127.0.0.1:8181/`（同一地址长期不变）。

### 关于 `--patch` 参数顺序（D 关键陷阱）

`dsh` 的 launcher flag（`--profile` / `--patch`）必须出现在 **app 参数（--host/--port）之前**。
`dsh --profile web --patch X --host 127.0.0.1 --port N` ✅；
`dsh --profile web --host ... --port ... --patch X` ❌（--patch 会被 app 拒收为未知选项）。
网关内部已按正确顺序拼参数。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BIN` | `dsh` | `dsh` 可执行文件路径 |
| `DSH_GATEWAY_LOGS_DIR` | `./logs` | 后端实例日志目录（每实例一个 `<role>-<ts>.log`） |
| `DSH_GATEWAY_CWD` | 当前目录 | 后端进程的工作目录（影响 profile workspace） |

---

## 蓝绿切换流程

```
open-update
 ├─ 校验 active 存在 & 健康
 ├─ 拉起 staging（分配空闲端口，注入新 --patch；绑 127.0.0.1）
 ├─ 轮询探活：PID 存活 + TCP 可连 + GET / 2xx（子进程退出即提前失败）
 │    └─ 失败 → terminate staging，保留 active（= 回滚）
 ├─ 等 active 空闲（proxy 层 in-flight http/ws 计数连续 1500ms 为 0；--force 跳过）
 │    └─ 超时 → terminate staging，保留 active（active-busy）
 ├─ 切流：proxy 上游动态指向 staging（之后随 registry.active() 走）
 ├─ drain 旧 active（SIGTERM → 6s → SIGKILL），释放 active 槽
 └─ promote：staging 晋升为新 active
```

## 验收记录（本机实测）

| 项 | 结果 |
|---|---|
| `up` 后 `GET /` 经网关 | 200 |
| `open-update`（带 patch） | `switched`，active 端口变化 |
| 切换后同一网关地址 `GET /` | 200 |
| 切换后 `/api/events.mux` WS | 101（真实 ws 客户端 OPEN） |
| 持 WS 时无 `--force` | `not-switched:active-busy`，active 不变 |
| 持 WS 时 `--force` | `switched` |
| staging 启动失败 | `not-switched:staging-failed`，active 不变，网关继续 200 |
| `$DSH_HOME/sessions` | 切换前后不变（会话未丢） |
| watchdog：kill active 后端 | 3 次探活失败自动重拉，网关恢复 200 |
| doctor：坏 patch 触发 staging 失败后 | 规则命中 `PATCH_NOT_FOUND` + 修复建议 |
| doctor：未知错误 | LLM 兜底被调用；key 无效时返回 `{ok:false}` 降级 |

## 目录结构

```
packages/dsh-web-gateway/
  index.js            CLI + 常驻 daemon 入口
  lib/gate.js         组装 registry/proxy/spawn/orchestrate + 控制端 API（含 doctor、adopt 纳管）
  lib/registry.js     active/staging 槽位状态机
  lib/spawn.js        分配空闲端口 + spawn dsh web（捕获日志）
  lib/prober.js       探活组合（PID/TCP/HTTP）
  lib/proxy.js        HTTP + WS 转发（Host 重写 + 删 Origin；WS 原样回传 101）
  lib/idle.js         空闲采样（in-flight 计数 + 安静窗口）
  lib/orchestrate.js  蓝绿流程 + 回滚（含 shim-child drain 兼容）
  lib/watchdog.js     active 健康监控 + 自拉起（阈值/防抖/退避）
  lib/doctor.js       规则诊断引擎（EADDRINUSE/patch/config 等）
  lib/ai.js           LLM 兜底（DeepSeek chat，读凭据/环境变量，可降级）
  tests/unit.test.mjs
  tests/p2.test.mjs
```

## 范围外（后续阶段）

- Doctor / AI 修复（P2，设计要求见 `docs/dsh-web-gateway-design.md`）
- 网关自身 HA / systemd（P3）
- 浏览器断线自愈（明确不做：刷新一次即可）