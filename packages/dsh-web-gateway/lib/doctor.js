// lib/doctor.js — 规则诊断引擎（P2）。
//
// 输入：一个后端实例的启动日志文本（+ 可选 --dump-config 输出）。
// 输出：结构化诊断 { verdict, rule, detail, fix? }。
//
// 规则覆盖 DSH 启动失败的高频根因：
//   EADDRINUSE / 端口占用
//   --patch / overlay 解析失败（unknown option / patch: entry not found / 找不到文件）
//   插件 declined-HMR / externals（需要重启）
//   0.0.0.0 绑定被拒（--host 0.0.0.0 不支持）
//   一般解析错误兜底
// 未命中 => { verdict: "unknown" }，由 ai.js 走 LLM 兜底。

export function diagnoseLog(text, { profile = "web" } = {}) {
  if (!text || text.length === 0) return { verdict: "empty", detail: "日志为空（进程可能未启动或立即静默退出）" };

  const rules = [
    {
      id: "EADDRINUSE",
      test: (t) => /EADDRINUSE|already in use|address already in use/i.test(t),
      describe: (t) => {
        const m = t.match(/listen\s+(?:EADDRINUSE|.*already in use).*:(\d+)/i) || t.match(/port\s+(\d+)/i);
        return {
          verdict: "EADDRINUSE",
          detail: `端口被占用${m ? `（疑似 :${m[1]}）` : ""}：换一个空闲端口重拉，或确认旧实例已释放端口。`,
          fix: { kind: "relaunch-with-new-port", note: "由网关重新分配空闲端口并重拉。" },
        };
      },
    },
    {
      id: "PATCH_OPTION_ORDER",
      test: (t) => /unknown option '--patch'/i.test(t),
      describe: () => ({
        verdict: "PATCH_OPTION_ORDER",
        detail: "`--patch` 出现在 app 参数（--host/--port）之后被 app 拒收；launcher flag 必须写在最前。",
        fix: { kind: "reorder-args", note: "网关 spawn 已保证 --patch 在 --profile 之后、app 参数之前；此错误来自手动/外部调用。" },
      }),
    },
    {
      id: "PATCH_NOT_FOUND",
      test: (t) =>
        (/patch.*not found|failed to (read|load|parse).*patch|no such file.*patch|ENOENT.*patch/i.test(t) && !/entry .* not found/i.test(t)) ||
        /failed to read overlay|ENOENT.*overlay|no such file.*overlay/i.test(t),
      describe: () => ({
        verdict: "PATCH_NOT_FOUND",
        detail: "指定的 --patch/--overlay 覆盖文件不存在或不可读。",
        fix: { kind: "check-patch-path", note: "确认 patch 路径存在且可读；否则移除此覆盖再重拉。" },
      }),
    },
    {
      id: "CONFIG_PARSE",
      test: (t) => /YAML|yaml|parse.*(failed|error)|invalid.*entry|entry .* not found|failed to parse/i.test(t),
      describe: (t) => {
        const m = t.match(/entry "([^"]+)" not found/);
        return {
          verdict: "CONFIG_PARSE",
          detail: m
            ? `patch 引用了不存在的条目 id "${m[1]}"（overlay 的 id 必须命中组合树里的某一行）。`
            : "组合配置解析失败：patch 文件语法/结构错误。",
          fix: { kind: "fix-patch-file", note: m ? `移除/修正对 "${m[1]}" 的引用。` : "修正 patch 语法。" },
        };
      },
    },
    {
      id: "HOST_0_0_0_0",
      test: (t) => /--host 0\.0\.0\.0 is intentionally not supported|0\.0\.0\.0 is intentionally/i.test(t),
      describe: () => ({
        verdict: "HOST_0_0_0_0",
        detail: "dsh web 拒绝绑定 0.0.0.0（安全限制）；后端只允许 127.0.0.1。",
        fix: { kind: "bind-loopback", note: "改用 127.0.0.1 绑定，由网关对外暴露。" },
      }),
    },
    {
      id: "ERR_INVALID_ARG_VALUE_STDIO",
      test: (t) => /ERR_INVALID_ARG_VALUE.*stdio|WriteStream.*fd: null/i.test(t),
      describe: () => ({
        verdict: "SPAWN_STDIO",
        detail: "网关曾把未就绪的 WriteStream 传给 stdio（旧版 bug，已修）。若仍出现请升级网关。",
        fix: { kind: "upgrade-gateway", note: "更新 dsh-web-gateway 版本。" },
      }),
    },
  ];

  for (const rule of rules) {
    if (rule.test(text)) return rule.describe(text);
  }

  return { verdict: "unknown", detail: "未命中已知错误模式，交由 LLM 兜底诊断。" };
}