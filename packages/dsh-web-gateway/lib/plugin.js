// lib/plugin.js — @linjianyu/dsh-web-gateway 的 Cordis bundle 入口（host 面）。
//
// 把 gateway 包装成真正的 DSH bundle 插件：接入 cordis.patch.yml 后由
// `dsh plugin --profile <name> add @linjianyu/dsh-web-gateway` 装入 profile，
// 在宿主上下文执行 apply()。宿主行注册的 skill provider 落进技能注册表的
// **全局层**（见 docs/subsystems/skills.md：宿主行与 repository 插件落入全局
// 层），因此本包随附的 skills/ 在**所有工作区、所有会话**可见，且内容始终来自
// 当前安装的包版本——无需拷贝、卸载即消失。
//
// 刻意不 import any @deepseek-ai/* runtime symbol：插件经 profile 安装后由
// loader import，其依赖解析沿包真实路径向上走 node_modules；把 cordis /
// dsh-skill 只保留为 peerDependencies（类型/契约声明）可让本入口对
// 符号链接（本地开发）与扁平 fallback（正式安装）两种布局都零依赖可解析。
// 技能逻辑全部在零依赖的 lib/skill-provider.js。

import { fileURLToPath } from "node:url";
import { createSkillProvider } from "./skill-provider.js";

/** Cordis 插件名；作为 loader 行的 name 时经 exports 映射指向本文件。 */
export const name = "dsh-web-gateway";

/** 技能注册表服务（@deepseek-ai/dsh-skill，宿主层常驻，web 面亦保留）。 */
export const inject = ["skills"];

/** 随包发布的技能目录：<pkg>/skills/。 */
const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/**
 * 注册包内技能 provider 到调用方上下文的层。宿主上下文（bundle patch 装入
 * 的普通行）→ 全局层 → 所有工作区的 agent 都能读到；provider 名在层内唯一。
 *
 * rank 用 createSkillProvider 的默认值 600（=官方 BUNDLED_SKILL_RANK 当前值，
 * 与 dsh-skill-badge 对齐）：随包技能走 bundled 档位，本地用户/项目技能
 * （更低 rank）可以同名覆盖。
 */
export function apply(ctx) {
  ctx.skills.registerProvider(() =>
    createSkillProvider(SKILLS_DIR, { providerName: "web-gateway-skills" }),
  );
}