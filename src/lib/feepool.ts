// src/lib/feepool.ts
// feepool 本地签名组装：demo 侧的 `prepare -> commit` 闭环辅助。
//
// 设计缘由（施工单 p2pkh / feepool 硬切换）：
//   - demo 拿到 `feepool.prepare` 的 result 后，要把上一轮的 `draftClientSignBytes`
//     用本地测试钱包私钥做"对端"签名，组装成 `feepool.commit` 的
//     `counterpartySignatures`。
//   - action === "close_and_recreate" 时还有 `closeClientSignBytes` →
//     `closeCounterpartySignatures`。
//   - demo 不发明自己的会话协议；不做 pending operation 队列；
//     不自动猜测 commit 哪条 prepare；operationId 失效就直接失败。
//   - 这一层**只**做本地组装 + 校验 + 派生 signature 数组；**不**与 Keymaster
//     服务端耦合。
//
// === 角色命名（与 `keymaster-multisig-pool` SDK 严格对齐） ===
//
// `keymaster-multisig-pool` SDK 用以下命名（参考
// `/home/david/Workspaces/keymaster.cc/packages/plugin-protocol/src/feepoolSdk.ts`
// 与 SDK 源码 `createDualMultisigScript([serverPublicKey, clientPublicKey])`）：
//
//   - `client`  = 持 active key、fund 池的 active key holder = **Keymaster**
//   - `server`  = 对端 = **demo（本测试钱包）**
//   - multisig redeemScript = `OP_2 <serverPub> <clientPub> OP_2 OP_CHECKMULTISIG`
//     即 demo 公钥在前、Keymaster 公钥在后。
//   - `feepool.prepare` 返回的 `counterpartyPublicKeyHex` = server 的公钥 = demo 公钥
//   - demo 在 `feepool.commit` 里要交的 `counterpartySignatures` = server sig，
//     用 demo 自己的 privkey 对 B-Tx 草稿做 BIP143 sighash。
//
// 因此本文件统一使用：
//   - `counterpartyPrivateKeyHex` / `counterpartyPublicKeyHex` = demo（test wallet）
//   - `keymasterPublicKeyHex`                                   = Keymaster
//   - 旧名 `serverPublicKeyHex` 是 Keymaster 的旧名，已废弃；
//     保留为参数别名仅用于向后兼容，UI 侧不要再用。

import type { BinaryField } from "./protocol";
import type { FeepoolCommitParams, FeepoolPrepareResult, ProtocolFeePoolAction } from "./protocol";
import { dsha256 } from "./testWallet";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/**
 * 把 `FeepoolPrepareResult` 投影成 `FeepoolCommitParams` 的 inputs 部分：
 *   - `operationId`（prepare 阶段产生的 id）
 *   - `counterpartyPublicKeyHex`
 *   - `counterpartySignatures`（本地对端签名，本函数不会自动生成；由调用方
 *     在拿到测试钱包后用 `signCounterpartySigForDraftTx` 生成）
 *   - `closeCounterpartySignatures`（仅 close_and_recreate）
 *
 * 本函数只做字段映射 + 必需字段校验；不发明任何字段，不读网络。
 */
export interface ProjectedFeepoolCommitInput {
  operationId: string;
  counterpartyPublicKeyHex: string;
  counterpartySignatures: BinaryField[];
  closeCounterpartySignatures?: BinaryField[];
}

/**
 * 从 prepare 结果投影 commit params 的最小可消费骨架；签名数组为空占位。
 *
 * 失败抛英文 Error（reason / message）；不抛协议层错误码。
 */
export function projectFeepoolCommitInput(prepare: FeepoolPrepareResult): ProjectedFeepoolCommitInput {
  if (!prepare || typeof prepare !== "object") {
    throw new Error("prepare result is missing");
  }
  if (typeof prepare.operationId !== "string" || prepare.operationId.length === 0) {
    throw new Error("prepare result is missing operationId");
  }
  if (typeof prepare.counterpartyPublicKeyHex !== "string" || prepare.counterpartyPublicKeyHex.length !== 66) {
    throw new Error("prepare result has invalid counterpartyPublicKeyHex");
  }
  const projected: ProjectedFeepoolCommitInput = {
    operationId: prepare.operationId,
    counterpartyPublicKeyHex: prepare.counterpartyPublicKeyHex,
    counterpartySignatures: []
  };
  if (prepare.action === "close_and_recreate") {
    projected.closeCounterpartySignatures = [];
  }
  return projected;
}

