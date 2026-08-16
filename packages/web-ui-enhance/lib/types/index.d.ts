/**
 * @linjianyu/dsh-web-ui-enhance —— host 面类型。
 * 提供跨 session 引用桥接命令（window.__DSH_BOOT__ 之外，agent/host 侧挂载）。
 */
import type { Context } from '@deepseek-ai/cordis';

export declare const name = 'web-ui-enhance';
/** Host 插件需注入的服务：命令注册（session-reference 按需 ctx.get）。 */
export declare const inject: string[];
/** 命令元数据（纯类型，运行时在 lib/index.js）。 */
export declare interface WebUIEnhanceConfig {
  [key: string]: unknown;
}
/**
 * 解析一条 `/webui-session-ref` 的输入，剥掉可选的 `dsh-session:` 前缀。
 * @param rawInput - 命令原始输入。
 * @returns 纯 session id（可能为空串）。
 */
export declare function parseSessionId(rawInput: string): string;
/**
 * 挂载 host 面的两条命令（/webui-session-id 与 /webui-session-ref）。
 * @param ctx - 带 commands + sessionReferenceResolver 的上下文。
 */
export declare function apply(ctx: Context): void;
export declare const Config: WebUIEnhanceConfig;
