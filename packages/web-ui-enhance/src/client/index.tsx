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
import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Menu,
  Toast,
  writeClipboard,
  IconCopyOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { ClientContext, SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client';
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots';
import { mobileCss, MOBILE_CSS_ID } from './mobile.css';

/** locale 命名空间（与 `apply()` 里 `locale.register` 的键一致）。 */
export const NS = 'webui';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    webui: 'copySessionId' | 'copied' | 'copiedSessionId' | 'session.new';
  }
}

/** 会话树行选择器（workspace 的会话树 row、搜索结果 row、项目 row 都是 treeitem）。 */
const SESSION_ROW_SELECTOR = '[role="treeitem"]';

interface ContextMenuState {
  sessionId: SessionId;
  x: number;
  y: number;
}

/**
 * 从一行被打中的 `[role="treeitem"]` DOM 里反解 session id。
 * workspace 沿 `displayTitle(node, t)` 决定行内标题：空白会话显示 `t("session.new")`，
 * 否则显示 `node.title`，缺省再回落成 session id。这里用同样的口径做反查。
 */
function resolveSessionId(
  row: HTMLElement,
  byId: Record<string, SessionSummary>,
  t: (key: string, params?: Record<string, unknown>) => string,
): SessionId | null {
  // 优先取行内的标题 span：workspace 会给每个 row 一个 class 含 "title" 的 span。
  const titleEl = row.querySelector(':scope [class*="title"]') as HTMLElement | null;
  const text = (titleEl?.textContent ?? row.textContent ?? '').trim();
  if (!text) return null;
  // 1) 文本本身就是 byId 的 key（无标题会话 displayTitle 回落成 id）。
  const direct = byId[text];
  if (direct) return direct.id;
  // 2) 按 displayTitle 匹配（含空白会话的 "session.new" 标签）。
  const blankLabel = t('session.new');
  for (const s of Object.values(byId)) {
    const label = s.blank ? blankLabel : s.displayTitle;
    if (label === text) return s.id;
  }
  return null;
}

/** overlay 组件接收的 props：全局标准件 + locale。 */
interface OverlayProps {
  useSessions: SnapshotSelectorHook<SessionListState>;
  t: PropsLocale<typeof NS>['t'];
}

/**
 * 内部子组件：一次性接管右键菜单，渲染浮动 Menu 与复制反馈。
 * shell.overlay 层是 click-through 的，Menu 用 portal 弹到 body（自带
 * pointer-events），Toast 仅展示，均不影响底层交互。
 */
function CopySessionIdOverlay({ useSessions, t }: OverlayProps): ReactElement | null {
  const state = useRef<ContextMenuState | null>(null);
  const byId = useSessions((s: SessionListState) => s.byId);
  const [phase, setPhase] = useState<'idle' | 'open' | 'copied'>('idle');
  const [at, setAt] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const toastTimer = useRef<number | undefined>(undefined);

  // 匹配依赖 byId 的引用在每次渲染更新时跟随。
  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const row = target.closest<HTMLElement>(SESSION_ROW_SELECTOR);
      if (row === null) return;
      const sessionId = resolveSessionId(row, byId, t);
      if (!sessionId) return;
      event.preventDefault();
      event.stopPropagation();
      state.current = { sessionId, x: event.clientX, y: event.clientY };
      setAt({ x: event.clientX, y: event.clientY });
      setPhase('open');
    }
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [byId, t]);

  useEffect(() => () => {
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
  }, []);

  const id = state.current?.sessionId;
  if (phase === 'idle' || id === undefined) return null;

  const close = () => {
    state.current = null;
    setPhase('idle');
  };

  const copy = () => {
    void writeClipboard(String(id)).then((ok) => {
      if (!ok) return;
      setPhase('copied');
      if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setPhase('idle'), 1500);
    });
  };

  if (phase === 'copied') {
    return <Toast key={id} text={t('copiedSessionId', { id: String(id) })} onDone={() => setPhase('idle')} />;
  }

  return (
    <div style={{ position: 'fixed', left: at.x, top: at.y, width: 0, height: 0, zIndex: 30 }}>
      <Menu
        open
        portal
        align="start"
        side="bottom"
        getAnchorRect={() => new DOMRect(at.x, at.y, 0, 0)}
        onSelect={(selected) => {
          if (selected === 'copy') copy();
          else close();
        }}
        onClose={close}
        anchor={<span aria-hidden style={{ display: 'none' }} />}
        items={[
          {
            id: 'copy',
            label: t('copySessionId'),
            icon: <IconCopyOutline16 />,
          },
        ]}
      />
    </div>
  );
}

/**
 * Client 插件入口：把 `<CopySessionIdOverlay/>` 作为一条 `shell.overlay`
 * 附加条目注册进去（list slot 本来就是 additive 的）。
 *
 * @param ctx - client root context（带 slots / sessions / locale 等服务）。
 */
export function apply(ctx: ClientContext): void {
  // 移动端 UI 适配：把响应式样式注入 <head>，fiber unload 时随 effect 清理移除。
  ctx.effect(() => {
    const style = document.createElement('style');
    style.id = MOBILE_CSS_ID;
    style.textContent = mobileCss;
    document.head.appendChild(style);
    return () => {
      const node = document.getElementById(MOBILE_CSS_ID);
      if (node !== null) node.remove();
    };
  }, 'web-ui-enhance: mobile css');

  ctx.effect(
    () =>
      ctx.locale.register(NS, {
        en: {
          copySessionId: 'Copy session id',
          copied: 'Copied',
          copiedSessionId: 'Copied session id: {id}',
          'session.new': 'New Session',
        },
        zh: {
          copySessionId: '复制 session id',
          copied: '已复制',
          copiedSessionId: '已复制 session id：{id}',
          'session.new': '新会话',
        },
      }),
    'web-ui-enhance: locale',
  );

  ctx.slots.inject(
    'shell.overlay',
    () =>
      ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'web-ui-enhance.copy-session-id',
          order: 100,
          locale: NS,
        },
        CopySessionIdOverlay,
      ),
    'web-ui-enhance: sidebar copy-session-id',
  );
}

export const inject = ['slots', 'sessions', 'locale'];