/**
 * 用本地测试钱包私钥对 `prepare` 出来的 draft 做对端签名，返回
 * `counterpartySignatures` 数组（一个 DER-encoded signature + sighash type）。
 *
 * 关键不变量（与 `keymaster-multisig-pool` SDK 严格一致）：
 *   - 角色命名：
 *       counterparty = demo（test wallet），作为 multisig 的 server 公钥
 *       keymaster    = Keymaster active key holder，作为 multisig 的 client 公钥
 *   - 计算 BIP143 sighash：`draftTotalAmount` 来自 `priorPoolRecord.totalAmount`
 *     或 action === "create" 时由调用方提供（pool 大小）。
 *   - scriptCode = 2-of-2 multisig redeemScript，**严格按 SDK 顺序**：
 *       `OP_2 <counterpartyPubKey> <keymasterPublicKey> OP_2 OP_CHECKMULTISIG`
 *     即 demo（counterparty / server）在前，Keymaster（client）在后。
 *     这一顺序与 SDK 的 `createDualMultisigScript([server, client])` 一致；
 *     调换顺序会导致 SDK 验签失败。
 *   - BIP143 sighash 用 SIGHASH_ALL_FORKID = 0x41。
 *
 * 兼容性：保留旧参数名 `serverPublicKeyHex` 作为 `keymasterPublicKeyHex` 的别名，
 * 但**强烈**推荐 UI 侧改用新名（语义清晰：Keymaster 是 active key holder）。
 */
export function signCounterpartySigForDraftTx(input: {
  /** demo 测试钱包私钥 hex（66 字符）。 */
  counterpartyPrivateKeyHex: string;
  /** demo 测试钱包压缩公钥 hex（66 字符）。SDK 中是 multisig 的 `server` 角色。 */
  counterpartyPublicKeyHex: string;
  /** Keymaster active key 压缩公钥 hex（66 字符）。SDK 中是 multisig 的 `client` 角色。 */
  keymasterPublicKeyHex?: string;
  /** B-Tx 草稿 hex。 */
  draftSpendTxHex: string;
  /** multisig output 总额（pool 大小）。BIP143 sighash 需要显式 satoshi 数。 */
  draftTotalAmount: number;
  /** 旧字段名兼容：等价于 `keymasterPublicKeyHex`。 */
  serverPublicKeyHex?: string;
}): { signatureDer: Uint8Array; signatureHex: string } {
  const keymasterPubHex = input.keymasterPublicKeyHex ?? input.serverPublicKeyHex;
  if (!keymasterPubHex) {
    throw new Error("keymasterPublicKeyHex is required");
  }
  validatePubkeyHex(input.counterpartyPublicKeyHex, "counterpartyPublicKeyHex");
  validatePubkeyHex(keymasterPubHex, "keymasterPublicKeyHex");
  if (!Number.isInteger(input.draftTotalAmount) || input.draftTotalAmount <= 0) {
    throw new Error(`draftTotalAmount must be a positive integer (got ${input.draftTotalAmount})`);
  }
  const txBytes = hexToBytes(input.draftSpendTxHex);
  if (txBytes.length < 60) {
    throw new Error("draftSpendTxHex too short to be a valid transaction");
  }

  const tx = parseTxForSighash(txBytes);
  if (tx.inputs.length === 0) {
    throw new Error("draft transaction has no inputs");
  }

  // redeemScript 严格按 SDK 顺序：counterparty（demo / server）在前，keymaster（client）在后。
  const counterpartyPub = hexToBytes(input.counterpartyPublicKeyHex);
  const keymasterPub = hexToBytes(keymasterPubHex);
  const redeemScript = buildDualMultisigScript(counterpartyPub, keymasterPub);

  const sighash = computeBip143Sighash(tx, 0, redeemScript, input.draftTotalAmount);

  // 用 noble 的 ECDSA.sign：@bsv/sdk 内部也用同一库，sighash 公式一致。
  const priv = hexToBytes(input.counterpartyPrivateKeyHex);
  if (priv.length !== 32) {
    throw new Error("counterpartyPrivateKeyHex must be 32 bytes");
  }
  const sig = secp256k1.sign(sighash, priv, { lowS: true });
  // noble curves v2 returns compact 64-byte signature: r || s, each 32 bytes.
  if (sig.length !== 64) {
    throw new Error(`Unexpected signature length ${sig.length}`);
  }
  const r = BigInt("0x" + bytesToHex(sig.slice(0, 32)));
  const s = BigInt("0x" + bytesToHex(sig.slice(32, 64)));
  const der = encodeDERSignature(r, s);
  const sigWithType = concatBytes(der, new Uint8Array([0x41])); // SIGHASH_ALL_FORKID
  return { signatureDer: sigWithType, signatureHex: bytesToHex(sigWithType) };
}

