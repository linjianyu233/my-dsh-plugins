/**
 * @linjianyu/dsh-bridge-runner —— 面向 bridge/客户端的通用常驻 agent 运行层。
 *
 * 与 `dsh-headless` 同构的一次性 direct driver，但改为「常驻 + 固定 sessionId + resume」：
 *   1. 用固定的 sessionId 首次 `agents.create`、之后（跨进程重启）`agents.resume` 恢复同一持久 session；
 *   2. 从 stdin 逐行读入输入，普通文本 → `agent.followup()`；特殊指令帧 → 运行时热切 model/permission；
 *   3. 循环直到 stdin EOF 或 SIGINT/SIGTERM，然后退出。
 *
 * 配置热切语义（与 DSH Web 对齐）：
 *   - model / provider：改 `selection.current`，下一次请求即用新模型（复用同一 session，不丢上下文）。
 *   - permission：调 `ctx.permissionPresets.set(session, preset)`，下 sandbox/mode + approval/policy 事件（复用 session）。
 *   - workspace(cwd)：SessionHeader.cwd 是不可变的，只能通过「换新 session + seed 继承记忆」实现（由桥侧 rotate 控制）。
 *
 * 额外把「切换模型」「切换权限」注册为 agent tool，使模型能通过自然语言自主调用。
 */

import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ImageCompatibility } from "./image-compat.mjs";

const name = "resident-runner";
const inject = ["agentDefaultModel", "agents", "sessions", "permissionPresets", "tools"];

const Config = z.object({
  sessionId: z.string().required(),
  workspace: z.string(),
  permission: z.string(),
  model: z.string(),
  provider: z.string(),
});

const internals = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
};

/**
 * 从一轮 events 里聚合「最后一个 assistant 文本」。
 * 只统计 firstSeq 之后（含）的事件，避免把历史轮次重复当成新产出。
 */
function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// 帧协议
// ---------------------------------------------------------------------------

function emit(id, payload) {
  internals.stdout.write(JSON.stringify({ id, ...payload }) + "\n");
}

function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

/** 逐行读取 stdin（跨平台；处理 \r\n 与无结尾换行的最后一行）。 */
async function* readLines(stream) {
  let buf = "";
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) yield line.slice(0, -1);
      else yield line;
    }
  }
  if (buf.length > 0) yield buf;
}

/** 拆 "provider/model" 或纯 model，返回 { provider?, model }。 */
function splitModel(value) {
  if (typeof value !== "string") return { model: "" };
  const v = value.trim();
  if (v.includes("/") && !v.includes(" ") && v.split("/").length === 2) {
    const [p, m] = v.split("/");
    return { provider: p, model: m };
  }
  return { model: v };
}

/**
 * 常驻主循环。
 */
