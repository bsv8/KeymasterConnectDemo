import { describe, expect, it } from "vitest";
import {
  buildChannelPublishRequest,
  buildChannelSubscriptionSetRequest,
  buildMsFileBlockReadRequest,
  buildMsFileSeedReadRequest,
  buildMsFileStatRequest,
} from "./requestBuilders";

describe("channel request builders", () => {
  it("builds publish with JSON content and no connectSessionId", () => {
    const request = buildChannelPublishRequest({
      channel: "demo.channel",
      content: { type: "demo", n: 1, ok: true, nested: [null, "x"] },
    });
    expect(request.method).toBe("channel.publish");
    expect(request.params).toEqual({
      channel: "demo.channel",
      content: { type: "demo", n: 1, ok: true, nested: [null, "x"] },
    });
    // Channel 会话来自 Session Window transport context，params 不带 sessionId。
    expect("connectSessionId" in request.params).toBe(false);
  });

  it("rejects wildcard, over-long, control-char and reserved inbox channels", () => {
    const channels = [
      "",
      "*",
      "bad\u0001channel",
      "bad\u007fchannel",
      "bsv8.inbox.demo",
      "a".repeat(257),
    ];
    for (const channel of channels) {
      expect(() =>
        buildChannelPublishRequest({ channel, content: null }),
      ).toThrow();
    }
  });

  it("rejects non-JSON content, non-finite numbers, and too-deep nesting", () => {
    expect(() =>
      buildChannelPublishRequest({ channel: "demo.channel", content: undefined }),
    ).toThrow(/JSON/);
    expect(() =>
      buildChannelPublishRequest({
        channel: "demo.channel",
        content: Number.NaN,
      }),
    ).toThrow(/finite/);
    expect(() =>
      buildChannelPublishRequest({
        channel: "demo.channel",
        content: new Date(),
      }),
    ).toThrow(/JSON/);
    expect(() =>
      buildChannelPublishRequest({
        channel: "demo.channel",
        content: new Uint8Array([1, 2]),
      }),
    ).toThrow(/JSON/);
    let deep: unknown = "leaf";
    for (let i = 0; i < 18; i += 1) deep = [deep];
    expect(() =>
      buildChannelPublishRequest({ channel: "demo.channel", content: deep }),
    ).toThrow(/nested/);
  });

  it("builds subscription set without mutating input and rejects duplicates/overflow", () => {
    const channels = ["demo.one", "demo.two"];
    const request = buildChannelSubscriptionSetRequest({ channels });
    channels.push("mutated.after.build");
    expect(request.params.channels).toEqual(["demo.one", "demo.two"]);

    const empty = buildChannelSubscriptionSetRequest({ channels: [] });
    expect(empty.params.channels).toEqual([]);

    expect(() =>
      buildChannelSubscriptionSetRequest({ channels: ["a", "a"] }),
    ).toThrow(/duplicates/);
    expect(() =>
      buildChannelSubscriptionSetRequest({
        channels: Array.from({ length: 65 }, (_, index) => `channel.${index}`),
      }),
    ).toThrow(/64/);
  });
});

describe("msfile request builders", () => {
  const seedHashHex = "ab".repeat(32);
  const blockHashHex = "cd".repeat(32);
  const supplierPublicKeyHex = "02" + "11".repeat(32);

  it("builds stat / seed.read / block.read bound to the session, without price fields", () => {
    const stat = buildMsFileStatRequest({
      connectSessionId: "sess-1",
      seedHashHex,
    });
    expect(stat.method).toBe("msfile.stat");
    expect(stat.params).toEqual({
      connectSessionId: "sess-1",
      seedHashHex,
    });

    const seed = buildMsFileSeedReadRequest({
      connectSessionId: "sess-1",
      supplierPublicKeyHex,
      seedHashHex,
    });
    expect(seed.method).toBe("msfile.seed.read");
    expect(seed.params).toEqual({
      connectSessionId: "sess-1",
      supplierPublicKeyHex,
      seedHashHex,
    });
    // 金额策略在 Keymaster 内部，builder 不接受价格参数。
    expect("maxPriceSatoshis" in seed.params).toBe(false);

    const block = buildMsFileBlockReadRequest({
      connectSessionId: "sess-1",
      supplierPublicKeyHex,
      blockHashHex,
    });
    expect(block.method).toBe("msfile.block.read");
    expect(block.params).toEqual({
      connectSessionId: "sess-1",
      supplierPublicKeyHex,
      blockHashHex,
    });
  });

  it("rejects uppercase hash, malformed supplier key, and missing session", () => {
    expect(() =>
      buildMsFileStatRequest({
        connectSessionId: "sess-1",
        seedHashHex: "AB".repeat(32),
      }),
    ).toThrow(/lowercase/);
    expect(() =>
      buildMsFileSeedReadRequest({
        connectSessionId: "sess-1",
        supplierPublicKeyHex: "03" + "AB".repeat(32),
        seedHashHex,
      }),
    ).toThrow(/lowercase/);
    expect(() =>
      buildMsFileSeedReadRequest({
        connectSessionId: "sess-1",
        supplierPublicKeyHex: "01" + "11".repeat(32),
        seedHashHex,
      }),
    ).toThrow(/supplierPublicKeyHex/);
    expect(() =>
      buildMsFileBlockReadRequest({
        connectSessionId: "",
        supplierPublicKeyHex,
        blockHashHex,
      }),
    ).toThrow(/connectSessionId/);
  });
});
