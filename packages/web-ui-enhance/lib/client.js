window.__ModuleLoader__.load({
	id: "@linjianyu/dsh-web-ui-enhance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/mobile.css.ts
		/**
		* @linjianyu/dsh-web-ui-enhance —— 移动端 UI 适配样式（client 面）。
		*
		* 作为纯字符串导出，由 `index.tsx` 在 `apply()` 里经 `ctx.effect` 注入到
		* `document.head` 的一个 `<style id="webui-mobile-css">` 中；fiber unload 时
		* 随 effect 清理一并移除，不留残留。
		*
		* 为什么「覆盖 CSS 变量」而不是改 hashed class：
		* 整个 DSH Web UI 的字号都走定义在 `body` 上的 `--dsw-font-*` token（见
		* ui-theme 的 gradient-shadow-text.css），几乎每一处 `font: var(--dsw-font-…)`
		* 都从这些 token 取值。在移动端改这些 token，等价于全局等比例缩放整套字体，
		* 无需逐条命中 CSS Module 的哈希类名，也不会因上游改类名而失效。字体族、
		* 字重、颜色等一律不动，只收字号与行高，视觉层级保持不变。
		*
		* 关于「布局」的处理（两档策略）：
		* AppFrame 的列求解器（ui-layout columns.ts）本身已是响应式的——
		*   - 视口 < 1024px 时侧边栏自动折叠为 56px 图标栏（SIDEBAR_AUTO_COLLAPSE）；
		*   - 详情列在放不下时自动关闭（concession chain 的 step 3），中心列吃满剩余宽度。
		* 因此「三列结构」无需干预。真正的移动端痛点在两处，本文件分别修复：
		*   1) 桌面级字号在小屏过大 → 覆盖 body 上的 --dsw-font-* token 等比缩号；
		*   2) 窄屏下 header / 内容区溢出堆叠、长内容被裁且不能横向滚动 → 用语义标签
		*      （<header>/<nav>）+ data-* 属性（data-conversation-scroll /
		*      data-composer-seat / data-phase）这些 CSS Module 哈希不了的稳定锚点，
		*      精准打开横向滚动、收紧留白、防 flex 溢出。全部用 !important 压过组件规则。
		*
		* 断点：
		* - `@media (max-width: 720px)`  手机竖屏（含大屏手机）：字号降档 + 布局修复。
		* - `@media (max-width: 1024px)` 平板 / 横屏手机：仅对 markdown 正文做温和收紧。
		*
		* 说明：本插件 client bundle 走最朴素的 tsdown（无 css inline plugin，README 已
		* 说明），因此此处以 TS 字符串导出 CSS（mobile.css.ts），不做 `.css` import。
		*/
		const MOBILE_CSS_ID = "webui-mobile-css";
		const mobileCss = `
/* ----------------------------------------------------------------------------
   手机竖屏（≤720px）：把整套字号等比下调一档，解决「字体太大」。
   只覆盖 body 上的 --dsw-font-* token（这些 token 仅此一份定义）。
---------------------------------------------------------------------------- */
@media (max-width: 720px) {
  body {
    /* markdown 正文：16/28 → 15/24 */
    --dsw-font-markdown-base: 15px/24px var(--dsw-font-family);
    --dsw-font-markdown-base-font-size: 15px;
    --dsw-font-markdown-base-line-height: 24px;
    --dsw-font-markdown-base-strong: 600 15px/24px var(--dsw-font-family);
    --dsw-font-markdown-base-strong-font-size: 15px;
    --dsw-font-markdown-base-strong-line-height: 24px;
    --dsw-font-markdown-base-italic: italic 15px/24px var(--dsw-font-family);
    --dsw-font-markdown-base-italic-font-size: 15px;
    --dsw-font-markdown-base-italic-line-height: 24px;
    --dsw-font-markdown-base-strong-italic: italic 600 15px/24px var(--dsw-font-family);
    --dsw-font-markdown-base-strong-italic-font-size: 15px;
    --dsw-font-markdown-base-strong-italic-line-height: 24px;

    /* markdown 标题逐级略降，避免小屏上标题压迫正文 */
    --dsw-font-markdown-h1: 700 21px/30px var(--dsw-font-family);
    --dsw-font-markdown-h1-font-size: 21px;
    --dsw-font-markdown-h1-line-height: 30px;
    --dsw-font-markdown-h2: 700 19px/28px var(--dsw-font-family);
    --dsw-font-markdown-h2-font-size: 19px;
    --dsw-font-markdown-h2-line-height: 28px;
    --dsw-font-markdown-h3: 700 17px/26px var(--dsw-font-family);
    --dsw-font-markdown-h3-font-size: 17px;
    --dsw-font-markdown-h3-line-height: 26px;
    --dsw-font-markdown-h4: 600 15px/24px var(--dsw-font-family);
    --dsw-font-markdown-h4-font-size: 15px;
    --dsw-font-markdown-h4-line-height: 24px;

    /* 表格 / small 同步 */
    --dsw-font-markdown-table: 14px/22px var(--dsw-font-family);
    --dsw-font-markdown-table-font-size: 14px;
    --dsw-font-markdown-table-line-height: 22px;
    --dsw-font-markdown-table-head: 500 14px/22px var(--dsw-font-family);
    --dsw-font-markdown-table-head-font-size: 14px;
    --dsw-font-markdown-table-head-line-height: 22px;
    --dsw-font-markdown-small: 13px/22px var(--dsw-font-family);
    --dsw-font-markdown-small-font-size: 13px;
    --dsw-font-markdown-small-line-height: 22px;
    --dsw-font-markdown-small-strong: 600 13px/22px var(--dsw-font-family);
    --dsw-font-markdown-small-strong-font-size: 13px;
    --dsw-font-markdown-small-strong-line-height: 22px;

    /* 代码块 13/22 → 12/20；小号 12/18 → 11/17 */
    --dsw-font-markdown-code: 13px/20px var(--ds-font-family-code);
    --dsw-font-markdown-code-font-size: 13px;
    --dsw-font-markdown-code-line-height: 20px;
    --dsw-font-markdown-code-block: 12px/20px var(--ds-font-family-code);
    --dsw-font-markdown-code-block-font-size: 12px;
    --dsw-font-markdown-code-block-line-height: 20px;
    --dsw-font-markdown-code-block-small: 11px/17px var(--ds-font-family-code);
    --dsw-font-markdown-code-block-small-font-size: 11px;
    --dsw-font-markdown-code-block-small-line-height: 17px;

    /* 通用 UI 字号 token 整体降一档 */
    --dsw-font-base-16: 15px/23px var(--dsw-font-family);
    --dsw-font-base-16-font-size: 15px;
    --dsw-font-base-16-line-height: 23px;
    --dsw-font-base-strong-16: 500 15px/23px var(--dsw-font-family);
    --dsw-font-base-strong-16-font-size: 15px;
    --dsw-font-base-strong-16-line-height: 23px;
    --dsw-font-s-14: 13px/20px var(--dsw-font-family);
    --dsw-font-s-14-font-size: 13px;
    --dsw-font-s-14-line-height: 20px;
    --dsw-font-s-strong-14: 500 13px/20px var(--dsw-font-family);
    --dsw-font-s-strong-14-font-size: 13px;
    --dsw-font-s-strong-14-line-height: 20px;
    --dsw-font-xs-13: 12px/18px var(--dsw-font-family);
    --dsw-font-xs-13-font-size: 12px;
    --dsw-font-xs-13-line-height: 18px;
    --dsw-font-xs-strong-13: 500 12px/18px var(--dsw-font-family);
    --dsw-font-xs-strong-13-font-size: 12px;
    --dsw-font-xs-strong-13-line-height: 18px;
  }

  /* ==========================================================================
     布局修复（针对「控件堆叠 / 内容溢出 / 列宽过窄」四大痛点）。
     命中的都是 CSS Module 哈希不了的稳定锚点：语义 <header>/<nav> 标签、
     data-* 属性（data-chat-flow / data-conversation-scroll / data-composer-seat
     / data-phase）、aria-label、原生 <select>/<pre>。用 !important 压过组件规则。
     ======================================================================== */

  /* 2) 正文列加宽：ChatView 的 scroll 容器左右 padding 各 32px（16 + clearance），
     在手机上是「看几个字就换行」的直接元凶。用 :has(> [data-chat-flow]) 命中
     该 scroll（其直接子级含消息列 data-chat-flow），把左右留白压到 8px。 */
  :has(> [data-chat-flow]) {
    padding-left: 8px !important;
    padding-right: 8px !important;
  }

  /* 3) 代码块：从「pre-wrap 软换行」改为「pre 不换行 + 横向滑动」，长行不再
     折成好几段。代码块 pre 位于消息列（data-chat-flow）内。横向滚动只发生在
     pre 元素这一局部，不动整个 scrollBody（避免「右滑整片空白」）。 */
  [data-chat-flow] pre {
    white-space: pre !important;
    word-break: normal !important;
    overflow-wrap: normal !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
  }

  /* 4) 模型名选择器在手机单独一行。
     关键：CSS 的 :has() 不能嵌套（":has(> :has(...))" 是非法的），所以无法用
     :has() 从 model slot 回溯两级命中 toolbar 行 .row。改用两件事，全部用
     CSS Module 哈希不了的稳定锚点（不再碰哈希类名，DSH 升级也不易失效）：
     a) toolbar 行（承载左组 tools + 右组 trailing 的 flex 容器）设
        flex-wrap: wrap —— 用稳定属性 [data-composer-card] 精确命中该行：
        > [data-composer-card] > :has([data-slot="conversation.input.model"]) <
        是该行唯一匹配（它唯一的直接子级里含 model slot 的是 trailing），
        等价于旧哈希类 .uV2eYG_row（该哈希已变、不可依赖）。
     b) trailing 右组（模型名+上下文+发送）用已验明合法的单层
        ":has(> [data-slot=\"conversation.input.model\"])" 命中，设 flex:1 1 100%
        独占换行后的第二行。
     这样加号/权限留在第一行，模型名组换到第二行，互不重叠（实测：row
     nowrap 时 trailing 的 flex-basis:100% 会被压回同一行并溢出到发送键上，
     这正是重叠根因；a 的 wrap 让 trailing 真正换行）。 */
  [data-composer-card] > :has([data-slot='conversation.input.model']) {
    flex-wrap: wrap !important;
  }
  [data-composer-seat] :has(> [data-slot='conversation.input.model']) {
    flex: 1 1 100% !important;
    justify-content: flex-end;
    margin-top: 4px;
  }

  /* 模型名 trigger 按钮：独占一行后给充足宽度的上限，仍防过长溢出。 */
  [data-composer-seat] button[aria-haspopup='menu'] {
    max-width: 180px !important;
  }

  /* 6) 会话顶部 header 防堆叠：收紧桌面级左右 padding（原 12px 28px 0 20px）。 */
  [data-phase] > header {
    padding: 8px 12px 0 !important;
    min-width: 0;
  }

  /* 面包屑：窄屏收缩 + 省略，不给 titleRow 制造溢出。 */
  [data-phase] > header nav {
    max-width: 100%;
    min-width: 0;
    flex: 1 1 auto;
  }

  /* tabs 标签条：收紧 gap（原 36px）+ 可横向滚动。 */
  [data-phase] > header [role='tablist'] {
    gap: 16px !important;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}

/* ----------------------------------------------------------------------------
   平板 / 横屏手机（721~1024px）：仅对 markdown 正文做温和收紧。
   （布局壳在此区间已自动折叠侧边栏，无需额外干预。）
---------------------------------------------------------------------------- */
@media (min-width: 721px) and (max-width: 1024px) {
  body {
    --dsw-font-markdown-base: 15px/26px var(--dsw-font-family);
    --dsw-font-markdown-base-font-size: 15px;
    --dsw-font-markdown-base-line-height: 26px;
    --dsw-font-markdown-base-strong: 600 15px/26px var(--dsw-font-family);
    --dsw-font-markdown-base-strong-font-size: 15px;
    --dsw-font-markdown-base-strong-line-height: 26px;
  }
}
`;
		//#endregion
		//#region src/client/index.tsx
		/**
		* @linjianyu/dsh-web-ui-enhance —— Web UI 增强（client 面）。
		*
		* 第一个功能：在 Web UI 左侧会话树里「右键某个会话」，弹出一个上下文菜单，
		* 提供「复制 session id」。复制出来的 id 可以贴到另一个会话里，用于**跨 session
		* 协同 / 问题定位**（例如请另一个会话读取该 session 的上下文，见 README 的
		* 「如何使用复制出来的 session id」一节）。
		*
		* 实现要点（严格走 DSH 的 slot 架构）：
		*
		* - 注册进 `shell.overlay`（layout 插件声明的“全局浮动层” list slot；additive，
		*   不会遮蔽任何既有界面）。`shell.overlay` 是 root 作用域，因此组件的注入点
		*   只拿得到全局标准件 `useSessions`（`SessionListState` 快照）与 locale 的 `t`——
		*   没有 `sessionId`/`useSession`。
		* - 在 document 上挂一个 `contextmenu` 监听：命中会话行（`[role="treeitem"]`，
		*   workspace 插件的会话树 row）时吞掉原生右键菜单，按行内展示的 `displayTitle`
		*   反查 `useSessions((s) => s.byId)` 得到 session id，在光标处渲染 `Menu`。
		* - 选中「复制 session id」用 primitives 的 `writeClipboard`（带 execCommand 回退）
		*   写剪贴板；反馈直接在当前 overlay 里渲染，不依赖任何 toast 服务（DSH 并没有）。
		*
		* 已知取舍：
		* - workspace 插件内部硬编码了会话行的 “…” 菜单，且会话行 DOM 没有
		*   `data-session-id` 属性（id 只出现在 drag 的 dataTransfer 里）。因此这里用
		*   overlay + document 右键监听来增强，这既是 DSH 文档推荐的 additive 手法，
		*   也是目前**唯一**不对核心插件打补丁的可行路线。
		* - 行→id 靠匹配行内展示的 `displayTitle`：无标题会话 `displayTitle` 会回落成
		*   session id，因此通常能精确命中；极端情况下（标题重复 / 空白行）取第一个匹配。
		*
		* 若你希望**完全精确**（消除一切歧义），在 workspace 插件的会话行 `<div>` 上补一个
		* `data-session-id={node.id}` 即可（这需要 patch DSH 核心插件，见 README 的“进阶”）。
		*/
		/** locale 命名空间（与 `apply()` 里 `locale.register` 的键一致）。 */
		const NS = "webui";
		/** 会话树行选择器（workspace 的会话树 row、搜索结果 row、项目 row 都是 treeitem）。 */
		const SESSION_ROW_SELECTOR = "[role=\"treeitem\"]";
		/**
		* 从一行被打中的 `[role="treeitem"]` DOM 里反解 session id。
		* workspace 沿 `displayTitle(node, t)` 决定行内标题：空白会话显示 `t("session.new")`，
		* 否则显示 `node.title`，缺省再回落成 session id。这里用同样的口径做反查。
		*/
		function resolveSessionId(row, byId, t) {
			const text = (row.querySelector(":scope [class*=\"title\"]")?.textContent ?? row.textContent ?? "").trim();
			if (!text) return null;
			const direct = byId[text];
			if (direct) return direct.id;
			const blankLabel = t("session.new");
			for (const s of Object.values(byId)) if ((s.blank ? blankLabel : s.displayTitle) === text) return s.id;
			return null;
		}
		/**
		* 内部子组件：一次性接管右键菜单，渲染浮动 Menu 与复制反馈。
		* shell.overlay 层是 click-through 的，Menu 用 portal 弹到 body（自带
		* pointer-events），Toast 仅展示，均不影响底层交互。
		*/
		function CopySessionIdOverlay({ useSessions, t }) {
			const state = (0, react.useRef)(null);
			const byId = useSessions((s) => s.byId);
			const [phase, setPhase] = (0, react.useState)("idle");
			const [at, setAt] = (0, react.useState)({
				x: 0,
				y: 0
			});
			const toastTimer = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				function onContextMenu(event) {
					const target = event.target;
					if (!target) return;
					const row = target.closest(SESSION_ROW_SELECTOR);
					if (row === null) return;
					const sessionId = resolveSessionId(row, byId, t);
					if (!sessionId) return;
					event.preventDefault();
					event.stopPropagation();
					state.current = {
						sessionId,
						x: event.clientX,
						y: event.clientY
					};
					setAt({
						x: event.clientX,
						y: event.clientY
					});
					setPhase("open");
				}
				document.addEventListener("contextmenu", onContextMenu);
				return () => document.removeEventListener("contextmenu", onContextMenu);
			}, [byId, t]);
			(0, react.useEffect)(() => () => {
				if (toastTimer.current !== void 0) window.clearTimeout(toastTimer.current);
			}, []);
			const id = state.current?.sessionId;
			if (phase === "idle" || id === void 0) return null;
			const close = () => {
				state.current = null;
				setPhase("idle");
			};
			const copy = () => {
				(0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(String(id)).then((ok) => {
					if (!ok) return;
					setPhase("copied");
					if (toastTimer.current !== void 0) window.clearTimeout(toastTimer.current);
					toastTimer.current = window.setTimeout(() => setPhase("idle"), 1500);
				});
			};
			if (phase === "copied") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: t("copiedSessionId", { id: String(id) }),
				onDone: () => setPhase("idle")
			}, id);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					position: "fixed",
					left: at.x,
					top: at.y,
					width: 0,
					height: 0,
					zIndex: 30
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
					open: true,
					portal: true,
					align: "start",
					side: "bottom",
					getAnchorRect: () => new DOMRect(at.x, at.y, 0, 0),
					onSelect: (selected) => {
						if (selected === "copy") copy();
						else close();
					},
					onClose: close,
					anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": true,
						style: { display: "none" }
					}),
					items: [{
						id: "copy",
						label: t("copySessionId"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, {})
					}]
				})
			});
		}
		/**
		* Client 插件入口：把 `<CopySessionIdOverlay/>` 作为一条 `shell.overlay`
		* 附加条目注册进去（list slot 本来就是 additive 的）。
		*
		* @param ctx - client root context（带 slots / sessions / locale 等服务）。
		*/
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.id = MOBILE_CSS_ID;
				style.textContent = mobileCss;
				document.head.appendChild(style);
				return () => {
					const node = document.getElementById(MOBILE_CSS_ID);
					if (node !== null) node.remove();
				};
			}, "web-ui-enhance: mobile css");
			ctx.effect(() => ctx.locale.register(NS, {
				en: {
					copySessionId: "Copy session id",
					copied: "Copied",
					copiedSessionId: "Copied session id: {id}",
					"session.new": "New Session"
				},
				zh: {
					copySessionId: "复制 session id",
					copied: "已复制",
					copiedSessionId: "已复制 session id：{id}",
					"session.new": "新会话"
				}
			}), "web-ui-enhance: locale");
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "web-ui-enhance.copy-session-id",
				order: 100,
				locale: NS
			}, CopySessionIdOverlay), "web-ui-enhance: sidebar copy-session-id");
		}
		const inject = [
			"slots",
			"sessions",
			"locale"
		];
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map