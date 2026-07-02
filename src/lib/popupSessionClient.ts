// src/lib/popupSessionClient.ts
// 页面级 popup session client。
//
// 设计缘由（施工单 2026-06-29 002 硬切换：session-first / 16 方法 / cancel +
//          施工单 2026-06-30 001 appView child ready + opener launch 硬切换 +
//          施工单 2026-07-01 001 appmsg 协议硬切换一次性迭代）：
//   - 同一 demo 页面，对同一 `targetOrigin`，只维护一个 popup 会话。
//   - 首次 `ensureSession()` 时若没有 popup 句柄就开窗、等一次 `ready`。
//   - 后续 `runRequest()` 复用现有 popup 句柄：不再 `window.open`。
//   - 同一时刻只允许**一条在途** request；第二条再点会抛 `session_busy`。
//   - `targetOrigin` 变化时主动关闭旧 popup，再用新 origin 开新窗。
//   - popup 手工关闭 / 刷新后，下次 `runRequest()` 重新开窗。
//   - 不做客户端请求队列；不做自动重试；不做跨 opener 编排。
//   - 暴露 `cancelCurrentRequest()`：对当前在途 request 发顶层 `cancel`；
//     发出后仍由原 request 收最终结果或失败（cancel 自己不单独回 result）。
//   - **appView 启动期**：必须支持"收养现有 Session Window"作为 transport
//     对端（详见 `adoptOpener`），**不**主动 `window.open` 一扇新的 popup；
//     调用方必须**先**调 `adoptOpener()`，再走 `runRequest()`——
//     `ensureSession()` 不会主动去找 opener。
//   - **顶层 `event` 收包**：暴露 `onEvent` 回调；`event` 到达时：
//       * **不**占用 in-flight request 槽位；
//       * **不**把连接状态切到 `connected` / `disconnected` 以外的新状态；
//       * 与 `result` 可交错到达，互不覆盖；
//       * 在 popup 生命周期内长期到达，**不**只在某次 request 期间有效；
//       * 走 origin 校验，与 `closing` / `result` 同一档严格度。
//
// 这一层拥有：
//   - 长期 `message` 监听（ResultDispatcher）；
//   - popup 句柄（或被收养的 opener 句柄）；
//   - popup 关闭轮询；
//   - 连接状态机（`opening` / `connected` / `disconnected`）。
//
// 这一层**不**拥有：
//   - 任何业务方法（identity.get / intent.sign / cipher.* / connect.* /
//     appmsg.*）；
//   - 任何 UI；只通过回调与日志暴露；
//   - "appView child ready 是 listener 就绪的标志" 这件事的判定——这由调用方
//     在 `adoptOpener()` 之后通过 `postReadyToOpener()` 自己发。

