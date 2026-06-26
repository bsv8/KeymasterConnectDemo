// src/lib/testWallet.ts
// 本地测试钱包。
//
// 设计缘由（施工单 p2pkh / feepool 硬切换）：
//   - demo 自带的私钥，只服务于"外部调用方"协议验证；不接触 Keymaster 私钥。
//   - 默认只放在页面内存里；不写 localStorage，不做多钱包，不做导出/导入。
//   - 提供三种能力：derive address、derive compressed pubkey hex、签名。
//   - 错误信息走英文；不做国际化。
//
// 这一层是 demo 自己的辅助工具，**不**属于 Keymaster Connect 协议。

import { PrivateKey } from "@bsv/sdk";
import { sha256 } from "@noble/hashes/sha2.js";

/** 内存态测试钱包对象。 */
export interface TestWallet {
  /** 32-byte secp256k1 私钥 hex（66 字符）。 */
  privateKeyHex: string;
  /** 主网 WIF。 */
  wif: string;
  /** 33-byte compressed 公钥 hex（66 字符）。 */
  publicKeyHex: string;
  /** 主网 P2PKH 地址。 */
  address: string;
}

/**
 * 随机生成一把 demo 用的测试钱包私钥（WIF + 派生 hex）。
 *
 * 设计缘由：硬切换要求 demo 必须能"生成测试私钥"路径，不能只是"导入"
 * 路径——手动导入门槛太高。
 */
export function generateTestWallet(): TestWallet {
  const pk = PrivateKey.fromRandom();
  return deriveTestWallet(pk);
}

/** 从 WIF 还原一把测试钱包。 */
export function importTestWallet(wif: string): TestWallet {
  const trimmed = wif.trim();
  if (trimmed.length === 0) {
    throw new Error("Test wallet WIF is empty");
  }
  let pk: PrivateKey;
  try {
    pk = PrivateKey.fromWif(trimmed);
  } catch (err) {
    throw new Error(`Invalid WIF: ${err instanceof Error ? err.message : String(err)}`);
  }
  return deriveTestWallet(pk);
}

/** 校验 WIF 是否能解析为 secp256k1 私钥。 */
export function isValidWif(wif: string): boolean {
  if (typeof wif !== "string" || wif.length === 0) return false;
  try {
    PrivateKey.fromWif(wif);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 PrivateKey 派生测试钱包全部字段。
 *
 * 关键不变量：
 *   - 主网 P2PKH：version byte 0x00；testnet (0x6f) 不在本 demo 范围内。
 *   - 公钥必须是 compressed（33 字节，前缀 02/03）。
 */
export function deriveTestWallet(pk: PrivateKey): TestWallet {
  const pubkey = pk.toPublicKey();
  // `encode(true, 'hex')` returns the 33-byte SEC1 compressed hex (02/03 prefix).
  const publicKeyHex = String(pubkey.encode(true, "hex"));
  if (publicKeyHex.length !== 66) {
    throw new Error("Derived public key is not a compressed hex");
  }
  const address = pk.toAddress().toString();
  return {
    privateKeyHex: pk.toHex(),
    wif: pk.toWif(),
    publicKeyHex,
    address
  };
}

/** 把测试钱包私钥 hex 转回 SDK 对象（内部用）。 */
export function loadPrivateKey(privateKeyHex: string): PrivateKey {
  if (typeof privateKeyHex !== "string" || privateKeyHex.length === 0) {
    throw new Error("Test wallet private key hex is empty");
  }
  return PrivateKey.fromHex(privateKeyHex);
}

/**
 * dsha256 = sha256(sha256(x))。BSV 链上 txid / sighash 都走这个。
 *
 * 走 noble hash 而不是 WebCrypto：feepool 同步路径要 deterministic +
 * 能在 Node 测试里跑同步断言，WebCrypto 是 async。
 */
export function dsha256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}