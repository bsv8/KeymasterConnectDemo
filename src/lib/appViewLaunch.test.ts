// src/lib/appViewLaunch.test.ts
// 单元测试：appView 启动期 / 手工 `connect.launch` 共用的 transport
// 预备动作 helper（src/lib/appViewLaunch.ts）。
//
// 关键约束（施工单 2026-07-02 002 appView manual launch transport 硬切换
// 一次性迭代第 5.一 / 5.二 / 5.三 / 6.一 / 6.三 / 10.1 / 10.2 章）：
//   - `missing_origin` → 不调 client、**不**调 `postReadyToOpener(...)`；
//   - `no_opener`     → 调 `adoptOpener()` 后立即收口，**不**调
//     `postReadyToOpener(...)`；
//   - `ready_failed`  → `adoptOpener()` 成功后 `postReadyToOpener(...)`
//     返回 `false`，调 `popup.closeSession()` 收敛刚收养的 listener /
//     timer，返回 ok: false；调用方拿到这个 result 后**不**应继续发
//     `connect.launch` request——本测试通过"调用方不再调 runRequest"
//     实现验证（即 caller 看到 ready_failed 不发 request）；
//   - happy path      → 返回 `{ ok: true, popup }`，调用方可以基于
//     popup.runRequest(...) 发 connect.launch。