import type {
  PopupConnectionState,
  ProtocolEventMessage,
  ProtocolMethod,
  ProtocolRequestMessage,
  ProtocolResultMessage
} from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";
import {
  ProtocolTransportError,
  buildPopupFeatures,
  buildPopupUrl,
  browserEnv,
  createResultDispatcher,
  getReusableOpener,
  isPopupClosed,
  normalizeOrigin,
  sendCancel,
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
   * 顶层 `event` 收包回调（施工单 2026-07-01 001 硬切换）。
   *
   * 设计缘由：
   *   - `event` 是 server-pushed 单向消息（V1 仅 `appmsg.inbox_dirty`），
   *     **不**回 result，**不**占用 in-flight 槽位，**不**改变连接状态；
   *   - 回调在 origin 校验通过后被调用；非法 origin 的 `event` 直接丢弃；
   *   - 在 popup 生命周期内长期到达，**不**只在某次 request 期间有效；
   *   - 与 `result` / `closing` 在同一 listener 里处理，互不抢占；
   *   - 回调**不**应抛错；内部 try/catch 包裹后写一条 `event_received`
   *     日志继续运行。
   *
   * 不设本回调时，`event` 报文仅记入 protocol log，不暴露给上层。
   */
  onEvent?: (message: ProtocolEventMessage) => void;
  /**
   * 自定义 env（测试用）。生产路径走 `browserEnv()`。
   */
  env?: ProtocolClientEnv;
  /**
   * appView 锁定模式（施工单 2026-07-02 002 appView manual launch
   * transport 硬切换一次性迭代第 5.三 / 6.一 / 6.二 / 7.4 / 10.1 章）：
   *
   *   - 当为 true 时，client 的 transport 真值被强制锁定到
   *     `window.opener` 指向的 Session Window：
   *       * `adoptOpener()` 仍然是唯一被允许的 transport 建立路径；
   *       * `ensureSession()` 在 state !== "connected" 时**绝不**调
   *         `window.open(...)`，而是抛 `appview_session_lost`；
   *       * 关闭 poller 命中"opener 已关"会把 state 收敛到
   *         `disconnected`，但状态一旦解锁，**任何后续** `runRequest()`
   *         都不允许偷偷 `window.open`，必须重新 `adoptOpener()`。
   *   - 默认 `false`：保留 direct / popup 登录链路的 `ensureSession
   *     -> window.open(...)` 行为不变；
   *   - 这一项一旦置 `true`，demo 整页都不应该有第二条 transport 入口；
   *     反之若运行时混用 direct + appView，会被这条锁暴露为失败态而不是
   *     静默兼容。
   */
  appViewOnly?: boolean;
}

export type PopupSessionState = PopupConnectionState | "idle";

interface PendingRequest {
  resolve: (value: ProtocolResultMessage) => void;
  reject: (reason?: unknown) => void;
  resultTimer: ReturnType<typeof setTimeout> | null;
  /** 与 pending 绑定的 requestId，供 cancel 时引用。 */
  requestId: string;
  method?: ProtocolMethod;
}

export class PopupSessionClient {
  private state: PopupSessionState = "idle";
  private popup: Window | null = null;
  /**
   * 当前 `this.popup` 是否来自 `adoptOpener()`（= `window.opener`）。
   *
   * 设计缘由（施工单 2026-06-30 001 appView child ready + opener launch 硬切换
   *          第 5.三 / 6.三 / 7.不能怎么做 章）：
   *   - appView child transport 复用的是 Keymaster Session Window 本身；
   *   - `closeSession()` **不**应调用 `this.popup.close()` 关掉 Session Window；
   *     那相当于 demo 主动关掉 launcher 给它的父窗，破坏"复用 opener"语义；
   *   - 标识为 `true` 时，`closeSession()` 只清本端 listener / timer / 注册表，
   *     跳过 `popup.close()`，并把 popup 引用置空以防后续误用。
   */
  private popupIsOpener = false;
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

  /** 当前在途 request 的 requestId；无在途时返回 null。 */
  getCurrentRequestId(): string | null {
    return this.inFlight?.requestId ?? null;
  }

