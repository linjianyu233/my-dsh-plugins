/**
 * lib/sessions.mjs —— 微信桥接的多会话管理：每个微信联系人可拥有多个命名会话。
 *
 * 会话模型：
 *   - 默认会话 "main" 的 chatId 保持 `wx:<联系人ID>`（与旧版完全兼容，旧记忆/工作目录原样保留）；
 *   - 命名会话的 chatId 为 `wx:<联系人ID>:<名字>`；
 *   - 会话名只进 chatId，绝不直接进文件路径（历史文件/工作目录一律由 safeKey(chatId) 派生，杜绝路径穿越）；
 *   - 注册表（"当前会话"指针 + 会话元数据）存在 data/sessions-registry/<联系人key>.json，
 *     缺失或损坏时安全回落默认会话，绝不中断消息处理。
 */

import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { safeKey, historyFile, loadHistory, log } from "./core.mjs";

export const DEFAULT_SESSION = "main";

// 合法的权限级别（对应 DSH 的 DSH_PERMISSION_MODE 三档沙箱预设）。
export const PERMISSION_LEVELS = Object.freeze(["read-only", "workspace-write", "danger-full-access"]);

// 名字规则：1-20 个字符，仅限字母（含中文）、数字、'-'、'_'、'.'；天然排除 '/'、'\\' 等路径敏感字符。
const NAME_RE = /^[\p{L}\p{N}_.\-]{1,20}$/u;

const registryCache = new Map(); // contactKey -> registry 对象（进程内缓存，本进程是唯一写者）

export function normalizeName(name) {
  return String(name ?? "").trim();
}

export function nameOk(name) {
  const n = normalizeName(name);
  return n.length > 0 && NAME_RE.test(n);
}

export function contactKeyFor(from) {
  return safeKey(`wx:${from}`);
}

export function chatIdFor(contactId, sessionName) {
  return sessionName === DEFAULT_SESSION ? `wx:${contactId}` : `wx:${contactId}:${sessionName}`;
}

function registryFile(cfg, contactKey) {
  return path.join(cfg.dataDir, "sessions-registry", `${contactKey}.json`);
}

export async function getRegistry(cfg, contactKey) {
  const hit = registryCache.get(contactKey);
  if (hit) return hit;
  let reg = null;
  try {
    const raw = JSON.parse(await readFile(registryFile(cfg, contactKey), "utf8"));
    if (typeof raw.current === "string" && raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
      reg = raw;
    }
  } catch {
    /* 文件缺失或损坏 → 回落默认注册表 */
  }
  if (!reg) {
    reg = { current: DEFAULT_SESSION, sessions: {} };
  } else if (!(reg.current === DEFAULT_SESSION || reg.sessions[reg.current])) {
    log(`[sessions] 注册表 current 无效（${reg.current}），回落 ${DEFAULT_SESSION}`);
    reg.current = DEFAULT_SESSION;
  }
  registryCache.set(contactKey, reg);
  return reg;
}

export async function saveRegistry(cfg, contactKey, reg) {
  registryCache.set(contactKey, reg);
  const file = registryFile(cfg, contactKey);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(reg, null, 2), "utf8");
  await rename(tmp, file);
}

/** 按名字找会话（大小写不敏感；main 永远视为存在）。返回 {name, createdAt, lastActiveAt, config} 或 null。 */
export function findSession(reg, name) {
  const n = normalizeName(name);
  if (n.toLowerCase() === DEFAULT_SESSION) {
    return {
      name: DEFAULT_SESSION,
      createdAt: reg.sessions[DEFAULT_SESSION]?.createdAt ?? 0,
      lastActiveAt: reg.sessions[DEFAULT_SESSION]?.lastActiveAt ?? 0,
      config: reg.sessions[DEFAULT_SESSION]?.config ?? {},
    };
  }
  const entry = reg.sessions[n];
  if (entry)
    return { name: n, createdAt: entry.createdAt ?? 0, lastActiveAt: entry.lastActiveAt ?? 0, config: entry.config ?? {} };
  const hit = Object.keys(reg.sessions).find((k) => k.toLowerCase() === n.toLowerCase());
  if (hit)
    return {
      name: hit,
      createdAt: reg.sessions[hit]?.createdAt ?? 0,
      lastActiveAt: reg.sessions[hit]?.lastActiveAt ?? 0,
      config: reg.sessions[hit]?.config ?? {},
    };
  return null;
}

