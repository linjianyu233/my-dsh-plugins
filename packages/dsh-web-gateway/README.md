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

# 4) 停止
dsh-gateway exit --port 8181
```

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

## 目录结构

```
packages/dsh-web-gateway/
  index.js            CLI + 常驻 daemon 入口
  lib/gate.js         组装 registry/proxy/spawn/orchestrate + 控制端 API
  lib/registry.js     active/staging 槽位状态机
  lib/spawn.js        分配空闲端口 + spawn dsh web（捕获日志）
  lib/prober.js       探活组合（PID/TCP/HTTP）
  lib/proxy.js        HTTP + WS 转发（Host 重写 + 删 Origin；WS 原样回传 101）
  lib/idle.js         空闲采样（in-flight 计数 + 安静窗口）
  lib/orchestrate.js  蓝绿流程 + 回滚
  tests/unit.test.mjs
```

## 范围外（后续阶段）

- Doctor / AI 修复（P2，设计要求见 `docs/dsh-web-gateway-design.md`）
- 网关自身 HA / systemd（P3）
- 浏览器断线自愈（明确不做：刷新一次即可）