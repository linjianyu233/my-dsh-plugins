// tests/unit.test.mjs — 纯逻辑单测：registry / proxy转发头 / prober / idle。
import test from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../lib/registry.js";
import { forwardHeaders } from "../lib/proxy.js";
import { pidAlive } from "../lib/prober.js";

test("forwardHeaders: rewrites Host to loopback and deletes Origin/sec-fetch-site", () => {
  const h = forwardHeaders(
    { host: "gateway.example.com", origin: "https://gateway.example.com", "sec-fetch-site": "cross-site", "x-keep": "1" },
    5210
  );
  assert.equal(h.Host, "127.0.0.1:5210");
  assert.equal(h.origin, undefined);
  assert.equal(h["sec-fetch-site"], undefined);
  assert.equal(h["x-keep"], "1");
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
