import { describe, expect, it } from "vitest";
import {
  deriveTestWallet,
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

describe("testnet 支持（施工单 2026-09-18 001）", () => {
  it("generateTestWallet('test') 派生 testnet 地址与 0xef WIF，并可被 importTestWallet 还原网络", () => {
    const wallet = generateTestWallet("test");
    expect(wallet.network).toBe("test");
    expect(wallet.address).toMatch(/^[mn]/);
    expect(wallet.wif[0]).toMatch(/^[9c]/);
    const imported = importTestWallet(wallet.wif);
    expect(imported.network).toBe("test");
    expect(imported.address).toBe(wallet.address);
    expect(imported.privateKeyHex).toBe(wallet.privateKeyHex);
  });

  it("mainnet 钱包不被误判为 testnet", () => {
    const wallet = generateTestWallet();
    expect(wallet.network).toBe("main");
    expect(wallet.address.startsWith("1")).toBe(true);
    expect(importTestWallet(wallet.wif).network).toBe("main");
  });
});