  /**
   * 确保 session 处于 connected 状态：
   *   - 若 state === connected：直接返回；
   *   - 若 popup 句柄丢了 / 关闭了：重开；
   *   - 首次调用：开窗、等 ready；
   *   - 改变 `targetOrigin` 时：先 `closeSession()` 再开。
   *
   * appView 锁定模式（施工单 2026-07-02 002 appView manual launch
   * transport 硬切换一次性迭代第 5.三 / 6.一 / 6.二 / 10.1 章）：
   *   - `opts.appViewOnly === true` 时，**绝不**允许 `window.open(...)`
   *     兜底；
   *   - state !== "connected" 一律抛 `appview_session_lost`，由调用方
   *     写失败态（"请从 Keymaster 重新拉起"）；
   *   - 这条规则把"opener 关闭 / 还没 `adoptOpener()`"两条边界都收口：
   *     client 不会偷偷另开 popup。
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
    // appView 锁定：禁止 ensureSession() 走 window.open 回退。
    // opener 关闭 / 还没 adoptive → 抛 appview_session_lost，由调用方
    // 写 UI 失败态，要求用户从 Keymaster 重新拉起。
    if (this.opts.appViewOnly) {
      const reason =
        "appView popup session is not connected; opener may be closed or never adopted. " +
        "Refusing to fall back to window.open; please relaunch from Keymaster.";
      this.log(
        "session_closed",
        { state: this.state, appViewOnly: true },
        reason
      );
      throw new ProtocolTransportError("appview_session_lost", reason);
    }
    // 没有 ready promise 在飞：开窗。
    if (!this.readyReady) {
      this.readyReady = this.openAndAwaitReady(targetOrigin);
    }
    await this.readyReady;
  }

  /**
   * "收养现有 Session Window"——appView 启动期 / 刷新后恢复入口。
   *
   * 设计缘由（施工单 2026-06-30 001 appView child ready + opener launch
   *          硬切换第 4.2 / 5.三 / 6.二 / 6.三 / 7.不能怎么做 章 +
   *          依赖项目 keymaster.cc 施工单 003 第 4.1 / 5.五 章）：
   *   - appView 启动期 Keymaster Session Window 已经主动打开了 demo 页面；
   *     此时 `window.opener` 指向那扇 Session Window；
   *   - 调用方必须能复用这扇已存在的窗口作为 transport 对端，**不**允许
   *     主动 `window.open` 一扇新 popup——否则一次 Open App 会变成两扇
   *     协议窗口、首次 `connect.launch` 也无处发送；
   *   - 成功：当前 popup 句柄替换为 `window.opener`，状态收口到 `connected`，
   *     后续 `runRequest()` 直接往这扇 Session Window 发请求；
   *   - 失败（无 opener / opener 已关 / targetOrigin 不一致）：抛 `no_opener`
   *     给调用方，调用方应走 appView 失败态（"请从 Keymaster 重新启动"）。
   *
   * ready 握手语义（**与上游对齐**）：
   *   - 上游 Session Window 在 mount 时**只**向自己的 `window.opener`
   *     （launcher / 旧 popup caller）发 `ready`，**不**为后续由它
   *     `openClientApp()` 打开的 client app 再补发一次；
   *   - 因此 demo 在 `adoptOpener()` 里**不**做"等 Session Window 发 ready"
   *     的握手——该信号不会到；改为：
   *       1. 校验 `window.opener` 存在且 targetOrigin 合法；
   *       2. 安装 message listener；
   *       3. 启动 close poller；
   *       4. 切换到 `connected`；
   *   - 实际"对端是否能正确响应 request"由 `runRequest()` 的 `result_timeout`
   *     / close poller 兜底——若 Session Window 真的没准备好，request 会
   *     拿不到 result，按 `result_timeout` 收口。
   *   - 这一收口与上游 connect popup 路径的 `ready` 等待行为**有意不同**：
   *     popup 路径下 Session Window 的 `window.opener` 就是 demo 自身，
   *     mount 时发的 `ready` 是发给 demo 的，所以等它成立；
   *     appView 路径下 Session Window 的 `window.opener` 是 launcher，
   *     `ready` 不会到达 demo，所以**不能**等。
   *
   * 边界：
   *   - **不**调用 `window.open(...)`——这是与"开新 popup"分支的核心区别；
   *   - 若上层在收养后又被要求"换 origin"，必须先 `closeSession()`，再走
   *     `ensureSession()` 重新开 popup。
   */
  async adoptOpener(): Promise<void> {
    const targetOrigin = normalizeOrigin(this.opts.targetOrigin);
    const reusable = getReusableOpener(targetOrigin);
    if (!reusable) {
      this.log("no_opener", { targetOrigin }, "no reusable opener for appView");
      throw new ProtocolTransportError(
        "no_opener",
        "No reusable Session Window opener is available; please relaunch from Keymaster."
      );
    }
    // 若当前已经处于 connected 且持有同一扇窗口，直接复用；否则接管状态。
    if (
      this.state === "connected" &&
      this.popup === reusable.opener &&
      this.currentTargetOrigin === targetOrigin
    ) {
      return;
    }
    // 旧 session 还没收口：这里显式 teardown 一次，避免继续绑着旧句柄。
    if (this.state !== "idle" || this.popup || this.dispatcher || this.listenerInstalled) {
      this.closeSession();
    }
    this.transitionTo("opening");
    this.popup = reusable.opener;
    // 标记当前 popup 句柄来自 `window.opener`；`closeSession()` 会读这个
    // 标志跳过 `this.popup.close()`，避免 demo 误关 Session Window。
    this.popupIsOpener = true;
    this.currentTargetOrigin = targetOrigin;
    this.installMessageListenerOnce(targetOrigin);
    this.startClosePoller();
    this.log("opener_adopted", undefined, "adopted existing Session Window opener");
    // 不等待 Session Window 的 `ready`：上游语义下它不会到。demo 信任
    // 对端 alive，直接进入 connected；后续 `runRequest()` 由 result_timeout /
    // close poller 兜底。
    this.transitionTo("connected", "ready");
  }

