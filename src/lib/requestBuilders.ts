// src/lib/requestBuilders.ts
// 集中管理所有协议方法的请求构包 helper。
//
// 设计缘由（施工单 2026-06-29 002 硬切换 8.3 + 施工单 2026-09-18 001
//          Keymaster 26 方法 / Channel / MSFile 硬切换）：
//   - 不在 App.tsx 里散落构包逻辑；按 method 收敛成显式 builder。
//   - 每个 builder 返回的是符合 `MethodParamsMap[M]` 的对象，**不**
//     触发任何 popup side-effect；调用方拿到对象后再交 session client。
//   - 业务方法（identity.get / intent.sign / cipher.* / p2pkh.transfer /
//     feepool.* / storage.* / msfile.*）的 builder 都会带上
//     `connectSessionId` 字段；调用方负责从当前 session state 提供，
//     没有时由 builder 直接抛错。
//   - **例外**：channel.* 的 connect session 属于 Session Window transport
//     context，不属于 App params；builder 不带 `connectSessionId`，
//     调用方必须先在同一窗口完成 connect.login / connect.resume。
//   - connect.login / connect.launch 不带 sessionId（前者是登录入口，
//     后者由 launcher bootstrap 提供 launchToken）。
//   - 当前 builder 覆盖 26 种现行方法；**不**做 "deprecated 壳"伪兼容。
//   - channel.* builder 显式 fail-closed：精确频道形状、JSON content 深度
//     和订阅集合上限都在本地先挡一次，避免把必然失败的请求发给 Keymaster。
//   - msfile.* builder 不接受调用方金额；hash / supplier 公钥按 Keymaster
//     契约要求小写 hex。

import type {
  AppIdentityProofV1,
  ChannelPublishParams,
  ChannelSubscriptionSetParams,
  CipherDecryptParams,
  CipherEncryptParams,
  ConnectLaunchParams,
  ConnectLoginParams,
  ConnectLogoutParams,
  ConnectResumeParams,
  FeepoolCommitParams,
  FeepoolPrepareParams,
  IdentityGetParams,
  IntentSignParams,
  JSONValue,
  MsFileBlockReadParams,
  MsFileSeedReadParams,
  MsFileStatParams,
  P2pkhTransferParams,
  ProtocolRequestMessage,
} from "./protocol";
import { isAppIdentityProof } from "./appIdentityProof";

/**
 * 在请求构包前校验 sessionId 已就绪；缺时直接 throw。
 *
 * 设计缘由：业务方法统一走 "当前 sessionId + 可手改" 策略；调用方
 * 必须明确提供 sessionId，避免 demo 静默用错 session。
 */
export function requireSessionId(sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("connectSessionId is required for this method");
  }
  return sessionId;
}

function buildRequest<M extends import("./protocol").ProtocolMethod>(
  method: M,
  id: string,
  params: import("./protocol").MethodParams<M>,
): ProtocolRequestMessage<M> {
  return {
    v: 1,
    type: "request",
    id,
    method,
    params,
  };
}

export function makeRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ============== connect.* ============== */

export function buildConnectLoginRequest(input: {
  id?: string;
  text: string;
  claims?: string[];
  appIdentity: AppIdentityProofV1;
}): ProtocolRequestMessage<"connect.login"> {
  if (!isAppIdentityProof(input.appIdentity)) {
    throw new Error("appIdentity proof is invalid");
  }
  const params: ConnectLoginParams = {
    text: input.text,
    claims: input.claims,
    appIdentity: input.appIdentity,
  };
  return buildRequest("connect.login", input.id ?? makeRequestId(), params);
}

