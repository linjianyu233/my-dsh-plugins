/**
 * lib/image-compat.mjs —— 模型图片能力的优雅降级。
 *
 * 场景：会话里一次多模态交互（read_image 等）会把 `type:"image"` 内容块写进
 * 持久 session 历史。之后热切切换到一个只支持文本的模型（例如 deepseek-v4-flash，
 * opencode-go 目录里 `input:["text"]`）时，agent 循环每次请求都会把整段历史
 * （含图片块）发给 LLM，`dsh-llm-pi-ai` 在 `stream()` 会抛
 *   `pi-ai model "<id>" does not support image input (UNSUPPORTED_CONTENT)`
 * 于是每一次回复都失败/空返回，除非清空会话或换回支持图片的模型。
 *
 * 本模块做「不丢文字、只剥离请求里的图片载荷」的兜底：
 *   - 按 `provider|model` 缓存模型的图片能力（来自 `llm.resolveModelInfo`，
 *     与 dsh-tool-fs 的 read_image 门禁同一来源）。
 *   - 仅在「当前模型已确认不支持图片」时，对 `session.deriveMessages()`
 *     的投影做浅重写：保留文本块、去掉 `type:"image"` 块与 `tool-result`
 *     里嵌套的图片块。
 *   - 不改动持久 session 事件日志：只影响发给 LLM 的那一份投影，文字上下文
 *     与 read_image 附带的文本信封（`<path>/<type>image</type><content>…`）
 *    仍然保留，因此切回 v4-flash 后对话能继续，只是不再携带二进制图片。
 */

/** 递归判断一个 content 块数组里是否含图片块（与 dsh-llm 的 contentHasImage 同语义）。 */
export function contentHasImageLikeBlock(content) {
  return content.some(
    (block) =>
      block.type === "image" ||
      (block.type === "tool-result" && Array.isArray(block.content) && contentHasImageLikeBlock(block.content)),
  );
}

/** 剥离单个 content 数组里的图片块（顶层 image 块 + tool-result 内嵌套 image 块）。 */
function stripImagesFromContent(content) {
  const out = [];
  for (const block of content) {
    if (block?.type === "image") continue;
    if (block?.type === "tool-result" && Array.isArray(block.content) && contentHasImageLikeBlock(block.content)) {
      out.push({ ...block, content: stripImagesFromContent(block.content) });
      continue;
    }
    out.push(block);
  }
  return out;
}

/**
 * 对一个 `deriveMessages()` 返回的 messages 数组做投影剥离。
 * messages 的元素是 session 共享的深冻结 Message；这里不原地改它们，
 * 而是为需要剥离的 message 建一份浅拷贝（content 换为过滤后的新数组）。
 * @returns 新数组；若没有任何图片块则原样返回同一数组。
 */
export function filterImagesFromMessages(messages) {
  let changed = false;
  const filtered = messages.map((message) => {
    const content = Array.isArray(message.content) ? message.content : [message.content];
    if (!contentHasImageLikeBlock(content)) return message;
    changed = true;
    return { ...message, content: stripImagesFromContent(content) };
  });
  return changed ? filtered : messages;
}

/**
 * 模型图片能力解析器 + deriveMessages 包裹器。
 * 只依赖 `ctx.get("llm")` 的 `resolveModelInfo(provider, model, signal)`。
 */
export class ImageCompatibility {
  #llm;
  #capabilities = new Map(); // "provider|model" -> boolean（是否支持 image）
  #resolving = new Map(); // 去重的 in-flight promise
  #enabled = false;
  #key = null;

  constructor(llm) {
    this.#llm = llm;
  }

  /** 取某 provider/model 的图片能力（异步，缓存 + 去重）。未知时返回 undefined。 */
  async resolveImageInput(provider, model, signal) {
    const key = `${provider}|${model}`;
    if (this.#capabilities.has(key)) return this.#capabilities.get(key);
    if (this.#resolving.has(key)) return this.#resolving.get(key);
    const p = (async () => {
      try {
        if (!this.#llm || typeof this.#llm.resolveModelInfo !== "function") return undefined;
        const info = await this.#llm.resolveModelInfo(provider, model, signal);
        const capable = Array.isArray(info?.inputModalities) && info.inputModalities.includes("image");
        this.#capabilities.set(key, capable);
        return capable;
      } catch {
        this.#capabilities.set(key, undefined); // 解析失败：未知能力，不剥离
        return undefined;
      } finally {
        this.#resolving.delete(key);
      }
    })();
    this.#resolving.set(key, p);
    return p;
  }

  /** 在模型热切后调用：异步确认新模型能力并纳入缓存（失败静默，不阻断切换）。 */
  async refresh(provider, model, signal) {
    await this.resolveImageInput(provider, model, signal).catch(() => {});
  }

  /** 给一个 agent session 安装对 deriveMessages 的投影剥离包裹。 */
  install(session) {
    if (this.#enabled) return;
    this.#enabled = true;
    const sessionObj = session;
    const origDerive = sessionObj.deriveMessages.bind(sessionObj);
    if (origDerive === void 0) return;
    // 运行时当前模型：由 installModelSelection 的 selection.current 提供，
    // 这里通过一个可替换的 getter 读取，避免与 set_model 的 selection 对象解耦。
    let currentGetter = () => void 0;
    this.setCurrentGetter = (fn) => {
      currentGetter = fn;
    };
    sessionObj.deriveMessages = (...args) => {
      const messages = origDerive(...args);
      const cur = currentGetter?.() ?? void 0;
      if (!cur?.provider || !cur?.model) return messages;
      const key = `${cur.provider}|${cur.model}`;
      const capable = this.#capabilities.has(key) ? this.#capabilities.get(key) : void 0;
      // 仅当「已确认不支持图片」才剥离；能力未知/支持时原样放行。
      if (capable !== false) return messages;
      return filterImagesFromMessages(messages);
    };
  }
}

/** 判断一个消息 content 是否含 `type:"image"` 顶层块或 tool-result 内嵌图片（导出版，供测试）。 */
export function hasImageLikeBlock(message) {
  return Array.isArray(message?.content) && contentHasImageLikeBlock(message.content);
}