/**
 * 解析该联系人当前的 chatId（不修改注册表）。
 */
export async function resolveChatId(cfg, contactId, contactKey) {
  const reg = await getRegistry(cfg, contactKey);
  return chatIdFor(contactId, reg.current);
}

/**
 * 取某会话的 resident 持久 session 标识（真·会话复用用）。
 * 形如 `<chatId>@<epoch>`：epoch 每次 /clear 递增，从而"换一个新 session"，
 * 旧的 DSH session 保留在 ~/.dsh/sessions/ 里归档（不删除）。
 * @returns {Promise<{sessionId:string, epoch:number}>}
 */
export async function resolveResidentSessionId(cfg, contactId, contactKey, name) {
  const reg = await getRegistry(cfg, contactKey);
  const entry = reg.sessions[name] ?? {};
  const epoch = typeof entry.residentEpoch === "number" && entry.residentEpoch >= 0 ? entry.residentEpoch : 0;
  return { sessionId: `${chatIdFor(contactId, name)}@${epoch}`, epoch };
}

/**
 * 让某会话换一个新的 resident session（epoch +1，不删除旧 session）。
 * @returns {Promise<{chatId:string, sessionId:string}>} 新的 chatId 与新的 resident sessionId。
 */
export async function rotateResidentSession(cfg, contactId, contactKey, name) {
  const reg = await getRegistry(cfg, contactKey);
  const entry = reg.sessions[name] ?? {};
  const next = (typeof entry.residentEpoch === "number" && entry.residentEpoch >= 0 ? entry.residentEpoch : 0) + 1;
  reg.sessions[name] = {
    createdAt: entry.createdAt ?? Date.now(),
    lastActiveAt: entry.lastActiveAt ?? Date.now(),
    config: entry.config ?? {},
    residentEpoch: next,
  };
  if (name === DEFAULT_SESSION && !reg.sessions[DEFAULT_SESSION]) {
    // 兜底：确保 main 条目存在
  }
  await saveRegistry(cfg, contactKey, reg);
  const chatId = chatIdFor(contactId, name);
  return { chatId, sessionId: `${chatId}@${next}` };
}

/**
 * 取指定会话生效的 config（workspace/permission/model/provider），缺省字段回退为空。
 * model 若为 "provider/model" 拼接串会自动拆分。返回 { name, workspace?, permission?, model?, provider? }。
 */
export async function resolveSessionState(cfg, contactId, contactKey, name) {
  const reg = await getRegistry(cfg, contactKey);
  const target = findSession(reg, name) ?? { name, config: {} };
  const c = target.config ?? {};
  const rawModel = typeof c.model === "string" && c.model.trim() ? c.model.trim() : undefined;
  const rawProvider = typeof c.provider === "string" && c.provider.trim() ? c.provider.trim() : undefined;
  // 兼容 "provider/model" 拼接串（历史脏数据或用户简写）
  let provider = rawProvider;
  let model = rawModel;
  if (!rawProvider && rawModel && rawModel.includes("/") && !rawModel.includes(" ") && rawModel.split("/").length === 2) {
    const [p, m] = rawModel.split("/");
    provider = p;
    model = m;
  }
  return {
    name: target.name,
    workspace: typeof c.workspace === "string" && c.workspace.trim() ? c.workspace.trim() : undefined,
    permission: typeof c.permission === "string" && c.permission.trim() ? c.permission.trim() : undefined,
    model,
    provider,
  };
}

