# dsh-shared — DSH profile / provider 共享模板

把 DSH 的 **profile 结构** 与 **provider/模型定义** 在这里共享，供其它节点复用。
**不含任何 API key** —— 所有凭据都通过环境变量引用，需在新节点单独配置。

## 结构与来源

本目录镜像 `~/.dsh/` 的配置（已剔除 node_modules、锁文件、运行时数据与凭据）：

```
dsh-shared/
  settings.yaml                 # 全局 provider + 模型定义（API key 走 apiKeyEnv 环境变量）
  profiles/
    web/                        # Web UI profile（bundles + market）
      package.json              # bundle 依赖与列表
      cordis.patch.yml          # profile 本地补丁
      .dsh-market/hot-1.yml     # 已安装市场条目
    tui/
    resident/
    dsh-tui/
```

## 在新节点如何应用

```sh
# 1) 把配置模板落位到 ~/.dsh
mkdir -p ~/.dsh/profiles
cp -r dsh-shared/settings.yaml ~/.dsh/settings.yaml
cp -r dsh-shared/profiles/* ~/.dsh/profiles/
#   （有同名旧目录时合并 / 覆盖）

# 2) 忽略 lock/node_modules：在 ~/.dsh/profiles 下执行
cd ~/.dsh/profiles
rm -rf */node_modules */pnpm-lock.yaml   # 重新按新节点平台安装

# 3) 安装各 profile 的 bundle 依赖（在目标 profile 目录内）
cd ~/.dsh/profiles/web && pnpm install
#   （tui / resident / dsh-tui 同理）
```

## 凭据：只通过环境变量，不进仓库

`settings.yaml` 里 provider 用的是 `apiKeyEnv`，所以真实 key 在**新节点**上只需导出环境变量即可（写入 shell rc，或系统密钥管理）：

```sh
# 例：settings.yaml 里 opencode-go 引用 OPENCODE_GO_API_KEY
export OPENCODE_GO_API_KEY="xxx"
export DEEPSEEK_API_KEY="xxx"      # 若该节点用 llm-deepseek
```

> 切勿把 key 写进本目录任何文件。`.credentials.yaml` 是 `~/.dsh ` 下的本地凭据文件，**永不入库**。

## 注意

- `profiles/web/package.json` 里 `@linjianyu/dsh-web-ui-enhance` 用的是 **npm 发布版**（`^0.1.0`），不是本机 `link:` 路径 —— 保证跨节点可安装。
- 各 profile 的 `cordis.patch.yml` / `package.json` 会随本地定制变化，如需共享你的改动记得 commit。
- 若某节点的 profile 目录已存在，覆盖前请先备份 `~/.dsh/profiles/<name>/cordis.patch.yml` 等本地补丁。
