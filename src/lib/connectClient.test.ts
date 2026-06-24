import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPopupProtocolRequest, type ProtocolClientEnv, type ProtocolLogEvent } from "./connectClient";
import type { ProtocolRequestMessage, ProtocolResultMessage } from "./protocol";

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

function createEnv() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const messages: unknown[] = [];
  type TestPopup = { closed: boolean; postMessage: (msg: unknown) => void };
  const popup: TestPopup = {
    closed: false,
    postMessage: (msg: unknown) => {
      messages.push(msg);
    }
  };

  const env: ProtocolClientEnv & {
    popup: typeof popup;
    listeners: Set<(event: MessageEvent) => void>;
    messages: unknown[];
    timers: { timeout: ReturnType<typeof setTimeout>[]; interval: ReturnType<typeof setInterval>[] };
  } = {
    now: () => 1234,
    open: vi.fn(() => popup as unknown as Window),
    addMessageListener: (handler) => listeners.add(handler),
    removeMessageListener: (handler) => listeners.delete(handler),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    popup,
    listeners,
    messages,
    timers: { timeout: [], interval: [] }
  };

  return { env, popup, listeners, messages };
}

function dispatch(listeners: Set<(event: MessageEvent) => void>, event: Partial<MessageEvent>) {
  for (const handler of listeners) {
    handler(event as MessageEvent);
  }
}

describe("runPopupProtocolRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("waits for ready before sending request", async () => {
    const { env, listeners, messages } = createEnv();
    const logs: ProtocolLogEvent[] = [];
    const request = makeRequest();
    const promise = runPopupProtocolRequest({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      request,
      onLog: (event) => logs.push(event),
      env
    });

    expect(messages).toHaveLength(0);
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: env.popup as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await Promise.resolve();

    expect(messages).toHaveLength(1);
    expect((messages[0] as ProtocolRequestMessage).id).toBe("req-1");

    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: env.popup as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { hello: "world" } as never
      } as ProtocolResultMessage
    });

    await expect(promise).resolves.toMatchObject({ ok: true });
    expect(logs.map((entry) => entry.stage)).toContain("ready_received");
    expect(logs.map((entry) => entry.stage)).toContain("request_sent");
  });

  it("times out waiting for ready", async () => {
    const { env } = createEnv();
    const request = makeRequest();
    const promise = runPopupProtocolRequest({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      request,
      env
    });

    const assertion = expect(promise).rejects.toMatchObject({ code: "ready_timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("rejects when popup is blocked", async () => {
    const { env } = createEnv();
    env.open = vi.fn(() => null);
    await expect(
      runPopupProtocolRequest({
        targetOrigin: "https://keymaster.cc",
        popupWidth: 520,
        popupHeight: 760,
        readyTimeoutMs: 1000,
        resultTimeoutMs: 1000,
        request: makeRequest(),
        env
      })
    ).rejects.toMatchObject({ code: "popup_blocked" });
  });

  it("rejects when popup closes before completion", async () => {
    const { env, popup } = createEnv();
    const request = makeRequest();
    const promise = runPopupProtocolRequest({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 5000,
      resultTimeoutMs: 5000,
      // V1 关闭轮询默认 500ms；显式传入让测试与轮询节奏一致。
      closePollMs: 500,
      request,
      env
    });

    popup.closed = true;
    const assertion = expect(promise).rejects.toMatchObject({ code: "popup_closed" });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("emits opening -> connected on ready then disconnected on closing", async () => {
    const { env, listeners, messages } = createEnv();
    const states: string[] = [];
    const request = makeRequest();
    const promise = runPopupProtocolRequest({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 5000,
      resultTimeoutMs: 5000,
      closePollMs: 500,
      request,
      env,
      onConnectionStateChange: (state) => states.push(state)
    });

    // 初始：opening
    expect(states).toEqual(["opening"]);

    // 收 ready → connected，且发出 request
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: env.popup as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await Promise.resolve();
    expect(states).toEqual(["opening", "connected"]);
    expect(messages).toHaveLength(1);

    // 收 closing → disconnected
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: env.popup as unknown as MessageEventSource,
      data: { v: 1, type: "closing" }
    });
    expect(states).toEqual(["opening", "connected", "disconnected"]);

    // 再发一个 closing：幂等，不应重复推进
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: env.popup as unknown as MessageEventSource,
      data: { v: 1, type: "closing" }
    });
    expect(states).toEqual(["opening", "connected", "disconnected"]);

    // 收 result 仍能正常 resolve（result 不替代断开，但业务还是要收）
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: env.popup as unknown as MessageEventSource,
      data: {
        v: 1,
        type: "result",
        id: "req-1",
        ok: true,
        result: { hello: "world" } as never
      } as ProtocolResultMessage
    });

    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("transitions to disconnected when popup closes without closing message", async () => {
    const { env, popup, listeners } = createEnv();
    const states: string[] = [];
    const request = makeRequest();
    const promise = runPopupProtocolRequest({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 5000,
      resultTimeoutMs: 5000,
      closePollMs: 500,
      request,
      env,
      onConnectionStateChange: (state) => states.push(state)
    });

    // 收到 ready
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: env.popup as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await Promise.resolve();
    expect(states).toEqual(["opening", "connected"]);

    // 用户手工关窗：未发 closing，但 popup.closed === true。
    // 注意：先挂上 reject 断言，再推进 timer，避免 timer 同步触发 reject 时
    // 还没挂 handler 造成 unhandled rejection。
    popup.closed = true;
    const assertion = expect(promise).rejects.toMatchObject({ code: "popup_closed" });
    await vi.advanceTimersByTimeAsync(500);

    expect(states).toEqual(["opening", "connected", "disconnected"]);
    await assertion;
  });

  it("ignores closing messages from non-popup source", async () => {
    const { env, listeners } = createEnv();
    const states: string[] = [];
    const request = makeRequest();
    runPopupProtocolRequest({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 5000,
      resultTimeoutMs: 5000,
      closePollMs: 500,
      request,
      env,
      onConnectionStateChange: (state) => states.push(state)
    });

    // ready
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: env.popup as unknown as MessageEventSource,
      data: { v: 1, type: "ready" }
    });
    await Promise.resolve();

    // 第三方伪造的 closing，source 不是 popup，被忽略。
    dispatch(listeners, {
      origin: "https://keymaster.cc",
      source: { name: "not-the-popup" } as unknown as MessageEventSource,
      data: { v: 1, type: "closing" }
    });
    expect(states).toEqual(["opening", "connected"]);
  });
});
