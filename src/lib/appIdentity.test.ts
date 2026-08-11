import { describe, expect, it } from "vitest";
import {
  APP_IDENTITY_STORAGE_KEY,
  buildAppIdentityProof,
  verifyAppIdentityProof,
  loadOrCreatePublisherPrivateKey,
  loadOrCreatePublisherIdentity,
  generateAndStorePublisherPrivateKey,
} from "./appIdentity";
import { identityDigestHex } from "./appIdentity";

describe("app identity", () => {
  it("matches the golden fixture digest", () => {
    expect(
      identityDigestHex(
        "0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0",
        { id: "fixture", name: "Fixture" },
      ),
    ).toBe("383e5c563e8df27758a38c6956c7ff651259682e127fb1b18093834bb34ffd0c");
  });
  it("signs and verifies canonical proof", () => {
    const key = new Uint8Array(32);
    key[31] = 7;
    const { proof, snapshot } = buildAppIdentityProof(key);
    expect(verifyAppIdentityProof(proof)).toEqual(snapshot);
    const tampered = {
      ...proof,
      signature: proof.signature.replace(/^../, "00"),
    };
    expect(verifyAppIdentityProof(tampered)).toBeNull();
    expect(
      verifyAppIdentityProof({
        ...proof,
        publisherPublicKey: proof.publisherPublicKey.toUpperCase(),
      }),
    ).toBeNull();
    expect(
      verifyAppIdentityProof({
        ...proof,
        signature: proof.signature.toUpperCase(),
      }),
    ).toBeNull();
    expect(
      verifyAppIdentityProof({
        ...proof,
        app: { ...proof.app, name: "tampered" },
      }),
    ).toBeNull();
    expect(
      verifyAppIdentityProof({
        ...proof,
        app: { ...proof.app, extra: true },
      } as unknown as typeof proof),
    ).toBeNull();
  });
  it("persists and recovers key", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
    } as unknown as Storage;
    const first = loadOrCreatePublisherPrivateKey(storage);
    expect(loadOrCreatePublisherPrivateKey(storage)).toEqual(first);
    data.set("keymaster-connect-demo.publisher-private-key.v1", "bad");
    expect(loadOrCreatePublisherPrivateKey(storage)).not.toEqual(first);
  });
  it("keeps startup identity stable and replaces only a damaged key", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
    } as unknown as Storage;
    const first = loadOrCreatePublisherIdentity(storage);
    const second = loadOrCreatePublisherIdentity(storage);
    expect(second).toEqual(first);
    expect(second.snapshot.publisherPublicKeyHex).toBe(
      first.snapshot.publisherPublicKeyHex,
    );
    expect(second.snapshot.identityDigestHex).toBe(
      first.snapshot.identityDigestHex,
    );

    data.set(APP_IDENTITY_STORAGE_KEY, "damaged");
    const repaired = loadOrCreatePublisherIdentity(storage);
    expect(repaired.snapshot.publisherPublicKeyHex).not.toBe(
      first.snapshot.publisherPublicKeyHex,
    );
    expect(repaired.snapshot.identityDigestHex).not.toBe(
      first.snapshot.identityDigestHex,
    );

    const readOnly = {
      getItem: () => null,
      setItem: () => {
        throw new Error("readonly");
      },
    } as unknown as Storage;
    expect(() => loadOrCreatePublisherIdentity(readOnly)).toThrow(/persist/);
  });
  it("generates and overwrites stored key", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
    } as unknown as Storage;
    const a = generateAndStorePublisherPrivateKey(storage);
    const b = generateAndStorePublisherPrivateKey(storage);
    expect(a).not.toEqual(b);
    expect(
      data.get("keymaster-connect-demo.publisher-private-key.v1"),
    ).toBeTruthy();
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("readonly");
      },
    } as unknown as Storage;
    expect(() => generateAndStorePublisherPrivateKey(failing)).toThrow();
  });
});
