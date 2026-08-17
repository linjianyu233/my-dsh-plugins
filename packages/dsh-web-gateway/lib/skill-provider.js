// lib/skill-provider.js — 包内 skills/ 目录的 SkillProvider（零 npm 依赖）。
//
// 路线 B：插件自身注册一个 provider，直接服务随包发布的 skills/ 目录，
// 而不是把文件拷贝到 ~/.dsh/skills。宿主上下文注册 → 全局层 → 所有工作区
// 的会话都能看到，且永远读取「当前安装版本」的内容；卸载包即自动消失。
//
// 本文件刻意不 import cordis / dsh-skill / yaml —— 逻辑全部用 node 内置模块，
// 便于单测和保持本包「零 npm 依赖」的传统；与 cordis 的接线只在 lib/plugin.js。

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** skill 名称必须是 kebab-case（与 dsh-skill 的 isSkillName 同规则）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 单个 skill 的来源标签；prompt 可见元数据，与优先级无关。 */
const BULK_SOURCE = "bundled";

/**
 * 解析 SKILL.md 的 YAML frontmatter（够用的子集）：
 *  - `key: value` 单行标量（支持引号包裹与 true/false 布尔）
 *  - `key: >-` 折叠块（多行缩进合并为单行，去掉尾部换行 —— DSH frontmatter 惯例）
 *  - `key: >` / `key: |` 块
 *  - 注释行（#）与空行跳过
 *
 * 不支持的 YAML 特性（列表、嵌套、锚点）按「无法解析 → 忽略该 skill」处理，
 * 与 dsh-skill-filesystem 对坏 frontmatter 的态度一致。
 *
 * @param {string} raw SKILL.md 全文
 * @returns {{ data: Record<string, unknown>, body: string } | undefined}
 */
export function parseFrontmatter(raw) {
  const firstBreak = raw.indexOf("\n");
  if (firstBreak < 0) return undefined;
  if (raw.slice(0, firstBreak).replace(/\r$/, "") !== "---") return undefined;
  const start = firstBreak + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === undefined) return undefined;

  const lines = raw.slice(start, closing.start).split(/\r?\n/);
  const data = {};
  let i = 0;
  let pendingKey = null;
  let pendingMode = null; // 'fold' | 'literal' | 'plain'
  let blockLines = [];

  const flushBlock = () => {
    if (pendingKey === null) return;
    if (pendingMode === "fold") {
      data[pendingKey] = blockLines.join(" ").trim();
    } else if (pendingMode === "literal") {
      data[pendingKey] = blockLines.join("\n");
    } else {
      data[pendingKey] = blockLines.join("\n");
    }
    pendingKey = null;
    pendingMode = null;
    blockLines = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    if (pendingKey !== null && indent > 0) {
      // 属于上一个 key 的块内容行。
      blockLines.push(line.trim());
      i += 1;
      continue;
    }
    flushBlock();

    if (indent > 0) {
      // 无主缩进行：视为坏 frontmatter，整体放弃（保守）。
      return undefined;
    }

    const colon = trimmed.indexOf(":");
    if (colon < 0) return undefined;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (key === "") return undefined;

    if (value === "" || value === ">-" || value === ">" || value === "|" || value === "|-") {
      pendingKey = key;
      pendingMode = value === ">-" ? "fold"
        : value === ">" ? "fold"
        : value === "|" ? "literal"
        : "plain";
      blockLines = [];
      i += 1;
      continue;
    }

    data[key] = parseScalar(value);
    i += 1;
  }
  flushBlock();

  return { data, body: raw.slice(closing.bodyStart) };
}

/** 单行标量的收紧解析：去引号、布尔化；其余保持字符串。 */
function parseScalar(value) {
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (value === "null" || value === "~") return null;
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
  }
  return value;
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextBreak = raw.indexOf("\n", lineStart);
    const lineEnd = nextBreak < 0 ? raw.length : nextBreak;
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      return { start: lineStart, bodyStart: nextBreak < 0 ? raw.length : nextBreak + 1 };
    }
    if (nextBreak < 0) return undefined;
    lineStart = nextBreak + 1;
  }
  return undefined;
}

