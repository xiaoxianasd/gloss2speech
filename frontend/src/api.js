/**
 * 与后端 6 个接口通信（对应《工程实现方案》§4）。
 * 开发时走 vite 代理；生产时默认走同源 /api（Nginx 反代），可用 VITE_API_BASE 覆盖。
 *
 * 访问口令（对应后端 API_TOKEN / backend/guard.py）：
 * 优先级 localStorage["signbridge.api_token"] > 构建期 VITE_API_TOKEN。
 * 后端开启口令后，所有 /api/* 请求自动携带 X-API-Token 头。
 */
const BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
const TOKEN_KEY = "signbridge.api_token";

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || import.meta.env.VITE_API_TOKEN || "";
  } catch (error) {
    return import.meta.env.VITE_API_TOKEN || "";
  }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    /* 隐私模式等场景下静默失败，仅本次会话内内存生效 */
  }
}

function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  const token = getToken();
  if (token) headers["X-API-Token"] = token;
  return headers;
}

let unauthorizedHandler = null;
let unauthorizedNotifying = false;

export function onUnauthorized(handler) {
  unauthorizedHandler = typeof handler === "function" ? handler : null;
}

function notifyUnauthorized(error) {
  if (!unauthorizedHandler || unauthorizedNotifying) return;
  unauthorizedNotifying = true;
  Promise.resolve()
    .then(() => unauthorizedHandler(error))
    .catch(() => {})
    .finally(() => {
      unauthorizedNotifying = false;
    });
}

async function request(path, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = authHeaders(opts.headers);
  const response = await fetch(BASE + path, opts);
  if (!response.ok) {
    let detail = response.status + " " + response.statusText;
    try {
      const data = await response.json();
      if (data && data.detail) detail = data.detail;
    } catch (error) {
      /* ignore */
    }
    const error = new Error(detail);
    error.status = response.status;
    if (response.status === 401) {
      notifyUnauthorized(error);
    }
    throw error;
  }
  return response.json();
}

function postJSON(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  base: BASE,
  getToken,
  setToken,
  hasToken: () => Boolean(getToken()),
  onUnauthorized,
  health: () => request("/api/health"),
  getScenes: () => request("/api/scenes"),

  recognize(imageBase64, sceneId) {
    return postJSON("/api/recognize", { image: imageBase64, scene_id: sceneId });
  },

  /** 流式造句：SSE，逐段回调 onDelta，结束回调 onDone(sentence, alternative)。 */
  async composeStream(words, sceneId, history, handlers) {
    const onDelta = handlers.onDelta || function () {};
    const onDone = handlers.onDone || function () {};
    const onError = handlers.onError || function () {};
    const response = await fetch(BASE + "/api/compose", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ words, scene_id: sceneId, history: history || [] }),
    });
    if (!response.ok || !response.body) {
      const error = new Error(
        response.status === 401 ? "访问口令缺失或错误（401）" : "SSE 连接失败：" + response.status,
      );
      error.status = response.status;
      if (response.status === 401) {
        notifyUnauthorized(error);
      }
      onError(error);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = block.trim();
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return;
            try {
              const event = JSON.parse(payload);
              if (event.type === "delta") onDelta(event.text || "");
              else if (event.type === "done") onDone(event.sentence || "", event.alternative || "", event);
              else if (event.type === "error") onError(new Error(event.message || "造句失败"));
            } catch (error) {
              /* 忽略解析失败的半包 */
            }
          }
          index = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      onError(error);
    }
  },

  tts(text) {
    return postJSON("/api/tts", { text });
  },

  asr(audioBase64) {
    return postJSON("/api/asr", { audio: audioBase64 });
  },

  quickReply(text, sceneId) {
    return postJSON("/api/quick-reply", { text, scene_id: sceneId });
  },
};
