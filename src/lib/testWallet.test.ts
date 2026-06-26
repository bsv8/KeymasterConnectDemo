import { describe, expect, it } from "vitest";
import {
  deriveTestWallet,
  dsha256,
  generateTestWallet,
  importTestWallet,
  isValidWif,
  type TestWallet
} from "./testWallet";

describe("generateTestWallet", () => {
  it("returns a 32-byte hex private key + WIF + mainnet P2PKH address + compressed pubkey", () => {
    const w = generateTestWallet();
    expect(w.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(w.wif.length).toBeGreaterThan(30);
    expect(w.wif.startsWith("L") || w.wif.startsWith("K") || w.wif.startsWith("5")).toBe(true);
    expect(w.publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/);
    expect(w.address.length).toBeGreaterThan(25);
    expect(w.address.startsWith("1")).toBe(true);
  });

  it("derives a stable address from the same private key", () => {
    const w = generateTestWallet();
    const re = importTestWallet(w.wif);
    expect(re.privateKeyHex).toBe(w.privateKeyHex);
    expect(re.publicKeyHex).toBe(w.publicKeyHex);
    expect(re.address).toBe(w.address);
  });
});

describe("importTestWallet", () => {
  it("round-trips through WIF", () => {
    const w = generateTestWallet();
    const re = importTestWallet(w.wif);
    expect(re.privateKeyHex).toBe(w.privateKeyHex);
    expect(re.publicKeyHex).toBe(w.publicKeyHex);
    expect(re.address).toBe(w.address);
  });

  it("rejects empty WIF", () => {
    expect(() => importTestWallet("")).toThrow(/empty/);
  });

  it("rejects malformed WIF", () => {
    expect(() => importTestWallet("not-a-wif")).toThrow();
  });
});

describe("isValidWif", () => {
  it("returns true for a freshly generated WIF", () => {
    const w = generateTestWallet();
    expect(isValidWif(w.wif)).toBe(true);
  });

  it("returns false for empty / random strings", () => {
    expect(isValidWif("")).toBe(false);
    expect(isValidWif("nope")).toBe(false);
  });
});

describe("deriveTestWallet", () => {
  it("emits a 66-char compressed pubkey hex starting with 02/03", () => {
    const w: TestWallet = generateTestWallet();
    expect(w.publicKeyHex.length).toBe(66);
    expect(["02", "03"]).toContain(w.publicKeyHex.slice(0, 2));
  });
});

describe("dsha256", () => {
  it("matches the canonical double-SHA256 for empty input", () => {
    // dsha256(empty) = sha256(sha256(empty)) = sha256(e3b0c44...) = 5df6e0e2...
    const got = bytesToHex(dsha256(new Uint8Array(0)));
    expect(got).toBe("5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456");
  });

  it("matches canonical dsha256 for 'hello'", () => {
    // dsha256("hello") = sha256(sha256("hello"))
    const data = new TextEncoder().encode("hello");
    const got = bytesToHex(dsha256(data));
    // Reference computed via @noble/hashes/sha2.js sha256(sha256("hello")).
    expect(got).toBe("9595c9df90075148eb06860365df33584b75bff782a510c6cd4883a419833d50");
  });
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}