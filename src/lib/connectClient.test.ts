import { describe, expect, it, vi } from "vitest";
import {
  browserEnv,
  buildPopupUrl,
  createResultDispatcher,
  getReusableOpener,
  isPopupClosed,
  normalizeOrigin,
  postReadyToOpener,
  stripLaunchTokenFromUrl,
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
      claims: ["key.label"],
      connectSessionId: "sess-test-1"
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
  it("covers the 16 V1 methods after hard switch", () => {
    expect(PROTOCOL_METHODS).toEqual([
      "identity.get",
      "intent.sign",
      "cipher.encrypt",
      "cipher.decrypt",
      "p2pkh.transfer",
      "feepool.prepare",
      "feepool.commit",
      "connect.login",
      "connect.resume",
      "connect.logout",
      "connect.launch",
      "storage.put",
      "storage.get",
      "storage.list",
      "storage.listAll",
      "storage.delete"
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

describe("getReusableOpener (appView child transport)", () => {
  // 这些测试需要 `window` 全局。Vitest 跑在 node 环境下时 `window`
  // 不存在；用 `vi.stubGlobal` 注入一个最小 stub。
  function withWindowStub<T>(run: (stub: { opener: Window | null }) => T): T {
    const stub: { opener: Window | null } = { opener: null };
    vi.stubGlobal("window", stub);
    try {
      return run(stub);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("returns null when window.opener is null", () => {
    withWindowStub(() => {
      expect(getReusableOpener("https://keymaster.cc")).toBeNull();
    });
  });

  it("returns null when opener.closed is true", () => {
    withWindowStub((stub) => {
      stub.opener = { closed: true } as unknown as Window;
      expect(getReusableOpener("https://keymaster.cc")).toBeNull();
    });
  });

  it("returns {opener, targetOrigin} when opener is alive and targetOrigin is valid", () => {
    withWindowStub((stub) => {
      const fakeOpener = { closed: false } as unknown as Window;
      stub.opener = fakeOpener;
      const result = getReusableOpener("https://keymaster.cc");
      expect(result).not.toBeNull();
      expect(result?.opener).toBe(fakeOpener);
      expect(result?.targetOrigin).toBe("https://keymaster.cc");
    });
  });

  it("returns null when targetOrigin is not a valid URL", () => {
    withWindowStub((stub) => {
      stub.opener = { closed: false } as unknown as Window;
      expect(getReusableOpener("not a url")).toBeNull();
    });
  });
});

describe("postReadyToOpener (appView child ready)", () => {
  function withWindowStub<T>(run: (stub: { opener: Window | null }) => T): T {
    const stub: { opener: Window | null } = { opener: null };
    vi.stubGlobal("window", stub);
    try {
      return run(stub);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("returns false when window.opener is null", () => {
    withWindowStub(() => {
      expect(postReadyToOpener("https://keymaster.cc")).toBe(false);
    });
  });

  it("returns false when opener is closed", () => {
    withWindowStub((stub) => {
      stub.opener = { closed: true } as unknown as Window;
      expect(postReadyToOpener("https://keymaster.cc")).toBe(false);
    });
  });

  it("postMessages a top-level ready message and returns true on success", () => {
    withWindowStub((stub) => {
      const sent: unknown[] = [];
      const fakeOpener = {
        closed: false,
        postMessage: (msg: unknown) => {
          sent.push(msg);
        }
      } as unknown as Window;
      stub.opener = fakeOpener;
      expect(postReadyToOpener("https://keymaster.cc")).toBe(true);
      expect(sent).toEqual([{ v: 1, type: "ready" }]);
    });
  });

  it("returns false and swallows postMessage errors", () => {
    withWindowStub((stub) => {
      stub.opener = {
        closed: false,
        postMessage: () => {
          throw new Error("boom");
        }
      } as unknown as Window;
      expect(postReadyToOpener("https://keymaster.cc")).toBe(false);
    });
  });

  it("returns false when targetOrigin is not a valid URL", () => {
    withWindowStub((stub) => {
      const sent: unknown[] = [];
      stub.opener = {
        closed: false,
        postMessage: (msg: unknown) => {
          sent.push(msg);
        }
      } as unknown as Window;
      expect(postReadyToOpener("not a url")).toBe(false);
      expect(sent).toEqual([]);
    });
  });
});

describe("stripLaunchTokenFromUrl", () => {
  // stripLaunchTokenFromUrl 内部会读 `window.location.search` 和
  // `window.history.replaceState`。这里用一个最小 stub 模拟。
  function withWindowStub<T>(search: string, run: (captured: { url: string | null }) => T): T {
    const captured: { url: string | null } = { url: null };
    const stub = {
      location: { search },
      history: {
        replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
          if (typeof url === "string") captured.url = url;
          else if (url) captured.url = String(url);
        }
      }
    };
    vi.stubGlobal("window", stub);
    try {
      return run(captured);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("returns false when there is no launchToken", () => {
    withWindowStub("", (captured) => {
      expect(stripLaunchTokenFromUrl()).toBe(false);
      expect(captured.url).toBeNull();
    });
  });

  it("strips the launchToken and preserves other query params", () => {
    withWindowStub("?launchToken=abc123&foo=bar", (captured) => {
      expect(stripLaunchTokenFromUrl()).toBe(true);
      expect(captured.url).not.toBeNull();
      expect(captured.url).toContain("foo=bar");
      expect(captured.url).not.toContain("launchToken");
    });
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

  it("cancelCurrentRequest posts a top-level cancel message for the in-flight request", async () => {
    const { env, listeners, getPopup, messages } = createEnv();
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
    expect(client.getCurrentRequestId()).toBe("req-1");
    // 调用 cancel：必须 postMessage 出顶层 cancel 报文，且**不**抛错。
    client.cancelCurrentRequest();
    // 最后一条发出的 message 必须是顶层 cancel 报文。
    const last = messages[messages.length - 1] as Record<string, unknown>;
    expect(last).toMatchObject({ v: 1, type: "cancel", id: "req-1" });
    // 让 request 正常收尾，避免悬挂。
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: false,
        error: { code: "user_rejected", message: "canceled" }
      } as unknown as ProtocolResultMessage
    });
    await expect(p1).resolves.toMatchObject({ ok: false });
  });

  it("cancelCurrentRequest throws no_in_flight when nothing is in flight", async () => {
    const { env } = createEnv();
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env
    });
    expect(() => client.cancelCurrentRequest()).toThrowError(/no_in_flight|No in-flight/);
  });

  it("cancel does not produce a second result; original request still owns the result", async () => {
    // cancel 完成后原 request 的 result 仍然由 result 报文收尾，
    // 不会冒出来第二条 result；cancel_sent 日志也只能有一条。
    const { env, listeners, getPopup } = createEnv();
    const logs: ProtocolLogEvent[] = [];
    const client = new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 5000,
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
    client.cancelCurrentRequest();
    // cancel_sent 只出现一次；cancel_sent 之后没有第二条 result_received。
    const cancelSentCount = logs.filter((l) => l.stage === "cancel_sent").length;
    expect(cancelSentCount).toBe(1);
    // 服务端随后回 result(ok=false)，原 request 正常 reject。
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: getPopup() as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: false,
        error: { code: "user_rejected", message: "canceled" }
      } as unknown as ProtocolResultMessage
    });
    await expect(p1).resolves.toMatchObject({ ok: false });
  });
});

describe("PopupSessionClient.adoptOpener (appView child transport)", () => {
  // 关键点：`try/finally` 是**同步**的；`run(stub)` 返回 promise 时，
  // `finally` 会在 promise resolve 之前就把 `window` 还原，导致后续
  // `await` 期间 `getReusableOpener` 读不到 stub。改用显式 await + try/finally
  // 包住 await，让 `vi.unstubAllGlobals` 跑在最后一次 await 之后。
  async function withWindowStub<T>(run: (stub: { opener: Window | null }) => Promise<T> | T): Promise<T> {
    const stub: { opener: Window | null } = { opener: null };
    vi.stubGlobal("window", stub);
    try {
      return await run(stub);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("throws no_opener when window.opener is null", async () => {
    await withWindowStub(async () => {
      const client = new PopupSessionClient({
        targetOrigin: "https://keymaster.cc",
        popupWidth: 520,
        popupHeight: 760,
        readyTimeoutMs: 1000,
        resultTimeoutMs: 1000,
        env: createEnv().env
      });
      await expect(client.adoptOpener()).rejects.toMatchObject({ code: "no_opener" });
    });
  });

  it("adopts a live opener and transitions to connected without waiting for ready", async () => {
    /** 等待一次 microtask flush；PopupSessionClient 内部依赖 microtask 推进。 */
    async function flushMicrotasksLocal(times = 5): Promise<void> {
      for (let i = 0; i < times; i++) {
        await Promise.resolve();
      }
    }
    await withWindowStub(async (stub) => {
      const { env, listeners, getPopup, messages } = createEnv();
      // 把 createEnv 创建的 popup 直接当作 opener：adoptOpener 把它接管为
      // transport popup，runRequest 走它的 postMessage。
      stub.opener = getPopup() as unknown as Window;
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
      await client.adoptOpener();
      // 直接 connected；**不**等 ready（上游 appView 语义）。
      expect(client.getConnectionState()).toBe("connected");
      // 后续 runRequest 复用 opener transport；message 必须经 opener 转发。
      const p = client.runRequest(makeRequest());
      await flushMicrotasksLocal();
      // 验证 message 已 postMessage 出去（不再走 window.open）。
      expect(messages.length).toBe(1);
      // dispatcher 收到的 result 走 result 分发。
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
      await flushMicrotasksLocal();
      await expect(p).resolves.toMatchObject({ ok: true });
    });
  });

  it("closeSession does NOT call .close() on the adopted opener (would close Session Window)", async () => {
    // 关键回归：appView 启动失败时 demo 走 closeSession()；若不保护，会
    // 顺带把 Keymaster Session Window 本体关掉。修复后必须只清本端引用、
    // 不触发 opener.close()。
    await withWindowStub(async (stub) => {
      const { env, getPopup, messages } = createEnv();
      let closeCalled = 0;
      const fakeOpener = {
        closed: false,
        close: () => {
          closeCalled++;
        }
      } as unknown as Window;
      stub.opener = fakeOpener;
      const client = new PopupSessionClient({
        targetOrigin: "https://keymaster.cc",
        popupWidth: 520,
        popupHeight: 760,
        readyTimeoutMs: 1000,
        resultTimeoutMs: 1000,
        env
      });
      await client.adoptOpener();
      // 收养后 closeSession() **不**应触发 opener.close()。
      client.closeSession();
      expect(closeCalled).toBe(0);
      expect(client.getConnectionState()).toBe("disconnected");
      // 二次 adoptOpener() 仍可用（opener 句柄没被永久破坏）。
      const fakeOpener2 = {
        closed: false,
        close: () => {
          closeCalled++;
        }
      } as unknown as Window;
      stub.opener = fakeOpener2;
      await client.adoptOpener();
      // 走普通开新 popup 路径（先 ensureSession）会让 popup 变成自己开的
      // 窗口；这里 sanity-check getPopup 的存在即可，不展开跑流程。
      void getPopup();
      void messages;
    });
  });

  it("StrictMode-like double mount: re-adopting same opener is idempotent (no second transition)", async () => {
    // 模拟 React StrictMode dev 双挂载：两次连续 adoptOpener() 不应触发
    // 重复 listener 安装或状态来回切。App.tsx 的 ref 守卫会拦住外层 effect
    // 重入；这里验证最底层——即便外层守卫失效，session client 自己也不会
    // 在已 connected 且持有同一扇 opener 时瞎折腾。
    await withWindowStub(async (stub) => {
      const { env, getPopup } = createEnv();
      stub.opener = getPopup() as unknown as Window;
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
      // 第一次 adopt：opening → connected。
      await client.adoptOpener();
      expect(states).toEqual(["opening", "connected"]);
      // 第二次 adopt（StrictMode replay）：状态机应**不**再切；同一扇窗口、
      // 同一 origin 视作 no-op。
      await client.adoptOpener();
      expect(states).toEqual(["opening", "connected"]);
    });
  });
});

// sanity: keep a single browserEnv reference so the import isn't unused.
void browserEnv;
