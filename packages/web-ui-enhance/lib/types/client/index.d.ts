/**
 * @linjianyu/dsh-web-ui-enhance —— client 面类型。
 * 浏览器端 cordis 插件：右键会话行 → 「复制 session id」。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client';

/** locale 命名空间键。 */
export declare const NS = 'webui';
/** 浏览器端需注入的服务：slots / sessions / locale。 */
export declare const inject: string[];
/** overlay 组件接收的 props（全局标准件 + locale）。 */
export declare interface OverlayProps {
  useSessions: (sel: (s: SessionListState) => unknown) => unknown;
  t: (key: string, params?: Record<string, unknown>) => string;
}
/**
 * 从一行 `[role="treeitem"]` DOM 反解 target session id。
 * @internal
 */
export declare function resolveSessionId(
  row: HTMLElement,
  byId: Record<SessionId, SessionSummary>,
  t: (key: string, params?: Record<string, unknown>) => string,
): SessionId | null;
/**
 * 挂载浏览器端入口：注册 shell.overlay 附加条目 + locale。
 * @param ctx - client root context。
 */
export declare function apply(ctx: ClientContext): void;
