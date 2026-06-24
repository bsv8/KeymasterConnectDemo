import { secp256k1 } from "@noble/curves/secp256k1.js";
import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import { bytesToHex, textToBytes } from "./encoding";
import { makeBinaryField } from "./binary";
import { inspectIdentityResult, inspectIntentResult, sha256Bytes, verifyCompactSecp256k1 } from "./verify";
import type { IdentityGetResult, IntentSignResult } from "./protocol";

const privateKey = new Uint8Array(32);
privateKey[31] = 1;
const publicKey = secp256k1.getPublicKey(privateKey, true);

describe("verify", () => {
  it("verifies compact secp256k1 signatures", () => {
    const message = textToBytes("message to sign");
    const signature = secp256k1.sign(message, privateKey, { prehash: false, format: "compact" });
    expect(verifyCompactSecp256k1(signature, message, publicKey)).toBe(true);
    expect(verifyCompactSecp256k1(signature, textToBytes("other"), publicKey)).toBe(false);
  });

  it("verifies identity envelope bytes and fails after tampering", () => {
    const identityEnvelopeBytes = encode([
      1,
      "req-1",
      "https://demo.example",
      1,
      2,
      "hello",
      publicKey,
      [["key.label", "Main"]]
    ]);
    const signature = secp256k1.sign(identityEnvelopeBytes, privateKey, { prehash: false, format: "compact" });
    const result: IdentityGetResult = {
      identityEnvelope: makeBinaryField(identityEnvelopeBytes),
      signature: makeBinaryField(signature),
      subject: { publicKey: makeBinaryField(publicKey) },
      resolvedClaims: { "key.label": "Main" }
    };
    const inspection = inspectIdentityResult(result);
    expect(inspection.ok).toBe(true);

    const tamperedSignature = new Uint8Array(signature);
    tamperedSignature[0] ^= 0x01;
    const tampered = {
      ...result,
      signature: makeBinaryField(tamperedSignature)
    };
    expect(inspectIdentityResult(tampered).ok).toBe(false);
  });

  it("checks contentSha256 and signature for intent envelopes", () => {
    const content = textToBytes("payload");
    const contentSha256 = sha256Bytes(content);
    const envelopeBytes = encode([1, "req-2", "https://demo.example", 1, 2, "hello", "demo.content.v1", contentSha256, publicKey]);
    const signature = secp256k1.sign(envelopeBytes, privateKey, { prehash: false, format: "compact" });
    const result: IntentSignResult = {
      signedEnvelope: makeBinaryField(envelopeBytes),
      signature: makeBinaryField(signature)
    };
    const inspection = inspectIntentResult(result, content);
    expect(inspection.signatureOk).toBe(true);
    expect(inspection.contentSha256Ok).toBe(true);
    expect(bytesToHex(contentSha256)).toHaveLength(64);
  });
});
