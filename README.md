# my-dsh-plugins

linjianyu 的 DeepSeek Harness (DSH) 插件 monorepo。所有自研插件以 npm 包形式放在 `packages/` 下。

## 包

| 包 | 发布名 | 说明 |
|---|---|---|
| `packages/dsh-wechat-bridge` | `@linjianyu/dsh-wechat-bridge` | 把 DSH 接到微信「龙虾」(ClawBot)：iLink 直连 + 通用桥接 |
| `packages/dsh-bridge-runner` | `@linjianyu/dsh-bridge-runner` | 面向 bridge/客户端的通用常驻会话运行层（DSH bundle 插件） |
| `packages/web-ui-enhance` | `@linjianyu/dsh-web-ui-enhance` | Web UI 增强（bundle+client 双面插件）：移动端 UI 适配、右键会话复制 session id、跨 session 引用 |

## 结构

```
packages/
  dsh-wechat-bridge/    # 微信桥接（CLI/HTTP，零 npm 依赖）
  dsh-bridge-runner/    # 常驻 agent runner 插件（dsh.bundle.patch，经 `dsh plugin add` 安装）
  web-ui-enhance/       # Web UI 增强（dsh.bundle + dsh.client 双面，client 面需 tsdown 构建）
```

## 开发

```sh
pnpm install          # 安装 workspace 依赖
pnpm -r run test      # 运行各包测试
```

## 发布（GitHub Actions）

发版已集成到 GitHub Actions（`.github/workflows/release.yml`）：**手动触发、只有仓库所有者本人能执行**。

1. 手动 bump 要发布包的 `package.json` 的 `version`，提交推送到 `main`（npm 不允许覆盖同名同版本）；
2. 在仓库 **Settings → Secrets → Actions** 里配好 `NPM_TOKEN`（npm automation token，一次性的）；
3. **Actions → Release npm → Run workflow**，可选参数：`target`（all/单包）、`dry_run`（演练）、`create_github_release`（顺带建 GitHub Release）。

流水线自动执行：权限校验 → 装依赖 → 构建 `web-ui-enhance` client 面 → 跑全部测试 → `npm publish --access public`（自动跳过 `dsh-web-gateway` 等 private 包）。

本地兜底发布仍可用：`cd packages/<pkg> && npm publish --access public`。

> 完整说明（权限模型、常见问题）见 [`docs/release.md`](docs/release.md)。

## 常驻 runner 的安装（DSH 插件机制）

`dsh-bridge-runner` 是 DSH bundle 插件，不直接 npm 依赖，而是通过 DSH 官方插件机制装入 profile：

```sh
dsh plugin --profile resident add @linjianyu/dsh-bridge-runner
```

详见 `packages/dsh-bridge-runner/README.md`。

> 若你的全局 npm registry 是镜像，需确保 `@linjianyu:registry=https://registry.npmjs.org/`
> 已写入 `~/.npmrc`（否则 `dsh plugin` 内部 pnpm 会从镜像拉不到 scope 包）。
