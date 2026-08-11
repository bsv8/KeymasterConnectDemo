import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./encoding";
import type { AppIdentityProofV1, AppIdentitySnapshot } from "./protocol";

export const APP_IDENTITY_DOMAIN_V1 = "keymaster-app-identity:v1";
export const APP_IDENTITY_STORAGE_KEY =
  "keymaster-connect-demo.publisher-private-key.v1";
export const APP_IDENTITY_APP = {
  id: "keymaster-connect-demo",
  name: "Keymaster Connect Demo",
} as const;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`)
    .join(",")}}`;
}

function validPrivateKey(bytes: Uint8Array): boolean {
  try {
    secp256k1.getPublicKey(bytes, true);
    return bytes.length === 32;
  } catch {
    return false;
  }
}
export function loadOrCreatePublisherPrivateKey(storage?: Storage): Uint8Array {
  if (!storage) {
    if (typeof localStorage === "undefined")
      throw new Error("Storage is unavailable");
    storage = localStorage;
  }
  const raw = storage.getItem(APP_IDENTITY_STORAGE_KEY);
  if (raw) {
    try {
      const b = hexToBytes(raw);
      if (validPrivateKey(b)) return b;
    } catch {}
  }
  const key = secp256k1.utils.randomSecretKey();
  try {
    storage.setItem(APP_IDENTITY_STORAGE_KEY, bytesToHex(key));
  } catch {
    throw new Error("Unable to persist publisher key");
  }
  return key;
}
export function generateAndStorePublisherPrivateKey(
  storage?: Storage,
): Uint8Array {
  if (!storage) {
    if (typeof localStorage === "undefined")
      throw new Error("Storage is unavailable");
    storage = localStorage;
  }
  const key = secp256k1.utils.randomSecretKey();
  try {
    storage.setItem(APP_IDENTITY_STORAGE_KEY, bytesToHex(key));
  } catch {
    throw new Error("Unable to persist publisher key");
  }
  return key;
}

/** Load the persisted publisher key, creating one only when absent or invalid. */
export function loadOrCreatePublisherIdentity(storage?: Storage): {
  proof: AppIdentityProofV1;
  snapshot: AppIdentitySnapshot;
} {
  return buildAppIdentityProof(loadOrCreatePublisherPrivateKey(storage));
}

export function canonicalIdentityPayload(
  publicKeyHex: string,
  app: { id: string; name: string } = APP_IDENTITY_APP,
): string {
  return canonicalize({ version: 1, publisherPublicKey: publicKeyHex, app });
}
export function identityDigestHex(
  publicKeyHex: string,
  app: { id: string; name: string } = APP_IDENTITY_APP,
): string {
  const payload = canonicalIdentityPayload(publicKeyHex, app);
  const bytes = new TextEncoder().encode(
    APP_IDENTITY_DOMAIN_V1 + "\0" + payload,
  );
  return bytesToHex(sha256(bytes));
}
export function buildAppIdentityProof(privateKey: Uint8Array): {
  proof: AppIdentityProofV1;
  snapshot: AppIdentitySnapshot;
} {
  const publisherPublicKey = bytesToHex(
    secp256k1.getPublicKey(privateKey, true),
  );
  const payload = canonicalIdentityPayload(publisherPublicKey);
  const digest = sha256(
    new TextEncoder().encode(APP_IDENTITY_DOMAIN_V1 + "\0" + payload),
  );
  const signature = secp256k1.sign(digest, privateKey, {
    prehash: false,
    format: "compact",
  });
  const signatureHex = bytesToHex(signature);
  return {
    proof: {
      version: 1,
      publisherPublicKey,
      app: APP_IDENTITY_APP,
      signature: signatureHex,
    },
    snapshot: {
      version: 1,
      publisherPublicKeyHex: publisherPublicKey,
      appId: APP_IDENTITY_APP.id,
      appName: APP_IDENTITY_APP.name,
      identityDigestHex: bytesToHex(digest),
    },
  };
}
export function verifyAppIdentityProof(
  proof: AppIdentityProofV1,
): AppIdentitySnapshot | null {
  try {
    if (
      proof.version !== 1 ||
      !/^[0-9a-f]{66}$/.test(proof.publisherPublicKey) ||
      !/^[0-9a-f]{128}$/.test(proof.signature) ||
      !proof.app ||
      proof.app.id !== APP_IDENTITY_APP.id ||
      proof.app.name !== APP_IDENTITY_APP.name ||
      Object.keys(proof.app).sort().join(",") !== "id,name" ||
      Object.keys(proof).sort().join(",") !==
        "app,publisherPublicKey,signature,version"
    )
      return null;
    const payload = canonicalIdentityPayload(
      proof.publisherPublicKey,
      proof.app,
    );
    const digest = sha256(
      new TextEncoder().encode(APP_IDENTITY_DOMAIN_V1 + "\0" + payload),
    );
    const ok = secp256k1.verify(
      hexToBytes(proof.signature),
      digest,
      hexToBytes(proof.publisherPublicKey),
      { prehash: false, format: "compact" },
    );
    if (!ok) return null;
    return {
      version: 1,
      publisherPublicKeyHex: proof.publisherPublicKey,
      appId: proof.app.id,
      appName: proof.app.name,
      identityDigestHex: bytesToHex(digest),
    };
  } catch {
    return null;
  }
}