async function run(ctx, config, io) {
  const { sessionId, workspace, permission, model, provider } = config;
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  const permissionPresets = ctx.get("permissionPresets");
  const tools = ctx.get("tools");
  const llm = ctx.get("llm");
  if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return;

  // 图片能力优雅降级：仅当当前模型已确认不支持图片时，剥离发送给 LLM 的历史图片块，
  // 避免切到 text-only 模型后每次请求都因历史里的 image 块抛 UNSUPPORTED_CONTENT 而空返回。
  const imageCompat = llm ? new ImageCompatibility(llm) : null;

  const identity = SessionId(sessionId);

  // 初始模型：显式 --model/--provider 覆盖默认；否则沿用 agentDefaultModel。
  const current = defaultModel.currentSelection();
  let effProvider = provider ?? current.provider ?? "deepseek-official";
  let effModel = model ?? current.model ?? "";
  if (!provider && model) {
    const sp = splitModel(model);
    effProvider = sp.provider ?? effProvider;
    effModel = sp.model;
  }

  // 可变 selection：installModelSelection 读取 selection.current，
  // 热切模型 = 改 selection.current（下一次请求即生效，复用同一 session）。
  const selection = { current: { provider: effProvider, model: effModel }, assembled: void 0 };

  // 切换模型时：更新 selection + 保存默认 + 刷新新模型图片能力（异步，不阻塞 reply）。
  const applyModel = async (provider, model) => {
    selection.current = { provider, model };
    try { await defaultModel.saveSelection(selection.current); } catch {}
    if (imageCompat) await imageCompat.refresh(provider, model);
  };

  const agentOptions = { provider: effProvider, model: effModel };
  let agent = agents.get(identity);
  if (agent === void 0) {
    const persistence = ctx.get("sessionPersistence");
    if (persistence !== void 0) {
      try {
        const resumed = await agents.resume({ resumeSessionId: identity, agentOptions });
        agent = resumed.agent;
        io.stderr.write(`dsh-resident: resumed session ${sessionId}\n`);
      } catch (err) {
        io.stderr.write(`dsh-resident: resume failed, creating new session ${sessionId}: ${String(err?.message ?? err)}\n`);
      }
    }
  }
  if (agent === void 0) {
    const { agent: created } = await agents.create({
      sessionId: identity,
      meta: { cwd: workspace ?? process.cwd() },
      agentOptions,
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selection);
      },
    });
    agent = created;
    io.stderr.write(`dsh-resident: created session ${sessionId}\n`);
  }

  // 给该会话挂上「text-only 模型剥离历史图片块」的 deriveMessages 投影包裹。
  if (imageCompat) {
    imageCompat.install(agent.session);
    imageCompat.setCurrentGetter(() => selection.current);
    // 预确认初始模型能力，让第一条消息就按能力正确剥离。
    imageCompat.refresh(effProvider, effModel).catch(() => {});
  }

  // 初始权限：--permission 通过 permissionPresets.set 热切（下 sandbox/mode + approval/policy 事件）
  if (permission && permissionPresets) {
    try {
      permissionPresets.set(agent.session, permission);
      io.stderr.write(`dsh-resident: permission preset -> ${permission}\n`);
    } catch (err) {
      io.stderr.write(`dsh-resident: permission switch failed: ${String(err?.message ?? err)}\n`);
    }
  }

  // ---- 注册模型/权限切换工具（让 agent 自然语言可调）----
  // 返回统一 { ok, message } 结构，output.schema 声明之，render 输出文本。
  const okOutput = {
    schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true }, message: { type: "string", required: true } } },
    render: (_args, value) => [{ type: "text", text: value.message ?? String(value) }],
  };
  if (tools) {
    tools.register(defineTool({
      name: "set_model",
      description: "Switch the active conversation's model. Changing the model keeps the current chat history.",
      parameters: {
        model: { type: "string", required: true, description: "Model id, e.g. deepseek-v4-flash or deepseek-v4-pro; may include provider as provider/model." },
      },
      output: okOutput,
      async execute(args) {
        const sp = splitModel(args.model);
        if (!sp.model) return { ok: false, message: "empty model id" };
        await applyModel(sp.provider ?? selection.current.provider, sp.model);
        return { ok: true, message: `已切换模型到 ${selection.current.provider}/${selection.current.model}（对话记忆保留）` };
      },
    }));
    tools.register(defineTool({
      name: "set_permission",
      description: "Switch the active conversation's file-access permission preset (sandbox mode + approval policy). Keeps chat history.",
      parameters: {
        preset: { type: "string", required: true, description: "One of: read-only, workspace-write, danger-full-access." },
      },
      output: okOutput,
      async execute(args, exec) {
        if (!permissionPresets) return { ok: false, message: "permission presets unavailable in this composition" };
        const p = String(args.preset).trim();
        if (!["read-only", "workspace-write", "danger-full-access"].includes(p)) return { ok: false, message: `unknown preset "${p}"` };
        try {
          permissionPresets.set(exec.agent.session, p);
          return { ok: true, message: `已切换权限到 ${p}（对话记忆保留）` };
        } catch (e) {
          return { ok: false, message: `权限切换失败: ${e?.message ?? e}` };
        }
      },
    }));
  }

  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    io.exit(code);
  };
  const onSignal = () => finish(0);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let seq = 0;
  for await (const rawLine of readLines(io.stdin)) {
    if (settled) break;
    const text = rawLine.trim();
    if (text === "") {
      emit(++seq, { ok: true, reply: "", skipped: true });
      continue;
    }

    // ---- 指令帧：@model / @permission（来自桥的 /config 指令，运行时热切，不发模型）----
    if (text.startsWith("@model ")) {
      const id = ++seq;
      try {
        const sp = splitModel(text.slice("@model ".length));
        await applyModel(sp.provider ?? selection.current.provider, sp.model);
        emit(id, { ok: true, reply: `模型已切换为 ${selection.current.provider}/${selection.current.model}` });
      } catch (error) {
        emit(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    if (text.startsWith("@permission ")) {
      const id = ++seq;
      const p = text.slice("@permission ".length).trim();
      try {
        if (!permissionPresets) throw new Error("permission presets unavailable");
        permissionPresets.set(agent.session, p);
        emit(id, { ok: true, reply: `权限已切换为 ${p}` });
      } catch (error) {
        emit(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }

    // ---- 普通消息 ---- 
    const id = ++seq;
    try {
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();
      const reply = summarize(agent.session.events, firstSeq);
      await sessions.flush(agent.session).catch(() => {});
      emit(id, { ok: true, reply });
    } catch (error) {
      emit(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  finish(0);
}

function apply(ctx, config) {
  const exit = ctx.get("appExit");
  if (exit === void 0) throw new Error("resident-runner: the launcher must provide ctx.appExit before the tree mounts");
  const io = {
    stdin: internals.stdin,
    stdout: internals.stdout,
    stderr: internals.stderr,
    exit,
  };
  run(ctx, config, io).catch((error) => {
    fail(io, error);
  });
}

export { Config, apply, inject, internals, name, summarize, splitModel };
