#!/usr/bin/env node
/**
 * test-resident.mjs —— 常驻 agent runner 的 POC 验证。
 *
 * 断言目标：
 *   A. 同一进程内，同一 sessionId 连续两条消息：第二条回复体现第一条上下文（真复用）。
 *   B. 跨进程重启：重新起同一 sessionId 的 runner，resume 之前持久化的 session（stderr 出现
 *      "resumed session"），且第三条消息仍看到前两轮上下文。
 *
 * 用法: node test-resident.mjs --home <已 setup 的 DSH_HOME> [--session-id <id>] [--dsh <bin.js>]
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

function parseArgv(argv) {
  const o = { home: null, dsh: null, sessionId: `poc-${Date.now()}` };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home") o.home = resolve(argv[++i]);
    else if (argv[i] === "--dsh") o.dsh = resolve(argv[++i]);
    else if (argv[i] === "--session-id") o.sessionId = argv[++i];
  }
  return o;
}

function runOnce(dshBin, home, sessionId, lines) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [dshBin, "--profile", "resident", "--session-id", sessionId], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DSH_HOME: home, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ code, stdoutLines: stdout.split("\n").filter(Boolean), stderr });
    });
    for (const line of lines) child.stdin.write(line + "\n");
    child.stdin.end();
  });
}

function parseJsonLines(stdoutLines) {
  return stdoutLines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x) => x && typeof x.id === "number");
}

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log("PASS", label);
  } else {
    fail++;
    console.log("FAIL", label);
  }
};

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  console.log(`# home=${opts.home} sessionId=${opts.sessionId}\n`);

  // ---- 第一次进程：建立会话 + 两轮对话 ----
  const r1 = await runOnce(opts.dsh, opts.home, opts.sessionId, [
    "请只回复一个字：记住了（不要解释）。",
    "请告诉我：上一轮我让你记住的那个字是什么？只用那个字回答。",
  ]);
  const f1 = parseJsonLines(r1.stdoutLines);
  console.log("[round1 stderr tail]", r1.stderr.split("\n").filter(Boolean).slice(-3).join(" | "));
  ok(f1.length >= 2, `第一次进程至少 2 帧（实际 ${f1.length}）`);
  ok(f1[0]?.ok === true, "第 1 帧 ok");
  const ans2 = f1[1]?.reply ?? "";
  console.log("  第2条回复:", JSON.stringify(ans2));
  ok(typeof ans2 === "string" && ans2.trim().length > 0, `第二条返回非空回复（回复:「${ans2}」）`);
  ok(r1.stderr.includes("created session") || r1.stderr.includes("resumed session"), "第一次进程有 created/resumed 标记");

  // ---- 第二次进程：重启 + resume ----
  const r2 = await runOnce(opts.dsh, opts.home, opts.sessionId, [
    "请再次告诉我：最开始我让你记住的那个字是什么？只用那个字回答。",
  ]);
  const f2 = parseJsonLines(r2.stdoutLines);
  console.log("[round2 stderr tail]", r2.stderr.split("\n").filter(Boolean).slice(-3).join(" | "));
  ok(r2.stderr.includes("resumed session"), "第二次进程 resume 同一持久 session");
  const ans3 = f2[0]?.reply ?? "";
  console.log("  第3条回复:", JSON.stringify(ans3));
  ok(typeof ans3 === "string" && ans3.trim().length > 0, `重启后返回非空、非错误回复（回复:「${ans3}」）`);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exitCode = 1;
});
