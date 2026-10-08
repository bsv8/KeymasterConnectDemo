// src/lib/protocol.ts
// Keymaster Connect V1 公开协议在 Demo 内的显式镜像。
//
// 设计缘由（施工单 2026-09-18 001 Keymaster 公开方法 / Channel / MSFile 硬切换）：
//   - Demo **不**依赖 Keymaster 内部 contracts 包；这里逐字段镜像
//     `packages/contracts/src/connectPublic.ts`（SDK 公开面）以及
//     `channel.ts` / `msfile.ts` / `connectStorage.ts` 的公开类型，便于暴露
//     外部调用方与 Keymaster 真值的偏差。
//   - feepool.prepare / feepool.commit 不在 Connect 公开面，镜像不保留；
//     公开方法收敛为 23 个。
//   - 与上一版（27 方法 + 2 event）相比：
//       * 删除 appmsg.*（3 方法）与 broadcast.*（3 方法）；
//       * 新增 channel.publish / channel.subscription_set（Channel 是唯一消息抽象）；
//       * 新增 msfile.stat / msfile.seed.read / msfile.block.read；
//       * 公开事件收敛为唯一 `channel.message_received`。
//   - Channel 的 connect session 属于 Session Window transport context，
//     因此 channel.* params **不**携带 connectSessionId；其余业务方法仍必填。
//   - 任何一处字段类型都不得比 Keymaster 更松；放宽即失去对照价值。

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_POPUP_PATH = "/protocol/v1/popup" as const;

export interface BinaryField {
  $type: "binary";
  bytes: ArrayBuffer;
  mime?: string;
}

/**
 * 协议错误码。
 *
 * 设计缘由：错误码集合是稳定可判定的；第三方接入方写 switch 时不应因为
 * 新增错误类型而把"未识别"分支当作成功。msfile_* 为 2026-09 新增。
 */
export type ProtocolErrorCode =
  | "invalid_request"
  | "invalid_origin"
  | "user_rejected"
  | "active_key_unavailable"
  | "decrypt_failed"
  /** 请求的资产未在 Keymaster 设置里开启（如 testnet）。 */
  | "asset_not_enabled"
  | "storage_not_configured"
  | "storage_unavailable"
  | "storage_invalid_path"
  | "storage_not_found"
  | "storage_conflict"
  | "storage_forbidden"
  | "storage_limit_exceeded"
  | "storage_invalid_upload"
  | "storage_provider_error"
  | "storage_identity_required"
  | "msfile_not_configured"
  | "msfile_unavailable"
  | "msfile_identity_required"
  | "msfile_supplier_not_found"
  | "msfile_supplier_disabled"
  | "msfile_invalid_hash"
  | "msfile_price_limit_exceeded"
  | "msfile_integrity_error"
  | "msfile_content_not_found"
  | "msfile_rate_limited"
  | "msfile_supplier_error"
  | "msfile_transport_error"
  | "msfile_protocol_error"
  | "internal_error";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
}

/**
 * 协议方法名常量集合（23 个）。
 *
 * 设计缘由：方法集合是外部调用方与 Keymaster 之间的硬边界；Demo 用这份
 * 常量表做 fail-closed 校验与工作台覆盖检查。费用池（feepool.*）不在
 * Connect 公开面，这里不再镜像。
 */
export const PROTOCOL_METHODS = [
  "identity.get",
  "intent.sign",
  "cipher.encrypt",
  "cipher.decrypt",
  "p2pkh.transfer",
  "connect.login",
  "connect.resume",
  "connect.logout",
  "connect.launch",
  "channel.publish",
  "channel.subscription_set",
  "price.get",
  "price.subscribe",
  "price.unsubscribe",
  "storage.list",
  "storage.directory.create",
  "storage.directory.delete",
  "storage.put",
  "storage.get",
  "storage.delete",



  "msfile.stat",
  "msfile.seed.read",
  "msfile.block.read",
] as const;
export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number];

export interface ProtocolReadyMessage {
  v: typeof PROTOCOL_VERSION;
  type: "ready";
}
export interface ProtocolClosingMessage {
  v: typeof PROTOCOL_VERSION;
  type: "closing";
}
export interface ProtocolCancelMessage {
  v: typeof PROTOCOL_VERSION;
  type: "cancel";
  id: string;
}

/* ============== Channel（2026-09-02 施工单；唯一消息抽象） ============== */

/** ChannelProtocol/SSP 共用的递归 JSON 值。 */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

/** 发布到精确频道的入参；content 由 App 自定义 JSON 协议。 */
export interface ChannelPublishParams {
  /** 精确频道；不允许通配符，≤256 UTF-8 字节，禁控制字符。 */
  channel: string;
  content: JSONValue;
}

export interface ChannelPublishResult {
  /** 由 Keymaster/ChannelProtocol 生成的消息编号。 */
  messageId: string;
}

