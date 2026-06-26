import { describe, expect, it } from "vitest";
import {
  actionLabel,
  buildFeepoolCommitParams,
  projectFeepoolCommitInput,
  signCounterpartySigForDraftTx
} from "./feepool";
import { generateTestWallet, type TestWallet } from "./testWallet";
import type { FeepoolPrepareResult } from "./protocol";
import { makeBinaryField } from "./binary";

function fixturePrepareResult(overrides: Partial<FeepoolPrepareResult> = {}): FeepoolPrepareResult {
  return {
    operationId: "op-1",
    action: "create",
    counterpartyPublicKeyHex: "02".padEnd(66, "a"),
    amountSatoshis: 1000,
    draftSpendTxHex: "0100000001".padEnd(40, "0") + "00000000" + "00" + "00" + "ffffffff" + "01" + "00" + "0000000000000000" + "00000000",
    draftClientSignBytes: makeBinaryField(new Uint8Array([0x30, 0x44, 0x02, 0x20])),
    ...overrides
  };
}

describe("actionLabel", () => {
  it("returns the action string verbatim", () => {
    expect(actionLabel("create")).toBe("create");
    expect(actionLabel("spend")).toBe("spend");
    expect(actionLabel("close_and_recreate")).toBe("close_and_recreate");
  });
});

describe("projectFeepoolCommitInput", () => {
  it("throws when operationId is missing", () => {
    expect(() =>
      projectFeepoolCommitInput({ ...fixturePrepareResult(), operationId: "" })
    ).toThrow(/operationId/);
  });

  it("throws when counterpartyPublicKeyHex is wrong length", () => {
    expect(() =>
      projectFeepoolCommitInput({ ...fixturePrepareResult(), counterpartyPublicKeyHex: "abcd" })
    ).toThrow(/counterpartyPublicKeyHex/);
  });

  it("returns a skeleton with empty counterpartySignatures", () => {
    const r = projectFeepoolCommitInput(fixturePrepareResult());
    expect(r.operationId).toBe("op-1");
    expect(r.counterpartyPublicKeyHex.length).toBe(66);
    expect(r.counterpartySignatures).toEqual([]);
    expect(r.closeCounterpartySignatures).toBeUndefined();
  });

  it("includes empty closeCounterpartySignatures slot for close_and_recreate", () => {
    const r = projectFeepoolCommitInput(
      fixturePrepareResult({
        action: "close_and_recreate",
        closeDraftTxHex: "00".repeat(40),
        closeClientSignBytes: makeBinaryField(new Uint8Array([0x30, 0x44]))
      })
    );
    expect(r.closeCounterpartySignatures).toEqual([]);
  });
});

