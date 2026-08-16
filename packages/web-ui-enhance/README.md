# @linjianyu/dsh-web-ui-enhance —— DeepSeek Harness Web UI 增强

对 DSH Web 界面的增量增强插件。当前包含一个功能：**左侧会话树里右键任意会话 →
「复制 session id」**，用复制出的 id 去别的会话里做**跨 session 协同 / 问题定位**。

本插件是「**bundle 插件 + client 插件**」双面：

- **client 面**（`dsh.client`，浏览器侧）：真正实现右键复制 session id 的 UI 增强；
- **host/agent 面**（`dsh.bundle`）：注册 `/webui-session-id` 与 `/webui-session-ref`
  两条命令，把复制出来的裸 id 桥接进 DSH 内置的跨会话引用机制。

---

## 1. 功能一览

| 功能 | 触发方式 | 效果 |
|---|---|---|
| 复制 session id | 左侧会话树右键某个会话 → 选「复制 session id」 | 把该会话的 `sessionId` 写入剪贴板，并弹提示 |
| 查看当前会话 id | 任意会话里 `/webui-session-id` | 输出当前会话自己的 id（方便分享给别人） |
| 用 id 引用别的会话 | `/webui-session-ref <id>` | 校验 id 并把裸 id 转成可粘贴的跨会话引用 |

## 2. 你能用它做什么（跨 session 协同 / 问题定位）

DSH 内置了**跨会话引用（session reference）**机制（见
`@deepseek-ai/dsh-session-reference`）：把一个会话做成**只读快照**，作为带来源的
上下文注入到当前会话，供模型阅读。也就是说，你不需要把上下文手抄出来，直接
“引用”即可。

典型工作流：

1. 在会话 A 的会话树上**右键 → 复制 session id**。
2. 在会话 B（另一个会话，可能是空会话或专门的“诊断会话”）里执行
   `/webui-session-ref <A的id>`，拿到一个可直接粘贴的 `@[…]` 引用。
3. 把该引用贴进下一条用户消息（可附说明，例如「请阅读 @<A的标题> 这个会话，
   帮我定位 XXX 问题」）。
4. DSH 会把会话 A 的上下文快照注入进会话 B，模型即可跨会话读取并回答。

> 引用是**只读快照**、带来源、受字节预算约束（`maxReferenceBytes` 默认
> 64KB / 源）。这正合适做问题定位，因为你不想让 B 改动 A。

## 3. 目录结构

```
packages/web-ui-enhance/
  package.json        双面清单：dsh.bundle.patch + dsh.client（platform:web）
  cordis.patch.yml    bundle patch：把 host 行插进 web profile 的 Loader
  tsdown.config.mts  client 面打包配置（tsdown → lib/client.js）
  src/client/index.tsx   client 面源码：shell.overlay 右键复制菜单
  lib/index.js        host 面源码：/webui-session-id、/webui-session-ref
  lib/types/*.d.ts    类型声明
  tests/*.test.mjs    逻辑测试
```

## 4. 安装 / 构建

### 4.1 前提

- `dsh` 已安装（DSH `0.1.0-rc.6+`）。
- 安装的是 **web profile**（`dsh --profile web`）。
- 构建 client bundle 需要 `tsdown`（项目里可用 `pnpm -w add -D tsdown` 或
  `npm i -g`）。

### 4.2 构建 client bundle（必须）

client 面的浏览器 bundle 由 `src/client/index.tsx` 经 `tsdown` 产出到
`lib/client.js`：

```sh
cd packages/web-ui-enhance
pnpm install                       # 安装/链接 peer 依赖
pnpm run build:client              # 产出 lib/client.js
# 开发时监听重建：
pnpm run watch:client
```

> 如果你在 **DSH 源码仓库**里开发，推荐直接把本包放进该仓库，并让它挂到官方
> `dev:web` watcher 下——这样改 `src/client` 就会热重载（client-plugin HMR）。

