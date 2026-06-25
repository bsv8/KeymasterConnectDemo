// src/lib/popupSessionClient.ts
// 页面级 popup session client。
//
// 设计缘由（施工单 002 硬切换：popup 复用与命令流）：
//   - 同一 demo 页面，对同一 `targetOrigin`，只维护一个 popup 会话。
//   - 首次 `ensureSession()` 时若没有 popup 句柄就开窗、等一次 `ready`。
//   - 后续 `runRequest()` 复用现有 popup 句柄：不再 `window.open`。
//   - 同一时刻只允许**一条在途** request；第二条再点会抛 `session_busy`。
//   - `targetOrigin` 变化时主动关闭旧 popup，再用新 origin 开新窗。
//   - popup 手工关闭 / 刷新后，下次 `runRequest()` 重新开窗。
//   - 不做客户端请求队列；不做自动重试；不做跨 opener 编排。
//
// 这一层拥有：
//   - 长期 `message` 监听（ResultDispatcher）；
//   - popup 句柄；
//   - popup 关闭轮询；
//   - 连接状态机（`opening` / `connected` / `disconnected`）。
//
// 这一层**不**拥有：
//   - 任何业务方法（identity.get / intent.sign / cipher.*）；
//   - 任何 UI；只通过回调与日志暴露。

import type {
  PopupConnectionState,
  ProtocolMethod,
  ProtocolRequestMessage,
  ProtocolResultMessage
} from "./protocol";
import {
  ProtocolTransportError,
  buildPopupFeatures,
  buildPopupUrl,
  browserEnv,
  createResultDispatcher,
  isPopupClosed,
  normalizeOrigin,
  type ProtocolClientEnv,
  type ProtocolLogEvent,
  type ProtocolLogStage
} from "./connectClient";

const POPUP_NAME = "keymaster-connect-demo";

export interface PopupSessionClientOptions {
  targetOrigin: string;
  popupWidth: number;
  popupHeight: number;
  readyTimeoutMs: number;
  resultTimeoutMs: number;
  /**
   * 关闭轮询间隔。V1 不做心跳；默认 500ms。
   */
  closePollMs?: number;
  /**
   * 每次关键阶段写一条日志；session client **不**自己 console.log，
   * 由调用方决定怎么存 / 展示。
   */
  onLog?: (event: ProtocolLogEvent) => void;
  /**
   * 连接状态变化回调。状态机在窗口级别，**不**与 request 级别业务
   * 结果绑定。`disconnected` 是终态；重复 `closing` / 重复
   * `popup.closed === true` 幂等忽略。
   */
  onConnectionStateChange?: (state: PopupConnectionState) => void;
  /**
   * 自定义 env（测试用）。生产路径走 `browserEnv()`。
   */
  env?: ProtocolClientEnv;
}

export type PopupSessionState = PopupConnectionState | "idle";

interface PendingRequest {
  resolve: (value: ProtocolResultMessage) => void;
  reject: (reason?: unknown) => void;
  resultTimer: ReturnType<typeof setTimeout> | null;
}

export class PopupSessionClient {
  private state: PopupSessionState = "idle";
  private popup: Window | null = null;
  private currentTargetOrigin: string | null = null;
  private listenerInstalled = false;
  private dispatcher: ReturnType<typeof createResultDispatcher> | null = null;
  /** 实际注册到 env 的 listener 引用；用于 removeMessageListener。 */
  private combinedListener: ((event: MessageEvent) => void) | null = null;
  private closePoller: ReturnType<typeof setInterval> | null = null;
  private inFlight: PendingRequest | null = null;
  private env: ProtocolClientEnv;
  private opts: PopupSessionClientOptions;
  private readyReady: Promise<void> | null = null;

  constructor(opts: PopupSessionClientOptions) {
    this.opts = opts;
    this.env = opts.env ?? browserEnv();
  }

  /** 当前 session state。 */
  getConnectionState(): PopupSessionState {
    return this.state;
  }

  /**
   * 确保 session 处于 connected 状态：
   *   - 若 state === connected：直接返回；
   *   - 若 popup 句柄丢了 / 关闭了：重开；
   *   - 首次调用：开窗、等 ready；
   *   - 改变 `targetOrigin` 时：先 `closeSession()` 再开。
   */
  async ensureSession(): Promise<void> {
    const targetOrigin = normalizeOrigin(this.opts.targetOrigin);
    if (this.currentTargetOrigin && this.currentTargetOrigin !== targetOrigin) {
      this.log("session_closed", undefined, `targetOrigin changed ${this.currentTargetOrigin} -> ${targetOrigin}`);
      this.closeSession();
    }
    if (this.state === "connected" && this.currentTargetOrigin === targetOrigin && !isPopupClosed(this.popup)) {
      return;
    }
    // 没有 ready promise 在飞：开窗。
    if (!this.readyReady) {
      this.readyReady = this.openAndAwaitReady(targetOrigin);
    }
    await this.readyReady;
  }

