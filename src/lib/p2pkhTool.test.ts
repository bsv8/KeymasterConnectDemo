import { describe, expect, it } from "vitest";
import {
  buildAndSignP2pkhTransfer,
  defaultFeeRateSatoshisPerKb,
  estimateSizeBytes,
  isLikelyP2pkhAddress,
  P2PKH_DUST_THRESHOLD_SATOSHIS,
  selectUtxos,
  TransferBuildError,
  validateTransferParams,
  wocUtxosToTestWalletUtxos,
  type TestWalletUtxo
} from "./p2pkhTool";
import { generateTestWallet, type TestWallet } from "./testWallet";

const RECIPIENT = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"; // famous mainnet P2PKH from bitcoin wiki; not used on chain.

function fixtureWallet(): TestWallet {
  return generateTestWallet();
}

function fixtureUtxos(wallet: TestWallet, count: number, valueEach: number): TestWalletUtxo[] {
  return Array.from({ length: count }, (_, i) => ({
    txid: "0000000000000000000000000000000000000000000000000000000000000000".replace(/0/g, (c, idx) =>
      c
    ),
    vout: i,
    value: valueEach,
    address: wallet.address,
    height: 100
  }));
}

describe("defaultFeeRateSatoshisPerKb", () => {
  it("returns a positive integer", () => {
    const r = defaultFeeRateSatoshisPerKb();
    expect(Number.isInteger(r)).toBe(true);
    expect(r).toBeGreaterThanOrEqual(1);
  });
});

describe("validateTransferParams", () => {
  it("accepts a valid mainnet P2PKH address + positive integer amount + positive fee rate", () => {
    expect(
      validateTransferParams({
        amountSatoshis: 1000,
        feeRateSatoshisPerKb: 1,
        recipientAddress: RECIPIENT
      })
    ).toBeNull();
  });

  it("rejects non-positive amount", () => {
    expect(
      validateTransferParams({
        amountSatoshis: 0,
        feeRateSatoshisPerKb: 1,
        recipientAddress: RECIPIENT
      })?.reason
    ).toBe("invalid-amount");
    expect(
      validateTransferParams({
        amountSatoshis: -1,
        feeRateSatoshisPerKb: 1,
        recipientAddress: RECIPIENT
      })?.reason
    ).toBe("invalid-amount");
  });

  it("rejects fee rate < 1", () => {
    expect(
      validateTransferParams({
        amountSatoshis: 1000,
        feeRateSatoshisPerKb: 0,
        recipientAddress: RECIPIENT
      })?.reason
    ).toBe("invalid-amount");
  });

  it("rejects invalid address", () => {
    expect(
      validateTransferParams({
        amountSatoshis: 1000,
        feeRateSatoshisPerKb: 1,
        recipientAddress: "not-an-address"
      })?.reason
    ).toBe("invalid-address");
  });
});

describe("isLikelyP2pkhAddress", () => {
  it("accepts a valid mainnet P2PKH address", () => {
    expect(isLikelyP2pkhAddress(RECIPIENT)).toBe(true);
  });

  it("rejects empty / invalid", () => {
    expect(isLikelyP2pkhAddress("")).toBe(false);
    expect(isLikelyP2pkhAddress("abc")).toBe(false);
  });
});

describe("selectUtxos", () => {
  const wallet = fixtureWallet();
  it("returns no selection when there are no utxos", () => {
    expect(selectUtxos([], 1000, 100).selected).toEqual([]);
  });

  it("picks smallest-first until amountSatoshis + fee is covered", () => {
    // 5 × 500 sats. Want 2000 + ~22 fee → must pick all 5 (2500 ≥ 2022).
    const utxos = fixtureUtxos(wallet, 5, 500);
    const r = selectUtxos(utxos, 2000, 100);
    expect(r.selected.length).toBe(5);
    expect(r.totalInputSatoshis).toBe(2500);
  });

  it("picks exactly one UTXO when a single UTXO already covers amount + fee", () => {
    const utxos = fixtureUtxos(wallet, 1, 100_000);
    const r = selectUtxos(utxos, 1000, 100);
    expect(r.selected.length).toBe(1);
    expect(r.totalInputSatoshis).toBe(100_000);
  });
});

