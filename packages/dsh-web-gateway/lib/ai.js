// lib/ai.js — LLM 兜底诊断修复（P2）。
//
// 当规则诊断未命中（verdict=unknown）时，把后端日志尾 + --dump-config 出错的
// 上下文喂给模型，产出**结构化修复指令 JSON**。模型永不直接改 active/profile：
// 指令只落到“应改哪个文件 + 改成什么”，由编排层 apply 到 staging 验证后才上线。
//
// 接入方式（零依赖、可降级）：
//   1. 环境变量 DEEPSEEK_API_KEY
//   2. $DSH_HOME/.credentials.yaml 里的 DEEPSEEK_API_KEY
// 都没有 => { available:false }，调用方降级为“仅规则诊断 + 人工介入提示”。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

export function resolveDshHome() {
  return process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || ".", ".dsh");
}

/** 读 DSH 凭据文件指定 key（扁平 {KEY:value}）。返回 undefined 当不存在/解析失败。 */
export function readCredential(key) {
  const env = process.env[key];
  if (env) return env;
  try {
    const file = join(resolveDshHome(), ".credentials.yaml");
    const text = readFileSync(file, "utf8");
    // 极简 YAML 扁平解析：直接抓 `KEY: value` 行（凭据值是裸字符串或者引号字符串）
    const re = new RegExp(`^\\s*${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))\\s*$`, "m");
    const m = text.match(re);
    if (m) return m[1] ?? m[2] ?? m[3];
  } catch {}
  return undefined;
}

export function deepseekKey() {
  return readCredential("DEEPSEEK_API_KEY");
}

/** 探测 yaml 解析库：优先 dsh 自带，其次裸实现。 */
function loadYaml() {
  try {
    // dsh 安装目录的 node_modules/yaml
    const dshNm = join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "..",
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "node_modules",
      "yaml"
    );
    return import(/* webpackIgnore: true */ `${dshNm}/dist/index.js`).then((m) => m.parse ?? m.default?.parse);
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * 调用 DeepSeek chat completions 产出结构化修复指令。
 * @param {string} logTail 后端日志尾部
 * @param {{dumpConfig?:string, profile?:string}} ctx
 * @returns {Promise<{ok:true, fix:object}|{ok:false, reason:string}>}
 *   fix = { file, change, why }（LLM 建议；由编排层决定如何应用）
 */
export async function askFix(logTail, { dumpConfig = "", profile = "web" } = {}) {
  const key = deepseekKey();
  if (!key) {
    return { ok: false, reason: "no-credential", detail: "未找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）" };
  }

  const system = [
    "你是 DeepSeek Harness (DSH) 的启动故障诊断助手。",
    "DSH 的 web profile 是一个 cordis 组合树：bundle 的 patch 层 + 用户 cordis.patch.yml + --patch overlay。",
    "dsh web 启动失败常见于：patch 引用了不存在的条目、YAML 结构错误、端口占用、",
    "插件 decline HMR / externals 需要重启、profile node_modules 缺失依赖。",
    "请根据提供的『后端日志尾部』与『组合配置 dump（若有）』，判断最可能的根因，",
    '并严格输出**一个 JSON 对象**（不要 markdown 代码块、不要解释文字），形如：',
    '{"verdict":"<简短标签>","detail":"一句话根因","fix":{"file":"要修改的文件相对路径，如 profiles/web/cordis.patch.yml（空串表示无需改文件）","change":"具体改动内容（YAML/JSON 片段，或 删掉第X行 之类操作）","reason":"为什么这样改"}}',
    "若判断为无需改文件（如端口冲突/需要重启），file 给空串、change 描述操作。",
  ].join("\n");

  const user = [
    `profile: ${profile}`,
    `--- 后端日志尾部 ---`,
    logTail.slice(0, 6000),
    dumpConfig ? `--- 组合配置 dump（出错段，可截取）---\n${dumpConfig.slice(0, 4000)}` : "",
    "",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `provider-http-${res.status}`, detail: text.slice(0, 300) };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // 模型偶尔包 markdown 代码块
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, reason: "bad-llm-json", detail: content.slice(0, 300) };
    }
    return { ok: true, fix: { ...parsed, model: "deepseek-chat" } };
  } catch (e) {
    return { ok: false, reason: "network-error", detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}