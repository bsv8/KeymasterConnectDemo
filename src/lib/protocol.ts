// src/lib/protocol.ts
// Keymaster Connect V1 协议 contract 镜像（demo 独立维护）。
//
// 设计缘由（施工单 2026-06-29 002 硬切换：session-first / 16 方法 / cancel）：
//   - demo **不**直接 import `@keymaster/contracts` 充当运行时库；这里只
//     镜像 contract 的外表面（method 名 + params/result 形状 + 错误码 +
//     顶层 message 形态），保持"外部调用方独立性"测试价值。
//   - 协议方法集一次硬切到 16 个：`identity.get` / `intent.sign` /
//     `cipher.encrypt` / `cipher.decrypt` / `p2pkh.transfer` /
//     `feepool.prepare` / `feepool.commit` / `connect.login` /
//     `connect.resume` / `connect.logout` / `connect.launch` /
//     `storage.put` / `storage.get` / `storage.list` / `storage.listAll`
//     / `storage.delete`。
//   - 旧业务方法（identity.get / intent.sign / cipher.* / p2pkh.transfer
//     / feepool.*）统一挂 `connectSessionId` 强制输入；不允许 fallback
//     到 "全局 active key" 或 "缺省 session"。
//   - transport 顶层消息扩到 5 种：`ready` / `request` / `result` /
//     `closing` / `cancel`。`cancel` 是 transport 控制消息，**不**带
//     params，**不**单独产出第二条 result。
//   - 协议错误码补 `not_found`（storage.get / storage.delete 命中不存在
//     对象时返回；属于业务级有效协议错误，不是 transport 错误）。
//   - 所有错误信息走英文；UI 展示由调用方决定。
//
// 字段命名 / 形状与 `/home/david/Workspaces/keymaster.cc/packages/contracts/src/protocol.ts`
// 对齐；具体 CBOR / 签名 / 加解密 / claim 解析都收敛在 keymaster.cc 内
// 部，**不**在 demo 这边重复实现。

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_POPUP_PATH = "/protocol/v1/popup" as const;

export interface BinaryField {
  $type: "binary";
  bytes: ArrayBuffer;
  mime?: string;
}

/**
 * Keymaster Connect V1 全量方法集合（施工单 2026-06-29 002 硬切换）：
 *   - 7 个原业务 / 资金能力：identity.get / intent.sign / cipher.encrypt
 *     / cipher.decrypt / p2pkh.transfer / feepool.prepare / feepool.commit
 *   - 4 个 session 生命周期能力：connect.login / connect.resume /
 *     connect.logout / connect.launch
 *   - 5 个 storage 能力：storage.put / storage.get / storage.list /
 *     storage.listAll / storage.delete
 *
 * 设计缘由：硬切换要求方法集合一次性扩到 16 个；不保留旧 "7 个" 路径。
 */
export const PROTOCOL_METHODS = [
  "identity.get",
  "intent.sign",
  "cipher.encrypt",
  "cipher.decrypt",
  "p2pkh.transfer",
  "feepool.prepare",
  "feepool.commit",
  "connect.login",
  "connect.resume",
  "connect.logout",
  "connect.launch",
  "storage.put",
  "storage.get",
  "storage.list",
  "storage.listAll",
  "storage.delete"
] as const;

export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number];

export type ProtocolErrorCode =
  | "invalid_request"
  | "invalid_origin"
  | "user_rejected"
  | "active_key_unavailable"
  | "decrypt_failed"
  | "not_found"
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

/**
 * 顶层 `cancel` 报文（施工单 2026-06-29 002 硬切换）。
 *
 * 设计缘由：
 *   - cancel 是 transport 控制消息，**不是**业务 method；不允许做成
 *     `method: "cancel"` 的伪 request。
 *   - `cancel.id` 指向**已经发出**的 `request.id`；popup 只尝试取消
 *     当前会话中绑定的那条 request。被取消的是原 request，所以最终
 *     仍由原 request 回 `result(ok=false)`。
 *   - cancel 自己**不**回一条新 result；这条不变量是 cancel 与普通
 *     request 的关键边界。
 *   - 校验失败（缺 v / id / type 不匹配）走 `invalid_request`。
 */
