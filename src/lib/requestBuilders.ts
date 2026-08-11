// src/lib/requestBuilders.ts
// 集中管理所有协议方法的请求构包 helper。
//
// 设计缘由（施工单 2026-06-29 002 硬切换 8.3 + 施工单 2026-07-01 001
//          appmsg 协议硬切换一次性迭代）：
//   - 不在 App.tsx 里散落构包逻辑；按 method 收敛成显式 builder。
//   - 每个 builder 返回的是符合 `MethodParamsMap[M]` 的对象，**不**
//     触发任何 popup side-effect；调用方拿到对象后再交 session client。
//   - 旧业务方法（identity.get / intent.sign / cipher.* / p2pkh.transfer
//     / feepool.*）的 builder 都会带上 `connectSessionId` 字段；调用方
//     负责从当前 session state 提供，没有时由 builder 直接抛错。
//   - connect.login / connect.launch 不带 sessionId（前者是登录入口，
//     后者由 launcher bootstrap 提供 launchToken）。
//   - 当前 builder 覆盖 27 种现行方法（含 storage.*）；**不**做
//     "deprecated 壳"伪兼容。
//   - appmsg.* builder 显式 fail-closed：
//       * `connectSessionId` 必填；
//       * `recipientPublicKeyHex` / `clientMessageId` / `body` 非空；
//       * `contentType` 仅允许 `text/plain` / `text/markdown`；
//       * `recipientOrigin` / `recipientAppId` 必须严格二选一，并分别满足
//         exact origin / pluginEndpointId 形状。
//   - appmsg.* builder **不**允许 caller 自报 sender owner / sender
//     endpoint；表单字段里也不允许出现。

