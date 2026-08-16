# my-dsh-plugins

linjianyu 的 DeepSeek Harness (DSH) 插件 monorepo。所有自研插件以 npm 包形式放在 `packages/` 下。

## 包

| 包 | 发布名 | 说明 |
|---|---|---|
| `packages/dsh-wechat-bridge` | `@linjianyu/dsh-wechat-bridge` | 把 DSH 接到微信「龙虾」(ClawBot)：iLink 直连 + 通用桥接 |
| `packages/dsh-bridge-runner` | `@linjianyu/dsh-bridge-runner` | 面向 bridge/客户端的通用常驻会话运行层（DSH bundle 插件） |

## 结构

```
packages/
  dsh-wechat-bridge/    # 微信桥接（CLI/HTTP，零 npm 依赖）
  dsh-bridge-runner/    # 常驻 agent runner 插件（dsh.bundle.patch，经 `dsh plugin add` 安装）
```

## 开发

```sh
pnpm install          # 安装 workspace 依赖
pnpm -r run test      # 运行各包测试
```

## 发布

各包独立发布到 npm（`@linjianyu/*` scope 固定走官方 registry，根 `.npmrc` 已配置）：

```sh
# 单个包
cd packages/<pkg> && npm publish --access public

# 全部（慎用，每个包版本号需先手动 bump）
pnpm run publish:all
```

> 发布前请确认 `package.json` 的 `version` 已 bump（npm 不允许覆盖同名同版本）。

## 常驻 runner 的安装（DSH 插件机制）

`dsh-bridge-runner` 是 DSH bundle 插件，不直接 npm 依赖，而是通过 DSH 官方插件机制装入 profile：

```sh
dsh plugin --profile resident add @linjianyu/dsh-bridge-runner
```

详见 `packages/dsh-bridge-runner/README.md`。

> 若你的全局 npm registry 是镜像，需确保 `@linjianyu:registry=https://registry.npmjs.org/`
> 已写入 `~/.npmrc`（否则 `dsh plugin` 内部 pnpm 会从镜像拉不到 scope 包）。
