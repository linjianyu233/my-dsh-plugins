/**
 * @linjianyu/dsh-web-ui-enhance —— Web UI 增强（host/agent 面）。
 *
 * 与 client 面对应：client 面负责「右键会话 → 复制 session id」；host 面负责把
 * 复制出来的 session id 变成 agent 真正能跨 session 读取上下文的能力：
 *
 * 命令：
 *   /webui-session-id                    输出当前会话自己的 id（方便分享给别人）
 *   /webui-session-ref <sessionId>       校验目标会话存在，并给出可直接粘贴的
 *                                        `@[label](dsh-session:…)` 引用（被引会话的
 *                                        上下文会在下一条用户消息里作为快照注入）
 * 工具：
 *   session_context_read(session_id)     给 model 一个工具：输入从 webui 复制的
 *                                        session id，直接用 web-app 内置的
 *                                        ctx.sessionQuery.readSurface 读出该会话
 *                                        当前可读上下文（用户/助手消息），跨工作区、
 *                                        无需 seq，专用于“拿到 id 就看整段”的问题定位。
 *
 * 原则：全部逻辑收在本插件（经 dsh.bundle.patch 由 `dsh plugin add` 装入，成为
 * loader entry），不修改任何官方 profile 配置。
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query';
import {
  encodeSessionReferenceUri,
  formatSessionReferenceMention,
} from '@deepseek-ai/dsh-session-reference';

export const name = 'web-ui-enhance';
// 只硬依赖 commands；tools / sessionQuery / sessionReferenceResolver 一律按需
// 用 ctx.get 取，缺任何服务都不拖挂整个 bundle（连带 client 面）。
export const inject = ['commands'];

const REFERENCED = [
  '跨 session 引用使用说明：',
  '- 输出当前会话 id：`/webui-session-id`（把结果给别的会话，让对方引用你）',
  '- 引用别的会话：`/webui-session-ref <targetSessionId>`，把返回的 `@[…]` 引用贴进消息。',
  '- DSH 会把被引会话做成只读快照注入，见 @deepseek-ai/dsh-session-reference。',
].join('\n');

/**
 * 解析一条命令的原始输入：取第一个非空 token 作为目标会话 id；支持整体
 * 粘贴包含 URI 前缀（`dsh-session:...`）的场景，剥掉前缀。
 */
function parseSessionId(rawInput) {
  const tok = (rawInput ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? '';
  return tok.replace(/^dsh-session:/, '').trim();
}

/** 挂载 host 面的两条命令。 */
function registerCommands(ctx) {
  // /webui-session-id —— 报告当前会话自己的 id。无参数命令，不声明 input。
  ctx.commands.register({
    name: 'webui-session-id',
    description: '输出当前会话的 session id（跨 session 分享用）',
    handler: (invocation) => ({
      kind: 'success',
      text: `当前会话 id：\n${invocation.agent.session.id}\n\n${REFERENCED}`,
    }),
  });

  // /webui-session-ref <sessionId> —— 校验并把裸 id 转成可粘贴的跨会话引用。
  ctx.commands.register({
    name: 'webui-session-ref',
    description: '把 session id 变成可跨会话引用的快照引用',
    input: { hint: '<sessionId>' },
    handler: async (invocation) => {
      const target = parseSessionId(invocation.rawInput);
      if (!target) {
        return { kind: 'error', text: 'missing <sessionId>. Usage: /webui-session-ref <sessionId>' };
      }
      const resolver = ctx.get?.('sessionReferenceResolver');
      if (!resolver || typeof resolver.listCandidates !== 'function') {
        return {
          kind: 'error',
          text: 'session-reference 服务未启用（dsh-session-reference）。请让 web profile 装载它后再试。',
        };
      }
      const [candidate] = (await resolver.listCandidates(invocation.agent, target, 20)) ?? [];
      if (candidate === void 0) {
        return {
          kind: 'error',
          text: `找不到会话「${target}」。可能该会话不在此 profile，或 id 输入不完整。`,
        };
      }
      const uri = encodeSessionReferenceUri(candidate.sessionId);
      const mention = formatSessionReferenceMention({
        sessionId: candidate.sessionId,
        label: candidate.label,
      });
      return {
        kind: 'success',
        text: [
          `目标会话：${candidate.sessionId}`,
          `标题：${candidate.label}`,
          `引用 URI：\`${uri}\``,
          `可直接粘贴的引用：${mention}`,
          '把它粘进下一条用户消息，DSH 就会注入该会话的快照。',
        ].join('\n'),
      };
    },
  });
}

/** 挂载 host 面：注册命令（命令注册到当前 fiber，unload 时自动注销）。 */
export function apply(ctx) {
  registerCommands(ctx);
  registerTools(ctx);
}

// 供测试/第三方使用：解析 /webui-session-ref 的输入。
export { parseSessionId };

/**
 * 把 session-query 读出的当前表层事件（SurfaceEvent[]）格式化为模型可读文本。
 * 每个事件按角色/类型加上标签，再输出 `extractSessionEventText` 提取的正文。
 * @param events - `ctx.sessionQuery.readSurface(surface).events` 的数组。
 * @param maxChars - 预算上限（默认 8000）；超出的部分截断并注明。
 * @returns 纯文本形式的目标会话上下文。
 */
export function formatSessionSurface(events, maxChars = 8000) {
  const lines = [];
  for (const event of events ?? []) {
    const role = event.type === 'user/message' ? 'USER' : event.type === 'assistant/message' ? 'ASSISTANT' : event.type;
    const text = extractSessionEventText(event) ?? '';
    if (text.trim() === '' && role !== 'USER' && role !== 'ASSISTANT') continue;
    lines.push(`[${role}] ${text.trim()}`);
  }
  let out = lines.join('\n');
  const cap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 8000;
  if (out.length > cap) {
    out = `${out.slice(0, cap)}\n…[已按 ${cap} 字符截断]`;
  }
  return out;
}

/** 注册 agent 工具：session_context_read —— 按 session id 直接读会话可读上下文。 */
function registerTools(ctx) {
  const tools = ctx.get?.('tools');
  if (!tools || typeof tools.register !== 'function') return;

  tools.register(defineTool({
    name: 'session_context_read',
    description: 'Read another session\'s readable context by its session id. Extracts the current user/assistant messages of the target session (across workspaces, no sequence number needed). Use for cross-session collaboration and issue triage when you hold a copied session id.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target session id (paste from the sidebar right-click \'复制 session id\', or from /webui-session-ref).' },
      max_chars: { type: 'integer', description: 'Optional output budget in characters. Default 8000.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // output schema 是 string：execute 必须返回普通字符串；出错用 throw。
      const idRaw = String(args.session_id ?? '').trim().replace(/^dsh-session:/, '');
      if (!idRaw) throw new Error('missing session_id');
      const sessionQuery = ctx.get?.('sessionQuery');
      if (!sessionQuery || typeof sessionQuery.readSurface !== 'function') {
        throw new Error('session-query 服务不可用（session-query-sqlite 未装载）。');
      }
      const surface = await sessionQuery.readSurface(SessionId(idRaw), exec?.signal);
      const body = formatSessionSurface(surface.events, Number(args.max_chars) || undefined);
      const header = surface.session;
      const meta = [`目标会话 ${idRaw}`];
      if (header.cwd) meta.push(`工作目录：${header.cwd}`);
      meta.push(`事件数：${surface.events.length}`);
      return `${meta.join('\n')}\n\n${body || '(无可读上下文)'}`;
    },
  }));
}

export const Config = z.object({});