export function buildConnectResumeRequest(input: {
  id?: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"connect.resume"> {
  const params: ConnectResumeParams = {
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("connect.resume", input.id ?? makeRequestId(), params);
}

export function buildConnectLogoutRequest(input: {
  id?: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"connect.logout"> {
  const params: ConnectLogoutParams = {
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("connect.logout", input.id ?? makeRequestId(), params);
}

export function buildConnectLaunchRequest(input: {
  id?: string;
  launchToken: string;
  appIdentity: AppIdentityProofV1;
}): ProtocolRequestMessage<"connect.launch"> {
  if (!isAppIdentityProof(input.appIdentity)) {
    throw new Error("appIdentity proof is invalid");
  }
  const params: ConnectLaunchParams = {
    launchToken: input.launchToken,
    appIdentity: input.appIdentity,
  };
  return buildRequest("connect.launch", input.id ?? makeRequestId(), params);
}

/* ============== identity.get / intent.sign ============== */

export function buildIdentityGetRequest(input: {
  id?: string;
  aud: string;
  iat: number;
  exp: number;
  text: string;
  claims?: string[];
  connectSessionId: string;
}): ProtocolRequestMessage<"identity.get"> {
  if (input.exp <= input.iat) {
    throw new Error("exp must be greater than iat");
  }
  const params: IdentityGetParams = {
    aud: input.aud,
    iat: input.iat,
    exp: input.exp,
    text: input.text,
    claims: input.claims,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("identity.get", input.id ?? makeRequestId(), params);
}

export function buildIntentSignRequest(input: {
  id?: string;
  aud: string;
  iat: number;
  exp: number;
  text: string;
  contentType: string;
  content: import("./protocol").BinaryField;
  connectSessionId: string;
}): ProtocolRequestMessage<"intent.sign"> {
  if (input.exp <= input.iat) {
    throw new Error("exp must be greater than iat");
  }
  const params: IntentSignParams = {
    aud: input.aud,
    iat: input.iat,
    exp: input.exp,
    text: input.text,
    contentType: input.contentType,
    content: input.content,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("intent.sign", input.id ?? makeRequestId(), params);
}

/* ============== cipher.* ============== */

export function buildCipherEncryptRequest(input: {
  id?: string;
  text: string;
  contentType: string;
  content: import("./protocol").BinaryField;
  connectSessionId: string;
}): ProtocolRequestMessage<"cipher.encrypt"> {
  const params: CipherEncryptParams = {
    text: input.text,
    contentType: input.contentType,
    content: input.content,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("cipher.encrypt", input.id ?? makeRequestId(), params);
}

export function buildCipherDecryptRequest(input: {
  id?: string;
  text: string;
  nonce: import("./protocol").BinaryField;
  cipherbytes: import("./protocol").BinaryField;
  connectSessionId: string;
}): ProtocolRequestMessage<"cipher.decrypt"> {
  const params: CipherDecryptParams = {
    text: input.text,
    nonce: input.nonce,
    cipherbytes: input.cipherbytes,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("cipher.decrypt", input.id ?? makeRequestId(), params);
}

/* ============== p2pkh.transfer ============== */

export function buildP2pkhTransferRequest(input: {
  id?: string;
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb?: number;
  connectSessionId: string;
}): ProtocolRequestMessage<"p2pkh.transfer"> {
  if (!Number.isFinite(input.amountSatoshis) || input.amountSatoshis <= 0) {
    throw new Error("amountSatoshis must be a positive integer");
  }
  const params: P2pkhTransferParams = {
    recipientAddress: input.recipientAddress,
    amountSatoshis: input.amountSatoshis,
    feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("p2pkh.transfer", input.id ?? makeRequestId(), params);
}

/* ============== feepool.* ============== */

export function buildFeepoolPrepareRequest(input: {
  id?: string;
  counterpartyPublicKeyHex: string;
  amountSatoshis: number;
  connectSessionId: string;
}): ProtocolRequestMessage<"feepool.prepare"> {
  if (!/^[0-9a-fA-F]{66}$/.test(input.counterpartyPublicKeyHex)) {
    throw new Error(
      "counterpartyPublicKeyHex must be 33-byte compressed hex (66 chars)",
    );
  }
  if (!Number.isFinite(input.amountSatoshis) || input.amountSatoshis <= 0) {
    throw new Error("amountSatoshis must be a positive integer");
  }
  const params: FeepoolPrepareParams = {
    counterpartyPublicKeyHex: input.counterpartyPublicKeyHex,
    amountSatoshis: input.amountSatoshis,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("feepool.prepare", input.id ?? makeRequestId(), params);
}

export function buildFeepoolCommitRequest(input: {
  id?: string;
  operationId: string;
  counterpartyPublicKeyHex: string;
  counterpartySignatures: import("./protocol").BinaryField[];
  closeCounterpartySignatures?: import("./protocol").BinaryField[];
  connectSessionId: string;
}): ProtocolRequestMessage<"feepool.commit"> {
  if (!/^[0-9a-fA-F]{66}$/.test(input.counterpartyPublicKeyHex)) {
    throw new Error(
      "counterpartyPublicKeyHex must be 33-byte compressed hex (66 chars)",
    );
  }
  if (
    !Array.isArray(input.counterpartySignatures) ||
    input.counterpartySignatures.length === 0
  ) {
    throw new Error("counterpartySignatures must be a non-empty array");
  }
  const params: FeepoolCommitParams = {
    operationId: input.operationId,
    counterpartyPublicKeyHex: input.counterpartyPublicKeyHex,
    counterpartySignatures: input.counterpartySignatures,
    closeCounterpartySignatures: input.closeCounterpartySignatures,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("feepool.commit", input.id ?? makeRequestId(), params);
}

/* ============== channel.* ============== */

/**
 * 校验精确频道值；规则与 Keymaster `validateExactChannel` 一致。
 *
 * 设计缘由：频道是大小写敏感的精确串；本地先挡掉必然被拒的输入，
 * 避免把 `*` / 控制字符 / 超长频道发到 popup 再失败。
 */
export function validateExactChannel(channel: string): string {
  if (typeof channel !== "string" || channel.length === 0 || channel === "*") {
    throw new Error("channel must be a non-empty exact string");
  }
  if (new TextEncoder().encode(channel).byteLength > 256) {
    throw new Error("channel exceeds 256 UTF-8 bytes");
  }
  for (const codePoint of channel) {
    if (codePoint < " " || codePoint === "\u007f") {
      throw new Error("channel contains a control character");
    }
  }
  if (channel.startsWith("bsv8.inbox.")) {
    throw new Error("bsv8.inbox.* is a reserved private channel");
  }
  return channel;
}

/**
 * 校验 content 是可序列化的 JSON 值（深度 ≤16），并返回归一化副本。
 *
 * 设计缘由：Keymaster 的 `validateJsonValue` 以 16 层为界并只接受
 * plain object；这里同规则先挡，避免发无效请求。`undefined` / 函数 /
 * bigint / Date / TypedArray / 循环引用一律拒绝。
 */
function normalizeJsonValue(
  value: unknown,
  field: string,
  depth = 0,
  seen = new Set<unknown>(),
): JSONValue {
  if (depth > 16) throw new Error(`${field} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${field} must be a finite JSON number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value))
      throw new Error(`${field} must not contain circular references`);
    seen.add(value);
    const out = value.map((item, index) =>
      normalizeJsonValue(item, `${field}[${index}]`, depth + 1, seen),
    );
    seen.delete(value);
    return out;
  }
  if (isPlainRecord(value)) {
    if (seen.has(value))
      throw new Error(`${field} must not contain circular references`);
    seen.add(value);
    const out: { [key: string]: JSONValue } = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 256) throw new Error(`${field} contains an oversized object key`);
      out[key] = normalizeJsonValue(item, `${field}.${key}`, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  throw new Error(`${field} must be a JSON value`);
}

/** 只接受原型为 Object.prototype / null 的 plain object。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `channel.publish` 构包。
 *
 * 关键约束：params **不**带 connectSessionId——Channel 会话由 Session
 * Window transport context 决定；调用方必须先在当前窗口登录。
 */
export function buildChannelPublishRequest(input: {
  id?: string;
  channel: string;
  content: unknown;
}): ProtocolRequestMessage<"channel.publish"> {
  const params: ChannelPublishParams = {
    channel: validateExactChannel(input.channel),
    content: normalizeJsonValue(input.content, "content"),
  };
  return buildRequest("channel.publish", input.id ?? makeRequestId(), params);
}

/**
 * `channel.subscription_set` 构包。
 *
 * 关键约束：最多 64 个、去重、每个都必须是精确频道；空数组表示释放
 * 全部订阅。builder 复制输入数组，避免调用方事后修改影响在途请求。
 */
export function buildChannelSubscriptionSetRequest(input: {
  id?: string;
  channels: string[];
}): ProtocolRequestMessage<"channel.subscription_set"> {
  if (!Array.isArray(input.channels)) {
    throw new Error("channels must be an array");
  }
  if (input.channels.length > 64) {
    throw new Error("channels must contain at most 64 entries");
  }
  const channels = input.channels.map((channel, index) => {
    if (typeof channel !== "string")
      throw new Error(`channels[${index}] must be a string`);
    return validateExactChannel(channel);
  });
  if (new Set(channels).size !== channels.length) {
    throw new Error("channels must not contain duplicates");
  }
  const params: ChannelSubscriptionSetParams = { channels };
  return buildRequest(
    "channel.subscription_set",
    input.id ?? makeRequestId(),
    params,
  );
}

/* ============== msfile.* ============== */

/** 64 位小写 hex（32 字节内容哈希）；与 Keymaster 契约一致。 */
export function validateMsFileHashHex(
  value: string,
  fieldName = "hash",
): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be a 64-char lowercase hex hash`);
  }
  return value;
}

/** 66 位小写 hex 且首字节 02/03（33 字节压缩 secp256k1 公钥）。 */
export function validateMsFileSupplierPublicKeyHex(value: string): string {
  if (typeof value !== "string" || !/^(02|03)[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      "supplierPublicKeyHex must be a 33-byte compressed lowercase hex (66 chars)",
    );
  }
  return value;
}

/**
 * `msfile.stat` 构包。
 *
 * 设计缘由：Stat 只提交 seed hash；供应商选择、报价和金额策略全部由
 * Keymaster 管理，builder 不接受价格参数。
 */
export function buildMsFileStatRequest(input: {
  id?: string;
  connectSessionId: string;
  seedHashHex: string;
}): ProtocolRequestMessage<"msfile.stat"> {
  const params: MsFileStatParams = {
    connectSessionId: requireSessionId(input.connectSessionId),
    seedHashHex: validateMsFileHashHex(input.seedHashHex, "seedHashHex"),
  };
  return buildRequest("msfile.stat", input.id ?? makeRequestId(), params);
}

/** `msfile.seed.read` 构包；读取上限 16 MiB，金额由 Keymaster 决定。 */
export function buildMsFileSeedReadRequest(input: {
  id?: string;
  connectSessionId: string;
  supplierPublicKeyHex: string;
  seedHashHex: string;
}): ProtocolRequestMessage<"msfile.seed.read"> {
  const params: MsFileSeedReadParams = {
    connectSessionId: requireSessionId(input.connectSessionId),
    supplierPublicKeyHex: validateMsFileSupplierPublicKeyHex(
      input.supplierPublicKeyHex,
    ),
    seedHashHex: validateMsFileHashHex(input.seedHashHex, "seedHashHex"),
  };
  return buildRequest("msfile.seed.read", input.id ?? makeRequestId(), params);
}

/** `msfile.block.read` 构包；读取上限 256 KiB，金额由 Keymaster 决定。 */
export function buildMsFileBlockReadRequest(input: {
  id?: string;
  connectSessionId: string;
  supplierPublicKeyHex: string;
  blockHashHex: string;
}): ProtocolRequestMessage<"msfile.block.read"> {
  const params: MsFileBlockReadParams = {
    connectSessionId: requireSessionId(input.connectSessionId),
    supplierPublicKeyHex: validateMsFileSupplierPublicKeyHex(
      input.supplierPublicKeyHex,
    ),
    blockHashHex: validateMsFileHashHex(input.blockHashHex, "blockHashHex"),
  };
  return buildRequest("msfile.block.read", input.id ?? makeRequestId(), params);
}

function validateStoragePath(path: string, directory = false): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f\u2044\u2215\u29f8\uff0f]/.test(path)
  )
    throw new Error("invalid storage path");
  const normalized = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = normalized.split("/");
  if (segments.some((s) => !s || s === "." || s === ".." || s.length > 255))
    throw new Error("invalid storage path");
  if (!directory && path.endsWith("/"))
    throw new Error("object path must not end with slash");
  return normalized;
}
function validateLimit(limit?: number): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("limit out of range");
  return limit;
}
export function buildStorageListRequest(input: {
  id?: string;
  connectSessionId: string;
  prefix?: string;
  cursor?: string;
  limit?: number;
}): ProtocolRequestMessage<"storage.list"> {
  const prefix = input.prefix
    ? validateStoragePath(input.prefix, true)
    : undefined;
  if (input.cursor !== undefined && !input.cursor)
    throw new Error("cursor must be non-empty");
  return buildRequest("storage.list", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    ...(prefix ? { prefix } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(validateLimit(input.limit) !== undefined ? { limit: input.limit } : {}),
  });
}
export function buildStorageDirectoryCreateRequest(input: {
  id?: string;
  connectSessionId: string;
  path: string;
  overwrite?: boolean;
}): ProtocolRequestMessage<"storage.directory.create"> {
  return buildRequest("storage.directory.create", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    path: validateStoragePath(input.path, true),
    overwrite: input.overwrite,
  });
}
export function buildStorageDirectoryDeleteRequest(input: {
  id?: string;
  connectSessionId: string;
  path: string;
}): ProtocolRequestMessage<"storage.directory.delete"> {
  return buildRequest("storage.directory.delete", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    path: validateStoragePath(input.path, true),
  });
}
function validBinary(
  content: unknown,
): content is import("./protocol").BinaryField {
  if (!content || typeof content !== "object") return false;
  const value = content as { $type?: unknown; bytes?: unknown };
  return value.$type === "binary" && value.bytes instanceof ArrayBuffer;
}
export function buildStoragePutRequest(input: {
  id?: string;
  connectSessionId: string;
  path: string;
  content: import("./protocol").BinaryField;
  contentType?: string;
  overwrite?: boolean;
}): ProtocolRequestMessage<"storage.put"> {
  if (!validBinary(input.content))
    throw new Error("content must be a BinaryField");
  const size = input.content.bytes.byteLength;
  if (size > 16 * 1024 * 1024) throw new Error("payload exceeds 16MiB");
  return buildRequest("storage.put", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    path: validateStoragePath(input.path),
    content: input.content,
    contentType: input.contentType,
    overwrite: input.overwrite,
  });
}
export function buildStorageGetRequest(input: {
  id?: string;
  connectSessionId: string;
  path: string;
  offset?: number;
  length?: number;
  ifMatch?: string;
}): ProtocolRequestMessage<"storage.get"> {
  for (const n of [input.offset, input.length])
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
      throw new Error("offset/length must be safe integers");
  if (
    input.length !== undefined &&
    (input.length < 1 || input.length > 16 * 1024 * 1024)
  )
    throw new Error("length out of range");
  if (
    input.offset !== undefined &&
    input.length !== undefined &&
    input.offset > Number.MAX_SAFE_INTEGER - (input.length - 1)
  )
    throw new Error("offset/length overflow");
  return buildRequest("storage.get", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    path: validateStoragePath(input.path),
    offset: input.offset,
    length: input.length,
    ifMatch: input.ifMatch,
  });
}
export function buildStorageDeleteRequest(input: {
  id?: string;
  connectSessionId: string;
  path: string;
}): ProtocolRequestMessage<"storage.delete"> {
  return buildRequest("storage.delete", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    path: validateStoragePath(input.path),
  });
}
export function buildStorageUploadBeginRequest(input: {
  id?: string;
  connectSessionId: string;
  path: string;
  contentType?: string;
  size: number;
  overwrite?: boolean;
}): ProtocolRequestMessage<"storage.upload.begin"> {
  if (!Number.isSafeInteger(input.size) || input.size < 0)
    throw new Error("size must be a safe integer");
  return buildRequest("storage.upload.begin", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    path: validateStoragePath(input.path),
    contentType: input.contentType,
    size: input.size,
    overwrite: input.overwrite,
  });
}
export function buildStorageUploadPartRequest(input: {
  id?: string;
  connectSessionId: string;
  uploadId: string;
  partNumber: number;
  content: import("./protocol").BinaryField;
}): ProtocolRequestMessage<"storage.upload.part"> {
  if (!input.uploadId) throw new Error("uploadId is required");
  if (!validBinary(input.content))
    throw new Error("content must be a BinaryField");
  if (
    !Number.isSafeInteger(input.partNumber) ||
    input.partNumber < 1 ||
    input.partNumber > 10000
  )
    throw new Error("partNumber out of range");
  if (input.content.bytes.byteLength > 16 * 1024 * 1024)
    throw new Error("payload exceeds 16MiB");
  return buildRequest("storage.upload.part", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    uploadId: input.uploadId,
    partNumber: input.partNumber,
    content: input.content,
  });
}
export function buildStorageUploadCompleteRequest(input: {
  id?: string;
  connectSessionId: string;
  uploadId: string;
}): ProtocolRequestMessage<"storage.upload.complete"> {
  if (typeof input.uploadId !== "string" || input.uploadId.length === 0)
    throw new Error("uploadId is required");
  return buildRequest("storage.upload.complete", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    uploadId: input.uploadId,
  });
}
export function buildStorageUploadAbortRequest(input: {
  id?: string;
  connectSessionId: string;
  uploadId: string;
}): ProtocolRequestMessage<"storage.upload.abort"> {
  if (typeof input.uploadId !== "string" || input.uploadId.length === 0)
    throw new Error("uploadId is required");
  return buildRequest("storage.upload.abort", input.id ?? makeRequestId(), {
    connectSessionId: requireSessionId(input.connectSessionId),
    uploadId: input.uploadId,
  });
}
