// src/lib/connectClient.ts
// 协议 transport 底层 helper。
//
// 设计缘由（施工单 2026-06-29 002 硬切换：session-first / 16 方法 / cancel）：
//   - 这一层**不**再拥有"一次性 request → 等 result → 会话结束"的 owner
//     身份；它只暴露 transport 原子：开窗、消息监听、close 轮询、
//     targetOrigin 校验、消息分发。
//   - 真正"页面级 popup 会话"的所有权在 `popupSessionClient.ts`。
//   - 保留"result 落到 requestId 上的回调注册"接口，让 session client
//     在收到 `result` 时直接派发到对应 pending request 上。
//   - 新增 `sendCancel(popup, targetOrigin, requestId)`：构造并发送顶层
//     `cancel` 报文。`cancel` 是 transport 控制消息，**不**带 params，
//     **不**单独产出第二条 result。

import type {
  PopupConnectionState,
  ProtocolCancelMessage,
  ProtocolMethod,
  ProtocolRequestMessage,
  ProtocolResultMessage
} from "./protocol";
import { PROTOCOL_POPUP_PATH, PROTOCOL_VERSION } from "./protocol";

export type ProtocolLogStage =
  | "popup_opened"
  | "popup_reused"
  | "waiting_ready"
  | "ready_received"
  | "request_sent"
  | "waiting_result"
  | "result_received"
  | "popup_closed"
  | "closing_received"
  | "cancel_sent"
  | "cancel_received"
  | "busy_rejected"
  | "timeout"
  | "session_closed";

export interface ProtocolLogEvent {
  at: number;
  stage: ProtocolLogStage;
  method?: ProtocolMethod;
  requestId?: string;
  message?: string;
  detail?: unknown;
}

export interface PopupOpenOptions {
  targetOrigin: string;
  popupWidth: number;
  popupHeight: number;
  /**
   * 关闭轮询间隔。V1 不做心跳，固定为 500ms / 1000ms 保守值；
   * 默认 500ms。
   */
  closePollMs?: number;
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
    public readonly code:
      | "popup_blocked"
      | "popup_closed"
      | "ready_timeout"
      | "result_timeout"
      | "invalid_origin"
      | "session_busy"
      | "no_session"
      | "no_in_flight"
      | "send_failed",
    message: string
  ) {
    super(message);
    this.name = "ProtocolTransportError";
  }
}

/**
 * 计算 popup URL 与 features；暴露给 session client 复用。
 */
export function buildPopupUrl(targetOrigin: string): string {
  return `${normalizeOrigin(targetOrigin)}${PROTOCOL_POPUP_PATH}`;
}

export function buildPopupFeatures(width: number, height: number): string {
  return `popup=yes,width=${Math.max(320, Math.trunc(width))},height=${Math.max(320, Math.trunc(height))}`;
}

/**
 * 探测一个 popup 句柄是否还活着（浏览器给的兜底真值）。
 * jsdom / 非 window 句柄会在 try/catch 里返回 true。
 */
export function isPopupClosed(popup: Window | null): boolean {
  if (!popup) return true;
  try {
    return (popup as Window & { closed?: boolean }).closed === true;
  } catch {
    return true;
  }
}

export function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