/** 更新某会话的 config（合并，不覆盖未提供的键）。name 必须已存在。 */
export async function updateSessionConfig(cfg, contactId, contactKey, name, patch) {
  const reg = await getRegistry(cfg, contactKey);
  const entry = reg.sessions[DEFAULT_SESSION === name ? name : name];
  if (!entry && name !== DEFAULT_SESSION) throw new Error(`会话「${name}」不存在`);
  if (name === DEFAULT_SESSION) {
    if (!reg.sessions[DEFAULT_SESSION]) reg.sessions[DEFAULT_SESSION] = { createdAt: Date.now(), lastActiveAt: Date.now() };
  }
  const cur = reg.sessions[name] ?? {};
  reg.sessions[name] = {
    createdAt: cur.createdAt ?? Date.now(),
    lastActiveAt: cur.lastActiveAt ?? Date.now(),
    config: { ...(cur.config ?? {}), ...patch },
  };
  await saveRegistry(cfg, contactKey, reg);
  return reg.sessions[name].config;
}

/** 新建一个匿名会话（唯一名）并切换过去，返回 chatId。 */
export async function createAnonymousSession(cfg, contactId, contactKey) {
  const reg = await getRegistry(cfg, contactKey);
  const now = Date.now();
  let name;
  let n = 0;
  do {
    n += 1;
    name = `s-${now}-${n}`;
  } while (findSession(reg, name));
  reg.sessions[name] = { createdAt: now, lastActiveAt: now };
  reg.current = name;
  await saveRegistry(cfg, contactKey, reg);
  return { chatId: chatIdFor(contactId, name), name };
}

export async function createSession(cfg, contactId, contactKey, name) {
  if (!nameOk(name)) throw new Error("会话名不合法：仅限中英文/数字/._-，1-20 字符");
  const reg = await getRegistry(cfg, contactKey);
  if (findSession(reg, name)) throw new Error(`会话「${name}」已存在，用 /switch ${name} 切换`);
  const now = Date.now();
  reg.sessions[name] = { createdAt: now, lastActiveAt: now };
  reg.current = name;
  await saveRegistry(cfg, contactKey, reg);
  return chatIdFor(contactId, name);
}

/** 切换会话。返回 {chatId, name}（name 为解析后的实际名字）。 */
export async function switchToSession(cfg, contactId, contactKey, name) {
  if (!nameOk(name)) throw new Error("会话名不合法：仅限中英文/数字/._-，1-20 字符");
  const reg = await getRegistry(cfg, contactKey);
  const target = findSession(reg, name);
  if (!target) throw new Error(`会话「${name}」不存在（/sessions 查看列表，/new ${name} 新建）`);
  reg.current = target.name;
  if (target.name !== DEFAULT_SESSION) {
    reg.sessions[target.name] = { createdAt: reg.sessions[target.name]?.createdAt ?? Date.now(), lastActiveAt: Date.now() };
  }
  await saveRegistry(cfg, contactKey, reg);
  return { chatId: chatIdFor(contactId, target.name), name: target.name };
}

/** 列出该联系人的全部会话：name / turns / lastActiveAt(ms) / isCurrent。当前会话排最前，main 其次。 */
export async function listSessionInfos(cfg, contactId, contactKey) {
  const reg = await getRegistry(cfg, contactKey);
  const names = [DEFAULT_SESSION, ...Object.keys(reg.sessions).filter((n) => n !== DEFAULT_SESSION)];
  const infos = [];
  for (const name of names) {
    const chatId = chatIdFor(contactId, name);
    const key = safeKey(chatId);
    const h = await loadHistory(cfg, key, chatId);
    let lastActiveAt = reg.sessions[name]?.lastActiveAt ?? 0;
    try {
      const st = await stat(historyFile(cfg, key));
      if (st.mtimeMs > lastActiveAt) lastActiveAt = st.mtimeMs;
    } catch {
      /* 无历史文件 */
    }
    infos.push({ name, turns: h.turns.length, lastActiveAt, isCurrent: name === reg.current });
  }
  infos.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.name === DEFAULT_SESSION) return -1;
    if (b.name === DEFAULT_SESSION) return 1;
    return (reg.sessions[a.name]?.createdAt ?? 0) - (reg.sessions[b.name]?.createdAt ?? 0);
  });
  return infos;
}
