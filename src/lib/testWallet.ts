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

import { PrivateKey, Utils } from "@bsv/sdk";

/**
 * 测试钱包网络（施工单 2026-09-18 001）。
 *
 * `main` = bsv-mainnet；`test` = bsv-testnet。地址 / WIF / WOC 查询
 * 都必须按同一个网络走，避免主网私钥派生出 testnet 地址这类串网错误。
 */
export type TestWalletNetwork = "main" | "test";

/** 内存态测试钱包对象。 */
export interface TestWallet {
  /** 32-byte secp256k1 私钥 hex（66 字符）。 */
  privateKeyHex: string;
  /** 对应网络的 WIF（mainnet 0x80 / testnet 0xef）。 */
  wif: string;
  /** 33-byte compressed 公钥 hex（66 字符）。 */
  publicKeyHex: string;
  /** 对应网络的 P2PKH 地址。 */
  address: string;
  /** 该钱包所属网络。 */
  network: TestWalletNetwork;
}

/**
 * 随机生成一把 demo 用的测试钱包私钥（WIF + 派生 hex）。
 *
 * 设计缘由：硬切换要求 demo 必须能"生成测试私钥"路径，不能只是"导入"
 * 路径——手动导入门槛太高。
 */
export function generateTestWallet(network: TestWalletNetwork = "main"): TestWallet {
  return deriveTestWallet(PrivateKey.fromRandom(), network);
}

/**
 * 从 WIF 还原一把测试钱包。
 *
 * 网络真值来自 WIF 的 version byte（0x80 main / 0xef test）；`@bsv/sdk`
 * 的 `fromWif` 不区分网络，所以这里先用 `Utils.fromBase58Check` 读前缀。
 */
export function importTestWallet(wif: string): TestWallet {
  const trimmed = wif.trim();
  if (trimmed.length === 0) {
    throw new Error("Test wallet WIF is empty");
  }
  let network: TestWalletNetwork = "main";
  try {
    const decoded = Utils.fromBase58Check(trimmed);
    const prefix = decoded.prefix as number[];
    if (prefix.length === 1 && prefix[0] === 0xef) network = "test";
  } catch (err) {
    throw new Error(`Invalid WIF: ${err instanceof Error ? err.message : String(err)}`);
  }
  let pk: PrivateKey;
  try {
    pk = PrivateKey.fromWif(trimmed);
  } catch (err) {
    throw new Error(`Invalid WIF: ${err instanceof Error ? err.message : String(err)}`);
  }
  return deriveTestWallet(pk, network);
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
 *   - P2PKH 地址按 network 派生：main version 0x00 / test version 0x6f。
 *   - 公钥必须是 compressed（33 字节，前缀 02/03）。
 */
export function deriveTestWallet(
  pk: PrivateKey,
  network: TestWalletNetwork = "main"
): TestWallet {
  const pubkey = pk.toPublicKey();
  // `encode(true, 'hex')` returns the 33-byte SEC1 compressed hex (02/03 prefix).
  const publicKeyHex = String(pubkey.encode(true, "hex"));
  if (publicKeyHex.length !== 66) {
    throw new Error("Derived public key is not a compressed hex");
  }
  const address = pk.toAddress(network === "test" ? "testnet" : "mainnet").toString();
  return {
    privateKeyHex: pk.toHex(),
    wif: network === "test" ? pk.toWif([0xef]) : pk.toWif(),
    publicKeyHex,
    address,
    network
  };
}

/** 从 32-byte hex 私钥派生指定网络的测试钱包（e2e 预置 key 用）。 */
export function deriveTestWalletFromHex(
  privateKeyHex: string,
  network: TestWalletNetwork = "main"
): TestWallet {
  return deriveTestWallet(loadPrivateKey(privateKeyHex), network);
}

/** 把测试钱包私钥 hex 转回 SDK 对象（内部用）。 */
export function loadPrivateKey(privateKeyHex: string): PrivateKey {
  if (typeof privateKeyHex !== "string" || privateKeyHex.length === 0) {
    throw new Error("Test wallet private key hex is empty");
  }
  return PrivateKey.fromHex(privateKeyHex);
}