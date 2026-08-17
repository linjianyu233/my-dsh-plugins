# @linjianyu/dsh-web-gateway —— DSH Web 蓝绿切换网关

常驻网关（HTTP + WebSocket 代理）+ active/staging 双后端 + 探活 + 切流/drain/回滚。
让 `dsh web` 的插件/配置更新变成「入口地址不变、刷新一次即用上新版本」的蓝绿发布。

**零 npm 依赖**（纯 node 内置模块），独立常驻进程。
同时是 **DSH bundle 插件**：随包发布 `skills/`，装进 profile 后由宿主层注册为
技能注册表**全局层** provider（所有工作区生效，见下文「作为 DSH bundle 插件」）。

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

## 转发配方（v2 统一改写，修复 dsh-better-sidebar 经网关 403）

**无论路径**，转发时都把自己呈现为「loopback 后端源」：入站 `Host` 重写为
`127.0.0.1:<backendPort>`；原请求带 `Origin` 时**改写**为 `http://127.0.0.1:<backendPort>`
（不删除，保证 `new URL(origin).host === Host`）；删除 `sec-fetch-site`。
这样能同时穿透两类信任围栏：

- DSH 式围栏（`dsh-client-connection` `/api` 与 dsh-better-sidebar 复制自它的 `/sidebar/*`）：
  Host 是 loopback → 放行；Origin 与 Host 相等 → 放行。**经网关用非 loopback 地址**
  （Tailscale / LAN IP / 主机名）访问时 `/sidebar/api/*`、`/sidebar/file`、`/sidebar/html`、
  `/sidebar/ws/*` 都不再 403 —— 修复 Explorer 显示 forbidden。
- dshmarket 式 `sameOrigin()`（仅要求 `new URL(origin).host === host`）：改写后仍相等 → 不回归
  'untrusted origin'。

> 旧配方（v1）对非 `/api` 路径「保留 Origin 并把 Host 设成 Origin 的 host」，导致外部
> 地址访问时 `/sidebar/*` 围栏收到非 loopback Host → 403。v2 不再依赖外部访问地址。

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

### 网关自身 HA（P3，已落地）

- **systemd 保活**：unit 文件在仓库 `systemd/dsh-gateway.service`，部署到
  `~/.config/systemd/user/` 并 `systemctl --user enable --now dsh-gateway`、
  `loginctl enable-linger <user>`。`Restart=always` + `RestartSec=3` 任何死法都自动拉起；
  `KillMode=process` 保证 systemd 只杀网关进程、不动后端，重启重纳管才成立。
- **环境镜像（关键，勿删）**：systemd user 环境是裸的，unit 必须显式带上
  `NODE_OPTIONS=--use-env-proxy`、`http(s)_proxy=127.0.0.1:7897`、`all_proxy`、
  `no_proxy` 与 `DSH_BIN`（nvm 全局 `dsh`）——缺失会让后端 LLM 请求走不了代理，
  opencode 等 provider 直接哑掉。PATH 也要显式含 nvm bin（`bin` 的
  `#!/usr/bin/env node` 依赖它）。
- **重启重纳管**：gateway 重启后若发现存量存活的原 active（孤儿），`_adoptExisting()` 直接纳管（pid/port 进 registry），不另起重复实例；绝不纳管 5100（GUI 宿主）。
- **adopt 兼容**：被纳管的 active 的 `child` 是 shim（无真实 exit 事件）；`terminate()`/`waitExit()` 对 shim 回退到 `pidAlive` 轮询，保证 open-update 的 drain 对纳管实例同样有效。
- 完整闭环已实测：`kill -9 gateway` → systemd 3s 拉起 → adopt 原 active（同端口）→ 恢复 200 → 可继续蓝绿切换 → tailscale 不变。

浏览器访问：`http://127.0.0.1:8181/`（同一地址长期不变）。

---

## 作为 DSH bundle 插件（路线 B：包内 skills 直挂全局层）

本包同时是 bundle 插件形态：`package.json` 声明 `dsh.bundle.patch` →
`cordis.patch.yml` 把 `@linjianyu/dsh-web-gateway/plugin` 挂进 profile 宿主层，
`apply()` 里 `ctx.skills.registerProvider()` 把包内 `skills/` 目录注册成技能
provider（`web-gateway-skills`，rank 600 bundled，对齐官方 dsh-skill-badge）。

- **生效范围**：宿主层注册 → 技能注册表**全局层** → **所有工作区、所有会话**可见；
- **永远是最新安装版本**：内容直接读 `<pkg>/skills/`，重装/升级包即换新，无需拷贝、
  不写 `~/.dsh/skills`；卸载包即自动消失。
- **同名可覆盖**：rank 600 意味着用户/项目本地技能（更低 rank）可同名覆盖。

安装（先把新版本发到 npm，或本仓库 `pnpm publish` 后执行）：

```sh
dsh plugin --profile web add @linjianyu/dsh-web-gateway
```

装完重启 dsh web 会话即可在技能目录看到 `dsh-web-gateway`（网关管理）技能。
daemon 面（`dsh-gateway`）不依赖此 patch，照常独立运行。

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
  lib/proxy.js        HTTP + WS 转发（Host/Origin 统一改写为 loopback；WS 原样回传 101）
  lib/idle.js         空闲采样（in-flight 计数 + 安静窗口）
  lib/orchestrate.js  蓝绿流程 + 回滚（含 shim-child drain 兼容）
  lib/watchdog.js     active 健康监控 + 自拉起（阈值/防抖/退避）
  lib/doctor.js       规则诊断引擎（EADDRINUSE/patch/config 等）
  lib/ai.js           LLM 兜底（DeepSeek chat，读凭据/环境变量，可降级）
  lib/plugin.js       Cordis bundle 入口（apply() 注册全局层 skills provider）
  lib/skill-provider.js  包内 skills 目录的零依赖 SkillProvider（frontmatter 解析 + 发现 + 加载）
  skills/dsh-web-gateway/SKILL.md   随包发布的「网关管理」技能
  cordis.patch.yml    bundle patch（insert web-gateway 行）
  tests/unit.test.mjs
  tests/skill-provider.test.mjs
  tests/p2.test.mjs
```

## 范围外（后续阶段）

- Doctor / AI 修复（P2，设计要求见 `docs/dsh-web-gateway-design.md`）
- 网关自身 HA / systemd（P3）
- 浏览器断线自愈（明确不做：刷新一次即可）