export function browserEnv(): ProtocolClientEnv {
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

/**
 * message 派发器：把 popup 发来的 `result` 落到对应 `requestId` 的回调上。
 *
 * 用法（session client 里）：
 *
 * ```ts
 * const dispatcher = createResultDispatcher(targetOrigin, (reqId, msg) => { ... });
 * env.addMessageListener(dispatcher.handler);
 * // ...
 * env.removeMessageListener(dispatcher.handler);
 * ```
 */
export interface ResultDispatcher {
  handler: (event: MessageEvent) => void;
  /**
   * 注册一个"等待 requestId 匹配的 result"的回调。返回解注册函数。
   * 回调**只**被调用一次；之后会被自动移除。
   */
  awaitResult(requestId: string, callback: (msg: ProtocolResultMessage) => void): () => void;
  /** 通知 dispatcher 关闭（解绑所有 pending）。通常用于 session 结束。 */
  close(): void;
}

export function createResultDispatcher(
  targetOrigin: string,
  expectedOrigin?: string
): ResultDispatcher {
  const pending = new Map<string, (msg: ProtocolResultMessage) => void>();
  const expected = expectedOrigin ?? normalizeOrigin(targetOrigin);
  const handler = (event: MessageEvent) => {
    const data = event.data as unknown;
    if (!isPlainObject(data) || data.v !== PROTOCOL_VERSION || typeof data.type !== "string") {
      return;
    }
    if (typeof event.origin === "string" && normalizeOrigin(event.origin) !== expected) {
      console.error("[keymaster-connect-demo] invalid message origin", {
        eventOrigin: event.origin,
        expectedOrigin: expected
      });
      return;
    }
    if (data.type === "result" && typeof data.id === "string") {
      const cb = pending.get(data.id);
      if (cb) {
        pending.delete(data.id);
        cb(data as ProtocolResultMessage);
      }
    }
  };
  return {
    handler,
    awaitResult(requestId, callback) {
      pending.set(requestId, callback);
      return () => pending.delete(requestId);
    },
    close() {
      pending.clear();
    }
  };
}

/**
 * 构造并发送顶层 `cancel` 报文（施工单 2026-06-29 002 硬切换）。
 *
 * 设计缘由：
 *   - cancel 是 transport 控制消息，**不**走 request/result 路径。
 *   - 调用方传入**当前在途**的 `requestId`；popup 拿到 cancel 后只会
 *     尝试取消自己当前已绑定的同 id request。
 *   - cancel 失败（popup 已关 / postMessage 抛错）由调用方吞掉：
 *     原 request 仍然走原 result 收口路径，**不**会冒出第二条 result。
 */
export function sendCancel(popup: Window, targetOrigin: string, requestId: string): void {
  const message: ProtocolCancelMessage = {
    v: PROTOCOL_VERSION,
    type: "cancel",
    id: requestId
  };
  // 失败就吞掉；cancel 与原 request 的 result 路径解耦。
  popup.postMessage(message, targetOrigin);
}

/**
 * 等待 popup 第一次发 `ready`。
 *
 * 返回一个 `Promise<{ ready, cancel }>`：调用 `ready` 拿值；调 `cancel` 取消。
 * `cancel` 后未 settled 的 promise 直接 reject。
 */
export function awaitReady(options: {
  popup: Window;
  targetOrigin: string;
  readyTimeoutMs: number;
  env: ProtocolClientEnv;
  onMessage: (event: MessageEvent) => boolean; // 返回 true 表示已 consume
  onTimeout?: () => void;
}): { promise: Promise<void>; cancel: () => void } {
  const { env, readyTimeoutMs, onMessage } = options;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let listener: ((e: MessageEvent) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    listener = (event) => {
      const consumed = onMessage(event);
      if (consumed && !settled) {
        settled = true;
        if (timer) env.clearTimeout(timer);
        env.removeMessageListener(listener!);
        resolve();
      }
    };
    env.addMessageListener(listener);
    timer = env.setTimeout(() => {
      if (settled) return;
      settled = true;
      if (listener) env.removeMessageListener(listener);
      options.onTimeout?.();
      reject(new ProtocolTransportError("ready_timeout", "Timed out waiting for ready"));
    }, readyTimeoutMs);
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      if (timer) env.clearTimeout(timer);
      if (listener) env.removeMessageListener(listener);
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 旧入口的"一次性"高层 API 暂时保留为 throw 提示：调用方应迁移到
 * `popupSessionClient.ts`。在硬切换期间，旧路径**不再**使用。
 *
 * 设计缘由：popup 复用后，单次"开窗 → 收 ready → 发 request → 等 result
 * → 关窗"模型与"popup 常驻"模型不兼容；强制让所有调用方走 session
 * client，避免双轨真值。
 */
export async function runPopupProtocolRequest<M extends ProtocolMethod>(options: {
  targetOrigin: string;
  popupWidth: number;
  popupHeight: number;
  readyTimeoutMs: number;
  resultTimeoutMs: number;
  request: ProtocolRequestMessage<M>;
  onLog?: (event: ProtocolLogEvent) => void;
  onConnectionStateChange?: (state: PopupConnectionState) => void;
  env?: ProtocolClientEnv;
}): Promise<ProtocolResultMessage> {
  throw new ProtocolTransportError(
    "no_session",
    "runPopupProtocolRequest is removed in 施工单 002; use popupSessionClient instead"
  );
}

// 兼容旧测试 stub。
export type { ProtocolRequestMessage, ProtocolResultMessage };