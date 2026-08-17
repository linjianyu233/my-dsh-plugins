# 发版（Release）流程 — GitHub Actions

发版已集成到 GitHub Actions（`.github/workflows/release.yml`），**手动触发、只有仓库所有者本人能执行**，无需再在本地跑 `npm publish`。

## 1. 一次性配置（前置条件）

### 1.1 npm 访问令牌 `NPM_TOKEN`

在 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：

- **Name**：`NPM_TOKEN`
- **Value**：npm 访问令牌，二选一：
  - **Automation token**（推荐）：npmjs.com → Access Tokens → Generate New Token → *Automation*（避免 2FA 交互，CI 环境必需）；
  - 或 **Granular Access Token**：只授权 `@linjianyu` scope 下这四个包（`dsh-wechat-bridge` / `dsh-bridge-runner` / `dsh-web-ui-enhance` / `dsh-web-gateway`）的 **Read and write**。

> ⚠️ 如果你的 npm 账号开了 **2FA**，**普通（不勾选 automation）token 无法在 CI 里用**——必须用 Automation 或 Granular token。

### 1.2 建议：保护 `main` 分支与发版环境（可选加固）

workflow 里已内置「触发者必须是仓库所有者」的硬校验，以下两项属于 GitHub 侧的可选加固：

- **Branch protection**：Settings → Branches → Add rule，`main` 分支勾选 *Require a pull request before merging*、*Only allow specific actors to push*（填你自己的账号），防止别人直接推 `package.json` 的版本。
- **Environment protection**（可选）：Settings → Environments → 新建 `release` 环境，把 *Deployment branch* 设为 `main`、添加 *Required reviewers*（只有你）。之后把 `release.yml` 里 `publish` job 加上 `environment: release` 即可启用（规则配好前不加，避免每次发布都要自己批准）。

## 2. 使用方式

1. **手动 bump 版本**：修改要发布包的 `packages/<pkg>/package.json` 里的 `version`（如 `1.3.1` → `1.4.0`），提交并推送到 `main`。**npm 不允许覆盖同名同版本**，release job 会提前校验并给出友好报错。
2. **触发发版**：仓库 **Actions** 页 → **Release npm** → **Run workflow**，填写参数：

   | 参数 | 说明 | 默认 |
   |---|---|---|
   | `target` | `all` = 发布全部可发布包（含 `dsh-web-gateway`）；或单选 `dsh-wechat-bridge` / `dsh-bridge-runner` / `web-ui-enhance` / `dsh-web-gateway` | `all` |
   | `dry_run` | 演练：完整走一遍流程（`npm publish --dry-run`），不真正上传 | 否 |
   | `create_github_release` | 发布成功后为每个已发布包创建 GitHub Release（tag：`<包目录>@<version>`，如 `dsh-wechat-bridge@1.4.0`） | 否 |

3. 流水线自动执行：**权限校验 → 装依赖 → 构建 `web-ui-enhance` client 面（tsdown）→ 跑全部测试（`pnpm -r run test`）→ 发布到 npm**。

## 3. 流程细节与行为

- **权限门禁**：两个 job 第一步都校验 `github.actor != github.repository_owner`则直接失败——现在只有仓库所有者 `linjianyu233`（所有者）能发版；以后若给协作者加了 write 权限，他们也无法用此 workflow 发版。若以后想让某协作者也能发版，把条件从 `github.repository_owner` 改成允许名单即可。
- **自动跳过 private 包**：防御性保留——某包若重新标记 `"private": true` 则不会被打包上传（`dsh-web-gateway` 已于 0.1.0 起可发布）。
- **版本冲突预检**：发布前 `npm view <pkg>@<version>` 查 registry；已存在则终止并用 `::error::` 提示先 bump。
- **凭据权限最小化**：全局 `permissions: contents: read`；只有 `github-release` job 单独放开 `contents: write`；npm 凭据全部来自 `NPM_TOKEN` secret，不会入库（根 `.npmrc` 只含 `@linjianyu` scope 映射，可提交）。
- **并发保护**：`concurrency: npm-release` 保证同一时间只有一个发版流程在跑，防止两个 workflow 同时 publish 互相踩版本。

## 4. 本地备选（兜底）

不想走 CI 时仍可本地发布（不推荐，容易漏掉测试/构建）：

```sh
# 单个包
cd packages/<pkg> && npm publish --access public

# 全部（慎用，每个包版本号需先手动 bump）
pnpm run publish:all
```

> 根 `.npmrc` 已把 `@linjianyu` scope 固定到官方 registry：`@linjianyu:registry=https://registry.npmjs.org/`，本机发布时请确保本地 `~/.npmrc` 有对应 `//registry.npmjs.org/:_authToken=...`。

## 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| Job 第一步红：`当前触发者 xxx 无权发版` | 触发者不是仓库所有者；只有你能点 Run workflow |
| `xxx 已存在于 npm registry` | 该版本号发过了，先 bump version 再触发 |
| 发布时报 401/403 / 走 2FA 卡住 | token 不是 automation/granular 类型，或没有 `@linjianyu` 包权限；换 token 重新配 `NPM_TOKEN` |
| `pnpm install --frozen-lockfile` 失败 | lockfile 与 package.json 不同步，先本地 `pnpm install` 把 `pnpm-lock.yaml` 提交 |
| 想删除误建的 GitHub Release | Releases 页删除该 release 与 tag 即可，删除 tag 不会影响已发布的 npm 包 |