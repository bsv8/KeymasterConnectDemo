export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_POPUP_PATH = "/protocol/v1/popup" as const;

export interface BinaryField {
  $type: "binary";
  bytes: ArrayBuffer;
  mime?: string;
}

/**
 * Keymaster Connect V1 全量方法集合（施工单 p2pkh / feepool 硬切换）：
 *   - 4 个原有能力：identity.get / intent.sign / cipher.encrypt / cipher.decrypt
 *   - 3 个新增能力：p2pkh.transfer / feepool.prepare / feepool.commit
 *
 * 设计缘由：硬切换要求方法集合一次性扩到 7 个；不保留旧"4 个"路径。
 */
export const PROTOCOL_METHODS = [
  "identity.get",
  "intent.sign",
  "cipher.encrypt",
  "cipher.decrypt",
  "p2pkh.transfer",
  "feepool.prepare",
  "feepool.commit"
] as const;

export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number];

export type ProtocolErrorCode =
  | "invalid_request"
  | "invalid_origin"
  | "user_rejected"
  | "active_key_unavailable"
  | "decrypt_failed"
  | "internal_error";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
}

export interface ProtocolReadyMessage {
  v: typeof PROTOCOL_VERSION;
  type: "ready";
}

/**
 * 顶层 `closing` 报文：popup 生命周期结束信号。
 *
 * 与 `ready` 对偶。`closing` 只承载连接结束语义：
 *   - 不携带业务结果；
 *   - 不替代 `result`；
 *   - 不携带 `error` / `ok` / `id` 等业务字段。
 *
 * client 侧状态机规则：
 *   - 收到 `closing` → 收敛到 `disconnected`；
 *   - 轮询到 `popup.closed === true` → 收敛到 `disconnected`；
 *   - 两者并联幂等。
 */
export interface ProtocolClosingMessage {
  v: typeof PROTOCOL_VERSION;
  type: "closing";
}

export interface ProtocolRequestMessage<M extends ProtocolMethod = ProtocolMethod> {
  v: typeof PROTOCOL_VERSION;
  type: "request";
  id: string;
  method: M;
  params: MethodParams<M>;
}

export type ProtocolResultMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      type: "result";
      id: string;
      ok: true;
      result: MethodResult;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      type: "result";
      id: string;
      ok: false;
      error: ProtocolError;
    };

export type ProtocolMessage =
  | ProtocolReadyMessage
  | ProtocolRequestMessage
  | ProtocolResultMessage
  | ProtocolClosingMessage;

/**
 * popup 连接状态机（窗口级别，与 request 级别无关）。
 *
 * 转移规则：
 *   - `window.open(...)` 成功 → `opening`；
 *   - 收到 `ready` → `connected`；
 *   - 收到 `closing` → `disconnected`；
 *   - 轮询到 `popup.closed === true` → `disconnected`；
 *   - 重复 `closing` / 重复 `popup.closed === true` 幂等忽略；
 *   - `disconnected` 是终态。
 *
 * 不做心跳，不引入 MessageChannel。
 */
export type PopupConnectionState = "opening" | "connected" | "disconnected";

export interface IdentityGetParams {
  aud: string;
  iat: number;
  exp: number;
  text: string;
  claims?: string[];
}

export type ResolvedClaimValue =
  | string
  | number
  | boolean
  | null
  | BinaryField
  | ResolvedClaimValue[]
  | { [key: string]: ResolvedClaimValue };

export interface IdentityGetResult {
  identityEnvelope: BinaryField;
  signature: BinaryField;
  subject: { publicKey: BinaryField };
  resolvedClaims: Record<string, ResolvedClaimValue>;
}

export interface IntentSignParams {
  aud: string;
  iat: number;
  exp: number;
  text: string;
  contentType: string;
  content: BinaryField;
}

export interface IntentSignResult {
  signedEnvelope: BinaryField;
  signature: BinaryField;
}

export interface CipherEncryptParams {
  text: string;
  contentType: string;
  content: BinaryField;
}

export interface CipherEncryptResult {
  nonce: BinaryField;
  cipherbytes: BinaryField;
}

export interface CipherDecryptParams {
  text: string;
  nonce: BinaryField;
  cipherbytes: BinaryField;
}

export interface CipherDecryptResult {
  contentType: string;
  content: BinaryField;
}

/* ============== 硬切换新增：p2pkh.transfer ============== */

/**
 * `p2pkh.transfer` 请求参数。
 *
 * 仅支持主网 P2PKH（base58check，version 0x00）。
 * `aud` 由 popup 端按 `event.origin` 自动绑定，site 不传。
 * `feeRateSatoshisPerKb` 可选；缺省由 service 走保守默认值。
 */
export interface P2pkhTransferParams {
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb?: number;
}

