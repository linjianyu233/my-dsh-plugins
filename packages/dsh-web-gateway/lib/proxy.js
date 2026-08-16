// lib/proxy.js — HTTP + WebSocket(upgrade) 转发，指向「当前 active」后端。
//
// 转发配方（P0 已实测闭环）：
//   - 把入站 Host 重写为 `127.0.0.1:<backendPort>`（loopback authority）
//   - **删除** Origin 头（空串不行，必须 delete），顺带删除 sec-fetch-site
//   - 三种路径均可穿透 dsh-web `isTrustedApiRequest` 围栏：
//       静态 SPA（GET / → 200）、/api RPC（→ 426/…）、/api/events.* WebSocket（→ 101）
//   - 因此**无需** --trusted-host。
//
// proxy 需要能「切换上游」：GET /set-backend 仅本机调试用；运行时由 orchestrate
// 通过 setBackend(port) 原子切换。这里实现一个可指向动态目标的上游解析器。

import { createServer, request as httpRequest } from "node:http";

/** 按配方重写请求头：Host 置为 loopback，删除 Origin / sec-fetch-site。 */
export function forwardHeaders(headers, backendPort) {
  const h = { ...headers, Host: `127.0.0.1:${backendPort}` };
  delete h.origin;
  delete h["sec-fetch-site"];
  return h;
}

/**
 * 创建转发代理服务器。`getBackend()` 每次请求时解析当前上游（支持原子切换）。
 * @param {()=>{port:number}|null} getBackend
 * @returns {{server, setGetBackend}}
 */
export function createGateway({ getBackend, onError = () => {} }) {
  const state = { getBackend };
  // 进行中的请求/WS 计数，供 idle 判定「无 in-flight」。
  const inflight = { http: 0, ws: 0 };

  const server = createServer((req, res) => {
    inflight.http += 1;
    res.on("close", () => {
      inflight.http -= 1;
    });
    const backend = state.getBackend();
    if (!backend || backend.port == null) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("gateway: no active backend");
      return;
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: backend.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers, backend.port),
      },
      (pres) => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
      }
    );
    upstream.on("error", (e) => {
      onError(e);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("gateway: upstream error");
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  });

  // WebSocket 升级透传（同配方）。
  // 关键：把上游的 101 响应 **原样** 回传（含由客户端 Sec-WebSocket-Key 计算出的
  // Sec-WebSocket-Accept），不能手写简化 101，否则真实 ws 客户端会校验失败。
  server.on("upgrade", (req, socket, head) => {
    inflight.ws += 1;
    const dec = () => {
      inflight.ws = Math.max(0, inflight.ws - 1);
    };
    socket.once("close", dec);
    socket.once("error", dec);
    const backend = state.getBackend();
    if (!backend || backend.port == null) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const up = httpRequest({
      host: "127.0.0.1",
      port: backend.port,
      method: "GET",
      path: req.url,
      headers: forwardHeaders(req.headers, backend.port),
    });
    up.on("upgrade", (pres, usocket, uhead) => {
      // 回传上游 101 状态行 + 响应头（含 Sec-WebSocket-Accept），再转发 body head
      socket.write(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\n`);
      for (const [k, v] of Object.entries(pres.headers)) {
        if (Array.isArray(v)) for (const item of v) socket.write(`${k}: ${item}\r\n`);
        else socket.write(`${k}: ${v}\r\n`);
      }
      socket.write("\r\n");
      if (uhead && uhead.length) socket.write(uhead);
      if (head && head.length) socket.write(head);
      socket.pipe(usocket);
      usocket.pipe(socket);
    });
    up.on("error", (e) => {
      onError(e);
      socket.destroy();
    });
    // 转发可能已读到的 head
    up.write(head && head.length ? head : Buffer.alloc(0));
    socket.on("error", () => {});
  });

  return {
    server,
    getInflight() {
      return { ...inflight };
    },
    setGetBackend(fn) {
      state.getBackend = fn;
    },
  };
}
