/**
 * host 面单元测试：验证 /webui-session-id 与 /webui-session-ref 两条命令的
 * 注册、参数解析与返回结果（mock commands + sessionReferenceResolver，不依赖
 * 真实 DSH 运行时）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, parseSessionId, formatSessionSurface } from '../lib/index.js';
import {
  encodeSessionReferenceUri,
  formatSessionReferenceMention,
} from '@deepseek-ai/dsh-session-reference';

function makeContext(candidates = []) {
  const registered = new Map();
  const commands = {
    register(def) {
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  };
  const sessionReferenceResolver = {
    async listCandidates(_agent, query, _limit) {
      const q = (query ?? '').toLowerCase();
      return candidates.filter(
        (c) => c.sessionId.toLowerCase().includes(q) || c.label.toLowerCase().includes(q),
      );
    },
  };
  const ctx = {
    commands,
    sessionReferenceResolver,
    get: (name) => (name === 'sessionReferenceResolver' ? sessionReferenceResolver : undefined),
  };
  return { ctx, registered };
}

const sessionIdOf = () => 'in-session-1';
const agent = {
  session: { id: sessionIdOf() },
};

test('parseSessionId strips dsh-session: prefix and whitespace', () => {
  assert.equal(parseSessionId(''), '');
  assert.equal(parseSessionId('  sess-abc  '), 'sess-abc');
  assert.equal(parseSessionId('  dsh-session:InNlc3MtxQ==  '), 'InNlc3MtxQ==');
});

test('inject requests commands only (sessionReferenceResolver is ctx.get-optional)', () => {
  assert.deepEqual(inject, ['commands']);
});

test('registers both commands', () => {
  const { ctx, registered } = makeContext();
  apply(ctx);
  assert.ok(registered.has('webui-session-id'));
  assert.ok(registered.has('webui-session-ref'));
});

test('/webui-session-id returns the current session id', async () => {
  const { ctx, registered } = makeContext();
  apply(ctx);
  const result = registered.get('webui-session-id').handler({ agent, rawInput: '' });
  assert.equal(result.kind, 'success');
  assert.ok(result.text.includes(sessionIdOf()));
});

test('/webui-session-ref returns a paste-ready mention for a found session', async () => {
  const target = { sessionId: 'target-9', label: 'A demo session' };
  const { ctx, registered } = makeContext([target]);
  apply(ctx);
  const res = await registered.get('webui-session-ref').handler({
    agent,
    rawInput: 'target-9',
  });
  assert.equal(res.kind, 'success');
  assert.ok(res.text.includes('target-9'));
  assert.ok(res.text.includes(encodeSessionReferenceUri('target-9')));
  assert.ok(
    res.text.includes(formatSessionReferenceMention({ sessionId: 'target-9', label: 'A demo session' })),
  );
});

test('/webui-session-ref errors for missing target', async () => {
  const { ctx, registered } = makeContext([
    { sessionId: 'target-9', label: 'A demo session' },
  ]);
  apply(ctx);
  const res = await registered.get('webui-session-ref').handler({
    agent,
    rawInput: 'no-such-id',
  });
  assert.equal(res.kind, 'error');
  assert.ok(res.text.includes('找不到'));
});

test('/webui-session-ref errors without argument', async () => {
  const { ctx, registered } = makeContext();
  apply(ctx);
  const res = await registered.get('webui-session-ref').handler({ agent, rawInput: '   ' });
  assert.equal(res.kind, 'error');
  assert.ok(res.text.includes('missing'));
});

test('/webui-session-ref degrades gracefully when session-reference service absent', async () => {
  const registered = new Map();
  const ctx = {
    commands: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); } },
    get: () => undefined,
  };
  apply(ctx);
  const res = await registered.get('webui-session-ref').handler({ agent, rawInput: 'any' });
  assert.equal(res.kind, 'error');
  assert.ok(res.text.includes('未启用'));
});

// ── session_context_read 工具 ────────────────────────────────────────────────

function makeToolContext() {
  const registered = new Map();
  const COMMANDS = {
    register(def) { registered.set('cmd:' + def.name, def); return () => registered.delete(def.name); },
  };
  const TOOLS = {
    register(def) { registered.set('tool:' + def.name, def); return () => registered.delete(def.name); },
  };
  const sessionQuery = {
    async readSurface(_id) {
      return {
        session: { version: 1, id: 'target-9', cwd: '/srv/a' },
        capturedThroughSeq: 2,
        events: [
          { type: 'user/message', data: { content: [{ type: 'text', text: '我们的订单系统报错' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我来排查订单接口。' }] } } },
        ],
      };
    },
  };
  const ctx = {
    commands: COMMANDS,
    get: (n) => (n === 'tools' ? TOOLS : n === 'sessionQuery' ? sessionQuery : undefined),
  };
  apply(ctx);
  return { registered };
}

test('registers session_context_read tool', () => {
  const { registered } = makeToolContext();
  assert.ok(registered.has('tool:session_context_read'));
});

test('session_context_read returns target session readable context (string output)', async () => {
  const { registered } = makeToolContext();
  const def = registered.get('tool:session_context_read');
  assert.equal(typeof def.execute, 'function');
  const res = await def.execute({ session_id: 'target-9' }, { signal: undefined });
  // output schema 是 string：execute 返回普通字符串
  assert.equal(typeof res, 'string');
  assert.ok(res.includes('目标会话 target-9'));
  assert.ok(res.includes('[USER] 我们的订单系统报错'));
  assert.ok(res.includes('[ASSISTANT] 我来排查订单接口。'));
});

test('session_context_read strips dsh-session: prefix', async () => {
  const { registered } = makeToolContext();
  const def = registered.get('tool:session_context_read');
  const res = await def.execute({ session_id: 'dsh-session:InNlc3MtMTIzIg' }, { signal: undefined });
  assert.equal(typeof res, 'string');
  assert.ok(res.includes('目标会话 InNlc3MtMTIzIg'));
});

test('session_context_read throws on missing session_id', async () => {
  const { registered } = makeToolContext();
  const def = registered.get('tool:session_context_read');
  await assert.rejects(() => def.execute({ session_id: '  ' }, { signal: undefined }), /missing session_id/);
});

test('session_context_read throws if sessionQuery absent', async () => {
  const registered = new Map();
  const ctx = {
    commands: { register: (d) => { registered.set('cmd:' + d.name, d); return () => {}; } },
    get: (n) => (n === 'tools' ? { register: (d) => registered.set('tool:' + d.name, d) } : undefined),
  };
  apply(ctx);
  const def = registered.get('tool:session_context_read');
  await assert.rejects(() => def.execute({ session_id: 'target-9' }, { signal: undefined }), /session-query/);
});

test('formatSessionSurface truncates over budget', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '0123456789ABCDEF' }] } },
  ];
  const out = formatSessionSurface(events, 8);
  // 截断后不再包含完整正文，且带截断标记。
  assert.ok(out.includes('已按 8 字符截断'));
  assert.ok(!out.includes('0123456789'));
  assert.ok(out.length <= 8 + 1 + '…[已按 8 字符截断]'.length);
});