### 4.3 安装进 profile

```sh
# 把打包产物发布/暴露后，经官方插件机制装入 web profile：
dsh plugin --profile web add @linjianyu/dsh-web-ui-enhance
```

`dsh plugin add` 会 `pnpm add` 并把声明了 `dsh.bundle` 的本包 reconcile 进
`web` profile 的 bundles；同一行也会被 `client-modules` 的 `dsh.client` 扫描发现，
从而把 `lib/client.js` 挂进 `__DSH_BOOT__`。重启 `dsh --profile web` 后生效。

## 5. 深入：client 面怎么实现的

严格走 DSH 的 **slot 架构**，没有 patch 任何核心插件：

1. `apply(ctx)` 里用 `ctx.slots.inject('shell.overlay', …)` 往 `shell.overlay`
   （layout 插件声明的**全局浮动层** list slot，additive、不会遮蔽既有界面）
   追加一条组件。
2. 该组件在 `document` 上挂 `contextmenu` 监听：命中会话行（`[role="treeitem"]`）
   时吞掉原生右键菜单，按行内展示的 `displayTitle` 反查
   `useSessions((s) => s.byId)` 得到 session id。
3. 用 primitives 的 `Menu`（`portal` + `getAnchorRect`，在右键坐标处定位）渲染
   「复制 session id」，选中后 `writeClipboard` 写剪贴板，`Toast` 反馈。

**为什么用 document 右键监听而不是给会话行加菜单项**：workspace 插件的会话行
“…” 菜单是内部硬编码的，**没有** per-session 注入点，会话行 DOM 也没有
`data-session-id` 属性（id 只出现在 drag 的 `dataTransfer` 里）。因此
`shell.overlay` + 右键监听是目前**唯一**不用 patch 核心插件、又能实现“右键复制”
的 additive 手法。

**已知取舍**：行→id 靠匹配 `displayTitle`。对无标题会话，`displayTitle` 会回落成
session id，通常能精确命中；极端情况（标题重复 / 多个空白“新会话”行）取第一个
匹配。若你希望**完全精确、零歧义**，在 workspace 插件的会话行 `<div>` 上补一个
`data-session-id={node.id}` 即可（那需要 patch DSH 核心插件，超出本插件范围）。

## 6. 深入：host 面怎么实现

`cordis.patch.yml` 把一个 `@linjianyu/dsh-web-ui-enhance` 行插进 web profile 的
Loader；该包同时承载 client 面 => client-modules 才能发现它的浏览器 bundle。

host 面注册两条命令：

- `/webui-session-id`：输出当前 agent 的 `session.id`。
- `/webui-session-ref <id>`：用 `ctx.sessionReferenceResolver.listCandidates`
  校验目标会话存在，再 `encodeSessionReferenceUri` + `formatSessionReferenceMention`
  生成 `@[label](dsh-session:…)` 引用。

真正“读取被引会话的上下文”由 DSH 核心的 session-reference 快照机制完成（只读、
带来源、受预算约束），本插件不重复实现，只负责把 id 做成合法引用。

## 7. 测试

```sh
cd packages/web-ui-enhance
node --test tests/
```

- `tests/host.test.mjs` —— host 命令的注册、参数解析、`/webui-session-ref` 对
  命中 / 未命中 / 缺参的处理（mock commands + sessionReferenceResolver）。
- `tests/client-resolve.test.mjs` —— `resolveSessionId` 反解算法的行为契约镜像
  （TS 源在浏览器里跑，这里用纯 JS 镜像做回归保护）。

## 8. 后续扩展位

- 复制后直接“复制会话引用 URI”（`dsh-session:…`）而不是裸 id；
- 右键菜单增加“在新会话打开该会话的只读快照”等动作；
- 若后续 DSH 为会话行开放 `data-session-id` 或 per-session 动作 slot，可改走
  更精确的注入点，消除 `displayTitle` 匹配的歧义。