/** 当前 caller 在 Coordinator/SSP 侧的物理订阅阶段。 */
export type ChannelSubscriptionPhase =
  | "idle"
  | "subscribing"
  | "subscribed"
  | "retrying"
  | "blocked";

/** 订阅失败的稳定业务错误码；不得把底层异常直接暴露给 App。 */
export type ChannelSubscriptionErrorCode =
  | "config"
  | "connect"
  | "identity"
  | "protocol"
  | "balance"
  | "unknown_result"
  | "validation"
  | "unavailable"
  | "conflict";

/** Channel 物理订阅状态快照。 */
export interface ChannelSubscriptionStatus {
  channel: string;
  phase: ChannelSubscriptionPhase;
  errorCode: ChannelSubscriptionErrorCode | null;
  errorMessage: string | null;
  updatedAtMs: number;
}

/** 替换当前 caller 的完整精确频道集合；空数组表示释放。 */
export interface ChannelSubscriptionSetParams {
  /** 最多 64 个、去重、每个都必须是精确频道。 */
  channels: string[];
}

export interface ChannelSubscriptionSetResult {
  /** Coordinator 已接受的逻辑期望集合；不代表物理订阅已完成。 */
  channels: string[];
  /**
   * 每个 accepted channel 的物理状态快照；旧 runtime 可省略。
   * 新 caller 不必等待下一次状态事件。
   */
  statuses?: ChannelSubscriptionStatus[];
}

/** 已验签的入站 Channel 事件数据。 */
export interface ChannelMessageReceivedEventData {
  channel: string;
  /** ChannelProtocol 验签得到的作者压缩公钥 hex。 */
  publisherPublicKeyHex: string;
  /** ChannelProtocol 消息编号。 */
  messageId: string;
  /** 已验签的 App JSON 内容。 */
  content: JSONValue;
}

/**
 * 协议对外 event 名；Channel 只保留一个入站事件。
 *
 * 设计缘由：旧 appmsg.message_received / broadcast.message_received 已随
 * 方法族移除；事件数据一律是已验签 JSON，由 App 自定义业务协议。
 */
export type ProtocolEventName = "channel.message_received" | "price.changed";
export type ProtocolEventMessage =
  | { v: typeof PROTOCOL_VERSION; type: "event"; event: "channel.message_received"; data: ChannelMessageReceivedEventData }
  | { v: typeof PROTOCOL_VERSION; type: "event"; event: "price.changed"; data: PriceValue };

export interface ProtocolRequestMessage<
  M extends ProtocolMethod = ProtocolMethod,
> {
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
  | ProtocolClosingMessage
  | ProtocolCancelMessage
  | ProtocolEventMessage
  | ProtocolRequestMessage
  | ProtocolResultMessage;
export type PopupConnectionState = "opening" | "connected" | "disconnected";

/* ============== identity.get / intent.sign ============== */

export interface IdentityGetParams {
  aud: string;
  iat: number;
  exp: number;
  text: string;
  claims?: string[];
  connectSessionId: string;
}
export type ResolvedClaimValue =
  | string
  | number
  | boolean
  | null
  | BinaryField
  | ResolvedClaimValue[]
  | { [k: string]: ResolvedClaimValue };
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
  connectSessionId: string;
}
export interface IntentSignResult {
  signedEnvelope: BinaryField;
  signature: BinaryField;
}

/* ============== cipher.* ============== */

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
 * Connect 公开的 P2PKH 资产标识。
 *
 * 设计缘由（施工单 2026-09-18 001）：公开值固定 `bsv-mainnet` /
 * `bsv-testnet`；缺省 `bsv-mainnet`。`bsv-testnet` 需要 Keymaster
 * 设置里开启 testnet，否则 `asset_not_enabled`。
 */
export type P2pkhTransferAssetId = "bsv-mainnet" | "bsv-testnet";

export interface P2pkhTransferParams {
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb?: number;
  assetId?: P2pkhTransferAssetId;
  connectSessionId: string;
}
export interface P2pkhTransferResult {
  /** 本次实际转账的资产；缺省回 `bsv-mainnet`。 */
  assetId: P2pkhTransferAssetId;
  txid: string;
  rawTxHex: string;
  feeSatoshis: number;
}

/* ============== App 身份（2026-08 施工单） ============== */

/** 入口 HTML meta 支持的能力声明；是启动前置条件，不是权限。 */
export type AppRequirement = "private-key" | "storage";

/**
 * 由 Core app create 生成并嵌入入口 HTML 的固定应用身份证明。
 *
 * 浏览器只读取这份公开证明，不生成、读取或保存 Publisher 私钥。
 */
export interface AppIdentityProofV1 {
  version: 1;
  publisherPublicKey: string;
  app: {
    id: string;
    name: string;
    description: string;
  };
  requirements: AppRequirement[];
  signature: string;
}

