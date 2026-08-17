---
name: dsh-web-gateway
description: >-
  管理 @linjianyu/dsh-web-gateway：DSH Web 的蓝绿切换网关（稳定入口
  127.0.0.1:8181 → active 后端，HTTP+WS 转发）。当你需要查看 DSH Web 网关
  状态（status）、执行蓝绿发布（open-update，含 --force 与回滚语义）、排查
  后端起不来/地址被占/patch 报错（doctor，规则诊断 + LLM 兜底）、或确认
  网关/后端进程是否健康时使用。覆盖 5100 安全边界（绝不碰 GUI 宿主）与
  Tailscale/LAN 访问场景。
disable-model-invocation: false
user-invocable: true
---

# DSH Web 网关管理（dsh-gateway）

本 skill 教 agent 用 `dsh-gateway` 管理 DSH Web 的蓝绿发布与健康状况。
网关是**独立常驻进程**（非 DSH 插件），提供了稳定入口 + active/staging 双后端
切换 + 探活 + 回滚 + Doctor 诊断。**凡是对 web 后端做"重启/换版本"的操作，
都走网关，而不是直接杀进程。**

## 关键事实

- 稳定入口：`http://127.0.0.1:8181/`（浏览器长期访问同一地址；经 Tailscale
  局域网 IP 访问也走同一网关，见下）。
- 控制端：`127.0.0.1:<gatewayPort+0x1000>`（默认 8181 → 控制端 12277），仅 loopback。
- active 后端：网关自动拉起，当前常驻在 `127.0.0.1:22670`（以 `dsh-gateway status` 为准）。
- 可执行文件：`dsh-gateway`（`~/.local/bin/dsh-gateway`，指向本仓库
  `packages/dsh-web-gateway/index.js`）；可用 `dsh-gateway up/status/open-update/doctor/exit`。
- 后端日志：包内 `logs/`（`lib/spawn.js` 里 `DSH_GATEWAY_LOGS_DIR` 默认 `<包>/logs`），
  每实例 `<role>-<ts>.log`，排障先看这里或 `dsh-gateway doctor`。
- 会话不丢：会话持久化在进程外（`~/.dsh/sessions` JSONL），切换只断浏览器连接，
  刷新一次即连上新实例。

## 常用命令（默认 `--port 8181 --profile web`）

```sh
dsh-gateway status --port 8181                      # 查 active/staging/健康
dsh-gateway open-update --port 8181 -p <new.patch>  # 蓝绿发布（等空闲；busy 则拒绝）
dsh-gateway open-update --port 8181 --force         # 强制切换（跳过空闲等待）
dsh-gateway doctor --port 8181                      # 诊断后端起不来/报错
dsh-gateway exit --port 8181                        # 停止网关（慎用，见安全边界）
```

`open-update` 返回语义：`switched`（成功，active 端口会变）、
`not-switched:active-busy`（有持连，需 --force 或稍后重试）、
`not-switched:staging-failed`（新实例没起来，**已自动回滚，active 不受影响**）。

## 安全边界（必须遵守）

- **绝不碰 `5100`**：那是 GUI 宿主进程，不属于网关管辖；任何"启动/停止/纳管 5100"
  的操作都禁止。
- **不要直接 kill 网关的 active 后端**：换版本用 `open-update`，停机用 `exit`；
  直接 kill 会让入口失联。
- **不要把 patch/profile 直接写到 active**：修复类改动一律走 staging 验证后才上线。

## 排障流程

1. `dsh-gateway status` 看是否有 active、健康状态；
2. 后端起不来时 `dsh-gateway doctor`：规则引擎覆盖 `EADDRINUSE`、patch 缺失/
   引用不存在条目（YAML 结构错）、`--patch` 参数顺序错、`--host 0.0.0.0` 被拒等，
   输出结构化 `{verdict, detail, fix}`；
3. 未命中规则时 Doctor 会走 LLM 兜底（读 `DEEPSEEK_API_KEY` 或
   `~/.dsh/.credentials.yaml`）返回 JSON 修复指令，**修复 apply 到 staging 验证后
   才上线，模型绝不直接改 active/profile**；凭据无效则优雅降级返回 `{ok:false}`，
   不阻塞；
4. 也可以直接看后端实例日志再决定。

## 保活与自愈

- **systemd user unit 已落地**：`~/.config/systemd/user/dsh-gateway.service`
  （`Restart=always` + `RestartSec=3` + `KillMode=process`），
  镜像了运行所需的 `NODE_OPTIONS=--use-env-proxy` 与 127.0.0.1:7897 代理环境
  （缺失会导致 LLM 走不了代理、opencode 等 provider 哑掉）。查询：
  `systemctl --user status dsh-gateway`；日志 `journalctl --user -u dsh-gateway -f`。
- `DSH_GATEWAY_WATCHDOG=1` 开启后端 watchdog：active 连续 3 次探活失败自动以相同配置
  重拉新实例（退避防抖 10s）；**切流成功后暂停监控 15s**（失败/忙未动 active 则不暂停）。
- **自愈闭环（已实测）**：`kill -9` 网关 → systemd 3 秒内拉起 → 新网关启动时发现
  存活的原 active（孤儿）会**纳管**（同端口，服务不中断）而不是另起 → 8181 恢复 200。
  `KillMode=process` 保证 systemd 重启只杀网关进程、不动后端，纳管才成立。

## Tailscale / LAN 访问场景

网关转发时统一把 `Host`/`Origin` 改写为 loopback 后端源，所以用
`http://<tailscale-ip或主机名>:8181/` 访问时，`/sidebar/*`、`/api`、
dshmarket 的 origin 校验都不会 403/untrusted-origin。诊断"外部地址访问异常"
时先确认访问的是网关端口（8181）而不是后端端口。