  /**
   * 发送一条 request 并等待 result。会先确保 session ready。
   * 同时只允许一条在途 request；并发会被立即拒绝。
   */
  async runRequest<M extends ProtocolMethod>(request: ProtocolRequestMessage<M>): Promise<ProtocolResultMessage> {
    if (this.inFlight) {
      this.log("busy_rejected", { requestId: request.id, method: request.method }, "Popup session is busy with another request");
      throw new ProtocolTransportError("session_busy", "Popup session is busy with another request");
    }
    await this.ensureSession();
    const targetOrigin = this.currentTargetOrigin!;
    const popup = this.popup!;
    // 注册 result 等待回调。
    let unsubscribe: () => void = () => undefined;
    const pending: PendingRequest = {
      resolve: () => undefined,
      reject: () => undefined,
      resultTimer: null
    };
    const promise = new Promise<ProtocolResultMessage>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      unsubscribe = this.dispatcher!.awaitResult(request.id, (msg) => {
        this.clearResultTimer(pending);
        this.inFlight = null;
        this.log("result_received", msg, undefined);
        resolve(msg);
      });
    });
    this.inFlight = pending;
    // 发送。
    try {
      console.info("[keymaster-connect-demo] sending request", sanitizeRequest(request));
      popup.postMessage(request, targetOrigin);
      this.log("request_sent", sanitizeRequest(request), undefined);
      this.log("waiting_result", undefined, undefined);
    } catch (err) {
      unsubscribe?.();
      this.clearResultTimer(pending);
      this.inFlight = null;
      this.log("busy_rejected", err, "Failed to send request");
      throw new ProtocolTransportError("invalid_origin", err instanceof Error ? err.message : "Failed to send request");
    }
    // result 超时。
    pending.resultTimer = this.env.setTimeout(() => {
      unsubscribe?.();
      this.inFlight = null;
      this.log("timeout", { stage: "result", requestId: request.id }, "result timeout");
      pending.reject(new ProtocolTransportError("result_timeout", "Timed out waiting for result"));
    }, this.opts.resultTimeoutMs);
    return promise;
  }

  /**
   * 主动关闭 session：清空 pending、解绑 listener、关闭 popup。
   * 外部再次 `ensureSession()` 时会重新开窗。
   */
  closeSession(): void {
    if (this.inFlight) {
      this.clearResultTimer(this.inFlight);
      const p = this.inFlight;
      this.inFlight = null;
      p.reject(new ProtocolTransportError("popup_closed", "Popup session was closed"));
    }
    if (this.dispatcher) {
      this.dispatcher.close();
      this.dispatcher = null;
    }
    if (this.combinedListener) {
      this.env.removeMessageListener(this.combinedListener);
      this.combinedListener = null;
    }
    if (this.closePoller) {
      this.env.clearInterval(this.closePoller);
      this.closePoller = null;
    }
    this.listenerInstalled = false;
    if (this.popup && !isPopupClosed(this.popup)) {
      try {
        this.popup.close();
      } catch {
        // ignore
      }
    }
    this.popup = null;
    this.currentTargetOrigin = null;
    this.readyReady = null;
    this.transitionTo("disconnected", "popup_closed");
  }

  /* ============== 内部 ============== */

  private async openAndAwaitReady(targetOrigin: string): Promise<void> {
    const url = buildPopupUrl(targetOrigin);
    const features = buildPopupFeatures(this.opts.popupWidth, this.opts.popupHeight);
    this.transitionTo("opening");
    const popup = this.env.open(url, POPUP_NAME, features);
    if (!popup) {
      this.log("busy_rejected", { url, features }, "Popup was blocked by the browser");
      this.transitionTo("disconnected", "popup_closed");
      throw new ProtocolTransportError("popup_blocked", "Popup was blocked by the browser");
    }
    this.popup = popup;
    this.currentTargetOrigin = targetOrigin;
    this.log("popup_opened", { url, features });
    this.installMessageListenerOnce(targetOrigin);
    this.startClosePoller();
    // 等 ready。
    const ready = new Promise<void>((resolve, reject) => {
      const readyTimer = this.env.setTimeout(() => {
        this.log("timeout", { stage: "ready" }, "ready timeout");
        reject(new ProtocolTransportError("ready_timeout", "Timed out waiting for ready"));
      }, this.opts.readyTimeoutMs);
      // 在 message listener 上挂一次性 ready watcher：通过 dispatcher 自己的
      // 派发路径无法直接 consume ready（它只派发 result）。所以这里再注册一个
      // 临时 listener，等 ready 一来就解绑。
      const onReady = (event: MessageEvent) => {
        if (event.source !== popup) return;
        if (normalizeOrigin(event.origin) !== targetOrigin) return;
        const data = event.data as unknown;
        if (!isPlainObject(data) || data.v !== 1 || data.type !== "ready") return;
        this.env.clearTimeout(readyTimer);
        this.env.removeMessageListener(onReady);
        this.log("ready_received", undefined, undefined);
        this.transitionTo("connected", "ready");
        resolve();
      };
      this.env.addMessageListener(onReady);
    });
    this.log("waiting_ready", undefined, undefined);
    try {
      await ready;
    } catch (err) {
      this.log("session_closed", err, "session aborted while waiting for ready");
      throw err;
    }
  }

  private installMessageListenerOnce(targetOrigin: string): void {
    if (this.listenerInstalled) return;
    this.dispatcher = createResultDispatcher(targetOrigin);
    // 一个 listener 同时承担：派发 `result` 给 in-flight request；以及
    // 监听 `closing` 进入"窗口生命周期结束"。
    const combinedHandler = (event: MessageEvent) => {
      const data = event.data as unknown;
      if (!isPlainObject(data) || data.v !== 1 || typeof data.type !== "string") return;
      // 1) `result` 派发（由 dispatcher 内部做 origin / id 校验）。
      if (data.type === "result") {
        this.dispatcher!.handler(event);
        return;
      }
      // 2) `closing` 是窗口生命周期结束信号：与 popup.closed 并联收敛。
      if (data.type === "closing") {
        // origin 校验：只接受 target origin 发来的 closing。
        if (typeof event.origin === "string" && normalizeOrigin(event.origin) !== targetOrigin) {
          return;
        }
        this.log("closing_received", undefined, undefined);
        this.handleSessionClosedByServer("closing");
      }
    };
    this.combinedListener = combinedHandler;
    this.env.addMessageListener(combinedHandler);
    this.listenerInstalled = true;
  }

  /**
   * 服务端通过 `closing` 报文通告窗口生命周期结束时的清理路径。
   * 行为与 close-poll 命中 popup.closed 等价：清空 in-flight、摘 listener、
   * 收敛到 `disconnected`。
   */
  private handleSessionClosedByServer(_reason: "closing"): void {
    if (this.inFlight) {
      this.clearResultTimer(this.inFlight);
      const p = this.inFlight;
      this.inFlight = null;
      p.reject(new ProtocolTransportError("popup_closed", "Popup session ended by server (closing)"));
    }
    if (this.dispatcher) {
      this.dispatcher.close();
      this.dispatcher = null;
    }
    if (this.combinedListener) {
      this.env.removeMessageListener(this.combinedListener);
      this.combinedListener = null;
    }
    if (this.closePoller) {
      this.env.clearInterval(this.closePoller);
      this.closePoller = null;
    }
    this.listenerInstalled = false;
    this.popup = null;
    this.currentTargetOrigin = null;
    this.readyReady = null;
    this.transitionTo("disconnected", "closing");
  }

  private startClosePoller(): void {
    if (this.closePoller) return;
    const closePollMs = this.opts.closePollMs ?? 500;
    this.closePoller = this.env.setInterval(() => {
      if (isPopupClosed(this.popup)) {
        this.log("popup_closed", undefined, undefined);
        if (this.inFlight) {
          this.clearResultTimer(this.inFlight);
          const p = this.inFlight;
          this.inFlight = null;
          p.reject(new ProtocolTransportError("popup_closed", "Popup was closed before the protocol completed"));
        }
        this.transitionTo("disconnected", "popup_closed");
        // 清掉 listener；下次 ensureSession() 会重装。
        if (this.dispatcher) {
          this.dispatcher.close();
          this.dispatcher = null;
        }
        if (this.combinedListener) {
          this.env.removeMessageListener(this.combinedListener);
          this.combinedListener = null;
        }
        if (this.closePoller) {
          this.env.clearInterval(this.closePoller);
          this.closePoller = null;
        }
        this.listenerInstalled = false;
        this.popup = null;
        this.currentTargetOrigin = null;
        this.readyReady = null;
      }
    }, closePollMs);
  }

  private clearResultTimer(p: PendingRequest): void {
    if (p.resultTimer) {
      this.env.clearTimeout(p.resultTimer);
      p.resultTimer = null;
    }
  }

  private transitionTo(next: PopupSessionState, reason: "ready" | "closing" | "popup_closed" = "popup_closed"): void {
    if (this.state === "disconnected" && next === "disconnected") return;
    if (this.state === next) return;
    this.state = next;
    if (reason === "closing" && next === "disconnected") {
      this.log("closing_received", undefined, undefined);
    }
    this.opts.onConnectionStateChange?.(next as PopupConnectionState);
  }

  private log(stage: ProtocolLogStage, detail?: unknown, message?: string): void {
    this.opts.onLog?.({
      at: this.env.now(),
      stage,
      message,
      detail
    });
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
