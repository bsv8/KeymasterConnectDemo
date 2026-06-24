import type { MethodParams, ProtocolMethod, ProtocolRequestMessage, ProtocolResultMessage } from "./protocol";
import { PROTOCOL_POPUP_PATH, PROTOCOL_VERSION } from "./protocol";

export type ProtocolLogStage =
  | "popup_opened"
  | "waiting_ready"
  | "ready_received"
  | "request_sent"
  | "waiting_result"
  | "result_received"
  | "popup_closed"
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
  request: ProtocolRequestMessage<M>;
  onLog?: (event: ProtocolLogEvent) => void;
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

  const log = (stage: ProtocolLogStage, detail?: unknown, message?: string) => {
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
    throw new ProtocolTransportError("popup_blocked", "Popup was blocked by the browser");
  }
  log("popup_opened", { popupUrl, popupFeatures });

  let readySeen = false;
  let requestSent = false;
  let settled = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let resultTimer: ReturnType<typeof setTimeout> | null = null;
  let closePoller: ReturnType<typeof setInterval> | null = null;

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
      return;
    }
    if (normalizeOrigin(event.origin) !== targetOrigin) {
      fail("invalid_origin", `Unexpected message origin: ${event.origin}`);
      return;
    }
    const data = event.data as unknown;
    if (!isPlainObject(data) || data.v !== PROTOCOL_VERSION || typeof data.type !== "string") {
      return;
    }
    if (data.type === "ready") {
      readySeen = true;
      log("ready_received");
      if (readyTimer) {
        env.clearTimeout(readyTimer);
        readyTimer = null;
      }
      if (!requestSent) {
        try {
          popup.postMessage(options.request, targetOrigin);
          requestSent = true;
          log("request_sent", sanitizeRequest(options.request));
          log("waiting_result");
          resultTimer = env.setTimeout(() => {
            log("timeout", { stage: "result" });
            fail("result_timeout", "Timed out waiting for result");
          }, options.resultTimeoutMs);
        } catch (error) {
          fail("invalid_origin", error instanceof Error ? error.message : "Failed to send request");
        }
      }
      return;
    }
    if (data.type === "result" && typeof data.id === "string" && data.id === options.request.id) {
      log("result_received", data);
      finish(data as ProtocolResultMessage);
    }
  };

  env.addMessageListener(onMessage);
  log("waiting_ready");
  readyTimer = env.setTimeout(() => {
    log("timeout", { stage: "ready" });
    fail("ready_timeout", "Timed out waiting for ready");
  }, options.readyTimeoutMs);

  closePoller = env.setInterval(() => {
    if (settled) {
      return;
    }
    if (isPopupClosed(popup)) {
      log("popup_closed");
      fail("popup_closed", "Popup was closed before the protocol completed");
    }
  }, 250);

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

