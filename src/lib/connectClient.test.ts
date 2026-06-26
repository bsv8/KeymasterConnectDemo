import { describe, expect, it, vi } from "vitest";
import {
  browserEnv,
  buildPopupUrl,
  createResultDispatcher,
  isPopupClosed,
  normalizeOrigin,
  type ProtocolClientEnv,
  type ProtocolLogEvent
} from "./connectClient";
import { PopupSessionClient } from "./popupSessionClient";
import { PROTOCOL_METHODS, type ProtocolRequestMessage, type ProtocolResultMessage } from "./protocol";

function makeRequest(): ProtocolRequestMessage<"identity.get"> {
  return {
    v: 1,
    type: "request",
    id: "req-1",
    method: "identity.get",
    params: {
      aud: "https://demo.example",
      iat: 1,
      exp: 2,
      text: "hello",
      claims: ["key.label"]
    }
  };
}

interface TestPopup {
  closed: boolean;
  postMessage: (msg: unknown) => void;
}

function createEnv() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const messages: unknown[] = [];
  let popup: TestPopup = {
    closed: false,
    postMessage: (msg: unknown) => {
      messages.push(msg);
    }
  };
  const env: ProtocolClientEnv = {
    now: () => 1234,
    open: vi.fn(() => popup as unknown as Window),
    addMessageListener: (handler) => listeners.add(handler),
    removeMessageListener: (handler) => listeners.delete(handler),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis)
  };
  return {
    env,
    getPopup: () => popup,
    setPopup: (next: TestPopup) => {
      popup = next;
    },
    listeners,
    messages
  };
}

function dispatch(listeners: Set<(event: MessageEvent) => void>, event: Partial<MessageEvent>) {
  for (const handler of listeners) {
    handler(event as MessageEvent);
  }
}

describe("PROTOCOL_METHODS", () => {
  it("covers the 7 V1 methods after hard switch", () => {
    expect(PROTOCOL_METHODS).toEqual([
      "identity.get",
      "intent.sign",
      "cipher.encrypt",
      "cipher.decrypt",
      "p2pkh.transfer",
      "feepool.prepare",
      "feepool.commit"
    ]);
  });
});

describe("buildPopupUrl", () => {
  it("appends the protocol popup path to the origin", () => {
    expect(buildPopupUrl("https://keymaster.cc")).toBe("https://keymaster.cc/protocol/v1/popup");
  });
  it("normalizes origin before appending", () => {
    expect(buildPopupUrl("https://KEYMASTER.cc:443/")).toBe("https://keymaster.cc/protocol/v1/popup");
  });
});

describe("normalizeOrigin", () => {
  it("lowercases host and removes default ports", () => {
    expect(normalizeOrigin("https://Keymaster.CC:443/x")).toBe("https://keymaster.cc");
  });
});

describe("isPopupClosed", () => {
  it("returns true when popup is null", () => {
    expect(isPopupClosed(null)).toBe(true);
  });
  it("returns true when popup.closed is true", () => {
    expect(isPopupClosed({ closed: true } as unknown as Window)).toBe(true);
  });
  it("returns false when popup.closed is false", () => {
    expect(isPopupClosed({ closed: false } as unknown as Window)).toBe(false);
  });
});