describe("signCounterpartySigForDraftTx", () => {
  function fixture(): {
    wallet: TestWallet;
    keymasterPublicKeyHex: string;
    draftTotalAmount: number;
    draftSpendTxHex: string;
  } {
    const wallet = generateTestWallet();
    // Use a fabricated keymaster pubkey hex (different from counterparty's).
    // 与 `keymaster-multisig-pool` SDK 命名一致：counterparty = demo（server），
    // keymaster = active key holder（client）。
    const keymasterPublicKeyHex = "03".padEnd(66, "b");
    const draftTotalAmount = 100_000;
    const draftSpendTxHex = buildMinimalDraftTxHex(100_000);
    return { wallet, keymasterPublicKeyHex, draftTotalAmount, draftSpendTxHex };
  }

  it("returns a DER signature + sighash type byte for a well-formed draft", () => {
    const { wallet, keymasterPublicKeyHex, draftTotalAmount, draftSpendTxHex } = fixture();
    const sig = signCounterpartySigForDraftTx({
      counterpartyPrivateKeyHex: wallet.privateKeyHex,
      counterpartyPublicKeyHex: wallet.publicKeyHex,
      keymasterPublicKeyHex,
      draftSpendTxHex,
      draftTotalAmount
    });
    expect(sig.signatureDer.length).toBeGreaterThanOrEqual(70);
    // Last byte = SIGHASH_ALL_FORKID = 0x41
    expect(sig.signatureDer[sig.signatureDer.length - 1]).toBe(0x41);
    // DER prefix
    expect(sig.signatureDer[0]).toBe(0x30);
  });

  it("accepts the legacy `serverPublicKeyHex` alias", () => {
    const { wallet, keymasterPublicKeyHex, draftTotalAmount, draftSpendTxHex } = fixture();
    const sig = signCounterpartySigForDraftTx({
      counterpartyPrivateKeyHex: wallet.privateKeyHex,
      counterpartyPublicKeyHex: wallet.publicKeyHex,
      serverPublicKeyHex: keymasterPublicKeyHex, // 旧名仍可用
      draftSpendTxHex,
      draftTotalAmount
    });
    expect(sig.signatureDer[0]).toBe(0x30);
  });

  it("rejects when neither `keymasterPublicKeyHex` nor `serverPublicKeyHex` is provided", () => {
    const { wallet, draftTotalAmount, draftSpendTxHex } = fixture();
    expect(() =>
      signCounterpartySigForDraftTx({
        counterpartyPrivateKeyHex: wallet.privateKeyHex,
        counterpartyPublicKeyHex: wallet.publicKeyHex,
        draftSpendTxHex,
        draftTotalAmount
      })
    ).toThrow(/keymasterPublicKeyHex/);
  });

  it("rejects invalid pubkey lengths", () => {
    const { wallet, keymasterPublicKeyHex, draftTotalAmount, draftSpendTxHex } = fixture();
    expect(() =>
      signCounterpartySigForDraftTx({
        counterpartyPrivateKeyHex: wallet.privateKeyHex,
        counterpartyPublicKeyHex: "abcd",
        keymasterPublicKeyHex,
        draftSpendTxHex,
        draftTotalAmount
      })
    ).toThrow(/counterpartyPublicKeyHex/);
  });

  it("rejects non-positive draftTotalAmount", () => {
    const { wallet, keymasterPublicKeyHex, draftSpendTxHex } = fixture();
    expect(() =>
      signCounterpartySigForDraftTx({
        counterpartyPrivateKeyHex: wallet.privateKeyHex,
        counterpartyPublicKeyHex: wallet.publicKeyHex,
        keymasterPublicKeyHex,
        draftSpendTxHex,
        draftTotalAmount: 0
      })
    ).toThrow(/draftTotalAmount/);
  });

  it("rejects too-short draftSpendTxHex", () => {
    const { wallet, keymasterPublicKeyHex, draftTotalAmount } = fixture();
    expect(() =>
      signCounterpartySigForDraftTx({
        counterpartyPrivateKeyHex: wallet.privateKeyHex,
        counterpartyPublicKeyHex: wallet.publicKeyHex,
        keymasterPublicKeyHex,
        draftSpendTxHex: "deadbeef",
        draftTotalAmount
      })
    ).toThrow();
  });
});

