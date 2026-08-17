// lib/proxy.js — HTTP + WebSocket(upgrade) 转发，指向「当前 active」后端。
//
// 转发配方 v2（统一改写，修复 dsh-better-sidebar 经网关 Explorer 403）：
//   无论路径，后端一律看到「loopback 后端源」：
//     - Host 恒为 `127.0.0.1:<backendPort>` —— 穿透 dsh-web `/api` 围栏，
//       也穿透 dsh-better-sidebar 复制自 `/api` 的围栏（两者都要求 Host 是
//       loopback 或 trustedHosts；而网关拉起的后端绑 127.0.0.1、未传
//       --trusted-host，trustedHosts 为空，非 loopback Host 一律 403）。
//     - 原请求带 Origin 时**改写**为 `http://127.0.0.1:<backendPort>`（不删除）：
//       · DSH 式围栏：`new URL(origin).host === Host` 成立 → 放行；
//       · dshmarket 式 `sameOrigin()`（`new URL(origin).host === host`）同样成立
//         → 不回归 'untrusted origin'（它只要求 origin 存在且与 Host 相等，
//         并不读取真实外部 origin）。
//     - 删除 sec-fetch-site（同 /api 既有配方；'cross-site' 标记不转发）。
//
// 旧配方缺陷：非 /api 路径「保留 Origin 并把 Host 设成 Origin 的 host」，导致经
// 网关用非 loopback 地址（Tailscale / LAN IP / 主机名）访问时，/sidebar/* 围栏
// 收到外部 Host → 403 forbidden（Explorer 显示 forbidden）。v2 不再依赖外部访问
// 地址，任何入口地址都能穿透两种围栏。
//
// proxy 需要能「切换上游」：GET /set-backend 仅本机调试用；运行时由 orchestrate
// 通过 setBackend(port) 原子切换。这里实现一个可指向动态目标的上游解析器。

import { createServer, request as httpRequest } from "node:http";

/**
 * 统一重写请求头：Host → loopback 后端，Origin（若带）→ loopback 后端源。
 * @param {object} headers
 * @param {number} backendPort
 * @param {string} url 请求原始 URL（保留签名；v2 配方不再按路径分流，所有路径同配方）
 */
export function forwardHeaders(headers, backendPort, url = "/") {
  // 注意：node http 入站头键名全小写（host/origin/sec-fetch-site），
  // 必须覆写小写键，否则 spread 后的旧 host 仍残留。
  const h = { ...headers, host: `127.0.0.1:${backendPort}` };
  if (typeof h.origin === "string") h.origin = `http://127.0.0.1:${backendPort}`;
  else delete h.origin;
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