describe("estimateSizeBytes", () => {
  it("grows linearly with inputs/outputs", () => {
    const a = estimateSizeBytes(1, 2);
    const b = estimateSizeBytes(2, 2);
    expect(b - a).toBe(148);
  });
});

describe("wocUtxosToTestWalletUtxos", () => {
  it("tags each UTXO with the test wallet address", () => {
    const woc = [
      { txid: "a", vout: 0, value: 100, height: 1 },
      { txid: "b", vout: 1, value: 200, height: 1 }
    ];
    const wallet = fixtureWallet();
    const out = wocUtxosToTestWalletUtxos(woc, wallet.address);
    expect(out[0]!.address).toBe(wallet.address);
    expect(out[1]!.value).toBe(200);
  });
});

describe("buildAndSignP2pkhTransfer", () => {
  it("throws TransferBuildError on insufficient funds", async () => {
    const wallet = fixtureWallet();
    const utxos = fixtureUtxos(wallet, 1, 100);
    let caught: unknown;
    try {
      await buildAndSignP2pkhTransfer({
        wallet,
        utxos,
        recipientAddress: RECIPIENT,
        amountSatoshis: 50_000,
        feeRateSatoshisPerKb: 100
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransferBuildError);
    const e = caught as TransferBuildError;
    expect(e.failure.reason).toBe("insufficient");
    expect(e.failure.available).toBe(100);
  });

  it("throws TransferBuildError on empty utxo set", async () => {
    const wallet = fixtureWallet();
    let caught: unknown;
    try {
      await buildAndSignP2pkhTransfer({
        wallet,
        utxos: [],
        recipientAddress: RECIPIENT,
        amountSatoshis: 1000,
        feeRateSatoshisPerKb: 100
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransferBuildError);
    expect((caught as TransferBuildError).failure.reason).toBe("no-utxos");
  });

  it("builds and signs a valid tx for a generously funded wallet", async () => {
    const wallet = fixtureWallet();
    const utxos = fixtureUtxos(wallet, 1, 100_000);
    const out = await buildAndSignP2pkhTransfer({
      wallet,
      utxos,
      recipientAddress: RECIPIENT,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 100
    });
    expect(out.rawTxHex.length).toBeGreaterThan(0);
    expect(out.txid.length).toBe(64);
    expect(out.feeSatoshis).toBeGreaterThan(0);
    expect(out.outputs.length).toBe(2); // recipient + change
  });

  it("drops the change output (and folds dust into fee) when change < dust threshold", async () => {
    // 1000 sats UTXO + 1 sat 收款 → change ≈ 1000 - 1 - fee；fee 在 1 in / 1 out 时
    // 通常 < 几百 sat；最后 change 必然 < DUST。期望：只有 1 个 output（recipient），
    // 没有 change output，避免构造出非标准 dust output。
    const wallet = fixtureWallet();
    const utxos = fixtureUtxos(wallet, 1, 1000);
    const out = await buildAndSignP2pkhTransfer({
      wallet,
      utxos,
      recipientAddress: RECIPIENT,
      amountSatoshis: 1,
      feeRateSatoshisPerKb: 100
    });
    expect(out.outputs.length).toBe(1); // 只剩 recipient，change 被 dust drop
    expect(out.outputs[0]!.address).toBe(RECIPIENT);
    // fee 应该 ≥ change drop 的那部分（即比原 fee 更大，因为吸收了 change）。
    expect(out.feeSatoshis).toBeGreaterThan(0);
  });

  it("keeps the change output when change ≥ dust threshold", async () => {
    const wallet = fixtureWallet();
    const utxos = fixtureUtxos(wallet, 1, 100_000);
    const out = await buildAndSignP2pkhTransfer({
      wallet,
      utxos,
      recipientAddress: RECIPIENT,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 100
    });
    expect(out.outputs.length).toBe(2);
    expect(out.outputs[1]!.address).toBe(wallet.address);
    expect(out.outputs[1]!.value).toBeGreaterThanOrEqual(P2PKH_DUST_THRESHOLD_SATOSHIS);
  });
});