/**
 * 把签名结果包装成 `BinaryField` 数组。调用方直接喂给 `FeepoolCommitParams`。
 */
export function wrapSignatureAsBinaryField(signature: Uint8Array): BinaryField {
  const copy = new Uint8Array(signature);
  return {
    $type: "binary",
    bytes: copy.buffer
  };
}

/**
 * 组装完整的 `FeepoolCommitParams`：
 *   - main 签名（来自 `signCounterpartySigForDraftTx(draftSpendTxHex)`）
 *   - close 签名（仅 close_and_recreate；来自 `signCounterpartySigForDraftTx(closeDraftTxHex)`）
 *
 * 关键不变量：测试钱包公钥**必须**等于 `prepare.counterpartyPublicKeyHex`。
 * 这是 demo 的"防错"硬约束——`prepare` 与 `commit` 之间的"换钱包"会让签名
 * 与 request 字段角色不一致，验签侧一定失败且对调用方不透明。本函数在
 * 构造阶段就拒绝这种用法，让 UI 直接显示"测试钱包已更换"而不是把这个
 * 错误推给 Keymaster 端变成莫名其妙的 `user_rejected`。
 *
 * 失败抛英文 Error。**不**做协议层重试。
 */
export function buildFeepoolCommitParams(input: {
  prepare: FeepoolPrepareResult;
  counterpartyPrivateKeyHex: string;
  counterpartyPublicKeyHex: string;
  /** Keymaster active key 压缩公钥 hex。SDK 中是 multisig 的 `client` 角色。 */
  keymasterPublicKeyHex: string;
  /** 旧字段名兼容：等价于 `keymasterPublicKeyHex`。 */
  serverPublicKeyHex?: string;
  /** pool 大小：create / close_and_recreate 时 = base tx multisig output 总额；
   *  spend 时 = priorPoolRecord.totalAmount。 */
  draftTotalAmount: number;
  /**
   * 当前 connect sessionId（施工单 2026-06-29 002 硬切换：feepool.commit
   * 强制要求 connectSessionId）。由调用方从当前 session state 注入。
   */
  connectSessionId: string;
}): FeepoolCommitParams {
  const { prepare } = input;
  if (prepare.action !== "spend" && prepare.action !== "create" && prepare.action !== "close_and_recreate") {
    throw new Error(`Unknown feepool action: ${prepare.action}`);
  }
  if (!prepare.draftSpendTxHex || prepare.draftSpendTxHex.length === 0) {
    throw new Error("prepare.draftSpendTxHex is missing");
  }
  // 防错：wallet 公钥必须等于 prepare 阶段的 counterparty 公钥，
  // 否则密钥与角色不匹配，Keymaster 验签一定失败且对调用方不透明。
  if (input.counterpartyPublicKeyHex !== prepare.counterpartyPublicKeyHex) {
    throw new Error(
      `Test wallet public key does not match feepool.prepare counterpartyPublicKeyHex. ` +
        `Expected ${prepare.counterpartyPublicKeyHex}, got ${input.counterpartyPublicKeyHex}. ` +
        `The test wallet has been changed or the prepare result is from a different counterparty.`
    );
  }

  const mainSig = signCounterpartySigForDraftTx({
    counterpartyPrivateKeyHex: input.counterpartyPrivateKeyHex,
    counterpartyPublicKeyHex: input.counterpartyPublicKeyHex,
    keymasterPublicKeyHex: input.keymasterPublicKeyHex,
    serverPublicKeyHex: input.serverPublicKeyHex,
    draftSpendTxHex: prepare.draftSpendTxHex,
    draftTotalAmount: input.draftTotalAmount
  });
  const counterpartySignatures: BinaryField[] = [wrapSignatureAsBinaryField(mainSig.signatureDer)];

  let closeCounterpartySignatures: BinaryField[] | undefined;
  if (prepare.action === "close_and_recreate") {
    if (!prepare.closeDraftTxHex) {
      throw new Error("close_and_recreate prepare result is missing closeDraftTxHex");
    }
    if (!prepare.closeClientSignBytes) {
      throw new Error("close_and_recreate prepare result is missing closeClientSignBytes");
    }
    const closeSig = signCounterpartySigForDraftTx({
      counterpartyPrivateKeyHex: input.counterpartyPrivateKeyHex,
      counterpartyPublicKeyHex: input.counterpartyPublicKeyHex,
      keymasterPublicKeyHex: input.keymasterPublicKeyHex,
      serverPublicKeyHex: input.serverPublicKeyHex,
      draftSpendTxHex: prepare.closeDraftTxHex,
      // close 草稿的 sighash 计算也走同一 multisig output 总额
      draftTotalAmount: input.draftTotalAmount
    });
    closeCounterpartySignatures = [wrapSignatureAsBinaryField(closeSig.signatureDer)];
  }

  return {
    operationId: prepare.operationId,
    counterpartyPublicKeyHex: prepare.counterpartyPublicKeyHex,
    counterpartySignatures,
    closeCounterpartySignatures,
    connectSessionId: input.connectSessionId
  };
}

