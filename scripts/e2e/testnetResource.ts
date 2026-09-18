// scripts/e2e/testnetResource.ts
// real-Keymaster e2e 的 testnet 资金资源。
//
// 设计缘由（施工单 2026-09-18 001 real e2e）：
//   - 长期 seed 私钥只从仓库外固定路径读取，绝不写入报告 / storageState；
//   - 每次运行从 seed 派生一次性钱包，结束后把一次性钱包与 Demo 测试钱包的
//     全部 UTXO 合并扫回 seed 地址；
//   - 所有广播交易都按 canonical txid 在 WOC 上对账，未知结果不盲目重发；
//   - 金额用差异化小额（2/3/4/5...）便于从余额差额定位是哪一项测试出的问题。

import { PrivateKey, P2PKH, Transaction } from "@bsv/sdk";
import { readFileSync } from "node:fs";

const DEFAULT_SEED_KEY_PATH = "/home/david/.config/keymaster-e2e/seed-key.hex";
const DEFAULT_WOC_BASE_URL = "https://api.whatsonchain.com/v1/bsv/test";

export type ObservedTransaction = "confirmed" | "unconfirmed" | "not-found";

export interface ChainUtxo {
  txid: string;
  vout: number;
  value: number;
}

export interface BuiltTransaction {
  rawTxHex: string;
  txid: string;
  feeSatoshis: number;
}

/** 读取仓库外长期 seed 私钥（64 位小写 hex）；不进入任何报告。 */
export function readSeedPrivateKeyHex(
  path = process.env.KEYMASTER_E2E_SEED_KEY_PATH ?? DEFAULT_SEED_KEY_PATH,
): string {
  const text = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/u.test(text)) {
    throw new Error("seed-key.hex must be a 64-char lowercase hex private key");
  }
  return text;
}

function wocBaseUrl(): string {
  return (process.env.KEYMASTER_E2E_WOC_BASE_URL ?? DEFAULT_WOC_BASE_URL).replace(/\/+$/u, "");
}

function toPrivateKey(privateKeyHex: string): PrivateKey {
  if (!/^[0-9a-f]{64}$/u.test(privateKeyHex)) {
    throw new Error("testnet private key must be 32-byte lowercase hex");
  }
  return PrivateKey.fromHex(privateKeyHex);
}

/** testnet P2PKH 地址（version 0x6f）。 */
export function testnetAddressOf(privateKeyHex: string): string {
  return toPrivateKey(privateKeyHex).toAddress("testnet").toString();
}

/** 33-byte compressed 公钥 hex。 */
export function compressedPublicKeyOf(privateKeyHex: string): string {
  return String(toPrivateKey(privateKeyHex).toPublicKey().encode(true, "hex"));
}

/** 生成一次性 testnet 私钥（只保留在本次 Node 调用栈）。 */
export function newTestnetPrivateKeyHex(): string {
  return PrivateKey.fromRandom().toHex();
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${wocBaseUrl()}${path}`);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`WOC ${response.status} ${path} ${body.slice(0, 200)}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

/**
 * 可花费 UTXO（含 mempool 中的未确认输出）。
 *
 * 设计缘由：WOC 的 `/confirmed/unspent` 不扣除 mempool 已花费输入；上一轮
 * 广播尚未确认时会再次选到同一 outpoint，导致 `txn-mempool-conflict`。
 * 这里用 mempool-inclusive 的 `/unspent`，避免重复花费。
 */
export async function listConfirmedUtxos(address: string): Promise<ChainUtxo[]> {
  const payload = await getJson<unknown>(`/address/${encodeURIComponent(address)}/unspent`);
  const rows = Array.isArray(payload)
    ? payload
    : ((payload as { result?: unknown } | null)?.result ?? []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      txid: String((row as { tx_hash?: unknown }).tx_hash ?? "").toLowerCase(),
      vout: Number((row as { tx_pos?: unknown }).tx_pos ?? -1),
      value: Number((row as { value?: unknown }).value ?? 0),
    }))
    .filter((row) => /^[0-9a-f]{64}$/u.test(row.txid) && row.vout >= 0 && row.value > 0);
}

