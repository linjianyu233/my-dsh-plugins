/**
 * iLink（微信 ClawBot）协议客户端 —— 依据腾讯官方 @tencent-weixin/openclaw-weixin@2.4.6 实现。
 * 纯 HTTP/JSON，零依赖（Node 18+ 内置 fetch）。
 *
 * 端点: https://ilinkai.weixin.qq.com/ilink/bot/...
 * 关键约定（与官方 SDK 一致）:
 *   - 请求头: Content-Type / AuthorizationType: ilink_bot_token / X-WECHAT-UIN(随机)
 *             / iLink-App-Id / iLink-App-ClientVersion / Authorization: Bearer <token>
 *   - base_info: { channel_version, bot_agent }
 *   - getupdates 长轮询 35s，客户端超时视为空响应
 *   - errcode/ret === -14 表示 token 过期（stale）
 */

import crypto from "node:crypto";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_BOT_TYPE = "3";
export const DEFAULT_APP_ID = "bot";
export const STALE_TOKEN_ERRCODE = -14;

export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;
export const LIGHT_TIMEOUT_MS = 10_000;

/** "2.4.6" -> 132102（major<<16 | minor<<8 | patch） */
export function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split(".").map((p) => parseInt(p, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

export class IlinkError extends Error {
  constructor(message, { kind = "api", ret, errcode, status } = {}) {
    super(message);
    this.name = "IlinkError";
    this.kind = kind;
    this.ret = ret;
    this.errcode = errcode;
    this.status = status;
  }
}

export function createIlinkClient(opts = {}) {
  const cfg = {
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
    token: opts.token ?? null,
    channelVersion: opts.channelVersion ?? "2.4.6",
    botAgent: opts.botAgent ?? "dsh-wechat-bridge",
    appId: opts.appId ?? DEFAULT_APP_ID,
    log: opts.log ?? (() => {}),
  };

  function baseInfo() {
    return { channel_version: cfg.channelVersion, bot_agent: cfg.botAgent };
  }

  function headers(withToken = true) {
    const h = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": cfg.appId,
      "iLink-App-ClientVersion": String(buildClientVersion(cfg.channelVersion)),
    };
    if (withToken && cfg.token?.trim()) h.Authorization = `Bearer ${cfg.token.trim()}`;
    return h;
  }

  async function fetchWithTimeout(url, init, timeoutMs, label, signal) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const rawText = await res.text();
      cfg.log(`[ilink] ${label} HTTP ${res.status} ${rawText.length} bytes`);
      if (!res.ok) {
        throw new IlinkError(`${label} HTTP ${res.status}: ${rawText.slice(0, 200)}`, {
          kind: "http",
          status: res.status,
        });
      }
      try {
        return JSON.parse(rawText);
      } catch {
        return { ret: 0, raw: rawText };
      }
    } finally {
      clearTimeout(t);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  function apiGet(endpoint, { timeoutMs = LIGHT_TIMEOUT_MS, withToken = false, label = "GET" } = {}) {
    const url = new URL(endpoint, ensureTrailingSlash(cfg.baseUrl)).toString();
    return fetchWithTimeout(url, { method: "GET", headers: headers(withToken) }, timeoutMs, label);
  }

  function apiPost(endpoint, body, { timeoutMs = API_TIMEOUT_MS, withToken = true, label = "POST" } = {}, signal) {
    const url = new URL(endpoint, ensureTrailingSlash(cfg.baseUrl)).toString();
    return fetchWithTimeout(
      url,
      { method: "POST", headers: headers(withToken), body: JSON.stringify(body ?? {}) },
      timeoutMs,
      label,
      signal,
    );
  }

  return {
    get config() {
      return { ...cfg };
    },
    setToken(token) {
      cfg.token = token ?? null;
    },
    setBaseUrl(url) {
      cfg.baseUrl = url;
    },

    /** 获取登录二维码（2.x 风格：POST + local_token_list，重连时携带现有 token）。 */
    async getBotQrcode(botType = DEFAULT_BOT_TYPE, localTokenList = []) {
      const resp = await apiPost(
        `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        { local_token_list: localTokenList.filter((t) => typeof t === "string" && t) },
        { label: "getBotQrcode" },
      );
      return { qrcode: resp.qrcode, qrcodeImgContent: resp.qrcode_img_content, raw: resp };
    },

    /**
     * 轮询扫码状态（长轮询）。网络错误/客户端超时视为 wait。
     * 返回 { status, botToken, botId, baseUrl, userId, redirectHost }
     */
    async pollQrcodeStatus(qrcode, verifyCode) {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
      if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
      try {
        const resp = await apiGet(endpoint, {
          timeoutMs: LONG_POLL_TIMEOUT_MS,
          label: "pollQrcodeStatus",
        });
        return {
          status: resp.status,
          botToken: resp.bot_token,
          botId: resp.ilink_bot_id,
          baseUrl: resp.baseurl,
          userId: resp.ilink_user_id,
          redirectHost: resp.redirect_host,
        };
      } catch (err) {
        if (err?.name === "AbortError" || err instanceof IlinkError) {
          return { status: "wait" };
        }
        cfg.log(`[ilink] pollQrcodeStatus error: ${String(err)}，按 wait 继续`);
        return { status: "wait" };
      }
    },

    /** 长轮询收消息；客户端超时返回空。signal 用于外部取消。 */
    async getUpdates(buf = "", timeoutMs = LONG_POLL_TIMEOUT_MS, signal) {
      try {
        const resp = await apiPost(
          "ilink/bot/getupdates",
          { get_updates_buf: buf, base_info: baseInfo() },
          { timeoutMs, label: "getUpdates" },
          signal,
        );
        return {
          ret: resp.ret ?? resp.errcode ?? 0,
          errcode: resp.errcode,
          errmsg: resp.errmsg,
          msgs: resp.msgs ?? [],
          get_updates_buf: resp.get_updates_buf ?? buf,
          longpolling_timeout_ms: resp.longpolling_timeout_ms,
        };
      } catch (err) {
        if (err?.name === "AbortError") {
          return { ret: 0, msgs: [], get_updates_buf: buf };
        }
        throw err;
      }
    },

    /** 获取某用户的 typing_ticket。 */
    async getConfig(ilinkUserId, contextToken) {
      const resp = await apiPost(
        "ilink/bot/getconfig",
        { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: baseInfo() },
        { timeoutMs: LIGHT_TIMEOUT_MS, label: "getConfig" },
      );
      return { typingTicket: resp.typing_ticket ?? "", raw: resp };
    },

    /** 发送"正在输入"状态：status 1=开始 2=结束。 */
    async sendTyping(ilinkUserId, typingTicket, status) {
      await apiPost(
        "ilink/bot/sendtyping",
        { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: baseInfo() },
        { timeoutMs: LIGHT_TIMEOUT_MS, label: `sendTyping(${status})` },
      );
    },

    /**
     * 发送任意 item_list（文本/图片/文件/视频消息通用入口）。
     * clientId 缺省自动生成。返回 {clientId}。resp.ret !== 0 视为失败。
     */
    async sendMessageItems({ to, itemList, contextToken, clientId }) {
      const id = clientId ?? `dsh-weixin-${crypto.randomBytes(6).toString("hex")}`;
      const resp = await apiPost(
        "ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: to,
            client_id: id,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            context_token: contextToken ?? undefined,
            item_list: itemList ?? [],
          },
          base_info: baseInfo(),
        },
        { timeoutMs: API_TIMEOUT_MS, label: "sendMessageItems" },
      );
      if (resp.ret !== undefined && resp.ret !== 0) {
        throw new IlinkError(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`, {
          kind: "api",
          ret: resp.ret,
          errcode: resp.errcode,
        });
      }
      return { clientId: id };
    },

    /** 发送文本消息（sendMessageItems 的便捷封装）。 */
    async sendMessage({ to, text, contextToken, clientId }) {
      return this.sendMessageItems({
        to,
        contextToken,
        clientId,
        itemList: [{ type: 1, text_item: { text } }],
      });
    },

    /**
     * 获取 CDN 预签名上传地址（媒体发送第一步，与官方 SDK getuploadurl 一致）。
     * @param {object} p.filekey      32 位 hex
     * @param {number} p.mediaType    UploadMediaType: 1 图片 / 2 视频 / 3 文件 / 4 语音
     * @param {string} p.toUserId     接收方
     * @param {number} p.rawsize      原始字节数
     * @param {string} p.rawfilemd5   原始文件 md5(hex)
     * @param {number} p.filesize     AES-ECB 加密后字节数（PKCS7 补齐）
     * @param {string} p.aeskeyHex    32 位 hex 密钥
     * @returns {{uploadFullUrl, uploadParam}}
     */
    async getUploadUrl({ filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskeyHex, noNeedThumb = true }) {
      const resp = await apiPost(
        "ilink/bot/getuploadurl",
        {
          filekey,
          media_type: mediaType,
          to_user_id: toUserId,
          rawsize,
          rawfilemd5,
          filesize,
          no_need_thumb: noNeedThumb,
          aeskey: aeskeyHex,
          base_info: baseInfo(),
        },
        { timeoutMs: API_TIMEOUT_MS, label: "getUploadUrl" },
      );
      if (resp.ret !== undefined && resp.ret !== 0) {
        throw new IlinkError(`getUploadUrl ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`, {
          kind: "api",
          ret: resp.ret,
          errcode: resp.errcode,
        });
      }
      return { uploadFullUrl: resp.upload_full_url ?? "", uploadParam: resp.upload_param ?? "", raw: resp };
    },

    /** 通知服务器客户端启动/停止（尽力而为）。 */
    async notifyStart() {
      try {
        await apiPost("ilink/bot/msg/notifystart", { base_info: baseInfo() }, { timeoutMs: LIGHT_TIMEOUT_MS, label: "notifyStart" });
      } catch (e) {
        cfg.log(`[ilink] notifyStart 失败（忽略）: ${e.message}`);
      }
    },
    async notifyStop() {
      try {
        await apiPost("ilink/bot/msg/notifystop", { base_info: baseInfo() }, { timeoutMs: LIGHT_TIMEOUT_MS, label: "notifyStop" });
      } catch (e) {
        cfg.log(`[ilink] notifyStop 失败（忽略）: ${e.message}`);
      }
    },
  };
}

/**
 * 从消息的 item_list 提取文本（与官方 SDK inbound 逻辑一致）：
 * 优先第一个 TEXT item（含引用拼接）；其次 VOICE item 的转写文本。
 */
export function extractText(msg) {
  const items = msg?.item_list ?? [];
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && [2, 3, 4, 5].includes(ref.message_item.type)) return text;
      const parts = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = extractText({ item_list: [ref.message_item] });
        if (refBody) parts.push(refBody);
      }
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
    if (item.type === 3 && item.voice_item?.text) return String(item.voice_item.text);
  }
  return "";
}

/** 消息里是否含媒体（图片/视频/文件/语音）。 */
export function hasMedia(msg) {
  return (msg?.item_list ?? []).some((i) => [2, 3, 4, 5].includes(i.type));
}
