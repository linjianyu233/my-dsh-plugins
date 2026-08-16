// ws.mjs 帧编解码单元测试：node test-ws.mjs
import { parseFrames, frame, WS_OPCODE } from "./lib/ws.mjs";
import assert from "node:assert";

function maskedClientFrame(opcode, payload) {
  const body = Buffer.from(payload, "utf8");
  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const head = [0x80 | (opcode & 0x0f), 0x80 | body.length];
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ maskKey[i & 3];
  return Buffer.concat([Buffer.from(head), maskKey, masked]);
}

// 1) 简单文本消息
{
  const events = [];
  const { rest } = parseFrames(maskedClientFrame(WS_OPCODE.TEXT, "你好, 世界"), {
    message: (t) => events.push(["msg", t]),
    ping: () => events.push(["ping"]),
  });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0][1], "你好, 世界");
  assert.strictEqual(rest.length, 0);
  console.log("✓ 简单文本消息");
}

// 2) 分片消息（两段 continuation）
{
  const f1 = maskedClientFrame(WS_OPCODE.TEXT, "hello ");
  // 改造为 fin=0 的首帧
  f1[0] = 0x01;
  const f2 = maskedClientFrame(WS_OPCODE.CONTINUATION, "world");
  const events = [];
  parseFrames(Buffer.concat([f1, f2]), { message: (t) => events.push(t) });
  assert.deepStrictEqual(events, ["hello world"]);
  console.log("✓ 分片重组");
}

// 3) 粘包：两个完整帧一次到达
{
  const f1 = maskedClientFrame(WS_OPCODE.TEXT, "one");
  const f2 = maskedClientFrame(WS_OPCODE.TEXT, "two");
  const events = [];
  parseFrames(Buffer.concat([f1, f2]), { message: (t) => events.push(t) });
  assert.deepStrictEqual(events, ["one", "two"]);
  console.log("✓ 粘包拆帧");
}

// 4) 半包：帧体分两次到达（rest 累积）
{
  const f = maskedClientFrame(WS_OPCODE.TEXT, "partial-data");
  const cut = Math.floor(f.length / 2);
  const events = [];
  const r1 = parseFrames(f.subarray(0, cut), { message: (t) => events.push(t) });
  assert.strictEqual(events.length, 0);
  const r2 = parseFrames(Buffer.concat([r1.rest, f.subarray(cut)]), { message: (t) => events.push(t) });
  assert.deepStrictEqual(events, ["partial-data"]);
  assert.strictEqual(r2.rest.length, 0);
  console.log("✓ 半包累积");
}

// 5) ping → 触发 ping 回调
{
  const events = [];
  parseFrames(maskedClientFrame(WS_OPCODE.PING, "hb"), { ping: () => events.push("ping") });
  assert.deepStrictEqual(events, ["ping"]);
  console.log("✓ ping 帧");
}

// 6) 服务端帧构造：长度 <126 / =126 编码 / >65535 用 BigInt 头
{
  const small = frame(WS_OPCODE.TEXT, "hi");
  assert.strictEqual(small[0], 0x81);
  assert.strictEqual(small[1], 2);
  assert.strictEqual(small.subarray(2).toString("utf8"), "hi");

  const mid = frame(WS_OPCODE.TEXT, "x".repeat(300));
  assert.strictEqual(mid[0], 0x81);
  assert.strictEqual(mid[1], 126);
  assert.strictEqual(mid.readUInt16BE(2), 300);

  const big = frame(WS_OPCODE.TEXT, "y".repeat(70000));
  assert.strictEqual(big[0], 0x81);
  assert.strictEqual(big[1], 127);
  assert.strictEqual(big.readBigUInt64BE(2), 70000n);
  console.log("✓ 帧构造（短/中/长长度编码）");
}

console.log("\n全部通过 ✅");
