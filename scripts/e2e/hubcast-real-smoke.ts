import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  HUBCAST_ENVELOPE_VERSION_V1,
  cborEncode,
  type BroadcastProviderSigner,
} from "@keymaster/contracts";
import {
  createHubCastProvider,
  DEFAULT_HUBCAST_URL,
} from "../../../keymaster.cc/packages/plugin-hubcast/src/hubcastProvider.ts";

const enabled = process.env.KEYMASTER_HUBCAST_SMOKE === "1";
const endpoint =
  process.env.KEYMASTER_HUBCAST_SMOKE_URL?.trim() || DEFAULT_HUBCAST_URL;

describe.skipIf(!enabled)(
  "HubCast real provider smoke (opt-in, public WSS)",
  () => {
    it("binds two signers, subscription set/list, publish/receive, clear and close", async () => {
      const sender = signer("01".padStart(64, "0"));
      const receiver = signer("02".padStart(64, "0"));
      const senderProvider = createHubCastProvider({
        url: endpoint,
        handshakeTimeoutMs: 15_000,
      });
      const receiverProvider = createHubCastProvider({
        url: endpoint,
        handshakeTimeoutMs: 15_000,
      });
      const channelId = `${sender.publicKeyHex}.demo-smoke.${Date.now()}`;
      const messageId = `demo-smoke-${Date.now()}`;
      let unsubscribe: (() => void) | undefined;
      try {
        const senderHandle = await senderProvider.bind({ signer: sender });
        const receiverHandle = await receiverProvider.bind({
          signer: receiver,
        });
        await receiverHandle.replaceSubscriptions({ channelIds: [channelId] });
        await expect(receiverHandle.listSubscriptions()).resolves.toEqual({
          channelIds: [channelId],
        });
        const received = new Promise<{
          envelopeBytes: Uint8Array;
          signatureBytes: Uint8Array;
        }>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("HubCast receive timeout")),
            20_000,
          );
          unsubscribe = receiverHandle.subscribeBroadcasts((event) => {
            clearTimeout(timer);
            resolve(event);
          });
        });
        const envelopeBytes = cborEncode([
          HUBCAST_ENVELOPE_VERSION_V1,
          hexToBytes(sender.publicKeyHex),
          channelId,
          "demo.smoke",
          messageId,
          Date.now(),
          new TextEncoder().encode("demo hubcast smoke"),
        ]);
        const signatureBytes = compactSign(sender.privateKeyHex, envelopeBytes);
        await senderHandle.publish({ envelopeBytes, signatureBytes });
        const event = await received;
        expect(Array.from(event.envelopeBytes)).toEqual(
          Array.from(envelopeBytes),
        );
        expect(Array.from(event.signatureBytes)).toEqual(
          Array.from(signatureBytes),
        );
        await receiverHandle.replaceSubscriptions({ channelIds: [] });
      } finally {
        unsubscribe?.();
        await senderProvider.shutdown();
        await receiverProvider.shutdown();
      }
    }, 60_000);
  },
);

function signer(
  privateKeyHex: string,
): BroadcastProviderSigner & { privateKeyHex: string } {
  const privateKey = hexToBytes(privateKeyHex);
  return {
    privateKeyHex,
    publicKeyHex: bytesToHex(secp256k1.getPublicKey(privateKey, true)),
    async signChallenge({ challenge }) {
      return bytesToHex(compactSign(privateKeyHex, challenge));
    },
  };
}

function compactSign(privateKeyHex: string, challenge: Uint8Array): Uint8Array {
  return secp256k1.sign(sha256(challenge), hexToBytes(privateKeyHex), {
    prehash: false,
    format: "compact",
  });
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