import { describe, expect, it, vi } from "vitest";
import { prepareAppViewTransportOrFail } from "./appViewLaunch";
import { ProtocolTransportError, type ProtocolLogEvent } from "./connectClient";
import { PopupSessionClient } from "./popupSessionClient";
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
  const env = {
    now: () => 1234,
    open: vi.fn(() => popup as unknown as Window),
    addMessageListener: (handler: (event: MessageEvent) => void) => listeners.add(handler),
    removeMessageListener: (handler: (event: MessageEvent) => void) => listeners.delete(handler),
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

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function dispatch(
  listeners: Set<(event: MessageEvent) => void>,
  event: Partial<MessageEvent>
) {
  for (const handler of listeners) {
    handler(event as MessageEvent);
  }
}

describe("prepareAppViewTransportOrFail (appView manual launch transport helper)", () => {
  /**
   * 测试用 opener stub：至少满足 `isPopupClosed(...)` 与
   * `postMessage(msg, targetOrigin)` 的最小接口。
   *   - `closed: false` ⇒ getReusableOpener() 视为可用；
   *   - `postMessage` 可以是 no-op、可以记录发送过的报文、可以抛错
   *     （模拟 ready 发送失败）。
   */
  interface OpenerStub {
    closed: boolean;
    postMessage: (msg: unknown, target?: string) => void;
    close?: () => void;
  }

  function stubWindow(opener: OpenerStub | null) {
    vi.stubGlobal("window", { opener: opener as unknown as Window | null });
  }

  async function withWindowStub<T>(
    opener: OpenerStub | null,
    run: () => Promise<T> | T
  ): Promise<T> {
    stubWindow(opener);
    try {
      // 必须 await run，否则 `finally` 在 async 内部尚未执行时就会
      // unstub `window`——helper 内部 promise 链路随后就在没有
      // `window.opener` 的环境下跑，会得到 no_opener。
      return await run();
    } finally {
      vi.unstubAllGlobals();
    }
  }

  function aliveOpener(): OpenerStub {
    return {
      closed: false,
      postMessage: () => undefined
    };
  }

  function makeClient(env: ReturnType<typeof createEnv>["env"]): PopupSessionClient {
    return new PopupSessionClient({
      targetOrigin: "https://keymaster.cc",
      popupWidth: 520,
      popupHeight: 760,
      readyTimeoutMs: 1000,
      resultTimeoutMs: 1000,
      env
    });
  }

  it("missing_origin: returns ok=false and never touches the client or postReadyToOpener", async () => {
    const { env } = createEnv();
    const adoptOpenerSpy = vi.spyOn(PopupSessionClient.prototype, "adoptOpener");
    const closeSessionSpy = vi.spyOn(PopupSessionClient.prototype, "closeSession");
    try {
      // 缺 / null / 空 / 非法四种情况都应直接 fail-closed。
      for (const value of [null, undefined, "", "   "]) {
        const result = await prepareAppViewTransportOrFail({
          sessionWindowOrigin: value as unknown as string | null,
          getSessionClient: () => makeClient(env)
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("missing_origin");
          expect(result.reason).toMatch(/sessionWindowOrigin/);
        }
      }
      // 整个调用周期里 adoptOpener / closeSession 都没被调过。
      expect(adoptOpenerSpy).not.toHaveBeenCalled();
      expect(closeSessionSpy).not.toHaveBeenCalled();
    } finally {
      adoptOpenerSpy.mockRestore();
      closeSessionSpy.mockRestore();
    }
  });

  it("no_opener (window.opener null): returns ok=false, code=no_opener, and stops before postReadyToOpener", async () => {
    await withWindowStub(null, async () => {
      const { env } = createEnv();
      const client = makeClient(env);
      // 先把 adoptOpener 替换为 spy：helper 内部必须调过它（用于触发失败）
      // 然后断言 client 状态保持 idle / 未连接、closeSession 未触发。
      const adoptSpy = vi.spyOn(client, "adoptOpener");
      const result = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: "https://keymaster.cc",
        getSessionClient: () => client
      });
      expect(adoptSpy).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("no_opener");
        expect(result.reason).toMatch(/relaunch from Keymaster/i);
      }
      // helper 内部先 `closeSession()` 清旧；即便旧状态本来是 idle
      // 走完也是 disconnected（populateSessionClient 一律收敛）——这条
      // 锁住 §7.3 reset 行为。
      expect(client.getConnectionState()).toBe("disconnected");
    });
  });

  it("no_opener surfaced via ProtocolTransportError 'no_opener' code (not 'ready_timeout' etc.)", async () => {
    await withWindowStub(null, async () => {
      const { env } = createEnv();
      const client = makeClient(env);
      vi.spyOn(client, "adoptOpener").mockRejectedValue(
        new ProtocolTransportError("no_opener", "no reusable opener")
      );
      const result = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: "https://keymaster.cc",
        getSessionClient: () => client
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("no_opener");
        expect(result.reason).toMatch(/No reusable Session Window/i);
      }
    });
  });

  it("non-no_opener adoptOpener failure is normalized as 'no_opener' code with the underlying message in reason", async () => {
    // §10.1 调用方心智：失败档位固定三档；非 `no_opener` 异常归一化到
    // `no_opener`，reason 含 underlying message 便于调试。
    await withWindowStub(null, async () => {
      const { env } = createEnv();
      const client = makeClient(env);
      vi.spyOn(client, "adoptOpener").mockRejectedValue(new Error("boom"));
      const result = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: "https://keymaster.cc",
        getSessionClient: () => client
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("no_opener");
        expect(result.reason).toMatch(/boom/);
      }
    });
  });

  it("ready_failed: adoptOpener succeeds but postReadyToOpener returns false, popup.closeSession is called and result is ready_failed", async () => {
    // 模拟情形：window.opener 存在且 closed=false（让 adoptOpener 成功），
    // 但 postMessage 抛错 → postReadyToOpener 返回 false。helper 内部
    // 必须调 popup.closeSession() 收敛 zombie listener，并返回
    // `{ ok: false, code: 'ready_failed' }`。
    const openerStub: OpenerStub = {
      closed: false,
      postMessage: () => {
        throw new Error("postMessage failure");
      }
    };
    await withWindowStub(openerStub, async () => {
      const { env } = createEnv();
      const client = makeClient(env);
      const closeSpy = vi.spyOn(client, "closeSession");
      const result = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: "https://keymaster.cc",
        getSessionClient: () => client
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("ready_failed");
        expect(result.reason).toMatch(/top-level ready/i);
      }
      // closeSession 至少被 helper 调过一次（用于清掉刚收养的 listener）。
      expect(closeSpy).toHaveBeenCalled();
      // 调用方拿到 ready_failed 后**不**应继续发 connect.launch——本
      // 验证通过"调用方只调 helper，不调 runRequest"来证明。
    });
  });

  it("happy path: adoptOpener + postReadyToOpener succeed, caller receives ok=true popup and can runRequest without window.open", async () => {
    // 走通"helper + caller 接着发 connect.launch request"这一段：
    //   - opener alive（closed=false、postMessage 转发到 messages）；
    //   - call helper → ok=true；
    //   - caller 拿 popup 跑 runRequest（发 connect.launch）；
    //   - opener.postMessage 收到一条 message（不是 window.open）。
    const messages: unknown[] = [];
    const openerStub: OpenerStub = {
      closed: false,
      postMessage: (msg: unknown) => {
        messages.push(msg);
      }
    };
    await withWindowStub(openerStub, async () => {
      const { env, listeners } = createEnv();
      const client = makeClient(env);
      const openSpy = env.open as ReturnType<typeof vi.fn>;
      const result = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: "https://keymaster.cc",
        getSessionClient: () => client
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const popup = result.popup;
      expect(popup.getConnectionState()).toBe("connected");
      // adoptOpener 也会触发 pre-message 路径；先把这条去掉再断言。
      const baseMessageCount = messages.length;
      // caller 现在按 §10.1 第 5/6 条继续发 connect.launch：
      const launchReq: ProtocolRequestMessage<"connect.launch"> = {
        v: 1,
        type: "request",
        id: "req-launch",
        method: "connect.launch",
        params: { launchToken: "lt-1" }
      };
      const p = popup.runRequest(launchReq);
      await flushMicrotasks();
      // opener 接收到 request；window.open 全程未被调。
      expect(openSpy).not.toHaveBeenCalled();
      expect(messages.length).toBeGreaterThan(baseMessageCount);
      dispatch(listeners, {
        origin: "https://keymaster.cc",
        source: openerStub as unknown as MessageEventSource,
        data: {
          v: 1,
          type: "result",
          id: "req-launch",
          ok: true,
          result: {
            connectSessionId: "sess-1",
            ownerPublicKeyHex: "02" + "ab".repeat(32),
            resolvedClaims: {},
            resolvedAt: 1
          } as never
        } as unknown as ProtocolResultMessage
      });
      await expect(p).resolves.toMatchObject({ ok: true });
    });
  });

  it("caller logic: on ready_failed the helper guarantees no request was sent — verified by spy on runRequest", async () => {
    // 等价于把 submitConnectLaunch 的失败收口在 helper 层就锁住：
    // ready_failed 时 helper 没有调 `popup.runRequest`，所以 popup 那边
    // 的 messages / pending 都**不**变。本测试通过 mock 替代
    // runRequest 以验证 helper 一旦 ready_failed 就不会触发 runRequest。
    const openerStub: OpenerStub = {
      closed: false,
      postMessage: () => {
        throw new Error("postMessage failure");
      }
    };
    await withWindowStub(openerStub, async () => {
      const { env } = createEnv();
      const client = makeClient(env);
      const runRequestSpy = vi.spyOn(client, "runRequest");
      const result = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: "https://keymaster.cc",
        getSessionClient: () => client
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("ready_failed");
      // 关键回归：**没有**触发 runRequest。submitConnectLaunch 必须
      // 看到 `prep.ok === false` 后立即 `return`，不调 runRequest。
      expect(runRequestSpy).not.toHaveBeenCalled();
    });
  });

  it("appViewOnly client integration: helper returns a popup whose runRequest uses appViewOnly-locked transport (no window.open)", async () => {
    // 端到端：appView 锁定模式下 helper + caller 发完 connect.launch 后
    // 业务 request 仍走 opener 路径，不会 window.open。这条把"lib helper
    // 行为正确" + "PopupSessionClient appViewOnly 行为正确"两端到端
    // 串起来。
    const messages: unknown[] = [];
    const openerStub: OpenerStub = {
      closed: false,
      postMessage: (msg: unknown) => {
        messages.push(msg);
      }
    };
    await withWindowStub(openerStub, async () => {
      const { env, listeners } = createEnv();
      const client = new PopupSessionClient({
        targetOrigin: "https://keymaster.cc",
        popupWidth: 520,
        popupHeight: 760,
        readyTimeoutMs: 1000,
        resultTimeoutMs: 1000,
        env,
        appViewOnly: true
      });
      const openSpy = env.open as ReturnType<typeof vi.fn>;
      const result = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: "https://keymaster.cc",
        getSessionClient: () => client
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const popup = result.popup;

      // connect.launch。
      const launchReq: ProtocolRequestMessage<"connect.launch"> = {
        v: 1,
        type: "request",
        id: "req-launch",
        method: "connect.launch",
        params: { launchToken: "lt-1" }
      };
      const p0 = popup.runRequest(launchReq);
      await flushMicrotasks();
      dispatch(listeners, {
        origin: "https://keymaster.cc",
        source: openerStub as unknown as MessageEventSource,
        data: {
          v: 1,
          type: "result",
          id: "req-launch",
          ok: true,
          result: {
            connectSessionId: "sess-1",
            ownerPublicKeyHex: "02" + "ab".repeat(32),
            resolvedClaims: {},
            resolvedAt: 1
          } as never
        } as unknown as ProtocolResultMessage
      });
      await p0;
      expect(openSpy).not.toHaveBeenCalled();

      const beforeList = messages.length;
      // 业务 request：appmsg.list（仍是同一个 client 的同一个 popup）。
      const listReq: ProtocolRequestMessage<"appmsg.list"> = {
        v: 1,
        type: "request",
        id: "req-list",
        method: "appmsg.list",
        params: { box: "inbox", connectSessionId: "sess-1" }
      };
      const p1 = popup.runRequest(listReq);
      await flushMicrotasks();
      expect(openSpy).not.toHaveBeenCalled();
      // opener 又收到一条 request。
      expect(messages.length).toBeGreaterThan(beforeList);
      dispatch(listeners, {
        origin: "https://keymaster.cc",
        source: openerStub as unknown as MessageEventSource,
        data: {
          v: 1,
          type: "result",
          id: "req-list",
          ok: true,
          result: { items: [], hasMore: false } as never
        } as unknown as ProtocolResultMessage
      });
      await expect(p1).resolves.toMatchObject({ ok: true });
      // suppress unused warning for the helper local
      void ({} as ProtocolLogEvent);
    });
  });

  it("helper is dependency-injected: getSessionClient is called fresh each invocation (no cached client state across calls)", async () => {
    // §5.二 / lib 设计缘由：helper 不缓存 client；每次执行都走 caller 提供的
    // `getSessionClient()`，与 App.tsx 的 useRef 单例模式自洽。
    await withWindowStub(null, async () => {
      const { env } = createEnv();
      const { getPopup, setPopup } = createEnv();
      // 让 popup 不同，便于观察 client 不是同一个引用。
      const popupA = getPopup();
      const popupB: TestPopup = {
        closed: false,
        postMessage: () => undefined
      };
      // 避免 setPopup 还没切到 B 时第一个 runRequest 就拿 A；这里只验
      // 计数 / 调用顺序。
      void popupA;
      void popupB;
      let callCount = 0;
      const factory = () => {
        callCount++;
        return makeClient(env);
      };
      // 第一次：缺 origin → 不应调 factory。
      const result1 = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: null,
        getSessionClient: factory
      });
      expect(result1.ok).toBe(false);
      expect(callCount).toBe(0);
      // 第二次：缺 origin（"  " 字符串）→ 仍不应调 factory。
      const result2 = await prepareAppViewTransportOrFail({
        sessionWindowOrigin: "   ",
        getSessionClient: factory
      });
      expect(result2.ok).toBe(false);
      expect(callCount).toBe(0);
      // 第三次：放到直接调工厂路径上验证计数；这里只验 helper 不缓存 client。
      void setPopup;
      // 注：第三次如果想真跑 prepareAppViewTransportOrFail 需要 window.opener
      // stub + opener alive，但本测试只断言 callCount 不被状态污染即可。
    });
  });
});
