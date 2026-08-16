---
name: dsh-web-cdp-inspect
description: >-
  通过 Chrome DevTools Protocol (CDP) 拿 DSH Web UI 的真实 DOM / computed style，
  用于定位或验证「纯 CSS 头痛症」——尤其是给 DSH Web 写移动端适配、又要命中
  CSS Module 哈希类名 / 无法用现有选择器定位的节点时。当你发现靠读源码猜不出
  某个元素的真实布局、某个选择器到底命中没命中、`:has()`/`:is()` 等现代选择器
  在目标浏览器里是否合法时，用本 skill 组织执行。也用于在 WSL 里调试 Windows 侧
  Chrome、从而间接观察手机端渲染的替代手段。
disable-model-invocation: false
user-invocable: true
---

# DSH Web UI 用 CDP 拿真实 DOM / computed style 调试

给 DSH Web 写 CSS 适配时，最大的坑是**所有组件都用 CSS Module**：类名是哈希
（如 `uV2eYG_row`），`grep` 源码只能看到 `.row` 这种逻辑名，却无法从最终渲染里
反推元素到底有哪些稳定锚点可命中。本 skill 用 CDP 直接连上浏览器，把真实 DOM、
computed style、`getBoundingClientRect()` 几何原原本本读出来，终结猜测。

## 何时使用

- 你在给 `@linjianyu/dsh-web-ui-enhance`（或任意 DSH client 插件）写移动端 CSS，
  想命中某个元素却不知道该用什么选择器（稳定属性？语义标签？`data-*`？哈希类名？）。
- 你写了一个选择器，但不确认它**到底命中了哪些元素**、或命中的对不对。
- 你想验证 `:has()` / `:is()` / `:where()` 等现代选择器在目标浏览器里是否合法。
- 布局问题反复修不好、肉眼（截图/对方反馈）和源码推导对不上，需要「眼见为实」。

## 前置条件

1. **DSH Web 已在 `127.0.0.1:<port>` 跑起来**（无论是否经 Tailscale Serve 暴露）。
   CDP Chrome 直接访问这个 loopback 地址即可。
2. **有可用的 Chrome/Chromium**。DSH 常在 WSL 里跑，而浏览器常装在 Windows 侧，
   此时要用 Windows Chrome 的完整路径，例如
   `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`。
3. **Node ≥ 22**（带全局 `WebSocket`，无需任何 npm 依赖）。

## 标准流程

### 第 1 步：用 CDP 端口启动 headless Chrome

```sh
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
mkdir -p /tmp/chrome-profile
nohup "$CHROME" --headless=new --disable-gpu --no-sandbox \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-profile \
  --window-size=390,844 \
  "http://127.0.0.1:3080/" > /tmp/chrome-cdp.log 2>&1 &
sleep 8
```

要点：
- `--headless=new` 走新版无头，支持现代 CSS（含 `:has()`）。
- `--window-size=390,844` 模拟手机竖屏视口（配合 CSS 的 `@media (max-width:720px)`）。
  注意 headless 的 `window.innerWidth` 会略小于 `--window-size`（有滚动条等），
  以页面里 `window.innerWidth` 实测为准。
- `--user-data-dir` 给个独立目录，避免和日常 Chrome 冲突。
- 在 WSL 里调用 Windows Chrome 时，`--dump-dom`/`--screenshot` 的 stdout 重定向
  **不可靠**（常拿到空），CDP 是唯一稳定的通道。这就是本 skill 存在的理由。

验证 CDP 起来了：

```sh
curl -s --noproxy '*' http://127.0.0.1:9222/json/version   # 有 Chrome 版本号即成功
curl -s --noproxy '*' http://127.0.0.1:9222/json           # 列出所有 tab
```

### 第 2 步：找到 DSH 页面的 ws URL

`curl .../json` 的输出里，**`url` 是 `http://127.0.0.1:3080/`、`title` 是
"DeepSeek Harness" 的那一条**，取其 `webSocketDebuggerUrl`：

```sh
curl -s --noproxy '*' http://127.0.0.1:9222/json \
  | grep -B2 -A4 '"url": "http://127.0.0.1:3080/"'
```

### 第 3 步：用 `cdp-eval.mjs` 在页面上下文执行 JS

用本 skill 目录下的 `cdp-eval.mjs`（通用工具，把表达式通过 CDP 塞进页面全局
作用域执行，等价于 DevTools Console）：

```sh
node .agents/skills/dsh-web-cdp-inspect/cdp-eval.mjs <ws-url> <expr 文件>
# 或从 stdin 传多行表达式：
node .agents/skills/dsh-web-cdp-inspect/cdp-eval.mjs <ws-url> -
```

表达式**在页面上下文**执行，可访问 `window` / `document` / `getComputedStyle` /
`getBoundingClientRect` 等。请用 `return JSON.stringify(...)` 回传结构化结果。

#### 最常用的几类探针

**探针 A：某个元素的「祖先链 + 每层 computed 布局」** —— 定位"该命中哪个容器"：