  /**
   * 发送一条 request 并等待 result。会先确保 session ready。
   * 同时只允许一条在途 request；并发会被立即拒绝。
   */
  async runRequest<M extends ProtocolMethod>(request: ProtocolRequestMessage<M>): Promise<ProtocolResultMessage> {
    if (this.inFlight) {
      this.logWithMethod("busy_rejected", request.method, { requestId: request.id }, "Popup session is busy with another request");
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
      resultTimer: null,
      requestId: request.id,
      method: request.method
    };
    const promise = new Promise<ProtocolResultMessage>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      unsubscribe = this.dispatcher!.awaitResult(request.id, (msg) => {
        this.clearResultTimer(pending);
        this.inFlight = null;
        this.logWithMethod("result_received", request.method, msg);
        resolve(msg);
      });
    });
    this.inFlight = pending;
    // 发送。
    try {
      console.info("[keymaster-connect-demo] sending request", sanitizeRequest(request));
      popup.postMessage(request, targetOrigin);
      this.logWithMethod("request_sent", request.method, sanitizeRequest(request));
      this.logWithMethod("waiting_result", request.method);
    } catch (err) {
      unsubscribe?.();
      this.clearResultTimer(pending);
      this.inFlight = null;
      this.logWithMethod("busy_rejected", request.method, err, "Failed to send request");
      throw new ProtocolTransportError("invalid_origin", err instanceof Error ? err.message : "Failed to send request");
    }
    // result 超时。
    pending.resultTimer = this.env.setTimeout(() => {
      unsubscribe?.();
      this.inFlight = null;
      this.logWithMethod("timeout", request.method, { stage: "result", requestId: request.id }, "result timeout");
      pending.reject(new ProtocolTransportError("result_timeout", "Timed out waiting for result"));
    }, this.opts.resultTimeoutMs);
    return promise;
  }

  /**
   * 取消当前在途 request（施工单 2026-06-29 002 硬切换）：
   *   - 只对当前 `inFlight.requestId` 发顶层 `cancel`；
   *   - 发出后仍由**原 request** 自己走 result 收尾（`result_received`
   *     或 `popup_closed` / `closing` 路径），demo **不**为 cancel 单独
   *     新开第二条 result 面板；
   *   - 无在途 request 时直接 throw `no_in_flight`，调用方吞掉即可。
   *
   * 设计缘由：cancel 是 transport 控制消息；"是否生效"由 popup 自己决
   * 定，demo 不假设一定能取消成功。若 popup 在 cancel 到达前已回 result
   * 或已发 closing，则 cancel 本身就是 no-op，**不**报错。
   */
  cancelCurrentRequest(): void {
    const inflight = this.inFlight;
    if (!inflight) {
      this.log("busy_rejected", undefined, "cancelCurrentRequest called with no in-flight request");
      throw new ProtocolTransportError("no_in_flight", "No in-flight request to cancel");
    }
    if (!this.popup || isPopupClosed(this.popup) || !this.currentTargetOrigin) {
      // popup 已经死了：cancel 不可达，但 inFlight 还在等 result；
      // 让它走 popup.closed / closing 收口即可。
      this.logWithMethod("cancel_sent", inflight.method ?? "identity.get", undefined, "cancel skipped: popup already closed");
      return;
    }
    try {
      sendCancel(this.popup, this.currentTargetOrigin, inflight.requestId);
      this.logWithMethod("cancel_sent", inflight.method ?? "identity.get", undefined, `cancel sent for requestId=${inflight.requestId}`);
    } catch (err) {
      this.logWithMethod("cancel_sent", inflight.method ?? "identity.get", undefined, `cancel postMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 主动关闭 session：清空 pending、解绑 listener、关闭 popup。
   * 外部再次 `ensureSession()` 时会重新开窗。
   *
   * appView 模式保护（施工单 2026-06-30 001 第 5.三 / 6.三 章）：
   *   - 若 `this.popup` 是 `adoptOpener()` 收养的 `window.opener`（= Keymaster
   *     Session Window 本体），**不**调 `this.popup.close()`——demo 主动关掉
   *     Session Window 会破坏 launcher 期望的窗口生命周期；
   *   - 这条仅影响"是否调 close()"；listener / timer / in-flight reject / 状态
   *     收敛照旧，避免把"已 orphan 的 request"挂在内存里。
   *   - close poller 在 popup 是 opener 的情况下**也**要继续工作：对端 Session
   *     Window 被用户关掉时仍能正常收口。
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
    // popupIsOpener ⇒ `this.popup` 是 `window.opener` (Keymaster Session
    // Window)，demo **不**主动关它；只清引用。其它情况下才安全地调 close。
    if (this.popup && !this.popupIsOpener && !isPopupClosed(this.popup)) {
      try {
        this.popup.close();
      } catch {
        // ignore
      }
    }
    this.popup = null;
    this.popupIsOpener = false;
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
    // 普通开窗路径：本端 `env.open(...)` 出来的就是自己开的 popup，
    // `closeSession()` 应当正常关它；显式置 false 防误关 Session Window。
    this.popupIsOpener = false;
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
        if (!isPlainObject(data) || data.v !== PROTOCOL_VERSION || data.type !== "ready") return;
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
    // 一个 listener 同时承担：
    //   - 派发 `result` 给 in-flight request；
    //   - 监听 `closing` 进入"窗口生命周期结束"；
    //   - 派发 `event` 给上层 `onEvent` 回调（V1 仅 `appmsg.inbox_dirty`）。
    const combinedHandler = (event: MessageEvent) => {
      const data = event.data as unknown;
      if (!isPlainObject(data) || data.v !== PROTOCOL_VERSION || typeof data.type !== "string") return;
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
        return;
      }
      // 3) `event` 是 server-pushed 单向消息；与 in-flight / 连接状态解耦。
      //    只接受 `appmsg.inbox_dirty`；其它 event 名一律忽略（V1 未启用）。
      if (data.type === "event") {
        if (typeof event.origin === "string" && normalizeOrigin(event.origin) !== targetOrigin) {
          // 非法 origin：记日志、不向上层派发、不改变连接状态。
          this.log("event_received", { reason: "invalid_origin", eventOrigin: event.origin });
          return;
        }
        if (data.event !== "appmsg.inbox_dirty") {
          this.log("event_received", { reason: "unknown_event", event: data.event }, "unknown event ignored");
          return;
        }
        const message: ProtocolEventMessage = {
          v: PROTOCOL_VERSION,
          type: "event",
          event: "appmsg.inbox_dirty",
          data: data.data as import("./protocol").AppMsgInboxDirtyEventData
        };
        this.log("event_received", { event: message.event, data: message.data });
        try {
          this.opts.onEvent?.(message);
        } catch (err) {
          this.log(
            "event_received",
            { error: err instanceof Error ? err.message : String(err) },
            "onEvent callback threw"
          );
        }
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

  private logWithMethod(
    stage: ProtocolLogStage,
    method: ProtocolMethod,
    detail?: unknown,
    message?: string
  ): void {
    this.opts.onLog?.({
      at: this.env.now(),
      stage,
      method,
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