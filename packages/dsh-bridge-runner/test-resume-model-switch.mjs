#!/usr/bin/env node
/**
 * test-resume-model-switch.mjs —— 覆盖「跨进程 resume 后 set_model / @model 是否真正生效」的集成测试。
 *
 * 复现 bug：runner 的 agents.resume 之前漏传 setup，导致 installModelSelection 没被重新安装，
 * 于是 resume 恢复的会话里 @model / set_model 改了 selection.current，但 agent/request 不采纳，
 * 模型切换静默失效。
 *
 * 断言手段：runner 在 `DSH_RUNNER_TEST_INSPECT=1` 时，会把每条普通消息的成功帧附加 `_inspect`：
 *   { installed, current, assembled }
 *   - installed=true  表示 installModelSelection 已安装（= resume 路径也有 setup）；
 *   - current         期望切到的 selection.current；
 *   - assembled       installModelSelection 的 assemble 监听采纳后的模型。
 * 因此「resume 后 @model 切换，assembled 也随之更新为 target」就是切换真正生效的直接证据。
 *
 * 用法:
 *   node test-resume-model-switch.mjs --home <已 setup 的 DSH_HOME> [--dsh <bin.js>] \
 *     [--target deepseek-v4-flash] [--provider opencode-go]
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

function parseArgv(argv) {
  const o = { home: null, dsh: null, sessionId: `sw-${Date.now()}`, provider: "opencode-go", target: "deepseek-v4-flash" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home") o.home = resolve(argv[++i]);
    else if (argv[i] === "--dsh") o.dsh = resolve(argv[++i]);
    else if (argv[i] === "--session-id") o.sessionId = argv[++i];
    else if (argv[i] === "--provider") o.provider = argv[++i];
    else if (argv[i] === "--target") o.target = argv[++i];
  }
  return o;
}

function runOnce(dshBin, home, sessionId, lines, inspect = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [dshBin, "--profile", "resident", "--session-id", sessionId], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DSH_HOME: home,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        ...(inspect ? { DSH_RUNNER_TEST_INSPECT: "1" } : {}),
      },
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
  const o = parseArgv(process.argv.slice(2));
  if (!o.home || !o.dsh) {
    console.error("用法: node test-resume-model-switch.mjs --home <DSH_HOME> --dsh <bin.js> [--target ...] [--provider ...]");
    process.exit(2);
  }
  const target = o.target;
  const targetRef = `${o.provider}/${target}`;
  console.log(`# home=${o.home} sessionId=${o.sessionId} target=${targetRef}\n`);

  // ---- 第一进程：建立会话 ----
  const r1 = await runOnce(o.dsh, o.home, o.sessionId, ["请只回复：好。"]);
  const f1 = parseJsonLines(r1.stdoutLines);
  console.log("[round1 stderr tail]", r1.stderr.split("\n").filter(Boolean).slice(-3).join(" | "));
  ok(f1.length >= 1 && f1[0]?.ok === true, "第一次进程建立会话并返回 ok");
  ok(r1.stderr.includes("created session"), "第一次进程 created session");

  // ---- 第二进程：resume + @model 热切 + 普通消息 ----
  const r2 = await runOnce(
    o.dsh,
    o.home,
    o.sessionId,
    [`@model ${targetRef}`, "请只回复一个字：好。"],
    /* inspect */ true,
  );
  const f2 = parseJsonLines(r2.stdoutLines);
  console.log("[round2 stderr tail]", r2.stderr.split("\n").filter(Boolean).slice(-3).join(" | "));
  ok(r2.stderr.includes("resumed session"), "第二次进程 resume 同一持久 session");

  const swFrame = f2.find((f) => String(f.reply ?? "").includes("模型已切换为") || String(f.reply ?? "").includes("切换"));
  ok(swFrame?.ok === true, "@model 指令帧返回 ok");
  console.log("  @model 帧回复:", JSON.stringify(swFrame?.reply));

  const msgFrame = f2.find((f) => f._inspect !== void 0);
  ok(msgFrame !== void 0, "普通消息帧携带 _inspect 检查字段");
  if (msgFrame) {
    const insp = msgFrame._inspect;
    console.log("  _inspect:", JSON.stringify(insp));
    ok(insp.current?.provider === o.provider && insp.current?.model === target, `selection.current 已热切为 ${targetRef}（实际 ${insp.current?.provider}/${insp.current?.model}）`);
    // 关键断言：assembled 只在 installModelSelection 的 assemble 监听里赋值。
    // resume 漏装 setup 时它会恒为 undefined——这正是模型切换静默失效的根因。
    ok(insp.assembled?.provider === o.provider && insp.assembled?.model === target, `assemble 已采纳新模型（assembled=${insp.assembled?.provider}/${insp.assembled?.model ?? "undefined"}）`);
    ok(typeof msgFrame.reply === "string" && msgFrame.reply.trim().length > 0, `切换后普通消息返回非空回复（「${msgFrame.reply}」）`);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exitCode = 1;
});