export interface ProtocolCancelMessage {
  v: typeof PROTOCOL_VERSION;
  type: "cancel";
  /** 要取消的原 `request.id`。 */
  id: string;
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
  | ProtocolClosingMessage
  | ProtocolCancelMessage;

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

/* ============== identity.get ============== */

/**
 * `identity.get` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - `connectSessionId` 是**强制**输入字段；所有外部业务方法都属于
 *     某个 `connectSessionId`（仅 `connect.login` 例外）。缺该字段直接
 *     `invalid_request` 拒绝。
 *   - `identity.get` 不再是"推荐登录入口"；登录走 `connect.login`。
 *     `identity.get` 是"会话内身份断言能力"——`subject` 取自 session
 *     绑定 owner，不是当前钱包 active key。
 */
export interface IdentityGetParams {
  /** 目标站点 origin；必须等于 `event.origin`，否则 `invalid_origin`。 */
  aud: string;
  /** 签发时间（unix seconds）。 */
  iat: number;
  /** 过期时间（unix seconds）；必须严格大于 iat。 */
  exp: number;
  /** 人类可读确认文案。 */
  text: string;
  /** 请求索要的 claim 名列表；缺省 = 不返回任何 claim。 */
  claims?: string[];
  /** `connect.login` 返回的 sessionId。**必填**。 */
  connectSessionId: string;
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

/* ============== intent.sign ============== */

/**
 * `intent.sign` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - `connectSessionId` 是**强制**输入字段；签名主体公钥取自 session
 *     绑定 owner。
 */
export interface IntentSignParams {
  aud: string;
  iat: number;
  exp: number;
  text: string;
  contentType: string;
  content: BinaryField;
  connectSessionId: string;
}

export interface IntentSignResult {
  signedEnvelope: BinaryField;
  signature: BinaryField;
}

/* ============== cipher.encrypt / cipher.decrypt ============== */

/**
 * `cipher.encrypt` 请求参数。
 *
 * 设计缘由：`connectSessionId` 强制；cipher 不再读取全局 active key。
 */
export interface CipherEncryptParams {
  text: string;
  contentType: string;
  content: BinaryField;
  connectSessionId: string;
}

export interface CipherEncryptResult {
  nonce: BinaryField;
  cipherbytes: BinaryField;
}

/**
 * `cipher.decrypt` 请求参数。
 *
 * 设计缘由：与 `cipher.encrypt` 对称——`connectSessionId` 强制。
 */
export interface CipherDecryptParams {
  text: string;
  nonce: BinaryField;
  cipherbytes: BinaryField;
  connectSessionId: string;
}

export interface CipherDecryptResult {
  contentType: string;
  content: BinaryField;
}

/* ============== p2pkh.transfer ============== */

/**
 * `p2pkh.transfer` 请求参数。
 *
 * 设计缘由：
 *   - 仅支持主网 P2PKH（base58check，version 0x00）。
 *   - `aud` 由 popup 端按 `event.origin` 自动绑定，site 不传。
 *   - `feeRateSatoshisPerKb` 可选；缺省走 service 保守默认值。
 *   - `connectSessionId` 强制；资金 owner 取自 session 绑定 owner。
 */
export interface P2pkhTransferParams {
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb?: number;
  connectSessionId: string;
}

export interface P2pkhTransferResult {
  /** canonical txid（双 sha256 + 字节序反转）。 */
  txid: string;
  /** 已签名交易 raw hex。 */
  rawTxHex: string;
  /** 实际花费的 fee satoshis。 */
  feeSatoshis: number;
}

/* ============== feepool.prepare / feepool.commit ============== */

/** fee pool 三种 action。Keymaster 单边决定，site 不传。 */
export type ProtocolFeePoolAction = "create" | "spend" | "close_and_recreate";

/**
 * `feepool.prepare` 请求参数。
 *
 * 设计缘由：
 *   - site 只提交对端公钥 + 本次金额。
 *   - action（create / spend / close_and_recreate）和 lockHeight 由
 *     Keymaster 单边决定。
 *   - `connectSessionId` 强制；fee pool 按 (origin + ownerPublicKeyHex
 *     + counterpartyPublicKeyHex) 三个维度归档，不同 owner 不串池。
 */
export interface FeepoolPrepareParams {
  /** 33-byte compressed secp256k1 公钥 hex（66 字符）。 */
  counterpartyPublicKeyHex: string;
  /** 本次想转给对端的金额（satoshis，正整数）。 */
  amountSatoshis: number;
  connectSessionId: string;
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

/**
 * `feepool.commit` 请求参数。
 *
 * 设计缘由：
 *   - `operationId` 只在当前 popup 会话内有效；popup 关闭后失效。
 *   - `connectSessionId` 强制；`feepool.commit` 必须按
 *     `connectSessionId + origin + ownerPublicKeyHex` 校验 pending op。
 *   - `closeCounterpartySignatures` 仅 `close_and_recreate` 路径下传入。
 */
export interface FeepoolCommitParams {
  /** 由 prepare 阶段返回的 operationId；只在本 popup 会话内有效。 */
  operationId: string;
  /** 33-byte compressed secp256k1 公钥 hex。 */
  counterpartyPublicKeyHex: string;
  /** 主 B-Tx 草稿上的对端（counterparty）签名数组。 */
  counterpartySignatures: BinaryField[];
  /** 仅 close_and_recreate 的 close 部分对端签名。 */
  closeCounterpartySignatures?: BinaryField[];
  connectSessionId: string;
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

/* ============== connect.login / connect.resume / connect.logout ============== */

/**
 * `connect.login` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - **不**在 params 里携带 ownerPublicKeyHex：owner 是用户在 popup UI
 *     上选定的，caller 不能代替用户决定。
 *   - caller 只传 `text` + 可选 `claims`。
 *   - `origin` 走 `event.origin`，params 不允许覆盖。
 */
export interface ConnectLoginParams {
  /** 人类可读确认文案。 */
  text: string;
  /** 请求索要的 claim 名列表（与 `identity.get` 同语义）。 */
  claims?: string[];
}

/**
 * `connect.login` 成功结果。
 *
 * 设计缘由：返回 sessionId + owner + resolvedClaims 三元组；caller 把
 * sessionId 持久化在本地，后续 connect.resume / 业务方法都用它。
 *
 * **不**再返回 `ownerKeyId`；owner 唯一真值 = `ownerPublicKeyHex`。
 */
export interface ConnectLoginResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** 本次解析时间（unix milliseconds）。 */
  resolvedAt: number;
}

/**
 * `connect.resume` 请求参数。
 *
 * 设计缘由：resume 必须显式传入 sessionId；service 按
 * `event.origin` + sessionId 查 session 记录。
 */
export interface ConnectResumeParams {
  connectSessionId: string;
}

/** `connect.resume` 成功结果（与 `connect.login` 对称）。 */
export interface ConnectResumeResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** 本次 resume 时间戳，**不**是 connect.login 时的快照时间。 */
  resolvedAt: number;
}

/**
 * `connect.logout` 请求参数。
 *
 * 设计缘由：logout 只需要 sessionId。
 */
export interface ConnectLogoutParams {
  connectSessionId: string;
}

/** `connect.logout` 成功结果。 */
export interface ConnectLogoutResult {
  connectSessionId: string;
  /** 吊销时间（unix milliseconds）。 */
  revokedAt: number;
}

/* ============== connect.launch ============== */

/**
 * `connect.launch` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - `connect.launch` 是 `appView` mode 下 client app 的**唯一**首登
 *     入口；消费 launcher 交给 client app 的 `launchToken`。
 *   - 不传 aud / iat / exp —— login 时机由 launcher 一次性 bootstrap
 *     阶段决定。
 *   - 失败按 fail-closed：launchToken 缺失 / 已消费 / 当前 Session Window
 *     不在 `appView` mode / caller origin 与 bootstrap 期记录不一致 →
 *     拒掉；**不**允许 fallback 到 `connect.login`。
 *   - demo **不**伪造 launcher bootstrap；没有真实 launchToken 时失败
 *     是预期行为。
 */
export interface ConnectLaunchParams {
  /** 由 launcher 写入 client app 启动 URL 的 launchToken。一次性消费。 */
  launchToken: string;
}

/** `connect.launch` 成功结果（与 `connect.login` 对齐）。 */
export interface ConnectLaunchResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
}

/* ============== storage.put / get / list / listAll / delete ============== */

/**
 * `storage.put` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - `connectSessionId` 强制输入；namespace 真值完全来自 session，
 *     **不**读 `appViewContext`。
 *   - `path` 是相对路径；Keymaster 在 execute 入口做 normalize + 越界
 *     检查。
 *   - `contentType` 可选；与明文一起被透明加密进对象内容；解密时原样
 *     返回。
 *   - `content` 是 `BinaryField`；明文写入由 Keymaster 在 Session Window
 *     内部完成加密；S3 侧只能看到密文 + 路径名 + 元数据。
 */
export interface StoragePutParams {
  connectSessionId: string;
  /** 相对路径，统一 `/` 分隔。 */
  path: string;
  contentType?: string;
  content: BinaryField;
}

/** `storage.put` 成功结果。 */
export interface StoragePutResult {
  /** 物理对象 key。app 端一般不感知；用于调试 / 测试。 */
  objectKey: string;
  /** 服务端最后更新时间（unix milliseconds）。S3 侧回填。 */
  updatedAt: number;
}

/** `storage.get` 请求参数。 */
export interface StorageGetParams {
  connectSessionId: string;
  path: string;
}

/**
 * `storage.get` 成功结果。对象不存在时返回 `not_found` 错误
 * （属于协议错误，**不**是 transport 错误）。
 */
export interface StorageGetResult {
  contentType?: string;
  content: BinaryField;
  updatedAt?: number;
}

/** `storage.list` 请求参数。 */
export interface StorageListParams {
  connectSessionId: string;
  /** 相对路径前缀；空串表示当前虚拟桶根。 */
  prefix: string;
}

/** 单条 list 结果。 */
export interface StorageListEntry {
  path: string;
  updatedAt?: number;
}

/** `storage.list` / `storage.listAll` 成功结果。 */
export interface StorageListResult {
  entries: StorageListEntry[];
}

/** `storage.listAll` 请求参数。 */
export interface StorageListAllParams {
  connectSessionId: string;
}

/** `storage.delete` 请求参数。对象不存在时返回 `not_found` 错误。 */
export interface StorageDeleteParams {
  connectSessionId: string;
  path: string;
}

/** `storage.delete` 成功结果。 */
export interface StorageDeleteResult {
  deleted: true;
  updatedAt: number;
}

/* ============== Method dispatch ============== */

export interface MethodParamsMap {
  "identity.get": IdentityGetParams;
  "intent.sign": IntentSignParams;
  "cipher.encrypt": CipherEncryptParams;
  "cipher.decrypt": CipherDecryptParams;
  "p2pkh.transfer": P2pkhTransferParams;
  "feepool.prepare": FeepoolPrepareParams;
  "feepool.commit": FeepoolCommitParams;
  "connect.login": ConnectLoginParams;
  "connect.resume": ConnectResumeParams;
  "connect.logout": ConnectLogoutParams;
  "connect.launch": ConnectLaunchParams;
  "storage.put": StoragePutParams;
  "storage.get": StorageGetParams;
  "storage.list": StorageListParams;
  "storage.listAll": StorageListAllParams;
  "storage.delete": StorageDeleteParams;
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
  "connect.login": ConnectLoginResult;
  "connect.resume": ConnectResumeResult;
  "connect.logout": ConnectLogoutResult;
  "connect.launch": ConnectLaunchResult;
  "storage.put": StoragePutResult;
  "storage.get": StorageGetResult;
  "storage.list": StorageListResult;
  "storage.listAll": StorageListResult;
  "storage.delete": StorageDeleteResult;
}

export type MethodResult<M extends ProtocolMethod = ProtocolMethod> = M extends keyof MethodResultMap
  ? MethodResultMap[M]
  : never;

/**
 * 当前 demo session 的最小真值。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - session = `connectSessionId` + `ownerPublicKeyHex` + `resolvedClaims`
 *     摘要；
 *   - 后续业务方法表单默认引用当前 sessionId；用户仍可手改用于故障路径
 *     测试。
 *   - 只在 demo 自己内存 / localStorage 里存这一份最小字段；**不**存
 *     unlock runtime，**不**存 Keymaster 敏感材料。
 */
export interface DemoSessionSnapshot {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  /** 最近一次解析得到的 claims 摘要；按 method 分桶存最后一次快照。 */
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** 最近一次登录 / 恢复 / launch 的结果对象；用于 UI 展示。 */
  lastResponse: ConnectLoginResult | ConnectResumeResult | ConnectLaunchResult;
  /** 最近一次 session 真值的产生方式。 */
  source: "connect.login" | "connect.resume" | "connect.launch";
  /** 最近一次刷新时间（unix milliseconds）。 */
  refreshedAt: number;
}