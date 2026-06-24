import type {
  PopupConnectionState,
  ProtocolMethod,
  ProtocolRequestMessage,
  ProtocolResultMessage
} from "./protocol";
import { PROTOCOL_POPUP_PATH, PROTOCOL_VERSION } from "./protocol";

export type ProtocolLogStage =
  | "popup_opened"
  | "waiting_ready"
  | "ready_received"
  | "request_sent"
  | "waiting_result"
  | "result_received"
  | "popup_closed"
  | "closing_received"
  | "timeout";

export interface ProtocolLogEvent {
  at: number;
  stage: ProtocolLogStage;
  method?: ProtocolMethod;
  requestId?: string;
  message?: string;
  detail?: unknown;
}

export interface PopupClientOptions<M extends ProtocolMethod> {
  targetOrigin: string;
  popupWidth: number;
  popupHeight: number;
  readyTimeoutMs: number;
  resultTimeoutMs: number;
  /**
   * Popup 关闭轮询间隔。V1 不做心跳，固定为 500ms / 1000ms 保守值；
   * 默认 500ms。
   */
  closePollMs?: number;
  request: ProtocolRequestMessage<M>;
  onLog?: (event: ProtocolLogEvent) => void;
  /**
   * 连接状态变化回调。状态机在窗口级别，**不**与 request 级别业务
   * 结果绑定。`disconnected` 是终态；重复 `closing` / 重复
   * `popup.closed === true` 幂等忽略。
   */
  onConnectionStateChange?: (state: PopupConnectionState) => void;
  env?: ProtocolClientEnv;
}

export interface ProtocolClientEnv {
  now: () => number;
  open: (url: string, name: string, features: string) => Window | null;
  addMessageListener: (handler: (event: MessageEvent) => void) => void;
  removeMessageListener: (handler: (event: MessageEvent) => void) => void;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
}

export class ProtocolTransportError extends Error {
  constructor(
    public readonly code: "popup_blocked" | "popup_closed" | "ready_timeout" | "result_timeout" | "invalid_origin",
    message: string
  ) {
    super(message);
    this.name = "ProtocolTransportError";
  }
}

