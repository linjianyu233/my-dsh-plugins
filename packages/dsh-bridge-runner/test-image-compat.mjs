#!/usr/bin/env node
/**
 * test-image-compat.mjs —— image-compat 优雅降级逻辑的单元测试（无 DSH 运行时依赖）。
 *
 * 覆盖：
 *   1. filterImagesFromMessages：剥离顶层 image 块、tool-result 内嵌 image 块、保留文本；
 *   2. contentHasImageLikeBlock / hasImageLikeBlock 递归判定；
 *   3. ImageCompatibility 的门控：仅当模型「已确认不支持图片」才剥离，支持图片/未知时放行。
 *
 * 用法: node test-image-compat.mjs
 */

import { ImageCompatibility, contentHasImageLikeBlock, filterImagesFromMessages, hasImageLikeBlock } from "./lib/image-compat.mjs";

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
}

// ---- 1. 纯函数：剥离 / 保留 ----
function imageCount(messages) {
  return JSON.stringify(messages).split("\"type\":\"image\"").length - 1;
}

const history = () => [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  {
    role: "tool-result",
    content: [
      { type: "text", text: "<path>/a.jpg</path>\n<type>image</type>\n<content>2x2</content>" },
      { type: "image", attachment: { id: "1" } },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "saw it" }] },
];

console.log("\n[1] filterImagesFromMessages 顶层剥离");
{
  const out = filterImagesFromMessages(history());
  assert(out !== history(), "含图历史返回新数组");
  assert(imageCount(out) === 0, `image 块被剥离（剩 ${imageCount(out)}）`);
  const tool = out.find((m) => m.role === "tool-result");
  assert(Array.isArray(tool.content) && tool.content.some((b) => b.type === "text"), "工具结果里的文本信封保留");
  assert(tool.content.length === 1, `工具结果只留文本块（${tool.content.length} 块）`);
  const plain = history().slice(0, 1);
  assert(filterImagesFromMessages(plain) === plain, "无图历史原样返回同一引用");
}

console.log("[2] tool-result 嵌套剥离");
{
  const nested = [{ role: "tool-result", content: [{ type: "tool-result", content: [{ type: "text", text: "x" }, { type: "image", attachment: {} }] }] }];
  const out = filterImagesFromMessages(nested);
  const inner = out[0].content[0].content;
  assert(imageCount(out) === 0, "嵌套 image 块被剥离");
  assert(inner.length === 1 && inner[0].type === "text", "嵌套内文本保留");
}

console.log("[3] 判定函数");
{
  assert(contentHasImageLikeBlock([{ type: "image" }]) === true, "顶层 image 命中");
  assert(contentHasImageLikeBlock([{ type: "tool-result", content: [{ type: "image" }] }]) === true, "嵌套 image 命中");
  assert(contentHasImageLikeBlock([{ type: "text", text: "no img" }]) === false, "纯文本不命中");
  assert(hasImageLikeBlock({ content: [{ type: "image" }] }) === true, "hasImageLikeBlock(顶层)");
}

// ---- 4. ImageCompatibility 门控 ----
console.log("[4] ImageCompatibility 门控（mock llm）");
{
  const llm = {
    async resolveModelInfo(_provider, model) {
      return { inputModalities: ["text", ...(model.includes("kimi") || model.includes("qwen") ? ["image"] : [])] };
    },
  };
  const ic = new ImageCompatibility(llm);
  const messages = () => [{ role: "tool-result", content: [{ type: "text", text: "e" }, { type: "image", attachment: {} }] }];
  const session = { deriveMessages() { return messages(); } };
  ic.install(session);
  const current = [{ provider: "opencode-go", model: "deepseek-v4-flash" }];
  ic.setCurrentGetter(() => current[0]);
  await ic.refresh("opencode-go", "deepseek-v4-flash"); // text-only
  await ic.refresh("opencode-go", "kimi-k3");          // image-capable

  current[0] = { provider: "opencode-go", model: "deepseek-v4-flash" };
  assert(imageCount(session.deriveMessages()) === 0, "text-only 模型 → image 剥离");
  current[0] = { provider: "opencode-go", model: "kimi-k3" };
  assert(imageCount(session.deriveMessages()) === 1, "image-capable 模型 → image 保留");
  current[0] = { provider: "opencode-go", model: "never-heard" };
  assert(imageCount(session.deriveMessages()) === 1, "能力未知模型 → 不剥离（保守放行）");

  // 缓存去重：同一模型不应重复 resolve
  let calls = 0;
  const ic2 = new ImageCompatibility({ async resolveModelInfo() { calls += 1; return { inputModalities: ["text"] }; } });
  await ic2.resolveImageInput("p", "m");
  await ic2.resolveImageInput("p", "m");
  assert(calls === 1, "能力按 provider|model 缓存去重");
}

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
