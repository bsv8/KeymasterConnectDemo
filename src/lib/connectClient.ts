// src/lib/connectClient.ts
// 协议 transport 底层 helper。
//
// 设计缘由（施工单 2026-06-29 002 硬切换：session-first / 16 方法 / cancel +
//          施工单 2026-06-30 001 appView child ready + opener launch 硬切换）：
//   - 这一层**不**再拥有"一次性 request → 等 result → 会话结束"的 owner
//     身份；它只暴露 transport 原子：开窗、消息监听、close 轮询、
//     targetOrigin 校验、消息分发、opener 探测、URL 启动 token 解析。
//   - 真正"页面级 popup 会话"的所有权在 `popupSessionClient.ts`。
//   - 保留"result 落到 requestId 上的回调注册"接口，让 session client
//     在收到 `result` 时直接派发到对应 pending request 上。
//   - 新增 `sendCancel(popup, targetOrigin, requestId)`：构造并发送顶层
//     `cancel` 报文。`cancel` 是 transport 控制消息，**不**带 params，
//     **不**单独产出第二条 result。
//   - appView 启动期：demo 必须能复用 `window.opener` 指向的 Session Window
//     作为 transport 对端（详见 `getReusableOpener`），并在自己 listener
//     就绪后向 opener 发顶层 `ready`（详见 `postReadyToOpener`），**不**
//     在新窗口里重复开 popup。

import type {
  PopupConnectionState,
  ProtocolCancelMessage,
  ProtocolMethod,
  ProtocolReadyMessage,
  ProtocolRequestMessage,
  ProtocolResultMessage
} from "./protocol";
import { PROTOCOL_POPUP_PATH, PROTOCOL_VERSION } from "./protocol";

export type ProtocolLogStage =
  | "popup_opened"
  | "popup_reused"
  | "waiting_ready"
  | "ready_received"
  | "ready_sent"
  | "request_sent"
  | "waiting_result"
  | "result_received"
  | "popup_closed"
  | "closing_received"
  | "cancel_sent"
  | "cancel_received"
  | "busy_rejected"
  | "timeout"
  | "session_closed"
  | "no_opener"
  | "opener_adopted";

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
      | "send_failed"
      | "no_opener",
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

/* ============== appView 启动期 transport 复用 ============== */

/**
 * 检测当前 demo 页面是否能"收养"已有的 `window.opener` 作为 transport 对端。
 *
 * 设计缘由（施工单 2026-06-30 001 appView child ready + opener launch 硬切换
 *          第 4.2 / 5.三 / 5.四 / 6.三 / 7.不能怎么做 章）：
 *   - appView 启动期 Keymaster Session Window 已经主动打开了 demo 页面；
 *     此时 `window.opener` 指向那扇 Session Window；
 *   - demo 必须**优先**复用这扇已存在的窗口，**不**主动 `window.open`
 *     出一扇新 popup——否则一次 Open App 会变成两扇协议窗口、首次
 *     `connect.launch` 也无处发送；
 *   - 但运行期若这扇窗口被用户关闭，下次请求仍允许重新开 popup 走
 *     `connect.resume`，**不**要求永远绑定同一扇窗口；
 *   - 因此这里只判断"是否有一扇仍存活的、targetOrigin 一致的 opener"；
 *     **不**判断"现在是否处于 appView 模式"——模式由 URL 中的 `launchToken`
 *     决定，本函数只是 transport 层的"能否复用"判定。
 *
 * 返回值：
 *   - `null` ⇒ 当前没有可复用的 Session Window；
 *   - 非 null ⇒ 返回一个真值对象，caller 可直接把它当作 popup 句柄 +
 *     targetOrigin 一并传给 transport。
 *
 * 注意：
 *   - 这里**不**读 `opener.location.href`（会触发跨 origin 安全异常），只读
 *     `closed` + 自身 `location.origin` 与 `targetOrigin`；
 *   - targetOrigin 与 `window.opener` 之间的"具体协议身份"判定由 Session
 *     Window 在 `ready` / `closing` / `result` 报文中继续走 origin 校验；
 *   - `closed` 探测失败（部分浏览器 / 沙盒抛异常）按"不可用"处理。
 */
export function getReusableOpener(
  targetOrigin: string
): { opener: Window; targetOrigin: string } | null {
  if (typeof window === "undefined") return null;
  const opener = window.opener;
  if (!opener) return null;
  if (isPopupClosed(opener)) return null;
  let normalized: string;
  try {
    normalized = normalizeOrigin(targetOrigin);
  } catch {
    return null;
  }
  return { opener, targetOrigin: normalized };
}

