/**
 * 客户端 `resolveSessionId` 的行为契约测试。
 *
 * 真正的实现位于 `src/client/index.ts`（TS 源码，由 tsdown 打包进浏览器，
 * 本环境没有 TS 编译器无法直接运行）。此文件用一段**纯 JS 镜像**复刻同样的
 * 算法，对「从会话行 DOM 反解 session id」的关键决策做回归保护：
 *   1) 行文本本身就是 `byId` 的 key（无标题会话 displayTitle 回落成 id）→ 直接命中；
 *   2) 否则按 `displayTitle` 匹配（空白会话匹配 `t('session.new')`）；
 *   3) 都不中 → null（不弹菜单）。
 * 若修改 `src/client/index.ts` 里的 `resolveSessionId`，请同步更新此镜像。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 纯 JS 镜像（与 src/client/index.ts 的 resolveSessionId 一致）────────────
function resolveSessionId(row, byId, t) {
  const titleEl = row.querySelector?.(':scope [class*="title"]')
    ?? row.querySelector?.('[class*="title"]')
    ?? null;
  const el = titleEl ?? row;
  const text = (el.textContent ?? '').trim();
  if (!text) return null;
  const direct = byId[text];
  if (direct) return direct.id;
  const blankLabel = t('session.new');
  for (const s of Object.values(byId)) {
    const label = s.blank ? blankLabel : s.displayTitle;
    if (label === text) return s.id;
  }
  return null;
}

function makeRowInsideTree(text) {
  return {
    querySelector: (sel) => (sel.includes('title') ? { textContent: text } : null),
    textContent: text,
  };
}

// 真实场景：空白会话 displayTitle 会落到本地化空白标签（workspace 的
// displayTitle(node, t)），因此 blank 会话的 displayTitle 是 "新会话"/"New Session"。
const byId = {
  'sess-1': { id: 'sess-1', title: '调研 CLI', displayTitle: '调研 CLI', blank: false },
  'sess-2': { id: 'sess-2', displayTitle: '新会话', blank: true },
  'sess-3': { id: 'sess-3', title: '修 bug', displayTitle: '修 bug', blank: false },
  'sess-4': { id: 'sess-4', displayTitle: '新会话', blank: true },
};

const t = (k) => (k === 'session.new' ? '新会话' : k);

test('直接命中：行文本就是 byId 的 key（无标题会话显示 id）', () => {
  // 一个既无标题、displayTitle 又直接回落成 id 的会话（主机端可能这么投影）。
  const alt = { ...byId, 'sess-x': { id: 'sess-x', displayTitle: 'sess-x', blank: true } };
  assert.equal(resolveSessionId(makeRowInsideTree('sess-x'), alt, t), 'sess-x');
});

test('空白会话按 t("session.new") 匹配到第一个 blank 行', () => {
  // 多个空白会话都显示 "新会话"，算法取 byId 迭代序的第一个 —— 已知取舍。
  assert.equal(resolveSessionId(makeRowInsideTree('新会话'), byId, t), 'sess-2');
});