export async function runPopupProtocolRequest<M extends ProtocolMethod>(
  options: PopupClientOptions<M>
): Promise<ProtocolResultMessage> {
  const env = options.env ?? browserEnv();
  const targetOrigin = normalizeOrigin(options.targetOrigin);
  const popupUrl = `${targetOrigin}${PROTOCOL_POPUP_PATH}`;
  const popupName = "keymaster-connect-demo";
  const popupFeatures = `popup=yes,width=${Math.max(320, Math.trunc(options.popupWidth))},height=${Math.max(
    320,
    Math.trunc(options.popupHeight)
  )}`;
  // popup 关闭轮询间隔：保守值。V1 不做心跳，不基于"若干秒没消息"判定断开。
  const closePollMs = options.closePollMs ?? 500;

  const log = (stage: ProtocolLogStage, detail?: unknown, message?: string) => {
    console.debug("[keymaster-connect-demo]", {
      stage,
      message,
      method: options.request.method,
      requestId: options.request.id,
      targetOrigin,
      popupUrl,
      detail
    });
    options.onLog?.({
      at: env.now(),
      stage,
      method: options.request.method,
      requestId: options.request.id,
      message,
      detail
    });
  };

  const popup = env.open(popupUrl, popupName, popupFeatures);
  if (!popup) {
    console.error("[keymaster-connect-demo] popup blocked", {
      popupUrl,
      popupName,
      popupFeatures
    });
    // 情况 A：popup 没打开。不进入 opening，也不启动轮询。
    throw new ProtocolTransportError("popup_blocked", "Popup was blocked by the browser");
  }
  log("popup_opened", { popupUrl, popupFeatures });

  // 连接状态机：opening → connected → disconnected（终态）
  let connectionState: PopupConnectionState = "opening";
  options.onConnectionStateChange?.(connectionState);

  let readySeen = false;
  let requestSent = false;
  let settled = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let resultTimer: ReturnType<typeof setTimeout> | null = null;
  let closePoller: ReturnType<typeof setInterval> | null = null;

  // 进入 disconnected 状态：状态机转移是幂等的，重复调用只取首次生效。
  const transitionToDisconnected = (reason: "closing" | "popup_closed") => {
    if (connectionState === "disconnected") return;
    connectionState = "disconnected";
    if (reason === "closing") {
      log("closing_received");
    } else {
      log("popup_closed");
    }
    options.onConnectionStateChange?.(connectionState);
  };

  const cleanup = () => {
    if (readyTimer) env.clearTimeout(readyTimer);
    if (resultTimer) env.clearTimeout(resultTimer);
    if (closePoller) env.clearInterval(closePoller);
    env.removeMessageListener(onMessage);
  };

  const finish = (value: ProtocolResultMessage | PromiseLike<ProtocolResultMessage>) => {
    if (settled) {
      return;
    }
    settled = true;
    // result 不替代断开；连接状态仍由 closing / popup.closed 推进。
    cleanup();
    resolvePromise(value);
  };

  const fail = (code: ProtocolTransportError["code"], message: string) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    rejectPromise(new ProtocolTransportError(code, message));
  };

  let resolvePromise!: (value: ProtocolResultMessage | PromiseLike<ProtocolResultMessage>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const pending = new Promise<ProtocolResultMessage>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const onMessage = (event: MessageEvent) => {
    if (settled) {
      return;
    }
    if (event.source !== popup) {
      console.debug("[keymaster-connect-demo] ignore message from non-popup source", {
        eventOrigin: event.origin,
        expectedOrigin: targetOrigin
      });
      return;
    }
    if (normalizeOrigin(event.origin) !== targetOrigin) {
      console.error("[keymaster-connect-demo] invalid message origin", {
        eventOrigin: event.origin,
        expectedOrigin: targetOrigin,
        requestId: options.request.id
      });
      fail("invalid_origin", `Unexpected message origin: ${event.origin}`);
      return;
    }
    const data = event.data as unknown;
    if (!isPlainObject(data) || data.v !== PROTOCOL_VERSION || typeof data.type !== "string") {
      console.debug("[keymaster-connect-demo] ignore non-protocol message", {
        eventOrigin: event.origin,
        data
      });
      return;
    }
    if (data.type === "ready") {
      readySeen = true;
      log("ready_received");
      if (readyTimer) {
        env.clearTimeout(readyTimer);
        readyTimer = null;
      }
      // 收到 ready → connected
      if (connectionState === "opening") {
        connectionState = "connected";
        options.onConnectionStateChange?.(connectionState);
      }
      if (!requestSent) {
        try {
          console.info("[keymaster-connect-demo] sending request", sanitizeRequest(options.request));
          popup.postMessage(options.request, targetOrigin);
          requestSent = true;
          log("request_sent", sanitizeRequest(options.request));
          log("waiting_result");
          resultTimer = env.setTimeout(() => {
            log("timeout", { stage: "result" });
            // 长时间没消息**不**自动判定断开；按 result_timeout 报错。
            // 断开仍由 closing / popup.closed 兜底。
            fail("result_timeout", "Timed out waiting for result");
          }, options.resultTimeoutMs);
        } catch (error) {
          console.error("[keymaster-connect-demo] failed to send request", error);
          fail("invalid_origin", error instanceof Error ? error.message : "Failed to send request");
        }
      }
      return;
    }
    if (data.type === "result" && typeof data.id === "string" && data.id === options.request.id) {
      console.info("[keymaster-connect-demo] received result", data);
      log("result_received", data);
      finish(data as ProtocolResultMessage);
      return;
    }
    if (data.type === "closing") {
      console.info("[keymaster-connect-demo] received closing", {
        requestId: options.request.id,
        method: options.request.method
      });
      transitionToDisconnected("closing");
    }
  };

  env.addMessageListener(onMessage);
  console.debug("[keymaster-connect-demo] waiting for ready", {
    requestId: options.request.id,
    method: options.request.method,
    popupUrl,
    targetOrigin
  });
  log("waiting_ready");
  readyTimer = env.setTimeout(() => {
    console.error("[keymaster-connect-demo] ready timeout", {
      requestId: options.request.id,
      method: options.request.method,
      readyTimeoutMs: options.readyTimeoutMs
    });
    log("timeout", { stage: "ready" });
    fail("ready_timeout", "Timed out waiting for ready");
  }, options.readyTimeoutMs);

  // popup.closed === true 是浏览器给的兜底真值；轮询兜底与 closing 并联收敛。
  closePoller = env.setInterval(() => {
    if (settled) {
      return;
    }
    if (isPopupClosed(popup)) {
      console.warn("[keymaster-connect-demo] popup closed before completion", {
        requestId: options.request.id,
        method: options.request.method
      });
      transitionToDisconnected("popup_closed");
      // 业务上仍未拿到 result 时，函数 fail 让上层感知；连接状态已收敛。
      fail("popup_closed", "Popup was closed before the protocol completed");
    }
  }, closePollMs);

  return pending;
}

export function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

function browserEnv(): ProtocolClientEnv {
  return {
    now: () => Date.now(),
    open: (url, name, features) => window.open(url, name, features),
    addMessageListener: (handler) => window.addEventListener("message", handler),
    removeMessageListener: (handler) => window.removeEventListener("message", handler),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis)
  };
}

function isPopupClosed(popup: Window): boolean {
  try {
    return (popup as Window & { closed?: boolean }).closed === true;
  } catch {
    return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeRequest(request: ProtocolRequestMessage<ProtocolMethod>): unknown {
  return {
    ...request,
    params: sanitizeValue(request.params)
  };
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return { $type: "binary", byteLength: value.byteLength };
  }
  if (value instanceof Uint8Array) {
    return { $type: "binary", byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeValue(entry);
    }
    return out;
  }
  return value;
}