/**
 * appView child app 在自身 listener 就绪后，向 `window.opener`（Session Window）
 * 发送顶层 `ready`。
 *
 * 设计缘由（施工单 2026-06-30 001 appView child ready + opener launch 硬切换
 *          第 4.2 / 4.3 / 5.一 / 6.一 / 6.不能怎么做 章 +
 *          依赖项目 keymaster.cc 施工单 003 第 4.1 章）：
 *   - appView 启动期 demo 是被 Session Window 打开的 child app；由 child app
 *     自己在 listener 装好之后向 opener 发 `ready`，让 Session Window 知道
 *     "child 已就绪，可以进入传统 popup"；
 *   - 这条消息与传统 popup 启动期 "Session Window → client web 发 ready"
 *     完全对称——只是方向在 appView 下反过来：传统 popup 是 Session Window
 *     当 child，在自己 listener 就绪后向 opener 发 ready；appView 下 Session
 *     Window 是 opener，demo 当 child，所以由 demo 发 ready；
 *   - **继续复用现有顶层 `ready`**——施工单 2026-06-30 001 第 4.2 / 6.不能
 *     怎么做 章明确禁止新增 `child_ready` / `app_ready` 等专用消息，让上游
 *     Session Window 可以用同一个 handler 同时处理两种入口方向下的 ready 收包；
 *   - 这是一个**最小原子**：只校验 opener、组装顶层 `ready`、`postMessage`；
 *     **不**在这里发 `connect.launch`，**不**启动任何新 session client，
 *     **不**做任何重试风暴——这一切都由调用方统一收口。
 *
 * 关键约束：
 *   1. 只校验 `window.opener` 存在且未关闭，**不**调用 `window.open(...)`
 *      新开 popup；
 *   2. 通过 `postMessage` 发送严格 `{ v: PROTOCOL_VERSION, type: "ready" }`；
 *   3. targetOrigin = `normalizeOrigin(targetOrigin)`，与协议会话 origin 自洽；
 *   4. 发送失败 → 返回 `false`，由调用方按"appView 启动失败"统一收口；
 *   5. 只在 appView 启动期使用，direct 模式不会调到这里。
 *
 * 返回值：
 *   - `true`  ⇒ 已成功发送 `ready` 给 opener；
 *   - `false` ⇒ window.opener 不存在 / 已关 / 不可用 / 发送失败。
 */
export function postReadyToOpener(targetOrigin: string): boolean {
  if (typeof window === "undefined") return false;
  const opener = window.opener;
  if (!opener) return false;
  if (isPopupClosed(opener)) return false;
  let normalized: string;
  try {
    normalized = normalizeOrigin(targetOrigin);
  } catch {
    return false;
  }
  const ready: ProtocolReadyMessage = {
    v: PROTOCOL_VERSION,
    type: "ready"
  };
  try {
    opener.postMessage(ready, normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从当前 URL 中解析 `launchToken`。
 *
 * 设计缘由（施工单 2026-06-30 001 appView child ready + opener launch
 *          第 3.2 / 4.1 / 5.一 章）：
 *   - 启动模式 `appView` 的**唯一**真值 = URL `?launchToken=`；
 *   - 调用方拿到后**必须**自己负责消费 + 清理（`stripLaunchTokenFromUrl`）；
 *   - 本函数只做解析，**不**做任何副作用、**不**写 localStorage；
 *   - 缺失 / 空字符串 / 多个同名参数 → 一律返回 null，由 caller 走 direct mode。
 */
export function readLaunchTokenFromUrl(search?: string): string | null {
  if (typeof window === "undefined") return null;
  const raw = search ?? window.location.search;
  if (raw.length === 0) return null;
  try {
    const params = new URLSearchParams(raw);
    const value = params.get("launchToken");
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 从当前 URL 中解析 `sessionWindowOrigin`（施工单 2026-06-30 002 launch
 * sessionWindowOrigin 显式注入 + 依赖项目 keymaster.cc 施工单 004 第 4.2 / 5.一
 * 章）。
 *
 * 设计缘由：
 *   - appView / launch 模式的 transport target origin **不**再读用户输入 /
 *     UI 默认的 `targetOrigin`；它的唯一真值 = 打开本 child app 的那扇
 *     Session Window 在 `openClientApp()` 时显式写进 URL 的 `sessionWindowOrigin`；
 *   - 这个值必须是**完整 origin**（scheme + host [+ port]），**不**接受
 *     `domain:port` 这类缺 scheme 的串——否则后续 `postMessage(..., origin)`
 *     的 origin 校验语义会被做脏；
 *   - 本函数只做解析 + 合法性校验，**不**做任何副作用、**不**回退到默认
 *     `https://keymaster.cc`、**不**回退到 `targetOrigin`、**不**去猜
 *     `window.opener.location.origin`；
 *   - 缺失 / 空 / 非法（缺 scheme / 不能解析成 origin）→ 一律返回 null，由
 *     caller 在 appView 模式下走 fail-closed。
 */
export function readSessionWindowOriginFromUrl(search?: string): string | null {
  if (typeof window === "undefined") return null;
  const raw = search ?? window.location.search;
  if (raw.length === 0) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const value = params.get("sessionWindowOrigin");
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let origin: string;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    return null;
  }
  // 非 http(s) / opaque scheme 的 URL.origin 是字符串 "null"；`domain:port`
  // 这类缺 scheme 的串会落到这里被拒。必须是完整 origin 才放行。
  if (!origin || origin === "null") return null;
  return origin;
}

/**
 * 从当前 URL 中移除 `launchToken`，保留其它 query 参数；用 `history.replaceState`
 * 改地址，不整页刷新。
 *
 * 设计缘由（施工单 2026-06-30 001 appView child ready + opener launch
 *          第 5.五 / 6.不能怎么做 章）：
 *   - launchToken 是一次性凭证，留在 URL 里没有长期价值；
 *   - 成功后立即清掉，刷新后走 `connect.resume` 而不是再次消费 token；
 *   - **不**允许通过 `location.href = ...` 触发整页刷新——会丢失内存态。
 *
 * 返回：是否真的做了修改（便于上层记录日志）。
 */
export function stripLaunchTokenFromUrl(search?: string): boolean {
  if (typeof window === "undefined") return false;
  const raw = search ?? window.location.search;
  if (raw.length === 0) return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return false;
  }
  if (!params.has("launchToken")) return false;
  params.delete("launchToken");
  const nextSearch = params.toString();
  const nextUrl =
    window.location.pathname +
    (nextSearch.length > 0 ? `?${nextSearch}` : "") +
    window.location.hash;
  try {
    window.history.replaceState(null, "", nextUrl);
    return true;
  } catch {
    return false;
  }
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