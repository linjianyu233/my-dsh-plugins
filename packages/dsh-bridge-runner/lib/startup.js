/**
 * 常驻 agent 的启动参数提供者：解析 --session-id，发布 residentStartup 服务。
 * 与 dsh-headless/startup 同构（普通 Cordis 插件，注入 cmdlineArgs）。
 */

import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

const name = "resident-startup";
const inject = ["cmdlineArgs"];
const RESIDENT_STARTUP_SERVICE = "residentStartup";

function residentCommand() {
  return new Command()
    .name("dsh --profile resident")
    .description("Run a resident DSH agent on a fixed session id; read messages from stdin.")
    .requiredOption(
      "--session-id <id>",
      "固定的 session id（持久化的 agent identity；首次运行时创建，之后 resume）",
    )
    .option("--workspace <dir>", "工作目录（cwd；缺省 = 进程当前目录）")
    .option("--permission <level>", "文件访问权限：read-only | workspace-write | danger-full-access")
    .option("--model <name>", "模型名（缺省用 DSH 默认）")
    .option("--provider <name>", "模型 provider（配合 --model，缺省 deepseek-official）")
    .helpOption("-h, --help", "show this help")
    .addHelpText(
      "after",
      `
协议（stdin/stdout 均为 UTF-8，逐行帧）:
  输入（每行 = 一条用户消息）:  <文本>\\n
  输出（每条完成后一行）:        <JSON>\\n
  JSON 形如 {"id":"<序号>","ok":true,"reply":"<最终assistant文本>"} 或 {"id":N,"ok":false,"error":"..."}
输入 EOF（关闭 stdin）时进程正常退出；SIGINT/SIGTERM 优雅退出。
`,
    );
}

function apply(ctx) {
  const program = residentCommand();
  program.action(() => {
    const opts = program.opts();
    const sessionId = String(opts.sessionId ?? "").trim();
    if (!sessionId) program.error("error: --session-id is required");
    ctx.provide(RESIDENT_STARTUP_SERVICE, {
      sessionId,
      workspace: opts.workspace ? String(opts.workspace).trim() : undefined,
      permission: opts.permission ? String(opts.permission).trim() : undefined,
      model: opts.model ? String(opts.model).trim() : undefined,
      provider: opts.provider ? String(opts.provider).trim() : undefined,
    });
  });
  parseCmdline(ctx, program);
}

export { RESIDENT_STARTUP_SERVICE, apply, inject, name };