/** 解析调用策略；拒绝旧式键名（与 dsh-skill-filesystem 一致）。 */
function parseInvocationPolicy(data) {
  for (const [legacy, canonical] of [
    ["disableModelInvocation", "disable-model-invocation"],
    ["modelInvocable", "disable-model-invocation"],
    ["userInvocable", "user-invocable"],
  ]) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`);
    }
  }
  const disableModel = data["disable-model-invocation"];
  const userInvocable = data["user-invocable"];
  if (disableModel !== undefined && typeof disableModel !== "boolean") {
    throw new TypeError(`frontmatter field "disable-model-invocation" must be a boolean`);
  }
  if (userInvocable !== undefined && typeof userInvocable !== "boolean") {
    throw new TypeError(`frontmatter field "user-invocable" must be a boolean`);
  }
  return {
    modelInvocable: disableModel !== true,
    userInvocable: userInvocable !== false,
  };
}

/**
 * 解析一个 SKILL.md 文件为 skill 定义。
 *
 * @param {string} path SKILL.md 绝对路径
 * @returns {Promise<object | undefined>} 解析失败（无 frontmatter / 缺 name
 *   description / 非法名称 / 坏 YAML）返回 undefined。
 */
export async function parseSkillFile(path) {
  const raw = await readFile(path, "utf8");
  const parsed = parseFrontmatter(raw);
  if (parsed === undefined) return undefined;
  const name = stringField(parsed.data, "name");
  const description = stringField(parsed.data, "description");
  if (name === undefined || description === undefined) return undefined;
  if (!SKILL_NAME_RE.test(name)) return undefined;
  const whenToUse = optionalString(parsed.data, "whenToUse");
  const invocation = parseInvocationPolicy(parsed.data);
  return {
    name,
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    invocation,
    content: parsed.body.trim(),
  };
}

function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 创建服务包内 skills/ 目录的 SkillProvider。
 *
 * 支持两种形态（与 dsh-skill-filesystem 对齐）：
 *   - 目录包：`<skillsDir>/<name>/SKILL.md`
 *   - 扁平文件：`<skillsDir>/<name>.md`
 * 目录包优先；隐藏项与非 .md 文件忽略；按名称排序。
 *
 * @param {string} skillsDir 包内 skills 目录绝对路径
 * @param {{ providerName?: string, rank?: number }} [options]
 * @returns {{ name: string, list: () => Promise<unknown[]>, get: (candidate: object) => Promise<object | undefined> }}
 */
export function createSkillProvider(skillsDir, options = {}) {
  const providerName = options.providerName ?? "web-gateway-skills";
  const rank = options.rank ?? 600; // 默认对齐 BUNDLED_SKILL_RANK：本地文件可覆盖

  return {
    name: providerName,

    async list() {
      let entries;
      try {
        entries = await readdir(skillsDir, { withFileTypes: true, encoding: "utf8" });
      } catch (error) {
        if (error && error.code === "ENOENT") return [];
        throw error;
      }
      const candidates = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".")) continue;
        try {
          const info = await stat(join(skillsDir, entry.name));
          let skillPath;
          let resourceDir;
          if (info.isDirectory()) {
            skillPath = join(skillsDir, entry.name, "SKILL.md");
            resourceDir = join(skillsDir, entry.name);
          } else if (info.isFile() && entry.name.endsWith(".md")) {
            skillPath = join(skillsDir, entry.name);
            resourceDir = skillsDir;
          } else {
            continue;
          }
          const parsed = await parseSkillFile(skillPath).catch((error) => {
            if (error && error.code === "ENOENT") return undefined;
            throw error;
          });
          if (parsed === undefined) continue;
          candidates.push({
            name: parsed.name,
            description: parsed.description,
            ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
            invocation: parsed.invocation,
            provider: providerName,
            source: BULK_SOURCE,
            rank,
            locator: { path: skillPath, directory: resourceDir },
            resourceBase: { kind: "directory", path: resourceDir },
            path: skillPath,
          });
        } catch (error) {
          // 单个坏条目不影响其余条目。
          continue;
        }
      }
      // 目录按名字排序扫描；最终按「解析出的 skill 名」排序返回（目录名与
      // frontmatter name 可能不一致，注册表最终也按 skill 名排摘要）。
      return candidates.sort((a, b) => a.name.localeCompare(b.name));
    },

    async get(candidate) {
      const locator = candidate.locator;
      if (!locator || typeof locator.path !== "string") return undefined;
      const parsed = await parseSkillFile(locator.path).catch((error) => {
        if (error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (parsed === undefined || parsed.name !== candidate.name) return undefined;
      return {
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
        invocation: parsed.invocation,
        provider: providerName,
        source: BULK_SOURCE,
        resourceBase: { kind: "directory", path: locator.directory },
        path: locator.path,
        content: parsed.content,
      };
    },
  };
}