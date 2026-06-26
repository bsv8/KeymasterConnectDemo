// src/lib/p2pkhTool.ts
// 测试钱包的链上 P2PKH 工具：构造 / 签名 / 序列化。**不**走 Keymaster 协议；
// 是 demo 工具区的本地逻辑。
//
// 设计缘由（施工单 p2pkh / feepool 硬切换）：
//   - 工具区只服务于"测试钱包"；不接触 Keymaster 私钥。
//   - 工具区**不**复用 `p2pkh.transfer` 协议；不做自动副作用。
//   - 走 BIP143 sighash（@bsv/sdk 已经内置 P2PKH.unlock，够用）。
//   - UTXO 选择用"smallest-first"贪心；fee 估算走 `feeRate * size / 1000`。
//   - 失败直接抛英文 Error，不包装协议语义。

import {
  P2PKH,
  PrivateKey,
  Transaction,
  type TransactionInput,
  type TransactionOutput
} from "@bsv/sdk";
import type { TestWallet } from "./testWallet";
import type { WocUtxo } from "./woc";

/** 测试钱包可见的 UTXO（在工具区用，等价于 WOC 真值）。 */
export interface TestWalletUtxo {
  txid: string;
  vout: number;
  value: number;
  /** 该 UTXO 属于哪个 P2PKH 地址（测试钱包自己的主网地址）。 */
  address: string;
  height?: number;
  script?: string;
}

/** 工具区构造 P2PKH 转账的输入。 */
export interface BuildP2pkhTransferInput {
  wallet: TestWallet;
  utxos: TestWalletUtxo[];
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb: number;
}

/** 工具区构造 P2PKH 转账的输出。 */
export interface BuildP2pkhTransferOutput {
  rawTxHex: string;
  txid: string;
  feeSatoshis: number;
  inputs: Array<{ txid: string; vout: number; value: number }>;
  outputs: Array<{ address: string; value: number }>;
}

/** 工具区构造失败的统一错误结构。 */
export interface BuildP2pkhTransferFailure {
  reason: "no-utxos" | "insufficient" | "invalid-amount" | "invalid-address";
  available: number;
  required: number;
  message: string;
}

const DEFAULT_FEE_RATE_SAT_PER_KB = 100;

/**
 * BSV 主网 P2PKH dust threshold（2018-fork 后）。
 *
 * 设计缘由：构造找零时若 `change < DUST_THRESHOLD`，会被节点当作 dust 拒绝；
 * 直接丢给 fee（不再为极小额单独建 output）能避免构造出非标准交易。
 *
 * 这里用 1000 sat 作为保守阈值（典型做法 546 / 1000 都行），避免
 * `1 sat` 或 `几十 sat` 这种 change 被错误地独立建 output，
 * 防止在广播阶段因为非标准 dust output 被拒。
 */
export const P2PKH_DUST_THRESHOLD_SATOSHIS = 1000;

export function defaultFeeRateSatoshisPerKb(): number {
  return DEFAULT_FEE_RATE_SAT_PER_KB;
}

/**
 * 校验 amountSatoshis / feeRateSatoshisPerKb 是正整数；recipientAddress 合法。
 *
 * 硬切换 4.7 收口：feeRateSatoshisPerKb 必须 >= 1；amountSatoshis 必须
 * 正整数。失败直接抛 `BuildP2pkhTransferFailure`（构造侧早失败）。
 */
export function validateTransferParams(input: {
  amountSatoshis: number;
  feeRateSatoshisPerKb: number;
  recipientAddress: string;
}): BuildP2pkhTransferFailure | null {
  if (!Number.isInteger(input.amountSatoshis) || input.amountSatoshis <= 0) {
    return {
      reason: "invalid-amount",
      available: 0,
      required: input.amountSatoshis,
      message: `amountSatoshis must be a positive integer (got ${input.amountSatoshis})`
    };
  }
  if (!Number.isInteger(input.feeRateSatoshisPerKb) || input.feeRateSatoshisPerKb < 1) {
    return {
      reason: "invalid-amount",
      available: 0,
      required: 0,
      message: `feeRateSatoshisPerKb must be a positive integer >= 1 (got ${input.feeRateSatoshisPerKb})`
    };
  }
  if (!isLikelyP2pkhAddress(input.recipientAddress)) {
    return {
      reason: "invalid-address",
      available: 0,
      required: 0,
      message: `recipientAddress is not a valid mainnet P2PKH address`
    };
  }
  return null;
}

