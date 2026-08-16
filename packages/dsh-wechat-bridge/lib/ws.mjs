/**
 * 极简 WebSocket 服务端（RFC 6455 子集），零依赖。
 * 仅实现网关所需部分：握手、文本/二进制帧、分片重组、ping/pong、close。
 * 客户端→服务端帧要求按规范做掩码；服务端→客户端不掩码。
 */

import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 64 * 1024 * 1024; // 单条消息 64MB 上限

export function computeAcceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/**
 * 解析累积缓冲区，返回 { messages: Buffer[], rest: Buffer }。
 * messages 为完整文本消息的 UTF-8 字符串以外的原始内容——这里直接收集 payload Buffer，
 * 由调用方 toString。遇到 ping 自动由 handle 层回复。
 */
export function parseFrames(buffer, handlers) {
  const rest = [];
  let offset = 0;
  let fragments = null; // 分片重组缓冲区

  while (true) {
    if (buffer.length - offset < 2) break;
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;

    if (len === 126) {
      if (buffer.length - p < 2) break;
      len = buffer.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buffer.length - p < 8) break;
      const big = buffer.readBigUInt64BE(p);
      p += 8;
      if (big > BigInt(MAX_PAYLOAD)) {
        handlers.protocolError?.("payload too large");
        return { messages: [], rest: buffer };
      }
      len = Number(big);
    }

    let maskKey = null;
    if (masked) {
      if (buffer.length - p < 4) break;
      maskKey = buffer.subarray(p, p + 4);
      p += 4;
    }

    if (buffer.length - p < len) break;
    let payload = buffer.subarray(p, p + len);
    p += len;

    if (maskKey) {
      // 客户端帧必须掩码
      const out = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    } else if (opcode >= 0x8 || opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      // 按 RFC 6455，客户端发给服务端的帧必须带掩码；宽容处理为原样
    }

    if (opcode === 0x8) {
      // close 帧
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      handlers.close?.(code, payload.length > 2 ? payload.subarray(2).toString("utf8") : "");
    } else if (opcode === 0x9) {
      handlers.ping?.(payload);
    } else if (opcode === 0xa) {
      handlers.pong?.(payload);
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (fragments) handlers.protocolError?.("new data frame during fragmented message");
      if (fin) {
        handlers.message?.(payload.toString("utf8"), opcode === 0x2);
      } else {
        fragments = [payload];
      }
    } else if (opcode === 0x0) {
      // continuation
      if (!fragments) handlers.protocolError?.("continuation without start");
      else {
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments);
          fragments = null;
          handlers.message?.(full.toString("utf8"), false);
        }
      }
    } else {
      handlers.protocolError?.(`unknown opcode ${opcode}`);
    }

    offset = p;
  }
  return { rest: buffer.subarray(offset) };
}

/** 构造服务端→客户端帧（不掩码）。 */
export function frame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const head = [0x80 | (opcode & 0x0f)];
  if (body.length < 126) {
    head.push(body.length);
  } else if (body.length <= 0xffff) {
    head.push(126, (body.length >> 8) & 0xff, body.length & 0xff);
  } else {
    head.push(127);
    const big = BigInt(body.length);
    for (let i = 7; i >= 0; i--) head.push(Number((big >> BigInt(i * 8)) & 0xffn));
  }
  return Buffer.concat([Buffer.from(head), body]);
}

export const WS_OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/**
 * 在已有 node:http server 上挂 WebSocket 升级处理。
 * onConnection(conn) 回调收到 WsConnection；path 过滤交给调用方。
 */
export function attachWs(server, onConnection) {
  server.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = computeAcceptKey(String(key));
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ];
    socket.write(headers.join("\r\n"));
    const conn = new WsConnection(socket, req);
    onConnection(conn);
    if (head.length > 0) conn._feed(head);
  });
}

export class WsConnection {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    socket.on("data", (d) => this._feed(d));
    socket.on("error", (e) => {
      if (!this.closed) this.onerror?.(e);
      this._teardown();
    });
    socket.on("close", () => {
      this._teardown();
      this.onclose?.(this.closeCode ?? 1006, this.closeReason ?? "");
    });
  }

  _feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    try {
      const { rest } = parseFrames(this.buffer, {
        message: (text) => this.onmessage?.(text),
        ping: (payload) => this.pong(payload),
        close: (code, reason) => {
          this.closeCode = code;
          this.closeReason = reason;
          this.close(code, reason);
        },
        protocolError: (msg) => this.close(1002, msg),
      });
      this.buffer = rest;
    } catch (e) {
      this.onerror?.(e);
      this.close(1002, String(e?.message ?? e));
    }
  }

  sendText(text) {
    if (this.closed) return;
    try {
      this.socket.write(frame(WS_OPCODE.TEXT, text));
    } catch {}
  }

  sendJson(obj) {
    this.sendText(JSON.stringify(obj));
  }

  ping(payload = "") {
    if (this.closed) return;
    try {
      this.socket.write(frame(WS_OPCODE.PING, payload));
    } catch {}
  }

  pong(payload = "") {
    if (this.closed) return;
    try {
      this.socket.write(frame(WS_OPCODE.PONG, payload));
    } catch {}
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, "utf8");
    try {
      this.socket.write(frame(WS_OPCODE.CLOSE, body));
    } catch {}
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
  }

  _teardown() {
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {}
  }
}