/** Keymaster 本地 session 内保存的 proof digest 快照。 */
export interface VerifiedAppIdentity {
  version: 1;
  publisherPublicKeyHex: string;
  appId: string;
  appName: string;
  identityDigestHex: string;
}

/** 与 Keymaster 公开导出保持一致的别名。 */
export type AppIdentitySnapshot = VerifiedAppIdentity;

/* ============== connect.login / resume / logout / launch ============== */

export interface ConnectLoginParams {
  text: string;
  claims?: string[];
  /** 缺省时建立无 storage / msfile 身份的普通 session。 */
  appIdentity?: AppIdentityProofV1;
}
export interface ConnectLoginResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
  appIdentity?: AppIdentitySnapshot;
}
export interface ConnectResumeParams {
  connectSessionId: string;
}
export interface ConnectResumeResult extends ConnectLoginResult {}
export interface ConnectLogoutParams {
  connectSessionId: string;
}
export interface ConnectLogoutResult {
  connectSessionId: string;
  revokedAt: number;
}
export interface ConnectLaunchParams {
  launchToken: string;
  appIdentity: AppIdentityProofV1;
}
export interface ConnectLaunchResult extends ConnectLoginResult {}

/** 当前价格只用于显示，不参与支付或计费。 */
export interface PriceValue { amount: string; unit: string; updatedAtMs: number; }
export interface PriceGetParams { connectSessionId: string; }
export type PriceGetResult = PriceValue;
export type PriceSubscribeParams = PriceGetParams;
export interface PriceSubscriptionResult { subscribed: boolean; }

/* ============== Storage ============== */

export const STORAGE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const STORAGE_DEFAULT_LIST_LIMIT = 200;
export const STORAGE_MAX_LIST_LIMIT = 1000;
export interface StorageListParams {
  connectSessionId: string;
  prefix?: string;
  cursor?: string;
  limit?: number;
}
export interface StorageListEntry {
  path: string;
  name: string;
  size: number;
  revision?: string;
  lastModified?: string;
}
export interface StorageListResult {
  prefix: string;
  parentPrefix: string;
  directories: Array<{ path: string; name: string }>;
  files: StorageListEntry[];
  markerPath?: string;
  nextCursor?: string;
}
export interface StorageDirectoryParams {
  connectSessionId: string;
  path: string;
  overwrite?: boolean;
}
export interface StorageDirectoryResult {
  path: string;
  created?: boolean;
  deleted?: boolean;
}
export interface StoragePutParams {
  connectSessionId: string;
  path: string;
  content: BinaryField;
  contentType?: string;
  overwrite?: boolean;
}
export interface StoragePutResult {
  path: string;
  size: number;
  revision?: string;
  updatedAt: number;
}
export interface StorageGetParams {
  connectSessionId: string;
  path: string;
  offset?: number;
  length?: number;
  ifMatch?: string;
}
export interface StorageGetResult {
  path: string;
  content: BinaryField;
  contentType?: string;
  offset: number;
  totalSize: number;
  eof: boolean;
  revision?: string;
  lastModified?: string;
}
export interface StorageDeleteParams {
  connectSessionId: string;
  path: string;
}
export interface StorageDeleteResult {
  path: string;
  deleted: true;
  updatedAt: number;
}








/* ============== MSFile（2026-09 施工单） ============== */

/** libp2p protocol ID；wire 真值来自 MSFile Proxy Wire Messages v1。 */
export const MSFILE_PROTOCOL_ID = "/msfile/1.0.0";
export const MSFILE_MAX_HEADER_BYTES = 65536;
export const MSFILE_MAX_SEED_BYTES = 16 * 1024 * 1024;
export const MSFILE_MAX_BLOCK_BYTES = 256 * 1024;
export const MSFILE_MAX_CONTENT_BYTES = MSFILE_MAX_SEED_BYTES;
export const MSFILE_MAX_ERROR_MESSAGE_BYTES = 1024;
export const MSFILE_BLOCK_SIZE_BYTES = 256 * 1024;
export const MSFILE_DIGEST_SIZE_BYTES = 32;

/** 规范十进制字符串形式的 uint64 金额 / 字节数。 */
export type MsFileSatoshiAmount = string;

export interface MsFileStatParams {
  connectSessionId: string;
  seedHashHex: string;
}

export interface MsFileStatAvailableEntry {
  supplierPublicKeyHex: string;
  status: "available";
  recommendedFilename: string;
  fileSizeBytes: MsFileSatoshiAmount;
  mediaType: string;
}

export interface MsFileStatAbsentEntry {
  supplierPublicKeyHex: string;
  status: "absent";
}

export interface MsFileStatDiscoveringEntry {
  supplierPublicKeyHex: string;
  status: "discovering";
  retryAfterMs: number;
}

