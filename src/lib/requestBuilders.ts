// src/lib/requestBuilders.ts
// 集中管理所有协议方法的请求构包 helper。
//
// 设计缘由（施工单 2026-06-29 002 硬切换 8.3）：
//   - 不在 App.tsx 里散落构包逻辑；按 method 收敛成显式 builder。
//   - 每个 builder 返回的是符合 `MethodParamsMap[M]` 的对象，**不**
//     触发任何 popup side-effect；调用方拿到对象后再交 session client。
//   - 旧业务方法（identity.get / intent.sign / cipher.* / p2pkh.transfer
//     / feepool.*）的 builder 都会带上 `connectSessionId` 字段；调用方
//     负责从当前 session state 提供，没有时由 builder 直接抛错。
//   - connect.login / connect.launch 不带 sessionId（前者是登录入口，
//     后者由 launcher bootstrap 提供 launchToken）。

import type {
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
  StorageDeleteParams,
  StorageGetParams,
  StorageListAllParams,
  StorageListParams,
  StoragePutParams
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

/* ============== storage.* ============== */

export function buildStoragePutRequest(input: {
  id?: string;
  path: string;
  contentType?: string;
  content: import("./protocol").BinaryField;
  connectSessionId: string;
}): ProtocolRequestMessage<"storage.put"> {
  if (input.path.length === 0) {
    throw new Error("path is required for storage.put");
  }
  const params: StoragePutParams = {
    path: input.path,
    contentType: input.contentType,
    content: input.content,
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("storage.put", input.id ?? makeRequestId(), params);
}

export function buildStorageGetRequest(input: {
  id?: string;
  path: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"storage.get"> {
  if (input.path.length === 0) {
    throw new Error("path is required for storage.get");
  }
  const params: StorageGetParams = {
    path: input.path,
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("storage.get", input.id ?? makeRequestId(), params);
}

export function buildStorageListRequest(input: {
  id?: string;
  prefix: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"storage.list"> {
  const params: StorageListParams = {
    prefix: input.prefix,
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("storage.list", input.id ?? makeRequestId(), params);
}

export function buildStorageListAllRequest(input: {
  id?: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"storage.listAll"> {
  const params: StorageListAllParams = {
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("storage.listAll", input.id ?? makeRequestId(), params);
}

export function buildStorageDeleteRequest(input: {
  id?: string;
  path: string;
  connectSessionId: string;
}): ProtocolRequestMessage<"storage.delete"> {
  if (input.path.length === 0) {
    throw new Error("path is required for storage.delete");
  }
  const params: StorageDeleteParams = {
    path: input.path,
    connectSessionId: requireSessionId(input.connectSessionId)
  };
  return buildRequest("storage.delete", input.id ?? makeRequestId(), params);
}