import type {
  AppMsgContentType,
  AppMsgGetParams,
  AppMsgListParams,
  AppMsgSendParams,
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
  P2pkhTransferParams,
  ProtocolRequestMessage,
} from "./protocol";
import {
  isValidExactOriginShape,
  isValidPluginEndpointIdShape,
} from "./protocol";

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
  appIdentity?: import("./protocol").AppIdentityProofV1;
}): ProtocolRequestMessage<"connect.login"> {
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
}): ProtocolRequestMessage<"connect.launch"> {
  const params: ConnectLaunchParams = {
    launchToken: input.launchToken,
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

/* ============== appmsg.* ============== */

function validateAppMsgContentType(contentType: string): AppMsgContentType {
  if (contentType !== "text/plain" && contentType !== "text/markdown") {
    throw new Error('contentType must be "text/plain" or "text/markdown"');
  }
  return contentType;
}

/**
 * 校验 `recipientPublicKeyHex` 字段的有效性。
 *
 * 关键约束（与 keymaster.cc 当前 shape 对齐）：
 *   - 33-byte compressed secp256k1 公钥 hex；
 *   - 严格 66 字符；不允许带 `0x` 前缀；
 *   - 字符集 `[0-9a-fA-F]`。
 *
 * 不合法直接 throw，**不**交给 server 再失败一次。
 */
export function validateCompressedSecp256k1Hex(publicKeyHex: string): string {
  if (typeof publicKeyHex !== "string" || publicKeyHex.length === 0) {
    throw new Error("publicKeyHex is required");
  }
  if (!/^[0-9a-fA-F]{66}$/.test(publicKeyHex)) {
    throw new Error(
      "publicKeyHex must be a 33-byte compressed secp256k1 hex (66 chars, [0-9a-fA-F])",
    );
  }
  return publicKeyHex;
}

/**
 * 校验"正整数"语义：有限、整数、> 0。**不**接受 `1.5` 这类浮点。
 * `null` / `undefined` / `NaN` / `Infinity` 一律 throw。
 */
export function validatePositiveInteger(
  value: number,
  fieldName: string,
): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

/**
 * `appmsg.send` 构包。
 *
 * 关键约束：
 *   - caller **不**允许传 sender owner / sender endpoint；sender 由
 *     service 从 `connectSession.ownerPublicKeyHex` + `event.origin`
 *     投影；
 *   - `connectSessionId` 必填；
 *   - `recipientPublicKeyHex` 必须是 33-byte compressed secp256k1
 *     hex（66 字符；不接受 `0x` 前缀 / 短 / 长 / 非 hex）；
 *   - `clientMessageId` / `body` 非空；
 *   - `contentType` 仅允许 `text/plain` / `text/markdown`；
 *   - `recipientOrigin` / `recipientAppId` 严格二选一并分别校验 shape；
 *   - `createdAtMs` 必须是正整数（**不**接受 1.5 这类浮点）；缺省由
 *     builder 写入 `Date.now()`。
 */
export function buildAppMsgSendRequest(input: {
  id?: string;
  recipientPublicKeyHex: string;
  recipientOrigin?: string;
  recipientAppId?: string;
  contentType: AppMsgContentType;
  body: string;
  clientMessageId: string;
  createdAtMs?: number;
  connectSessionId: string;
}): ProtocolRequestMessage<"appmsg.send"> {
  const recipientPublicKeyHex = validateCompressedSecp256k1Hex(
    input.recipientPublicKeyHex,
  );
  if (
    typeof input.clientMessageId !== "string" ||
    input.clientMessageId.length === 0
  ) {
    throw new Error("clientMessageId is required for appmsg.send");
  }
  if (typeof input.body !== "string" || input.body.length === 0) {
    throw new Error("body must be a non-empty string for appmsg.send");
  }
  const contentType = validateAppMsgContentType(input.contentType);
  const hasOrigin = Object.prototype.hasOwnProperty.call(
    input,
    "recipientOrigin",
  );
  const hasAppId = Object.prototype.hasOwnProperty.call(
    input,
    "recipientAppId",
  );
  if ((hasOrigin ? 1 : 0) + (hasAppId ? 1 : 0) !== 1)
    throw new Error(
      "exactly one of recipientOrigin or recipientAppId is required",
    );
  if (hasOrigin && !isValidExactOriginShape(input.recipientOrigin!))
    throw new Error("recipientOrigin must be an exact origin");
  if (hasAppId && !isValidPluginEndpointIdShape(input.recipientAppId!))
    throw new Error("recipientAppId is invalid");
  const createdAtMs = validatePositiveInteger(
    input.createdAtMs ?? Date.now(),
    "createdAtMs",
  );
  const params: AppMsgSendParams = {
    recipientPublicKeyHex,
    ...(hasOrigin
      ? { recipientOrigin: input.recipientOrigin }
      : { recipientAppId: input.recipientAppId }),
    contentType,
    body: input.body,
    clientMessageId: input.clientMessageId,
    createdAtMs,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("appmsg.send", input.id ?? makeRequestId(), params);
}

/**
 * `appmsg.list` 构包。
 *
 * 关键约束：
 *   - `connectSessionId` 必填；
 *   - `afterMessageId` / `limit` 仅在显式传入时
 *     进入 params；缺省不携带，**不**替 caller 编 null；
 *   - `limit` 必须是正整数（**不**接受 1.5 这类浮点）。
 */
export function buildAppMsgListRequest(input: {
  id?: string;
  afterMessageId?: string;
  limit?: number;
  connectSessionId: string;
}): ProtocolRequestMessage<"appmsg.list"> {
  if (input.limit !== undefined) {
    validatePositiveInteger(input.limit, "limit");
  }
  const params: AppMsgListParams = {
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  if (
    typeof input.afterMessageId === "string" &&
    input.afterMessageId.length > 0
  ) {
    params.afterMessageId = input.afterMessageId;
  }
  if (input.limit !== undefined) {
    params.limit = input.limit;
  }
  return buildRequest("appmsg.list", input.id ?? makeRequestId(), params);
}

/**
 * `appmsg.get` 构包。
 *
 * 关键约束：
 *   - `connectSessionId` 必填；
 *   - `messageId` 非空。
 *
 * 注：appmsg.get 找不到时由 server 决定 result 真值；Demo **不**把它
 * 翻译成 `not_found` 协议错误，也不做本地补偿猜测。
 */
export function buildAppMsgGetRequest(input: {
  id?: string;
  messageId: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"appmsg.get"> {
  if (typeof input.messageId !== "string" || input.messageId.length === 0) {
    throw new Error("messageId is required for appmsg.get");
  }
  const params: AppMsgGetParams = {
    messageId: input.messageId,
    connectSessionId: requireSessionId(input.connectSessionId),
  };
  return buildRequest("appmsg.get", input.id ?? makeRequestId(), params);
}

export function buildBroadcastPublishRequest(input: {
  id?: string;
  channelId: string;
  protocolId: string;
  clientMessageId: string;
  createdAtMs?: number;
  bodyBase64: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"broadcast.publish"> {
  if (
    typeof input.channelId !== "string" ||
    input.channelId.trim().length === 0 ||
    typeof input.protocolId !== "string" ||
    input.protocolId.trim().length === 0 ||
    typeof input.clientMessageId !== "string" ||
    input.clientMessageId.trim().length === 0
  )
    throw new Error("channelId, protocolId and clientMessageId are required");
  const createdAtMs = input.createdAtMs ?? Date.now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0)
    throw new Error("createdAtMs must be a positive safe integer");
  if (!isValidBase64(input.bodyBase64))
    throw new Error("bodyBase64 must be valid base64");
  return buildRequest("broadcast.publish", input.id ?? makeRequestId(), {
    channelId: input.channelId,
    protocolId: input.protocolId,
    clientMessageId: input.clientMessageId,
    createdAtMs,
    bodyBase64: input.bodyBase64,
    connectSessionId: requireSessionId(input.connectSessionId),
  });
}

function isValidBase64(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return true;
  return (
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  );
}

export function buildBroadcastSubscriptionSetRequest(input: {
  id?: string;
  channelIds: string[];
  connectSessionId: string;
}): ProtocolRequestMessage<"broadcast.subscription_set"> {
  if (
    !Array.isArray(input.channelIds) ||
    input.channelIds.some((x) => typeof x !== "string" || x.length === 0)
  )
    throw new Error("channelIds must be an array of non-empty strings");
  return buildRequest(
    "broadcast.subscription_set",
    input.id ?? makeRequestId(),
    {
      channelIds: [...input.channelIds],
      connectSessionId: requireSessionId(input.connectSessionId),
    },
  );
}
export function buildBroadcastSubscriptionListRequest(input: {
  id?: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"broadcast.subscription_list"> {
  return buildRequest(
    "broadcast.subscription_list",
    input.id ?? makeRequestId(),
    { connectSessionId: requireSessionId(input.connectSessionId) },
  );
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
