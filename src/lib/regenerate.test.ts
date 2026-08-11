import { describe, expect, it } from "vitest";
import { regeneratePublisherKeyFlow } from "./regenerate";
describe("regenerate flow", () => {
  it("does not replace when logout fails", async () => {
    let replaced = false;
    await expect(
      regeneratePublisherKeyFlow({
        sessionId: "s",
        logout: async () => {
          throw new Error("x");
        },
        replaceKey: () => {
          replaced = true;
        },
        reset: () => {},
      }),
    ).rejects.toThrow();
    expect(replaced).toBe(false);
  });
  it("replaces after logout or no session", async () => {
    const calls: string[] = [];
    await regeneratePublisherKeyFlow({
      sessionId: "s",
      logout: async () => {
        calls.push("logout");
      },
      replaceKey: () => {
        calls.push("replace");
      },
      reset: () => {
        calls.push("reset");
      },
    });
    expect(calls).toEqual(["logout", "replace", "reset"]);
    calls.length = 0;
    await regeneratePublisherKeyFlow({
      sessionId: "",
      logout: async () => {
        calls.push("logout");
      },
      replaceKey: () => {
        calls.push("replace");
      },
      reset: () => {
        calls.push("reset");
      },
    });
    expect(calls).toEqual(["replace", "reset"]);
  });
  it("does not reset when replacement throws", async () => {
    let reset = false;
    await expect(
      regeneratePublisherKeyFlow({
        sessionId: "",
        logout: async () => {},
        replaceKey: () => {
          throw new Error("write");
        },
        reset: () => {
          reset = true;
        },
      }),
    ).rejects.toThrow();
    expect(reset).toBe(false);
  });
});
