// tests/skill-provider.test.mjs — 包内技能 provider 的单测（零依赖，node --test）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, parseSkillFile, createSkillProvider } from "../lib/skill-provider.js";

/** 建一个临时 skills 根目录，返回路径；测试结束自动清理。 */
async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "gw-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const GOOD_SKILL = `---
name: dsh-web-gateway
description: >-
  管理 DSH Web 网关
  的蓝绿发布。
disable-model-invocation: false
user-invocable: true
---

# 正文第一行

正文第二行。
`;

test("parseFrontmatter: 折叠块 + 布尔 + 注释", () => {
  const parsed = parseFrontmatter(GOOD_SKILL);
  assert.ok(parsed);
  assert.equal(parsed.data.name, "dsh-web-gateway");
  // `>-` 折叠：行间折成单空格，去掉尾部换行
  assert.equal(parsed.data.description, "管理 DSH Web 网关 的蓝绿发布。");
  assert.equal(parsed.data["disable-model-invocation"], false);
  assert.equal(parsed.data["user-invocable"], true);
  assert.equal(parsed.body.trim(), "# 正文第一行\n\n正文第二行。");
});

test("parseFrontmatter: 引号值 / 字面块 / 无 frontmatter", () => {
  assert.equal(
    parseFrontmatter('---\ntitle: "a:b"\n---\nbody\n').data.title,
    "a:b",
  );
  const literal = parseFrontmatter("---\nnotes: |\n  line1\n  line2\n---\nx");
  assert.equal(literal.data.notes, "line1\nline2");
  assert.equal(parseFrontmatter("no frontmatter here\n"), undefined);
  assert.equal(parseFrontmatter("---\nname: x\n"), undefined); // 未闭合
});

test("parseSkillFile: 缺 name/description、非法名称、坏 YAML → undefined", async (t) => {
  const root = await fixture(t, {
    "bad1/SKILL.md": "---\ndescription: x\n---\n",
    "bad2/SKILL.md": "---\nname: HasUpper\n---\n",
    "bad3/SKILL.md": "not yaml",
    "ok/SKILL.md": GOOD_SKILL,
  });
  assert.equal(await parseSkillFile(join(root, "bad1", "SKILL.md")), undefined);
  assert.equal(await parseSkillFile(join(root, "bad2", "SKILL.md")), undefined);
  assert.equal(await parseSkillFile(join(root, "bad3", "SKILL.md")), undefined);
  const ok = await parseSkillFile(join(root, "ok", "SKILL.md"));
  assert.equal(ok.name, "dsh-web-gateway");
  assert.equal(ok.invocation.modelInvocable, true);
  assert.equal(ok.invocation.userInvocable, true);
});

test("parseInvocationPolicy: 旧式键被拒（经 createSkillProvider.list）", async (t) => {
  const root = await fixture(t, {
    "legacy/SKILL.md": "---\nname: legacy\nmodelInvocable: false\n---\nbody",
  });
  // 旧键抛错 → list 对坏条目跳过，目录里没有 candidate
  const provider = createSkillProvider(root);
  assert.deepEqual(await provider.list(), []);
});

test("createSkillProvider: 目录包 + 扁平 md + 隐藏项 + 非 md 过滤 + 排序 + 元数据", async (t) => {
  const root = await fixture(t, {
    "dsh-web-gateway/SKILL.md": GOOD_SKILL,
    "alpha/SKILL.md": "---\nname: alpha\ndescription: 目录包技能\n---\n",
    "flat-one.md": "---\nname: flat-one\ndescription: 扁平文件技能\n---\nflat body",
    "notes.txt": "ignore me",
    ".hidden/SKILL.md": "---\nname: hidden\n---\n",
  });
  const provider = createSkillProvider(root, { providerName: "test-skills", rank: 600 });
  const candidates = await provider.list();
  assert.deepEqual(candidates.map((c) => c.name), ["alpha", "dsh-web-gateway", "flat-one"]);
  const first = candidates[1]; // dsh-web-gateway（按字母序 alpha < dsh-web-gateway < flat-one）
  assert.equal(first.provider, "test-skills");
  assert.equal(first.source, "bundled");
  assert.equal(first.rank, 600);
  assert.deepEqual(first.invocation, { modelInvocable: true, userInvocable: true });
  assert.deepEqual(first.resourceBase, { kind: "directory", path: join(root, "dsh-web-gateway") });
  assert.equal(typeof first.locator.path, "string");
});

test("createSkillProvider: get 返回完整正文，文件消失返回 undefined", async (t) => {
  const root = await fixture(t, {
    "demo/SKILL.md": GOOD_SKILL,
  });
  const provider = createSkillProvider(root);
  const [candidate] = await provider.list();
  const def = await provider.get(candidate);
  assert.equal(def.name, "dsh-web-gateway");
  assert.equal(def.content, "# 正文第一行\n\n正文第二行。");
  // 文件被删 → get 反回 undefined（内容读取始终是活的，不缓存）
  await rm(join(root, "demo", "SKILL.md"));
  assert.equal(await provider.get(candidate), undefined);
});

test("createSkillProvider: skills 目录不存在 → 空列表", async () => {
  const provider = createSkillProvider("/nonexistent/skills-dir");
  assert.deepEqual(await provider.list(), []);
});