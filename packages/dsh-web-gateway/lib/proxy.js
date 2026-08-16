// lib/proxy.js — HTTP + WebSocket(upgrade) 转发，指向「当前 active」后端。
//
// 转发配方（P0 已实测闭环）+ 分级处理（P3 修复 dshmarket sameOrigin）：
//   - DSH 核心 `/api/*`：Host 重写为 `127.0.0.1:<backendPort>`，**删除 Origin/sec-fetch-site**
//     —— 穿透 dsh-web `isTrustedApiRequest` 围栏（HTTP RPC + /api/events.* WebSocket）。
//   - 其他路径（静态 SPA、第三方插件如 dshmarket 的 `/dsh-market/*` POST）：
//     **保留原始 Origin**，并把 Host 设成 Origin 的 host，使请求**同源** 。
//     —— 因为 dshmarket 的 `sameOrigin()` 要求 `new URL(origin).host === Host`，
//        若照旧删 Origin 会返回 403 "untrusted origin"。
//
// proxy 需要能「切换上游」：GET /set-backend 仅本机调试用；运行时由 orchestrate
// 通过 setBackend(port) 原子切换。这里实现一个可指向动态目标的上游解析器。

import { createServer, request as httpRequest } from "node:http";

/** 是否 DSH 核心 /api 前缀（使用 loopback+删 Origin 配方）。 */
function isDshApi(url) {
  const p = new URL(url || "/", "http://x").pathname;
  return p === "/api" || p.startsWith("/api/");
}

/**
 * 按路径分级重写请求头。
 * @param {object} headers
 * @param {number} backendPort
 * @param {string} url 请求原始 URL（判断前缀）
 */
export function forwardHeaders(headers, backendPort, url = "/") {
  if (isDshApi(url)) {
    // DSH 核心 /api：loopback Host + 删 Origin，穿透围栏
    const h = { ...headers, Host: `127.0.0.1:${backendPort}` };
    delete h.origin;
    delete h["sec-fetch-site"];
    return h;
  }
  // 非 /api（SPA / dsh-market 等）：保留 Origin，并把 Host 设为 Origin 的 host（同源）。
  const h = { ...headers };
  const origin = h.origin;
  if (origin && typeof origin === "string") {
    try {
      const u = new URL(origin);
      h.host = u.host; // 含端口，满足 sameOrigin 的 new URL(origin).host === host
      h["x-forwarded-host"] = h.host;
      return h;
    } catch {}
  }
  // 无 Origin（如简单导航 GET）：维持 loopback Host 即可（静态资源无同源要求）。
  h.host = `127.0.0.1:${backendPort}`;
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
        headers: forwardHeaders(req.headers, backend.port, req.url),
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
      headers: forwardHeaders(req.headers, backend.port, req.url),
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