/** 把 action 投影成 UI 上的"中文友好"标签。 */
export function actionLabel(action: ProtocolFeePoolAction): string {
  switch (action) {
    case "create":
      return "create";
    case "spend":
      return "spend";
    case "close_and_recreate":
      return "close_and_recreate";
  }
}

/* ============== helpers ============== */

function validatePubkeyHex(hex: string, name: string): void {
  if (typeof hex !== "string" || hex.length !== 66) {
    throw new Error(`${name} must be a 33-byte compressed public key hex (66 chars)`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${name} must be hex`);
  }
  if (hex[0] !== "0" || (hex[1] !== "2" && hex[1] !== "3")) {
    throw new Error(`${name} must start with 02 or 03 (compressed secp256k1)`);
  }
}

interface ParsedInput {
  prevTxid: string;
  prevVout: number;
  scriptSig: Uint8Array;
  sequence: number;
}
interface ParsedOutput {
  value: number;
  script: Uint8Array;
}
interface ParsedTx {
  version: number;
  inputs: ParsedInput[];
  outputs: ParsedOutput[];
  lockTime: number;
}

/** 解析 BSV 交易用于 sighash 计算（不验证任何业务规则；只解出 bytes）。 */
function parseTxForSighash(bytes: Uint8Array): ParsedTx {
  const reader = new Reader(bytes);
  const version = reader.readU32LE();
  const inputCount = reader.readVarInt();
  const inputs: ParsedInput[] = [];
  for (let i = 0; i < inputCount; i++) {
    const txidLE = reader.readBytes(32);
    const vout = reader.readU32LE();
    const scriptLen = reader.readVarInt();
    const scriptSig = reader.readBytes(scriptLen);
    const sequence = reader.readU32LE();
    inputs.push({
      prevTxid: bytesToHex(new Uint8Array(txidLE.slice().reverse())),
      prevVout: vout,
      scriptSig,
      sequence
    });
  }
  const outputCount = reader.readVarInt();
  const outputs: ParsedOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    const value = reader.readU64LE();
    const scriptLen = reader.readVarInt();
    const script = reader.readBytes(scriptLen);
    outputs.push({ value, script });
  }
  const lockTime = reader.readU32LE();
  return { version, inputs, outputs, lockTime };
}

/** 构造 2-of-2 multisig redeemScript。 */
function buildDualMultisigScript(serverPub: Uint8Array, clientPub: Uint8Array): Uint8Array {
  if (serverPub.length !== 33 || clientPub.length !== 33) {
    throw new Error("multisig pubkeys must be 33 bytes compressed");
  }
  return concatBytes(
    new Uint8Array([0x52]), // OP_2
    new Uint8Array([serverPub.length]),
    serverPub,
    new Uint8Array([clientPub.length]),
    clientPub,
    new Uint8Array([0x52]), // OP_2
    new Uint8Array([0xae]) // OP_CHECKMULTISIG
  );
}

/** 计算 BIP143 sighash：4-way preimage + dsha256 + SIGHASH_ALL_FORKID。 */
function computeBip143Sighash(
  tx: ParsedTx,
  inputIndex: number,
  scriptCode: Uint8Array,
  prevValue: number
): Uint8Array {
  const hashPrevouts = dsha256(
    concatBytes(
      ...tx.inputs.map((i) => concatBytes(hexToBytesLittleEndian(i.prevTxid), u32LE(i.prevVout)))
    )
  );
  const hashSequence = dsha256(concatBytes(...tx.inputs.map((i) => u32LE(i.sequence))));
  const hashOutputs = dsha256(
    concatBytes(
      ...tx.outputs.map((o) => concatBytes(u64LE(o.value), encodeVarInt(o.script.length), o.script))
    )
  );
  const input = tx.inputs[inputIndex]!;
  const preimage = concatBytes(
    u32LE(tx.version),
    hashPrevouts,
    hashSequence,
    hexToBytesLittleEndian(input.prevTxid),
    u32LE(input.prevVout),
    encodeVarInt(scriptCode.length),
    scriptCode,
    u64LE(prevValue),
    u32LE(input.sequence),
    hashOutputs,
    u32LE(tx.lockTime),
    u32LE(0x41) // SIGHASH_ALL_FORKID
  );
  return dsha256(preimage);
}

/* ============== 低层 helpers ============== */

class Reader {
  private bytes: Uint8Array;
  private pos = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  readU32LE(): number {
    const a = this.bytes[this.pos++]!;
    const b = this.bytes[this.pos++]!;
    const c = this.bytes[this.pos++]!;
    const d = this.bytes[this.pos++]!;
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  }
  readU64LE(): number {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      v |= this.bytes[this.pos++]! << (i * 8);
    }
    // BSV amount is uint64; we expose as Number; values above 2^53 lose precision.
    // For demo test wallet scenarios (< 21M BSV = 2.1e15 sats), Number is safe.
    return v;
  }
  readVarInt(): number {
    const first = this.bytes[this.pos++]!;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      return this.bytes[this.pos++]! | (this.bytes[this.pos++]! << 8);
    }
    if (first === 0xfe) {
      return (
        this.bytes[this.pos++]! |
        (this.bytes[this.pos++]! << 8) |
        (this.bytes[this.pos++]! << 16) |
        (this.bytes[this.pos++]! << 24)
      );
    }
    throw new Error("compact size varint too large");
  }
  readBytes(len: number): Uint8Array {
    const out = this.bytes.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytesLittleEndian(txidHex: string): Uint8Array {
  // txid 是大端显示；BSV preimage 里 txid 是小端字节序。
  const bytes = hexToBytes(txidHex);
  return new Uint8Array(bytes.slice().reverse());
}

function u32LE(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

function u64LE(n: number): Uint8Array {
  // Number 范围对 demo 足够；>=2^53 时降级为 BigInt 安全路径。
  const big = BigInt(n);
  return new Uint8Array([
    Number(big & 0xffn),
    Number((big >> 8n) & 0xffn),
    Number((big >> 16n) & 0xffn),
    Number((big >> 24n) & 0xffn),
    Number((big >> 32n) & 0xffn),
    Number((big >> 40n) & 0xffn),
    Number((big >> 48n) & 0xffn),
    Number((big >> 56n) & 0xffn)
  ]);
}

function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n < 0x10000) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function encodeDERSignature(r: bigint, s: bigint): Uint8Array {
  const encodeInt = (n: bigint): Uint8Array => {
    let hex = n.toString(16);
    if (hex.length % 2 !== 0) hex = "0" + hex;
    let bytes = hexToBytes(hex);
    while (bytes.length > 1 && bytes[0] === 0 && ((bytes[1] ?? 0) < 0x80)) {
      bytes = bytes.slice(1);
    }
    if ((bytes[0] ?? 0) >= 0x80) {
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes, 1);
      bytes = padded;
    }
    return concatBytes(new Uint8Array([0x02, bytes.length]), bytes);
  };
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const seqLen = rEnc.length + sEnc.length;
  return concatBytes(new Uint8Array([0x30, seqLen]), rEnc, sEnc);
}