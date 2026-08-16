// lib/spawn.js — 拉起一个 `dsh web --host 127.0.0.1 --port <N>` 子进程。
//
// 职责：
//  - 分配（探测）一个空闲端口，避免 EADDRINUSE；
//  - spawn `dsh`（可配置可执行文件路径），仅绑 127.0.0.1；
//  - 把 stdout/stderr 追加到 logs/<role>-<ts>.log；
//  - 进程退出时上报（供 registry/orchestrator 感知非预期退出）。
//  - 可选：以「额外 patch」方式注入新插件/覆盖（--patch 可重复）。

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认日志目录：包内 logs/（可被 env DSH_GATEWAY_LOGS_DIR 覆盖）。 */
export function logDir() {
  return process.env.DSH_GATEWAY_LOGS_DIR || resolve(HERE, "..", "logs");
}

/** 默认 `dsh` 可执行文件。 */
export function dshBin() {
  return process.env.DSH_BIN || "dsh";
}

/** 探测给定 host+port 是否空闲（绑定 0 立即释放）。 */
export async function probePortFree(host, port, timeoutMs = 1500) {
  return new Promise((resolveFree) => {
    const tester = createServer({ host });
    tester.once("error", () => resolveFree(false));
    tester.once("listening", () => {
      tester.close(() => resolveFree(true));
    });
    tester.listen(port, host);
    if (timeoutMs > 0) {
      tester.once("timeout", () => {
        try { tester.close(); } catch {}
        resolveFree(false);
      });
    }
  });
}

/** 从 hint 起找一个空闲端口。 */
export async function allocPort(host = "127.0.0.1", hint = 0) {
  if (hint > 0 && (await probePortFree(host, hint))) return hint;
  // 从随机高位端口试起
  for (let i = 0; i < 64; i++) {
    const p = 20000 + Math.floor(Math.random() * 30000);
    if (await probePortFree(host, p)) return p;
  }
  throw new Error("spawn: could not allocate a free port");
}

/**
 * 拉起一个 dsh web 子进程。
 * @param {object} opts
 * @param {'active'|'staging'} opts.role
 * @param {number} opts.port 监听端口（网关分配）
 * @param {string[]} [opts.patches] 额外 `--patch <file>` 覆盖（可重复）
 * @param {string} [opts.profile='web']
 * @param {object} [opts.env] 附加环境变量（会覆盖 inherited env）
 * @returns {Promise<{child, port, logFile}>}
 */
export function spawnBackend({ role, port, patches = [], profile = "web", env = {} }) {
  // 注意：launcher flag 必须在前；--patch 属于 launcher，--host/--port 属于 app。
  // 一旦出现 app 参数，其后所有 token 都作为 app 参数原样传递，--patch 会被 app 拒收。
  const args = ["--profile", profile];
  for (const p of patches) args.push("--patch", p);
  args.push("--host", "127.0.0.1", "--port", String(port));

  const logs = logDir();
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `${role}-${Date.now()}.log`);
  const sink = createWriteStream(logFile, { flags: "a" });
  // 写一行 header 方便诊断
  sink.write(`# role=${role} port=${port} profile=${profile}\n`);

  const child = spawn(dshBin(), args, {
    cwd: process.env.DSH_GATEWAY_CWD || process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 待 WriteStream fd 就绪后把子进程 stdout/stderr 接进去
  const attach = () => {
    if (child.stdout) child.stdout.on("data", (d) => sink.write(d));
    if (child.stderr) child.stderr.on("data", (d) => sink.write(d));
  };
  if (sink.writableNeedDrain === undefined && sink.fd === null) {
    sink.once("open", attach);
  } else {
    attach();
  }
  child.once("exit", () => sink.end());

  return { child, port, logFile };
}