/**
 * 选择 UTXO：smallest-first 贪心；满足 `amountSatoshis + feeReserve` 即可。
 */
export function selectUtxos(
  utxos: TestWalletUtxo[],
  amountSatoshis: number,
  feeRateSatoshisPerKb: number
): { selected: TestWalletUtxo[]; totalInputSatoshis: number } {
  if (utxos.length === 0) {
    return { selected: [], totalInputSatoshis: 0 };
  }
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  const selected: TestWalletUtxo[] = [];
  let total = 0;
  for (const u of sorted) {
    selected.push(u);
    total += u.value;
    const estimatedFee = Math.max(1, Math.ceil((estimateSizeBytes(selected.length, 2) * feeRateSatoshisPerKb) / 1000));
    if (total >= amountSatoshis + estimatedFee) {
      break;
    }
  }
  return { selected, totalInputSatoshis: total };
}

/** 估算 P2PKH tx 字节大小：~10 overhead + per-input + per-output 字节数。 */
export function estimateSizeBytes(inputCount: number, outputCount: number): number {
  const overhead = 10;
  const perInput = 148;
  const perOutput = 34;
  return overhead + inputCount * perInput + outputCount * perOutput;
}

/**
 * 主入口：构造并签名测试钱包的 P2PKH 转账。
 *
 * 失败抛 `TransferBuildError`（含 `BuildP2pkhTransferFailure`）。成功返回
 * rawTxHex / txid / fee 等。
 *
 * 构造是 deterministic iteration：先按 feeRate 估算 1 input 的 fee，
 * 再依次扩大直到 fee 收敛。这样即使 fee 估算偏小，最多也只是 fee 偏小
 * 一轮；不会无限循环。
 */