export interface MsFileStatQuotedEntry {
  supplierPublicKeyHex: string;
  status: "quoted";
  recommendedFilename: string;
  fileSizeBytes: MsFileSatoshiAmount;
  mediaType: string;
  minSeedPriceSatoshis: MsFileSatoshiAmount;
  maxSeedPriceSatoshis: MsFileSatoshiAmount;
  minFullBlockPriceSatoshis: MsFileSatoshiAmount;
  maxFullBlockPriceSatoshis: MsFileSatoshiAmount;
}

/** 网络错误不得折叠成 absent。 */
export interface MsFileStatNetworkErrorEntry {
  supplierPublicKeyHex: string;
  status: "network-error";
}

export type MsFileSupplierStat =
  | MsFileStatAvailableEntry
  | MsFileStatAbsentEntry
  | MsFileStatDiscoveringEntry
  | MsFileStatQuotedEntry
  | MsFileStatNetworkErrorEntry;

type MsFileRemoteSourceStat<T> = T extends MsFileSupplierStat
  ? T & { sourceId: string; sourceKind: "remote-proxy" } : never;
type MsFileLocalSourceStat<T> = T extends MsFileSupplierStat
  ? Omit<T, "supplierPublicKeyHex"> & { sourceId: "local-bitfs"; sourceKind: "local-bitfs" } : never;
export type MsFileSourceStat = MsFileRemoteSourceStat<MsFileSupplierStat> | MsFileLocalSourceStat<MsFileSupplierStat>;

export interface MsFileStatResult {
  seedHashHex: string;
  sources: MsFileSourceStat[];
}

export interface MsFileSeedReadParams {
  connectSessionId: string;
  sourceId: string;
  seedHashHex: string;
}

export interface MsFileBlockReadParams {
  connectSessionId: string;
  sourceId: string;
  seedHashHex: string;
  blockHashHex: string;
}

export interface MsFileReadResult {
  contentHashHex: string;
  content: BinaryField;
}

/* ============== 方法 -> 参数 / 结果 ============== */

export interface MethodParamsMap {
  "identity.get": IdentityGetParams;
  "intent.sign": IntentSignParams;
  "cipher.encrypt": CipherEncryptParams;
  "cipher.decrypt": CipherDecryptParams;
  "p2pkh.transfer": P2pkhTransferParams;
  "connect.login": ConnectLoginParams;
  "connect.resume": ConnectResumeParams;
  "connect.logout": ConnectLogoutParams;
  "connect.launch": ConnectLaunchParams;
  "channel.publish": ChannelPublishParams;
  "channel.subscription_set": ChannelSubscriptionSetParams;
  "price.get": PriceGetParams;
  "price.subscribe": PriceSubscribeParams;
  "price.unsubscribe": PriceSubscribeParams;
  "storage.list": StorageListParams;
  "storage.directory.create": StorageDirectoryParams;
  "storage.directory.delete": StorageDirectoryParams;
  "storage.put": StoragePutParams;
  "storage.get": StorageGetParams;
  "storage.delete": StorageDeleteParams;
  "msfile.stat": MsFileStatParams;
  "msfile.seed.read": MsFileSeedReadParams;
  "msfile.block.read": MsFileBlockReadParams;
}
export type MethodParams<M extends ProtocolMethod> = MethodParamsMap[M];

export interface MethodResultMap {
  "identity.get": IdentityGetResult;
  "intent.sign": IntentSignResult;
  "cipher.encrypt": CipherEncryptResult;
  "cipher.decrypt": CipherDecryptResult;
  "p2pkh.transfer": P2pkhTransferResult;
  "connect.login": ConnectLoginResult;
  "connect.resume": ConnectResumeResult;
  "connect.logout": ConnectLogoutResult;
  "connect.launch": ConnectLaunchResult;
  "channel.publish": ChannelPublishResult;
  "channel.subscription_set": ChannelSubscriptionSetResult;
  "price.get": PriceGetResult;
  "price.subscribe": PriceSubscriptionResult;
  "price.unsubscribe": PriceSubscriptionResult;
  "storage.list": StorageListResult;
  "storage.directory.create": StorageDirectoryResult;
  "storage.directory.delete": StorageDirectoryResult;
  "storage.put": StoragePutResult;
  "storage.get": StorageGetResult;
  "storage.delete": StorageDeleteResult;
  "msfile.stat": MsFileStatResult;
  "msfile.seed.read": MsFileReadResult;
  "msfile.block.read": MsFileReadResult;
}
export type MethodResult<M extends ProtocolMethod = ProtocolMethod> =
  MethodResultMap[M];

export interface DemoSessionSnapshot {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  lastResponse: ConnectLoginResult | ConnectResumeResult | ConnectLaunchResult;
  source: "connect.login" | "connect.resume" | "connect.launch";
  refreshedAt: number;
}
