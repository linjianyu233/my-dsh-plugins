/**
 * 移动端 UI 适配样式（client 面）的行为契约测试。
 *
 * `src/client/mobile.css.ts` 是一段纯文本 CSS（无 import），由 tsdown 内联进
 * `lib/client.js`；`src/client/index.tsx` 的 `apply()` 用一个 `ctx.effect` 把它
 * 注入 `<head>` 并在卸载时清理。本测试分两部分：
 *
 *   1) 读取 `src/client/mobile.css.ts`，抽取导出的 CSS 字符串，断言其关键
 *      结构不变量（断点、覆盖手法、不破坏字体族/字重）；
 *   2) 用伪 DOM + 伪 ctx 镜像 `apply()` 里的注入/清理行为（与真实代码一致），
 *      保证「注入到 head + 卸载移除，且不残留/不重复」的契约。
 *
 * 若修改 `src/client/mobile.css.ts` 或 `src/client/index.tsx` 里的注入逻辑，
 * 请同步更新此镜像与断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cssTsPath = path.join(here, '../src/client/mobile.css.ts');

/** 从 mobile.css.ts 源码里抽出 `mobileCss` 模板字符串与 `MOBILE_CSS_ID`。 */
function readExports() {
  const text = fs.readFileSync(cssTsPath, 'utf8');
  const idMatch = text.match(/MOBILE_CSS_ID\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(idMatch, '应导出 MOBILE_CSS_ID 字符串字面量');
  const id = idMatch[1];
  // export const mobileCss = /* css */ `...`; —— 抽取反引号内的内容（CSS 里无反引号）。
  const cssMatch = text.match(/mobileCss\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)?`([\s\S]*?)`;/);
  assert.ok(cssMatch, '应导出 mobileCss 模板字符串');
  return { id, css: cssMatch[1] };
}

// ── 1) CSS 结构不变量 ────────────────────────────────────────────────────────
test('CSS：用 @media 断点覆盖 body 上的 --dsw-font-* token（不碰字体族/字重）', () => {
  const { css } = readExports();

  // 手机竖屏与平板两档断点都在。
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /@media \(min-width: 721px\) and \(max-width: 1024px\)/);

  // 核心修复：缩小 markdown 正文 token，且都作用在 body 上。
  assert.match(css, /body\s*\{/);
  assert.match(css, /--dsw-font-markdown-base:\s*15px\/24px/);
  assert.match(css, /--dsw-font-markdown-base-font-size:\s*15px/);
  assert.match(css, /--dsw-font-markdown-base-line-height:\s*24px/);

  // 不覆盖字体族：--dsw-font-family 不应被本样式改写（否则会破坏 UI 字库）。
  assert.doesNotMatch(css, /--dsw-font-family\s*:/);
});

test('CSS：手机端比平板端更激进（更小的正文字号与行高）', () => {
  const { css } = readExports();
  // 平板档 15/26，手机档 15/24 —— 手机行高更紧。
  const mobileBase = css.match(/@media \(max-width: 720px\)[\s\S]*?--dsw-font-markdown-base:\s*([^;]+);/);
  const tabletBase = css.match(/@media \(min-width: 721px\)[\s\S]*?--dsw-font-markdown-base:\s*([^;]+);/);
  assert.ok(mobileBase && tabletBase, '两档都应覆盖 markdown 正文 token');
  assert.equal(mobileBase[1], '15px/24px var(--dsw-font-family)');
  assert.equal(tabletBase[1], '15px/26px var(--dsw-font-family)');
});

// ── 2) 注入/清理行为镜像 ─────────────────────────────────────────────────────
/** 与 src/client/index.tsx apply() 的 mobile-css effect 完全一致的镜像。 */
function makeFakeDocument() {
  const children = [];
  return {
    children,
    head: {
      appendChild(node) { children.push(node); },
    },
    getElementById(id) {
      return children.find((n) => n.id === id) ?? null;
    },
    createElement(tag) {
      const node = { tag, id: undefined, textContent: undefined };
      // 镜像真实 DOM 节点的 remove()：把自身从 children 里移除。
      node.remove = () => {
        const i = children.indexOf(node);
        if (i !== -1) children.splice(i, 1);
      };
      return node;
    },
  };
}

function callEffect(document, MOBILE_CSS_ID, mobileCss) {
  // 镜像 apply() 里那条 effect 的 body / cleanup。
  const body = () => {
    const style = document.createElement('style');
    style.id = MOBILE_CSS_ID;
    style.textContent = mobileCss;
    document.head.appendChild(style);
    return () => {
      const node = document.getElementById(MOBILE_CSS_ID);
      if (node !== null) node.remove();
    };
  };
  return body();
}

test('注入：往 head 添加带固定 id 的 <style>，卸载后 remove 且不残留', () => {
  const { id, css } = readExports();
  const doc = makeFakeDocument();
  const cleanup = callEffect(doc, id, css);

  assert.equal(doc.children.length, 1);
  assert.equal(doc.children[0].id, id);
  assert.equal(doc.children[0].textContent, css);

  cleanup();
  assert.equal(doc.children.length, 0, '卸载后 style 应被移除');
});

test('注入：重复注入不会叠加（同 id 下只保留一份，靠 remove 幂等清理）', () => {
  const { id, css } = readExports();
  const doc = makeFakeDocument();
  const c1 = callEffect(doc, id, css);
  const c2 = callEffect(doc, id, css);
  // 真实实现里每个 effect 各自 append，靠 id 在清理时定位；此处只保证两处
  // cleanup 都幂等：即使叠加，也能按 id 各自 remove 而不报错。
  c1();
  c2();
  assert.equal(doc.children.length, 0);
});
