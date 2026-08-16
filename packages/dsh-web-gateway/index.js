#!/usr/bin/env node
// index.js — dsh-gateway CLI + 常驻 daemon（零 npm 依赖）。
//
// 单一常驻进程同时充当：
//   - 网关 proxy（HTTP+WS，转发到 active 后端，带 P0 配方）
//   - 控制端（仅 127.0.0.1），通过路径上的子资源接收 status / open-update / exit。
//
// 用法：
//   dsh-gateway up [--port <gatewayPort>] [-p <patch>...] [--profile web]
//       启动 daemon 并拉起初始 active；控制端在 127.0.0.1:<gatewayPort+0x1000>。
//   dsh-gateway status [--port <gatewayPort>]
//   dsh-gateway open-update [--port <gatewayPort>] [-p <patch>...] [--force]
//   dsh-gateway exit [--port <gatewayPort>]

import { resolve } from "node:path";
import { Gate, controlPort } from "./lib/gate.js";
import { request } from "node:http";

const GATEWAY_PORT_FLAG = 8181;

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args.shift();
  const opts = { patches: [], force: false, gatewayPort: GATEWAY_PORT_FLAG, profile: "web" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--patch") opts.patches.push(resolve(args[++i]));
    else if (a === "--force") opts.force = true;
    else if (a === "--profile") opts.profile = args[++i];
    else if (a === "--port") opts.gatewayPort = Number(args[++i]);
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return { cmd, opts };
}

function usage() {
  return [
    "usage: dsh-gateway <up|status|open-update|exit> [options]",
    "  up            start daemon: bootstrap active + gateway proxy + control (blocking)",
    "  status        query running daemon",
    "  open-update   ask running daemon to blue-green cutover (with new -p patches)",
    "  exit          stop running daemon",
    "options:",
    "  -p, --patch <file>   extra --patch overlay for the (new) backend",
    "  --profile <name>     dsh profile (default web)",
    "  --port <n>           gateway listen port (default 8181); control is port+0x1000",
    "  --force              skip waiting for active idle on open-update",
    "",
  ].join("\n");
}

/** 向 daemon 控制端发一个 JSON 请求。 */
function controlCall(gatewayPort, action, body) {
  const port = controlPort(gatewayPort);
  return new Promise((resolveP, rejectP) => {
    const data = JSON.stringify({ action, ...(body || {}) });
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/", headers: { "content-type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolveP({ statusCode: res.statusCode, body: buf ? JSON.parse(buf) : null });
          } catch {
            resolveP({ statusCode: res.statusCode, body: null, raw: buf });
          }
        });
      }
    );
    req.on("error", (e) => rejectP(e));
    req.end(data);
  });
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv);
  if (opts.help || !cmd) {
    process.stdout.write(usage());
    return;
  }

  if (cmd === "up") {
    const gate = new Gate({ gatewayPort: opts.gatewayPort });
    await gate.init({ profile: opts.profile, patches: opts.patches });
    gate.startControlServer();
    process.stdout.write(
      `dsh-gateway up: http://127.0.0.1:${opts.gatewayPort} -> active :${gate.registry.active().port}; ` +
        `control :${controlPort(opts.gatewayPort)}\n`
    );
    // 常驻，直到 control exit 或被杀。写出错(EPIPE)时静默忽略。
    try {
      await gate.readyToExit();
    } catch (e) {
      process.stderr.write(`daemon error: ${e.message}\n`);
    }
  } else if (cmd === "status") {
    const r = await controlCall(opts.gatewayPort, "status");
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else if (cmd === "open-update") {
    const r = await controlCall(opts.gatewayPort, "open-update", { patches: opts.patches, force: opts.force });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else if (cmd === "exit") {
    const r = await controlCall(opts.gatewayPort, "exit").catch((e) => ({ statusCode: 0, body: { error: e.message } }));
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
