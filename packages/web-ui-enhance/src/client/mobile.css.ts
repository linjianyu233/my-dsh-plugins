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

export const MOBILE_CSS_ID = 'webui-mobile-css'

export const mobileCss = /* css */ `
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
     :has() 从 model slot 回溯两级命中 toolbar 行 .row。改用两件事：
     a) .row（toolbar 行）设 flex-wrap: wrap —— 用 rc.6 的 CSS Module 哈希类名
        uV2eYG_row 直接命中（未来 DSH 升级若改这组哈希需复核；类名前缀
        uV2eYG 是 InputBar.module.css 的哈希）。
     b) .trailing（模型名+上下文+发送右组）用已验明合法的单层
        ":has(> [data-slot=\"conversation.input.model\"])" 命中，设 flex:1 1 100%
        独占换行后的第二行。
     这样加号/权限留在第一行，模型名组换到第二行，互不重叠。 */
  [data-composer-seat] .uV2eYG_row {
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