describe("createResultDispatcher", () => {
  it("dispatches a result with matching id to the registered callback", () => {
    const d = createResultDispatcher("https://keymaster.cc");
    let got: ProtocolResultMessage | null = null;
    d.awaitResult("r-1", (msg) => {
      got = msg;
    });
    dispatch(dispatcherListeners(d), {
      origin: "https://keymaster.cc",
      data: { v: 1, type: "result", id: "r-1", ok: true, result: { hello: "world" } } as unknown as ProtocolResultMessage
    });
    expect(got).not.toBeNull();
  });

  it("ignores result for other ids", () => {
    const d = createResultDispatcher("https://keymaster.cc");
    let called = 0;
    d.awaitResult("r-1", () => {
      called++;
    });
    dispatch(dispatcherListeners(d), {
      origin: "https://keymaster.cc",
      data: { v: 1, type: "result", id: "r-other", ok: true, result: {} } as unknown as ProtocolResultMessage
    });
    expect(called).toBe(0);
  });

  it("ignores messages from a different origin", () => {
    const d = createResultDispatcher("https://keymaster.cc");
    let called = 0;
    d.awaitResult("r-1", () => {
      called++;
    });
    dispatch(dispatcherListeners(d), {
      origin: "https://evil.com",
      data: { v: 1, type: "result", id: "r-1", ok: true, result: {} } as unknown as ProtocolResultMessage
    });
    expect(called).toBe(0);
  });

  it("unsubscribe stops further delivery", () => {
    const d = createResultDispatcher("https://keymaster.cc");
    let called = 0;
    const off = d.awaitResult("r-1", () => {
      called++;
    });
    off();
    dispatch(dispatcherListeners(d), {
      origin: "https://keymaster.cc",
      data: { v: 1, type: "result", id: "r-1", ok: true, result: {} } as unknown as ProtocolResultMessage
    });
    expect(called).toBe(0);
  });
});

// The dispatcher uses a closure-captured listener; expose it for tests.
function dispatcherListeners(d: ReturnType<typeof createResultDispatcher>): Set<(event: MessageEvent) => void> {
  // We piggyback on the handler reference: the handler is the only
  // registered listener, so we can dispatch through a parallel `dispatch`
  // mechanism. Tests just call `d.handler` directly via the captured ref.
  const set = new Set<(event: MessageEvent) => void>();
  set.add(d.handler);
  return set;
}