export async function buildAndSignP2pkhTransfer(input: BuildP2pkhTransferInput): Promise<BuildP2pkhTransferOutput> {
  const { wallet, utxos } = input;
  const validationFailure = validateTransferParams({
    amountSatoshis: input.amountSatoshis,
    feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
    recipientAddress: input.recipientAddress
  });
  if (validationFailure) {
    throw new TransferBuildError(validationFailure);
  }
  if (utxos.length === 0) {
    throw new TransferBuildError({
      reason: "no-utxos",
      available: 0,
      required: input.amountSatoshis,
      message: "No UTXOs available for the test wallet"
    });
  }

  const { selected, totalInputSatoshis } = selectUtxos(
    utxos,
    input.amountSatoshis,
    input.feeRateSatoshisPerKb
  );
  if (selected.length === 0) {
    throw new TransferBuildError({
      reason: "no-utxos",
      available: 0,
      required: input.amountSatoshis,
      message: "No UTXOs available for the test wallet"
    });
  }

  const privKey = PrivateKey.fromHex(wallet.privateKeyHex);

  // 12 轮迭代：fee 估算与 tx size 互相依赖，几次后必收敛。
  //
  // dust 处理：本轮先按"是否带 change output"两种 size 估算 fee（影响 feeSatoshis），
  // 再看当前轮 change 是否 < DUST；若是则 drop change output 并把差值并入 fee。
  // 这样 12 轮里 fee / change 互相收敛，最终要么稳定带 change output、要么稳定无 change。
  let feeSatoshis = 1;
  let includeChange = true;
  let rawTxHex = "";
  let txid = "";
  let outputs: Array<{ address: string; value: number }> = [];
  for (let round = 0; round < 12; round++) {
    const change = totalInputSatoshis - input.amountSatoshis - feeSatoshis;
    if (change < 0) {
      throw new TransferBuildError({
        reason: "insufficient",
        available: totalInputSatoshis,
        required: input.amountSatoshis + feeSatoshis,
        message: `Test wallet balance insufficient: have ${totalInputSatoshis}, need ${input.amountSatoshis + feeSatoshis} (amount + fee)`
      });
    }
    // dust 判定：change < DUST 时不再单独建 change output（直接并入 fee）。
    // 否则节点会在 broadcast 阶段拒绝非标准 dust output。
    includeChange = change >= P2PKH_DUST_THRESHOLD_SATOSHIS;
    outputs = [{ address: input.recipientAddress, value: input.amountSatoshis }];
    if (includeChange) {
      outputs.push({ address: wallet.address, value: change });
    }
    const tx = new Transaction();
    for (const u of selected) {
      const txInput: TransactionInput = {
        sourceTXID: u.txid,
        sourceOutputIndex: u.vout,
        sequence: 0xfffffffe,
        unlockingScriptTemplate: new P2PKH().unlock(privKey, "all", false, u.value, new P2PKH().lock(wallet.address))
      };
      tx.addInput(txInput);
    }
    for (const o of outputs) {
      const txOutput: TransactionOutput = {
        satoshis: o.value,
        lockingScript: new P2PKH().lock(o.address)
      };
      tx.addOutput(txOutput);
    }
    await tx.sign();
    rawTxHex = tx.toHex();
    const hashResult = tx.hash("hex");
    txid = typeof hashResult === "string" ? hashResult : "";
    const sizeBytes = rawTxHex.length / 2;
    const nextFee = Math.max(1, Math.ceil((sizeBytes * input.feeRateSatoshisPerKb) / 1000));
    if (nextFee === feeSatoshis) {
      return {
        rawTxHex,
        txid,
        feeSatoshis,
        inputs: selected.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
        outputs
      };
    }
    feeSatoshis = nextFee;
  }
  // 不收敛：最后一次用估算 fee 构造 + 重新计算 fee 比较。
  const finalSizeBytes = rawTxHex.length / 2;
  const finalFee = Math.max(1, Math.ceil((finalSizeBytes * input.feeRateSatoshisPerKb) / 1000));
  if (finalFee !== feeSatoshis) {
    throw new TransferBuildError({
      reason: "insufficient",
      available: totalInputSatoshis,
      required: input.amountSatoshis + finalFee,
      message: `Fee did not converge after 12 rounds (last estimated ${finalFee})`
    });
  }
  return {
    rawTxHex,
    txid,
    feeSatoshis,
    inputs: selected.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
    outputs
  };
}

/** 把 WOC 的 UTXO 真值转换成工具区内部形状。 */
export function wocUtxosToTestWalletUtxos(utxos: WocUtxo[], address: string): TestWalletUtxo[] {
  return utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    address,
    height: u.height,
    script: u.script
  }));
}

/** 抛 `BuildP2pkhTransferFailure` 的 Error。 */
export class TransferBuildError extends Error {
  readonly failure: BuildP2pkhTransferFailure;
  constructor(failure: BuildP2pkhTransferFailure) {
    super(failure.message);
    this.name = "TransferBuildError";
    this.failure = failure;
  }
}

/**
 * 最小主网 P2PKH 地址合法性检查：
 *   - base58 解码得到 25 字节；
 *   - version byte 0x00。
 *
 * 不做 checksum 校验：硬切换 4.7 收口——base58 解码长度 + version 已足够；
 * 真正的 chain-level 校验交给 SDK 的 signing / 后续广播阶段。
 */
export function isLikelyP2pkhAddress(addr: string): boolean {
  if (typeof addr !== "string" || addr.length < 26 || addr.length > 35) return false;
  try {
    const decoded = base58Decode(addr);
    if (decoded.length !== 25) return false;
    return decoded[0] === 0x00;
  } catch {
    return false;
  }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of input) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("invalid base58");
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]! * 58 + carry;
      bytes[i] = v & 0xff;
      carry = (v / 256) | 0;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = (carry / 256) | 0;
    }
  }
  let leadingZeros = 0;
  for (const ch of input) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i]!;
  }
  return out;
}