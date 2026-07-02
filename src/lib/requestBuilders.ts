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
//   - 旧 storage.* 五种 builder **硬删除**；当前 builder 仅保留 14 种
//     现行方法；**不**做"deprecated 壳"伪兼容。
//   - appmsg.* builder 显式 fail-closed：
//       * `connectSessionId` 必填；
//       * `recipientOwnerPublicKeyHex` / `clientMessageId` / `body` 非空；
//       * `contentType` 仅允许 `text/plain` / `text/markdown`；
//       * `recipientEndpoint.kind = "origin"` 时 `id` 必须是完整 origin
//         （scheme + host + port）；
//       * `recipientEndpoint.kind = "plugin"` 时 `id` 必须满足稳定
//         pluginEndpointId 形状。
//   - appmsg.* builder **不**允许 caller 自报 sender owner / sender
//     endpoint；表单字段里也不允许出现。

import type {
  AppMsgContentType,
  AppMsgEndpoint,
  AppMsgGetParams,
  AppMsgListBox,
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
  ProtocolRequestMessage
} from "./protocol";
import {
  isValidExactOriginShape,
  isValidPluginEndpointIdShape
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
  params: import("./protocol").MethodParams<M>
): ProtocolRequestMessage<M> {
  return {
    v: 1,
    type: "request",
    id,
    method,
    params
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
}): ProtocolRequestMessage<"connect.login"> {
  const params: ConnectLoginParams = {
    text: input.text,
    claims: input.claims
  };
  return buildRequest("connect.login", input.id ?? makeRequestId(), params);
}

