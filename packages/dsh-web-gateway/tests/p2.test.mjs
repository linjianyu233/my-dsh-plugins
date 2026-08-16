// tests/p2.test.mjs — P2 Doctor/Watchdog/AI 单测。
import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseLog } from "../lib/doctor.js";
import { readCredential } from "../lib/ai.js";
import { Watchdog } from "../lib/watchdog.js";
import { Registry } from "../lib/registry.js";

test("doctor: EADDRINUSE 命中", () => {
  const d = diagnoseLog("node: Error: listen EADDRINUSE: address already in use 127.0.0.1:5188");
  assert.equal(d.verdict, "EADDRINUSE");
  assert.match(d.detail, /端口被占用/);
  assert.equal(d.fix.kind, "relaunch-with-new-port");
});

test("doctor: patch 未知选项命中", () => {
  const d = diagnoseLog("error: unknown option '--patch'");
  assert.equal(d.verdict, "PATCH_OPTION_ORDER");
});

test("doctor: patch 引用不存在条目命中", () => {
  const d = diagnoseLog('dsh: [/tmp/x.yml] patch: entry "foo-bar" not found');
  assert.equal(d.verdict, "CONFIG_PARSE");
  assert.match(d.detail, /"foo-bar"/);
});

test("doctor: overlay 文件不存在命中", () => {
  const d = diagnoseLog('Error: dsh: failed to read overlay /tmp/definitely-not-exist.yml: Error: ENOENT: no such file or directory');
  assert.equal(d.verdict, "PATCH_NOT_FOUND");
});

test("doctor: 0.0.0.0 拒绝命中", () => {
  const d = diagnoseLog("--host 0.0.0.0 is intentionally not supported yet for safety");
  assert.equal(d.verdict, "HOST_0_0_0_0");
});

test("doctor: 未知日志 → unknown 交由 LLM", () => {
  const d = diagnoseLog("some weird cryptic crash 0xC0FFEE");
  assert.equal(d.verdict, "unknown");
});

test("doctor: 空日志 → empty", () => {
  assert.equal(diagnoseLog("").verdict, "empty");
});

test("ai: readCredential 读不到时返回 undefined（不抛）", () => {
  assert.equal(readCredential("DEFINITELY_NOT_A_REAL_KEY_XYZ"), undefined);
});

test("watchdog: 连续失败达阈值触发 relaunch（用假 backend）", async () => {
  const registry = new Registry();
  const events = [];
  let relaunched = 0;
  const fakeSlot = registry.claim("active");
  fakeSlot.port = 1;
  fakeSlot.pid = 999999; // 不存在
  fakeSlot.child = { exitCode: null, signalCode: null, kill: () => {} };
  registry.setState(fakeSlot, "ready");

  // 替换单测：不真 spawn，直接验证阈值计数逻辑
  const w = new Watchdog(
    {
      registry,
      proxy: { setGetBackend: () => {} },
      capture: (m) => events.push(m),
    },
    { profile: "web", patches: [], threshold: 3, backoffMs: 0 }
  );
  // monkey-patch _relaunch 避免真拉起
  let _relaunchCalls = 0;
  w._relaunch = async () => {
    _relaunchCalls += 1;
    relaunched += 1;
  };
  w.pause(0);
  await w.tick(); // fail#1
  await w.tick(); // fail#2
  assert.equal(_relaunchCalls, 0);
  await w.tick(); // fail#3 -> relaunch
  assert.equal(_relaunchCalls, 1);
  assert.ok(events.some((m) => /relaunching/.test(m)));
});