```js
(() => {
  const el = document.querySelector('[data-slot="conversation.input.model"]');
  const chain = [];
  let p = el, i = 0;
  while (p && i < 10) {
    chain.push({
      tag: p.tagName,
      cls: (p.className || '').slice(0, 40),
      display: getComputedStyle(p).display,
      flexDir: getComputedStyle(p).flexDirection,
      flexWrap: getComputedStyle(p).flexWrap,
      flexBasis: getComputedStyle(p).flexBasis,
      boxW: Math.round(p.getBoundingClientRect().width),
      boxY: Math.round(p.getBoundingClientRect().y),
    });
    p = p.parentElement; i++;
  }
  return JSON.stringify(chain, null, 0);
})()
```

**探针 B：一个选择器到底命中几个元素、它们是啥**：

```js
(() => {
  const q = (sel) => {
    try {
      return [...document.querySelectorAll(sel)].map(e => ({
        tag: e.tagName, cls: (e.className || '').slice(0, 40),
        flexWrap: getComputedStyle(e).flexWrap,
      }));
    } catch (err) { return [{ ERR: err.message }]; }  // 非法选择器会在这里暴露
  };
  return JSON.stringify({
    single: q('[data-composer-seat] :has(> [data-slot="conversation.input.model"])'),
    nested: q('[data-composer-seat] :has(> :has(> [data-slot="conversation.input.model"]))'),
  });
})()
```

**探针 C：验证某条 CSS 规则是否真的生效**（改完样式后，确认 computed 值变了）：

```js
(() => {
  const row = document.querySelector('[data-composer-seat] .uV2eYG_row');
  return JSON.stringify({ flexWrap: getComputedStyle(row).flexWrap });
})()
```

### 第 4 步：改完 CSS 后验证

改 `mobile.css.ts` 后：
1. `pnpm run build:client` 重新打包 → `lib/client.js` 更新。
2. 重启 DSH（让它重算 bundle 的 `rev`），或若 HMR watcher 在跑则自动。
3. **让 CDP Chrome 重新加载页面**（新 bundle 才会进浏览器）。可以用另一条
   `Runtime.evaluate` 执行 `location.reload()`，或干脆杀掉 Chrome 重开。
4. 再用探针 C 验证 computed 值。

## 关键经验（踩过的坑，务必记住）

1. **`:has()` 不能嵌套**：`A :has(> :has(...))` 是**非法选择器**（Chromium 直接
   `is not a valid selector`）。`:has()` 的参数只能是一个简单选择器（可带 `>` 等
   组合器 + 简单选择器），不能是另一个 `:has()`。所以**无法**用 `:has()` 从某个
   数据属性/语义锚点「回溯两层」命中祖先。需要回溯多层时，改用：
   - 更外层元素已知的稳定锚点（`data-slot` / `aria-*` / 语义标签）；
   - 或直接命中该元素的 CSS Module 哈希类名（见下条，代价是可维护性）。
2. **CSS Module 哈希类名是「最后的锚点」**：`grep` 源码看到 `.row`，渲染后是
   `uV2eYG_row`（前缀是 `InputBar.module.css` 的哈希）。哈希对同一 DSH 版本是
   稳定的，但**升级 DSH 会变**。命中哈希类名时要写注释说明「对应 rc.6 的哪张
   module、升级后需复核」，并优先用稳定锚点（`data-slot`/`aria-*`）兜底。
3. **slot 框架会给每个 slot 渲染包一层 `<div data-slot="<slot名>">`，且
   `display:contents`**：这意味着 `data-slot` 是**极好的稳定锚点**（不会被哈希），
   但它自己**不产生盒子**（`display:contents`），它的子元素才是真正参与 flex 布局
   的项。用 `data-slot` 选中后若要改布局，注意 `display:contents` 的影响：
   - `data-slot` div 的 `getBoundingClientRect()` 是 0×0（没有盒子）；
   - 它仍是 DOM 里父容器的**直接子级**，所以 `:has(> [data-slot=…])` 能精确命中
     该 slot 的**直接父容器**（合法的单层 `:has()`）。
4. **模型名选择器不是 `<select>`**：`ui-model-selection` 的 ModelSelect 是
   `<button aria-haspopup="menu">`（自定义 trigger），权限选择（PermissionSelect）
   也有 trigger 但**没有** `aria-haspopup`。所以 `button[aria-haspopup="menu"]` 能
   唯一命中模型名。这类「哪个元素是什么标签」只能靠 CDP 探针确认，看源码易被
   语义命名误导（类名叫 `.select` 却可能不是 `<select>`）。
5. **WSL ↔ Windows 的 curl/headless 有坑**：`curl` 默认会走 `http_proxy`
   （WSL 常设 `http_proxy=http://127.0.0.1:7897`），访问本机 loopback 要加
   `--noproxy '*'`，否则会拿到假 502。`--dump-dom`/`--screenshot` 的 stdout
   重定向到 WSL 文件不可靠，CDP 是唯一稳的。

## 收尾

```sh
# 关掉 headless Chrome（注意 pkill 模式别匹配到自己的命令行）
pkill -f 'remote-debugging-port=9222'
```

## 相关文件

- 本工具：`.agents/skills/dsh-web-cdp-inspect/cdp-eval.mjs`
- 移动端适配 CSS（本 skill 的直接产物/消费方）：
  `packages/web-ui-enhance/src/client/mobile.css.ts`