export function buildConnectResumeRequest(input: {
  id?: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"connect.resume"> {
  const params: ConnectResumeParams = {
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("connect.resume", input.id ?? makeRequestId(), params);
}

export function buildConnectLogoutRequest(input: {
  id?: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"connect.logout"> {
  const params: ConnectLogoutParams = {
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("connect.logout", input.id ?? makeRequestId(), params);
}

export function buildConnectLaunchRequest(input: {
  id?: string;
  launchToken: string;
}): ProtocolRequestMessage<"connect.launch"> {
  const params: ConnectLaunchParams = {
    launchToken: input.launchToken
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
    connectSessionId: requireSessionId(input.connectSessionId)
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
    connectSessionId: requireSessionId(input.connectSessionId)
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
    connectSessionId: requireSessionId(input.connectSessionId)
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
    connectSessionId: requireSessionId(input.connectSessionId)
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
    connectSessionId: requireSessionId(input.connectSessionId)
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
    throw new Error("counterpartyPublicKeyHex must be 33-byte compressed hex (66 chars)");
  }
  if (!Number.isFinite(input.amountSatoshis) || input.amountSatoshis <= 0) {
    throw new Error("amountSatoshis must be a positive integer");
  }
  const params: FeepoolPrepareParams = {
    counterpartyPublicKeyHex: input.counterpartyPublicKeyHex,
    amountSatoshis: input.amountSatoshis,
    connectSessionId: requireSessionId(input.connectSessionId)
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
    throw new Error("counterpartyPublicKeyHex must be 33-byte compressed hex (66 chars)");
  }
  if (!Array.isArray(input.counterpartySignatures) || input.counterpartySignatures.length === 0) {
    throw new Error("counterpartySignatures must be a non-empty array");
  }
  const params: FeepoolCommitParams = {
    operationId: input.operationId,
    counterpartyPublicKeyHex: input.counterpartyPublicKeyHex,
    counterpartySignatures: input.counterpartySignatures,
    closeCounterpartySignatures: input.closeCounterpartySignatures,
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("feepool.commit", input.id ?? makeRequestId(), params);
}

/* ============== appmsg.* ============== */

/**
 * 校验 `recipientEndpoint` 形状并返回规范化后的对象。
 *
 * 关键约束（与 keymaster.cc 当前 shape 对齐）：
 *   - `kind = "origin"` 时 `id` 必须是完整 origin（scheme + host + port）。
 *   - `kind = "plugin"` 时 `id` 必须满足稳定 pluginEndpointId 形状：
 *     `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`，长度 <= 128。
 *
 * 不合法直接 throw，**不**交给 server 再失败一次。
 */
export function validateRecipientEndpoint(endpoint: AppMsgEndpoint): AppMsgEndpoint {
  if (!endpoint || typeof endpoint !== "object") {
    throw new Error("recipientEndpoint is required for appmsg methods");
  }
  if (endpoint.kind !== "origin" && endpoint.kind !== "plugin") {
    throw new Error("recipientEndpoint.kind must be \"origin\" or \"plugin\"");
  }
  if (typeof endpoint.id !== "string" || endpoint.id.length === 0) {
    throw new Error("recipientEndpoint.id must be a non-empty string");
  }
  if (endpoint.kind === "origin") {
    if (!isValidExactOriginShape(endpoint.id)) {
      throw new Error(
        "recipientEndpoint.kind=\"origin\" requires id to be an exact origin (scheme + host + port)"
      );
    }
  } else {
    if (!isValidPluginEndpointIdShape(endpoint.id)) {
      throw new Error(
        "recipientEndpoint.kind=\"plugin\" id must match ^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$ and be <= 128 chars"
      );
    }
  }
  return { kind: endpoint.kind, id: endpoint.id };
}

function validateAppMsgContentType(contentType: string): AppMsgContentType {
  if (contentType !== "text/plain" && contentType !== "text/markdown") {
    throw new Error("contentType must be \"text/plain\" or \"text/markdown\"");
  }
  return contentType;
}

function validateAppMsgListBox(box: string): AppMsgListBox {
  if (box !== "inbox" && box !== "sent" && box !== "all") {
    throw new Error("box must be \"inbox\", \"sent\" or \"all\"");
  }
  return box;
}

/**
 * 校验 `recipientOwnerPublicKeyHex` 字段命名的有效性。
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
      "publicKeyHex must be a 33-byte compressed secp256k1 hex (66 chars, [0-9a-fA-F])"
    );
  }
  return publicKeyHex;
}

/**
 * 校验"正整数"语义：有限、整数、> 0。**不**接受 `1.5` 这类浮点。
 * `null` / `undefined` / `NaN` / `Infinity` 一律 throw。
 */
export function validatePositiveInteger(value: number, fieldName: string): number {
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
 *   - `recipientOwnerPublicKeyHex` 必须是 33-byte compressed secp256k1
 *     hex（66 字符；不接受 `0x` 前缀 / 短 / 长 / 非 hex）；
 *   - `clientMessageId` / `body` 非空；
 *   - `contentType` 仅允许 `text/plain` / `text/markdown`；
 *   - `recipientEndpoint` 形状校验同上；
 *   - `createdAtMs` 必须是正整数（**不**接受 1.5 这类浮点）；缺省由
 *     builder 写入 `Date.now()`。
 */
export function buildAppMsgSendRequest(input: {
  id?: string;
  recipientOwnerPublicKeyHex: string;
  recipientEndpoint: AppMsgEndpoint;
  contentType: AppMsgContentType;
  body: string;
  clientMessageId: string;
  createdAtMs?: number;
  connectSessionId: string;
}): ProtocolRequestMessage<"appmsg.send"> {
  const recipientOwnerPublicKeyHex = validateCompressedSecp256k1Hex(input.recipientOwnerPublicKeyHex);
  if (typeof input.clientMessageId !== "string" || input.clientMessageId.length === 0) {
    throw new Error("clientMessageId is required for appmsg.send");
  }
  if (typeof input.body !== "string" || input.body.length === 0) {
    throw new Error("body must be a non-empty string for appmsg.send");
  }
  const contentType = validateAppMsgContentType(input.contentType);
  const recipientEndpoint = validateRecipientEndpoint(input.recipientEndpoint);
  const createdAtMs = validatePositiveInteger(input.createdAtMs ?? Date.now(), "createdAtMs");
  const params: AppMsgSendParams = {
    recipientOwnerPublicKeyHex,
    recipientEndpoint,
    contentType,
    body: input.body,
    clientMessageId: input.clientMessageId,
    createdAtMs,
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("appmsg.send", input.id ?? makeRequestId(), params);
}

/**
 * `appmsg.list` 构包。
 *
 * 关键约束：
 *   - `connectSessionId` 必填；
 *   - `box` ∈ {"inbox", "sent", "all"}；
 *   - `afterMessageId` / `beforeMessageId` / `limit` 仅在显式传入时
 *     进入 params；缺省不携带，**不**替 caller 编 null；
 *   - `limit` 必须是正整数（**不**接受 1.5 这类浮点）。
 */
export function buildAppMsgListRequest(input: {
  id?: string;
  box: AppMsgListBox;
  afterMessageId?: string;
  beforeMessageId?: string;
  limit?: number;
  connectSessionId: string;
}): ProtocolRequestMessage<"appmsg.list"> {
  const box = validateAppMsgListBox(input.box);
  if (input.limit !== undefined) {
    validatePositiveInteger(input.limit, "limit");
  }
  const params: AppMsgListParams = {
    box,
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  if (typeof input.afterMessageId === "string" && input.afterMessageId.length > 0) {
    params.afterMessageId = input.afterMessageId;
  }
  if (typeof input.beforeMessageId === "string" && input.beforeMessageId.length > 0) {
    params.beforeMessageId = input.beforeMessageId;
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
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("appmsg.get", input.id ?? makeRequestId(), params);
}