/** `p2pkh.transfer` 成功结果。 */
export interface P2pkhTransferResult {
  /** canonical txid（双 sha256 + 字节序反转）。 */
  txid: string;
  /** 已签名交易 raw hex。 */
  rawTxHex: string;
  /** 实际花费的 fee satoshis。 */
  feeSatoshis: number;
}

/* ============== 硬切换新增：feepool.prepare / feepool.commit ============== */

/** fee pool 三种 action。Keymaster 单边决定，site 不传。 */
export type ProtocolFeePoolAction = "create" | "spend" | "close_and_recreate";

/** `feepool.prepare` 请求参数。site 只提交对端公钥 + 本次金额。 */
export interface FeepoolPrepareParams {
  /** 33-byte compressed secp256k1 公钥 hex（66 字符）。 */
  counterpartyPublicKeyHex: string;
  /** 本次想转给对端的金额（satoshis，正整数）。 */
  amountSatoshis: number;
}

/**
 * `feepool.prepare` 成功结果。
 *
 * 三种 action 共有的字段：
 *   - `draftSpendTxHex`：当前 B-Tx 草稿（site 与 server 持续协商的对象）。
 *   - `draftClientSignBytes`：当前草稿上 Keymaster（client 角色）的部分签名。
 *
 * 仅 `create` / `close_and_recreate` 出现：
 *   - `baseTxHex` / `baseTxOutputIndex`：建池那笔 A-Tx。
 *
 * 仅 `close_and_recreate` 出现：
 *   - `closeDraftTxHex` / `closeClientSignBytes`：旧池的 close 版本草稿与签名。
 */
export interface FeepoolPrepareResult {
  operationId: string;
  action: ProtocolFeePoolAction;
  counterpartyPublicKeyHex: string;
  amountSatoshis: number;
  /** A-Tx hex；仅 create / close_and_recreate。 */
  baseTxHex?: string;
  /** multisig output 在 A-Tx 里的 vout index；仅 create / close_and_recreate。 */
  baseTxOutputIndex?: number;
  /** 当前 B-Tx 草稿 hex（持续协商对象，不是真广播的 tx）。 */
  draftSpendTxHex: string;
  /** 当前草稿上 Keymaster（client 角色）的部分签名。 */
  draftClientSignBytes: BinaryField;
  /** close_and_recreate 的 close 部分草稿 hex。 */
  closeDraftTxHex?: string;
  /** close 部分草稿上的 client 部分签名。 */
  closeClientSignBytes?: BinaryField;
  /** 决策时参考的旧池快照（仅 spend / close_and_recreate）。 */
  priorPoolRecord?: {
    baseTxid: string;
    totalAmount: number;
    serverAmount: number;
    draftSpendTxHex?: string;
  } | null;
}

/** `feepool.commit` 请求参数。 */
export interface FeepoolCommitParams {
  /** 由 prepare 阶段返回的 operationId；只在本 popup 会话内有效。 */
  operationId: string;
  /** 33-byte compressed secp256k1 公钥 hex。 */
  counterpartyPublicKeyHex: string;
  /** 主 B-Tx 草稿上的对端（counterparty）签名数组。 */
  counterpartySignatures: BinaryField[];
  /** 仅 close_and_recreate 的 close 部分对端签名。 */
  closeCounterpartySignatures?: BinaryField[];
}

/** `feepool.commit` 成功结果。 */
export interface FeepoolCommitResult {
  operationId: string;
  action: ProtocolFeePoolAction;
  /** 当前主 B-Tx 草稿的 txid。 */
  draftTxid: string;
  /** 当前主 B-Tx 草稿的 raw tx hex。 */
  draftTxHex: string;
  /** 仅 close_and_recreate：旧池 close 草稿的 txid。 */
  closeDraftTxid?: string;
}

export interface MethodParamsMap {
  "identity.get": IdentityGetParams;
  "intent.sign": IntentSignParams;
  "cipher.encrypt": CipherEncryptParams;
  "cipher.decrypt": CipherDecryptParams;
  "p2pkh.transfer": P2pkhTransferParams;
  "feepool.prepare": FeepoolPrepareParams;
  "feepool.commit": FeepoolCommitParams;
}

export type MethodParams<M extends ProtocolMethod> = M extends keyof MethodParamsMap
  ? MethodParamsMap[M]
  : never;

export interface MethodResultMap {
  "identity.get": IdentityGetResult;
  "intent.sign": IntentSignResult;
  "cipher.encrypt": CipherEncryptResult;
  "cipher.decrypt": CipherDecryptResult;
  "p2pkh.transfer": P2pkhTransferResult;
  "feepool.prepare": FeepoolPrepareResult;
  "feepool.commit": FeepoolCommitResult;
}

export type MethodResult<M extends ProtocolMethod = ProtocolMethod> = M extends keyof MethodResultMap
  ? MethodResultMap[M]
  : never;