/** 广播 raw tx；返回 WOC 回执或抛错。 */
export async function broadcast(rawTxHex: string): Promise<string> {
  const response = await fetch(`${wocBaseUrl()}/tx/raw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txhex: rawTxHex }),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(`WOC broadcast failed ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const txid = typeof body === "string" ? body : (body as { txid?: unknown } | null)?.txid;
  if (typeof txid !== "string" || !/^[0-9a-f]{64}$/u.test(txid.toLowerCase())) {
    throw new Error(`WOC broadcast did not return a canonical txid: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return txid.toLowerCase();
}

export async function observeTransaction(txid: string): Promise<ObservedTransaction> {
  const normalized = txid.toLowerCase();
  try {
    await getJson(`/tx/hash/${encodeURIComponent(normalized)}`);
    return "confirmed";
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  try {
    await getJson(`/tx/hash/${encodeURIComponent(normalized)}/propagation`);
    return "unconfirmed";
  } catch (error) {
    if ((error as { status?: number }).status === 404) return "not-found";
    throw error;
  }
}

export async function waitForConfirmedTransaction(
  txid: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  let last: ObservedTransaction = "not-found";
  while (Date.now() < deadline) {
    last = await observeTransaction(txid);
    if (last === "confirmed") return;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000));
  }
  throw new Error(`testnet transaction ${txid} not confirmed before timeout (last=${last})`);
}

function estimateSizeBytes(inputCount: number, outputCount: number): number {
  return 10 + inputCount * 148 + outputCount * 34;
}

async function signAndSerialize(
  privateKey: PrivateKey,
  sourceAddress: string,
  utxos: ChainUtxo[],
  outputs: Array<{ address: string; value: number }>,
): Promise<{ rawTxHex: string; txid: string }> {
  const tx = new Transaction();
  for (const utxo of utxos) {
    tx.addInput({
      sourceTXID: utxo.txid,
      sourceOutputIndex: utxo.vout,
      sequence: 0xfffffffe,
      unlockingScriptTemplate: new P2PKH().unlock(
        privateKey,
        "all",
        false,
        utxo.value,
        new P2PKH().lock(sourceAddress),
      ),
    });
  }
  for (const output of outputs) {
    tx.addOutput({ satoshis: output.value, lockingScript: new P2PKH().lock(output.address) });
  }
  await tx.sign();
  const rawTxHex = tx.toHex();
  const txid = String(tx.id("hex"));
  return { rawTxHex, txid };
}

/**
 * 构造一笔从一次性钱包花出的交易。
 *
 * `amountSatoshis` 缺省 = 全部余额清空（只建一个输出，fee 从总额里扣）；
 * 显式金额时找零按 feeRate 估算收敛，零头 < 1000 sats 时不单独建输出。
 */
export async function buildSpendTransaction(input: {
  privateKeyHex: string;
  utxos: ChainUtxo[];
  recipientAddress: string;
  amountSatoshis?: number;
  feeRateSatoshisPerKb: number;
}): Promise<BuiltTransaction> {
  if (input.utxos.length === 0) throw new Error("no UTXO to spend");
  const privateKey = toPrivateKey(input.privateKeyHex);
  const sourceAddress = privateKey.toAddress("testnet").toString();
  const total = input.utxos.reduce((sum, utxo) => sum + utxo.value, 0);
  const sweepAll = input.amountSatoshis === undefined;

  let fee = Math.max(1, Math.ceil((estimateSizeBytes(input.utxos.length, 1) * input.feeRateSatoshisPerKb) / 1000));
  let outputs: Array<{ address: string; value: number }> = [];
  let rawTxHex = "";
  let txid = "";
  for (let round = 0; round < 12; round += 1) {
    if (sweepAll) {
      const value = total - fee;
      if (value <= 0) throw new Error(`insufficient to sweep: total=${total} fee=${fee}`);
      outputs = [{ address: input.recipientAddress, value }];
    } else {
      const change = total - input.amountSatoshis - fee;
      if (change < 0) {
        throw new Error(`insufficient: total=${total} amount=${input.amountSatoshis} fee=${fee}`);
      }
      outputs = [{ address: input.recipientAddress, value: input.amountSatoshis }];
      if (change >= 1000) outputs.push({ address: sourceAddress, value: change });
    }
    const signed = await signAndSerialize(privateKey, sourceAddress, input.utxos, outputs);
    rawTxHex = signed.rawTxHex;
    txid = signed.txid;
    const nextFee = Math.max(1, Math.ceil((rawTxHex.length / 2) * input.feeRateSatoshisPerKb / 1000));
    if (nextFee === fee) {
      return { rawTxHex, txid, feeSatoshis: fee };
    }
    fee = nextFee;
  }
  throw new Error("fee did not converge for testnet spend transaction");
}

/**
 * 把多个私钥的 UTXO 合并成一笔扫回交易（recovery 用）。
 *
 * 每笔输入用各自的私钥签名；输出只有一个（recipient = seed 地址），
 * fee 从总额里扣，避免留下无法单独支付手续费的零散 UTXO。
 */
export async function buildConsolidationTransaction(input: {
  wallets: Array<{ privateKeyHex: string; utxos: ChainUtxo[] }>;
  recipientAddress: string;
  feeRateSatoshisPerKb: number;
}): Promise<BuiltTransaction> {
  const entries = input.wallets.flatMap((wallet) =>
    wallet.utxos.map((utxo) => ({ privateKeyHex: wallet.privateKeyHex, utxo })),
  );
  if (entries.length === 0) throw new Error("no UTXO to consolidate");
  const total = entries.reduce((sum, entry) => sum + entry.utxo.value, 0);
  let fee = Math.max(1, Math.ceil((estimateSizeBytes(entries.length, 1) * input.feeRateSatoshisPerKb) / 1000));
  for (let round = 0; round < 12; round += 1) {
    const tx = new Transaction();
    for (const entry of entries) {
      const privateKey = toPrivateKey(entry.privateKeyHex);
      const sourceAddress = privateKey.toAddress("testnet").toString();
      tx.addInput({
        sourceTXID: entry.utxo.txid,
        sourceOutputIndex: entry.utxo.vout,
        sequence: 0xfffffffe,
        unlockingScriptTemplate: new P2PKH().unlock(
          privateKey,
          "all",
          false,
          entry.utxo.value,
          new P2PKH().lock(sourceAddress),
        ),
      });
    }
    const value = total - fee;
    if (value <= 0) throw new Error(`insufficient to consolidate: total=${total} fee=${fee}`);
    tx.addOutput({ satoshis: value, lockingScript: new P2PKH().lock(input.recipientAddress) });
    await tx.sign();
    const rawTxHex = tx.toHex();
    const nextFee = Math.max(1, Math.ceil((rawTxHex.length / 2) * input.feeRateSatoshisPerKb / 1000));
    if (nextFee === fee) {
      return { rawTxHex, txid: String(tx.id("hex")), feeSatoshis: fee };
    }
    fee = nextFee;
  }
  throw new Error("fee did not converge for consolidation transaction");
}

/** 从 seed 给一次性钱包充值；找零回 seed。 */
export async function fundOneTimeWallet(input: {
  seedPrivateKeyHex: string;
  targetAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb: number;
}): Promise<string> {
  const seedAddress = testnetAddressOf(input.seedPrivateKeyHex);
  const utxos = await listConfirmedUtxos(seedAddress);
  if (utxos.length === 0) throw new Error("seed testnet address has no confirmed UTXO");
  // 选最小的足够 UTXO，减少对 seed 余额的扰动。
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  const selected: ChainUtxo[] = [];
  for (const utxo of sorted) {
    selected.push(utxo);
    const fee = Math.ceil((estimateSizeBytes(selected.length, 2) * input.feeRateSatoshisPerKb) / 1000);
    if (selected.reduce((sum, item) => sum + item.value, 0) >= input.amountSatoshis + fee) break;
  }
  const total = selected.reduce((sum, item) => sum + item.value, 0);
  const fee = Math.ceil((estimateSizeBytes(selected.length, 2) * input.feeRateSatoshisPerKb) / 1000);
  if (total < input.amountSatoshis + fee) {
    throw new Error(`seed balance insufficient: ${total} < ${input.amountSatoshis + fee}`);
  }
  const privateKey = toPrivateKey(input.seedPrivateKeyHex);
  const outputs: Array<{ address: string; value: number }> = [
    { address: input.targetAddress, value: input.amountSatoshis },
  ];
  const change = total - input.amountSatoshis - fee;
  // change 低于 dust 时并入 fee，不建非法小额输出（BSV 无 dust 策略但保持
  // 与 Demo Test Wallet 相同的保守阈值，便于两端对账）。
  if (change >= 1000) outputs.push({ address: seedAddress, value: change });
  const signed = await signAndSerialize(privateKey, seedAddress, selected, outputs);
  return broadcast(signed.rawTxHex);
}
