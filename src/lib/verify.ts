import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { BinaryField, IdentityGetResult, IntentSignResult } from "./protocol";
import { binaryFieldToBytes } from "./binary";
import { decodeCborBytes, prettyCborValue } from "./cbor";
import { bytesToHex } from "./encoding";

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

export function verifyCompactSecp256k1(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return secp256k1.verify(signature, message, publicKey, {
      prehash: false,
      format: "compact"
    });
  } catch {
    return false;
  }
}

export interface IdentityInspection {
  ok: boolean;
  reason?: string;
  decodedEnvelope?: unknown;
  decodedEnvelopePretty?: string;
  signatureOk?: boolean;
  envelopeBytesHex?: string;
  signatureHex?: string;
  publicKeyHex?: string;
  resolvedClaims?: Record<string, unknown>;
  claimsProjection?: unknown;
}

export function inspectIdentityResult(result: IdentityGetResult): IdentityInspection {
  const envelopeBytes = binaryFieldToBytes(result.identityEnvelope);
  const signatureBytes = binaryFieldToBytes(result.signature);
  const publicKeyBytes = binaryFieldToBytes(result.subject.publicKey);
  const decodedEnvelope = decodeCborBytes(envelopeBytes);
  if (!Array.isArray(decodedEnvelope) || decodedEnvelope.length !== 8) {
    return {
      ok: false,
      reason: "Identity envelope is not the expected 8-item CBOR array",
      decodedEnvelope,
      decodedEnvelopePretty: prettyCborValue(decodedEnvelope),
      envelopeBytesHex: bytesToHex(envelopeBytes),
      signatureHex: bytesToHex(signatureBytes),
      publicKeyHex: bytesToHex(publicKeyBytes),
      resolvedClaims: result.resolvedClaims
    };
  }

  const signatureOk = verifyCompactSecp256k1(signatureBytes, envelopeBytes, publicKeyBytes);
  return {
    ok: signatureOk,
    decodedEnvelope,
    decodedEnvelopePretty: prettyCborValue(decodedEnvelope),
    signatureOk,
    envelopeBytesHex: bytesToHex(envelopeBytes),
    signatureHex: bytesToHex(signatureBytes),
    publicKeyHex: bytesToHex(publicKeyBytes),
    resolvedClaims: result.resolvedClaims,
    claimsProjection: decodedEnvelope[7]
  };
}

export interface IntentInspection {
  ok: boolean;
  reason?: string;
  decodedEnvelope?: unknown;
  decodedEnvelopePretty?: string;
  signatureOk?: boolean;
  contentSha256Ok?: boolean;
  computedContentSha256Hex?: string;
  envelopeContentSha256Hex?: string;
  envelopeBytesHex?: string;
  signatureHex?: string;
  publicKeyHex?: string;
}

export function inspectIntentResult(result: IntentSignResult, contentBytes: Uint8Array): IntentInspection {
  const envelopeBytes = binaryFieldToBytes(result.signedEnvelope);
  const signatureBytes = binaryFieldToBytes(result.signature);
  const decodedEnvelope = decodeCborBytes(envelopeBytes);
  if (!Array.isArray(decodedEnvelope) || decodedEnvelope.length !== 9) {
    return {
      ok: false,
      reason: "Signed envelope is not the expected 9-item CBOR array",
      decodedEnvelope,
      decodedEnvelopePretty: prettyCborValue(decodedEnvelope),
      envelopeBytesHex: bytesToHex(envelopeBytes),
      signatureHex: bytesToHex(signatureBytes),
      publicKeyHex: "n/a"
    };
  }

  const contentSha256 = sha256Bytes(contentBytes);
  const envelopeContentSha256 = decodedEnvelope[7] instanceof Uint8Array ? decodedEnvelope[7] : null;
  const envelopePublicKey = decodedEnvelope[8] instanceof Uint8Array ? decodedEnvelope[8] : null;
  const contentSha256Ok =
    envelopeContentSha256 instanceof Uint8Array &&
    bytesToHex(envelopeContentSha256) === bytesToHex(contentSha256);
  const signatureOk =
    envelopePublicKey instanceof Uint8Array &&
    verifyCompactSecp256k1(signatureBytes, envelopeBytes, envelopePublicKey);

  return {
    ok: signatureOk && contentSha256Ok,
    decodedEnvelope,
    decodedEnvelopePretty: prettyCborValue(decodedEnvelope),
    signatureOk,
    contentSha256Ok,
    computedContentSha256Hex: bytesToHex(contentSha256),
    envelopeContentSha256Hex: envelopeContentSha256 ? bytesToHex(envelopeContentSha256) : undefined,
    envelopeBytesHex: bytesToHex(envelopeBytes),
    signatureHex: bytesToHex(signatureBytes),
    publicKeyHex: envelopePublicKey ? bytesToHex(envelopePublicKey) : "n/a"
  };
}
