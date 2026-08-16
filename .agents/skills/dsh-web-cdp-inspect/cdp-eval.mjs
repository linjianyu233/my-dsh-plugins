/**
 * dsh-web-cdp-inspect —— 通过 Chrome DevTools Protocol (CDP) 在 DSH Web 页面上
 * 执行任意 JS 表达式并回传结果。用于「拿真实 DOM / computed style」调试移动端
 * UI 适配这类 CSS 问题：不再靠读源码猜测，而是直接观察浏览器里实际渲染的结构。
 *
 * 用法：
 *   node cdp-eval.mjs <webSocketDebuggerUrl> <表达式文件或 - >
 *
 * - 第 1 个参数：CDP 页面的 ws URL（形如 ws://127.0.0.1:9222/devtools/page/<id>），
 *   从 `curl -s http://127.0.0.1:9222/json` 的 webSocketDebuggerUrl 字段取。
 * - 第 2 个参数：要执行的 JS 表达式；传 `-` 表示从 stdin 读取（支持多行）。
 *
 * 表达式在页面全局上下文执行（等同 DevTools Console），可访问 window/document/
 * getComputedStyle 等。用 `return JSON.stringify(...)` 把结构化结果回传，避免
 * CDP 对非 JSON 值的序列化问题。
 *
 * 依赖：Node ≥ 22（全局 WebSocket）。无需任何 npm 依赖。
 *
 * 示例（打印某个元素及其所有祖先的 computed layout）：
 *   cat > /tmp/probe.js <<'JS'
 *   (() => {
 *     const el = document.querySelector('[data-slot="conversation.input.model"]');
 *     const chain = [];
 *     let p = el, i = 0;
 *     while (p && i < 10) {
 *       chain.push({ tag: p.tagName, cls: p.className, display: getComputedStyle(p).display,
 *                    flexDir: getComputedStyle(p).flexDirection, flexWrap: getComputedStyle(p).flexWrap,
 *                    w: Math.round(p.getBoundingClientRect().width) });
 *       p = p.parentElement; i++;
 *     }
 *     return JSON.stringify(chain);
 *   })()
 *   JS
 *   node cdp-eval.mjs <ws-url> /tmp/probe.js
 */
const WS_URL = process.argv[2];
const EXPR_FILE = process.argv[3];

if (!WS_URL || !EXPR_FILE) {
  console.error('usage: node cdp-eval.mjs <webSocketDebuggerUrl> <exprFile|->');
  process.exit(2);
}

async function readExpr() {
  if (EXPR_FILE === '-') {
    return new Promise((resolve) => {
      let s = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { s += d; });
      process.stdin.on('end', () => resolve(s));
    });
  }
  const { readFileSync } = await import('node:fs');
  return readFileSync(EXPR_FILE, 'utf8');
}

const expression = await readExpr();
const ws = new WebSocket(WS_URL);
let id = 0;
const pending = new Map();

ws.addEventListener('open', () => {
  const myId = ++id;
  pending.set(myId, (msg) => {
    if (msg.result?.exceptionDetails) {
      console.error('JS exception:', JSON.stringify(msg.result.exceptionDetails, null, 2));
      ws.close();
      process.exit(1);
    }
    // 回传结果：优先取 returnByValue 后的 value（已是 JSON 字符串或原值）。
    console.log(msg.result?.result?.value ?? JSON.stringify(msg, null, 2));
    ws.close();
    process.exit(0);
  });
  ws.send(JSON.stringify({
    id: myId,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  }));
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

ws.addEventListener('error', (e) => {
  console.error('WS error:', e.message ?? e);
  process.exit(1);
});

setTimeout(() => { console.error('timeout: 表达式执行超过 20s'); process.exit(1); }, 20000);
