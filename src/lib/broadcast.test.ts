import { describe, expect, it } from "vitest";
import {
  buildBroadcastPublishRequest,
  buildBroadcastSubscriptionListRequest,
  buildBroadcastSubscriptionSetRequest,
} from "./requestBuilders";

describe("broadcast request builders", () => {
  it("builds publish with empty or non-empty base64 body", () => {
    const empty = buildBroadcastPublishRequest({
      channelId: "demo.channel",
      protocolId: "demo.v1",
      clientMessageId: "msg-1",
      createdAtMs: 1700000000000,
      bodyBase64: "",
      connectSessionId: "sess-1",
    });
    expect(empty.params).toMatchObject({
      channelId: "demo.channel",
      protocolId: "demo.v1",
      bodyBase64: "",
      createdAtMs: 1700000000000,
      connectSessionId: "sess-1",
    });

    const encoded = buildBroadcastPublishRequest({
      channelId: "demo.channel",
      protocolId: "demo.v1",
      clientMessageId: "msg-2",
      bodyBase64: "aGVsbG8=",
      connectSessionId: "sess-1",
    });
    expect(encoded.params.bodyBase64).toBe("aGVsbG8=");
    expect(encoded.params.createdAtMs).toBeGreaterThan(0);
  });

  it("builds subscription set without mutating input, including empty replacement", () => {
    const channelIds = ["demo.one", "demo.two"];
    const request = buildBroadcastSubscriptionSetRequest({
      channelIds,
      connectSessionId: "sess-1",
    });
    channelIds.push("mutated.after.build");
    expect(request.params.channelIds).toEqual(["demo.one", "demo.two"]);

    const empty = buildBroadcastSubscriptionSetRequest({
      channelIds: [],
      connectSessionId: "sess-1",
    });
    expect(empty.params.channelIds).toEqual([]);
  });

  it("builds subscription list with the session id", () => {
    const request = buildBroadcastSubscriptionListRequest({
      connectSessionId: "sess-1",
    });
    expect(request.params).toEqual({ connectSessionId: "sess-1" });
  });

  it("rejects invalid publish body, createdAt, and channel fields", () => {
    const base = {
      channelId: "demo.channel",
      protocolId: "demo.v1",
      clientMessageId: "msg-1",
      createdAtMs: 1700000000000,
      bodyBase64: "aGVsbG8=",
      connectSessionId: "sess-1",
    };
    for (const bodyBase64 of ["not base64", "A", "!!!!"]) {
      expect(() =>
        buildBroadcastPublishRequest({ ...base, bodyBase64 }),
      ).toThrow(/base64/);
    }
    for (const createdAtMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        buildBroadcastPublishRequest({ ...base, createdAtMs }),
      ).toThrow(/createdAtMs/);
    }
    for (const channelId of ["", "   "]) {
      expect(() =>
        buildBroadcastPublishRequest({ ...base, channelId }),
      ).toThrow(/channelId/);
    }
  });

  it("rejects empty subscription channel entries", () => {
    for (const channelIds of [[""], ["demo.one", ""], ["demo.one", 1]]) {
      expect(() =>
        buildBroadcastSubscriptionSetRequest({
          channelIds: channelIds as string[],
          connectSessionId: "sess-1",
        }),
      ).toThrow(/channelIds/);
    }
  });
});