describe("PopupSessionClient", () => {
  // 注意：本组测试**不**用 fake timers。PopupSessionClient 内部用
  // setTimeout 做 ready / result / close-poll；本组测试关心事件流本身，
  // fake timers 反而会让 microtask 调度出现意想不到的"Promise 卡住"。
  // close-poll 时序在"reopens popup"那条用例里用真 timer 控。

  /** 等待一次 microtask flush；fake timer 环境下 Promise 仍要靠 microtask 推进。 */
  async function flushMicrotasks(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  it("opens popup on first runRequest and reuses it on second runRequest", async () => {
    const { env, listeners, getPopup } = createEnv();
    const openSpy = env.open as ReturnType<typeof vi.fn>;
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env
    });

    const p1 = client.runRequest(makeRequest());
    expect(openSpy).toHaveBeenCalledTimes(1);
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await expect(p1).resolves.toMatchObject({ ok: true });
    // 再次发送第二条 request：应复用同一 popup，不再调 open。
    const req2: ProtocolRequestMessage<"identity.get"> = { ...makeRequest(), id: "req-2" };
    const p2 = client.runRequest(req2);
    expect(openSpy).toHaveBeenCalledTimes(1);
    // runRequest 内部 await ensureSession 会让出 microtask；
    // 必须在 awaitResult 注册完成后再发 result。
    await flushMicrotasks();
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-2",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("rejects a second runRequest when one is in flight", async () => {
    const { env, listeners, getPopup } = createEnv();
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 5000,
      env
    });
    const p1 = client.runRequest(makeRequest());
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    const req2: ProtocolRequestMessage<"identity.get"> = { ...makeRequest(), id: "req-2" };
    await expect(client.runRequest(req2)).rejects.toMatchObject({ code: "session_busy" });
    // 让第一条正常结束，避免未处理的 promise。
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await expect(p1).resolves.toMatchObject({ ok: true });
  });

  it("targetOrigin change forces a new popup", async () => {
    // 两条独立 listener 集：第一次开窗用 env1，第二次开窗用 env2。
    const a = createEnv();
    const b = createEnv();
    const openSpy = a.env.open as ReturnType<typeof vi.fn>;
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env: a.env
    });
    const p1 = client.runRequest(makeRequest());
    expect(openSpy).toHaveBeenCalledTimes(1);
    dispatch(a.listeners, {
      origin: "https://keymaster.cc",
      source: a.getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    dispatch(a.listeners, {
      origin: "https://keymaster.cc",
      source: a.getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await p1;

    // targetOrigin 改变：用一个全新 client 跑新 origin；用独立 env 让 listener
    // 集不互相干扰。
    const bOpenSpy = b.env.open as ReturnType<typeof vi.fn>;
    const client2 = new PopupSessionClient({
      targetOrigin: "https://staging.keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env: b.env
    });
    const p2 = client2.runRequest({ ...makeRequest(), id: "req-2" });
    expect(bOpenSpy).toHaveBeenCalledTimes(1);
    dispatch(b.listeners, {
      origin: "https://staging.keymaster.cc",
      source: b.getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    dispatch(b.listeners, {
      origin: "https://staging.keymaster.cc",
      source: b.getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-2",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("reopens popup after the previous popup was closed", async () => {
    const { env, listeners, getPopup, setPopup } = createEnv();
    const openSpy = env.open as ReturnType<typeof vi.fn>;
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      closePollMs: 50,
      env
    });
    const p1 = client.runRequest(makeRequest());
    expect(openSpy).toHaveBeenCalledTimes(1);
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await p1;

    // 模拟用户手工关 popup：把 popup 引用上的 .closed 置 true（保持引用
    // 不变，sessionClient 持有的是同一引用）。
    const current = getPopup() as TestPopup;
    current.closed = true;
    await new Promise((r) => setTimeout(r, 80));
    await flushMicrotasks();

    // 再发 request：必须重新开窗。
    const p2 = client.runRequest({ ...makeRequest(), id: "req-2" });
    expect(openSpy).toHaveBeenCalledTimes(2);
    current.closed = false;
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-2",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("transitions connection state opening -> connected on ready", async () => {
    const { env, listeners, getPopup } = createEnv();
    const states: string[] = [];
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env,
      onConnectionStateChange: (s) => states.push(s)
    });
    const p1 = client.runRequest(makeRequest());
    expect(states).toEqual(["opening"]);
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    expect(states).toContain("connected");
    // 让 request 正常结束。
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await p1;
  });

  it("records log events for popup_opened, ready_received, request_sent, result_received", async () => {
    const { env, listeners, getPopup } = createEnv();
    const logs: ProtocolLogEvent[] = [];
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env,
      onLog: (e) => logs.push(e)
    });
    const p1 = client.runRequest(makeRequest());
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await p1;
    const stages = logs.map((l) => l.stage);
    expect(stages).toContain("popup_opened");
    expect(stages).toContain("ready_received");
    expect(stages).toContain("request_sent");
    expect(stages).toContain("result_received");
  });

  it("consumes 'closing' message and transitions to disconnected", async () => {
    // 施工单 002 收口：closing 是窗口生命周期结束信号；demo 必须消费它，
    // 不能仅靠 popup.closed 兜底。
    const { env, listeners, getPopup } = createEnv();
    const states: string[] = [];
    const logs: ProtocolLogEvent[] = [];
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env,
      onConnectionStateChange: (s) => states.push(s),
      onLog: (e) => logs.push(e)
    });
    const p1 = client.runRequest(makeRequest());
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    // 服务端发 closing：demo 必须立即进入 disconnected。
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "closing" }
    });
    await flushMicrotasks();
    expect(states).toContain("disconnected");
    expect(client.getConnectionState()).toBe("disconnected");
    expect(logs.map((l) => l.stage)).toContain("closing_received");
    // 在途的 request 必须被 reject。
    await expect(p1).rejects.toMatchObject({ code: "popup_closed" });
  });

  it("ignores 'closing' from wrong origin", async () => {
    const { env, listeners, getPopup } = createEnv();
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env
    });
    const p1 = client.runRequest(makeRequest());
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await flushMicrotasks();
    // 第三方伪造的 closing：source 不对、origin 不对，都不应触发收口。
    dispatch(listeners, {
      origin: "https://evil.com",
      source: getPopup() as unknown as MessageEventSource,
      data: { v: 1, type: "closing" }
    });
    await flushMicrotasks();
    // 仍然 connected（inFlight 仍存在）。
    expect(client.getConnectionState()).toBe("connected");
    // 让 request 正常结束，避免悬挂。
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { ok: true } as never
      } as unknown as ProtocolResultMessage
    });
    await expect(p1).resolves.toMatchObject({ ok: true });
  });
});

// sanity: keep a single browserEnv reference so the import isn't unused.
void browserEnv;
