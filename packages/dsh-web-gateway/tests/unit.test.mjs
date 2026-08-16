// tests/unit.test.mjs — 纯逻辑单测：registry / proxy转发头 / prober / idle。
import test from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../lib/registry.js";
import { forwardHeaders } from "../lib/proxy.js";
import { pidAlive } from "../lib/prober.js";

test("forwardHeaders: /api 路径 → loopback Host + 删 Origin（穿透 DSH 围栏）", () => {
  const h = forwardHeaders(
    { host: "gateway.example.com", origin: "https://gateway.example.com", "sec-fetch-site": "cross-site", "x-keep": "1" },
    5210,
    "/api/events.mux"
  );
  assert.equal(h.Host, "127.0.0.1:5210");
  assert.equal(h.origin, undefined);
  assert.equal(h["sec-fetch-site"], undefined);
  assert.equal(h["x-keep"], "1");
});

test("forwardHeaders: 非 /api（dsh-market POST）→ 保留 Origin + Host 置为 Origin.host（同源）", () => {
  const h = forwardHeaders(
    { host: "127.0.0.1:8181", origin: "http://127.0.0.1:8181", "x-keep": "1" },
    5210,
    "/dsh-market/install"
  );
  // sameOrigin() 要求 new URL(origin).host === Host → Host 必须等于 origin.host
  assert.equal(h.host, "127.0.0.1:8181");
  assert.equal(h.origin, "http://127.0.0.1:8181"); // Origin 保留
  assert.equal(h["sec-fetch-site"], undefined);
  assert.equal(h["x-keep"], "1");
});

test("forwardHeaders: 非 /api 但无 Origin（静态导航 GET）→ loopback Host", () => {
  const h = forwardHeaders({ host: "gw.x", "sec-fetch-site": "same-origin" }, 5210, "/app.js");
  assert.equal(h.host, "127.0.0.1:5210");
  assert.equal(h["sec-fetch-site"], undefined);
});

test("registry: claim/promote/release lifecycle", () => {
  const r = new Registry();
  const s = r.claim("staging");
  s.port = 9001;
  s.pid = 123;
  r.setState(s, "ready");
  assert.equal(r.staging().port, 9001);
  r.promote();
  assert.equal(r.active().port, 9001);
  assert.equal(r.active().pid, 123);
  assert.equal(r.staging().port, null);
  const snap = r.release("active");
  assert.equal(snap.pid, 123);
  assert.equal(r.active().port, null);
});

test("pidAlive false for nonexistent pid", () => {
  assert.equal(pidAlive(999999999), false);
});
