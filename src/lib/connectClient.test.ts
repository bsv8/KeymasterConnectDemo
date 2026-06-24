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
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      request,
      env
    });

    popup.closed = true;
    const assertion = expect(promise).rejects.toMatchObject({ code: "popup_closed" });
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });
});