describe("buildFeepoolCommitParams", () => {
  it("builds a commit for action=create with a single counterparty signature", () => {
    const wallet = generateTestWallet();
    const keymasterPublicKeyHex = "03".padEnd(66, "b");
    const draftSpendTxHex = buildMinimalDraftTxHex(100_000);
    const prepare = fixturePrepareResult({
      action: "create",
      counterpartyPublicKeyHex: wallet.publicKeyHex,
      draftSpendTxHex
    });
    const params = buildFeepoolCommitParams({
      prepare,
      counterpartyPrivateKeyHex: wallet.privateKeyHex,
      counterpartyPublicKeyHex: wallet.publicKeyHex,
      keymasterPublicKeyHex,
      draftTotalAmount: 100_000
    });
    expect(params.operationId).toBe("op-1");
    expect(params.counterpartySignatures.length).toBe(1);
    expect(params.closeCounterpartySignatures).toBeUndefined();
  });

  it("builds a commit for action=close_and_recreate with both signatures", () => {
    const wallet = generateTestWallet();
    const keymasterPublicKeyHex = "03".padEnd(66, "b");
    const draftSpendTxHex = buildMinimalDraftTxHex(100_000);
    const closeDraftTxHex = buildMinimalDraftTxHex(100_000);
    const prepare = fixturePrepareResult({
      action: "close_and_recreate",
      counterpartyPublicKeyHex: wallet.publicKeyHex,
      draftSpendTxHex,
      closeDraftTxHex,
      closeClientSignBytes: makeBinaryField(new Uint8Array([0x30, 0x44, 0x02, 0x20]))
    });
    const params = buildFeepoolCommitParams({
      prepare,
      counterpartyPrivateKeyHex: wallet.privateKeyHex,
      counterpartyPublicKeyHex: wallet.publicKeyHex,
      keymasterPublicKeyHex,
      draftTotalAmount: 100_000
    });
    expect(params.counterpartySignatures.length).toBe(1);
    expect(params.closeCounterpartySignatures?.length).toBe(1);
  });

  it("throws when action is close_and_recreate but closeDraftTxHex is missing", () => {
    const wallet = generateTestWallet();
    const keymasterPublicKeyHex = "03".padEnd(66, "b");
    const draftSpendTxHex = buildMinimalDraftTxHex(100_000);
    const prepare = fixturePrepareResult({
      action: "close_and_recreate",
      counterpartyPublicKeyHex: wallet.publicKeyHex,
      draftSpendTxHex
    });
    expect(() =>
      buildFeepoolCommitParams({
        prepare,
        counterpartyPrivateKeyHex: wallet.privateKeyHex,
        counterpartyPublicKeyHex: wallet.publicKeyHex,
        keymasterPublicKeyHex,
        draftTotalAmount: 100_000
      })
    ).toThrow(/closeDraftTxHex/);
  });

  it("rejects when counterparty public key does not match prepare", () => {
    // 防错：prepare -> commit 之间换钱包时，签名会与 request 字段角色不一致。
    // 必须明确报错，而不是推到 Keymaster 端变成莫名其妙的 user_rejected。
    const walletA = generateTestWallet();
    const walletB = generateTestWallet();
    const keymasterPublicKeyHex = "03".padEnd(66, "b");
    const draftSpendTxHex = buildMinimalDraftTxHex(100_000);
    const prepare = fixturePrepareResult({
      action: "create",
      counterpartyPublicKeyHex: walletA.publicKeyHex,
      draftSpendTxHex
    });
    expect(() =>
      buildFeepoolCommitParams({
        prepare,
        counterpartyPrivateKeyHex: walletB.privateKeyHex,
        counterpartyPublicKeyHex: walletB.publicKeyHex, // 跟 prepare 的不一致
        keymasterPublicKeyHex,
        draftTotalAmount: 100_000
      })
    ).toThrow(/does not match feepool\.prepare counterpartyPublicKeyHex/);
  });

  it("rejects unknown action", () => {
    const wallet = generateTestWallet();
    const keymasterPublicKeyHex = "03".padEnd(66, "b");
    const draftSpendTxHex = buildMinimalDraftTxHex(100_000);
    const prepare = fixturePrepareResult({
      // @ts-expect-error - intentionally invalid action for the test
      action: "bogus",
      counterpartyPublicKeyHex: wallet.publicKeyHex,
      draftSpendTxHex
    });
    expect(() =>
      buildFeepoolCommitParams({
        prepare,
        counterpartyPrivateKeyHex: wallet.privateKeyHex,
        counterpartyPublicKeyHex: wallet.publicKeyHex,
        keymasterPublicKeyHex,
        draftTotalAmount: 100_000
      })
    ).toThrow();
  });
});

/**
 * Helper: build a minimal well-formed 1-in / 1-out BSV transaction hex.
 * The result is only used to feed the sighash preimage path; we never broadcast it.
 */
function buildMinimalDraftTxHex(amountSatoshis: number): string {
  const parts: string[] = [];
  // version (4 bytes LE)
  parts.push("01000000");
  // input count (varint = 1)
  parts.push("01");
  // prev txid (32 bytes LE)
  parts.push("00".repeat(32));
  // prev vout (4 bytes LE)
  parts.push("00000000");
  // scriptSig length (varint = 0)
  parts.push("00");
  // sequence (4 bytes LE)
  parts.push("ffffffff");
  // output count (varint = 1)
  parts.push("01");
  // value (8 bytes LE)
  const valueLE = u64LE(amountSatoshis);
  parts.push(valueLE);
  // script (P2PKH-like dummy: OP_DUP OP_HASH160 <20-byte 0> OP_EQUALVERIFY OP_CHECKSIG)
  const script = "76a9" + "00".repeat(20) + "88ac";
  parts.push(byteToVarInt(script.length / 2));
  parts.push(script);
  // lockTime (4 bytes LE)
  parts.push("00000000");
  return parts.join("");
}

function byteToVarInt(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function u64LE(n: number): string {
  const big = BigInt(n);
  const parts: string[] = [];
  for (let i = 0; i < 8; i++) {
    parts.push(Number((big >> BigInt(i * 8)) & 0xffn).toString(16).padStart(2, "0"));
  }
  return parts.join("");
}