export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_POPUP_PATH = "/protocol/v1/popup" as const;
export interface BinaryField {
  $type: "binary";
  bytes: ArrayBuffer;
  mime?: string;
}
export type ProtocolErrorCode =
  | "invalid_request"
  | "invalid_origin"
  | "user_rejected"
  | "active_key_unavailable"
  | "decrypt_failed"
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
  | "internal_error";
export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
}
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
  "appmsg.send",
  "appmsg.list",
  "appmsg.get",
  "broadcast.publish",
  "broadcast.subscription_set",
  "broadcast.subscription_list",
  "storage.list",
  "storage.directory.create",
  "storage.directory.delete",
  "storage.put",
  "storage.get",
  "storage.delete",
  "storage.upload.begin",
  "storage.upload.part",
  "storage.upload.complete",
  "storage.upload.abort",
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
export type ProtocolEventName =
  "appmsg.message_received" | "broadcast.message_received";
export type AppMsgContentType = "text/plain" | "text/markdown";
export interface AppMsgMessage {
  messageId: string;
  clientMessageId: string;
  senderPublicKeyHex: string;
  senderOrigin?: string;
  senderAppId?: string;
  recipientPublicKeyHex: string;
  recipientOrigin?: string;
  recipientAppId?: string;
  contentType: AppMsgContentType;
  body: string;
  createdAtMs: number;
  insertedAtMs: number;
}
export interface AppMsgMessageReceivedEventData {
  message: AppMsgMessage;
}
export interface BroadcastMessagePublicView {
  channelId: string;
  protocolId: string;
  clientMessageId: string;
  createdAtMs: number;
  bodyBase64: string;
  publisherPublicKeyHex: string;
}
export interface BroadcastMessageReceivedEventData {
  message: BroadcastMessagePublicView;
}
export interface ProtocolEventMessage {
  v: typeof PROTOCOL_VERSION;
  type: "event";
  event: ProtocolEventName;
  data: AppMsgMessageReceivedEventData | BroadcastMessageReceivedEventData;
}
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
export type AppMsgRecipient = {
  recipientPublicKeyHex: string;
  recipientOrigin?: string;
  recipientAppId?: string;
};
export interface AppMsgSendParams extends AppMsgRecipient {
  contentType: AppMsgContentType;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
  connectSessionId: string;
}
export interface AppMsgListParams {
  limit?: number;
  afterMessageId?: string;
  connectSessionId: string;
}
export interface AppMsgGetParams {
  messageId: string;
  connectSessionId: string;
}
export interface AppMsgSendResult {
  messageId: string;
  createdAtMs: number;
}
export interface AppMsgListResult {
  items: AppMsgMessage[];
  hasMore: boolean;
}
export interface AppMsgGetResult {
  message: AppMsgMessage;
}
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
export interface P2pkhTransferParams {
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb?: number;
  connectSessionId: string;
}
export interface P2pkhTransferResult {
  txid: string;
  rawTxHex: string;
  feeSatoshis: number;
}
export type ProtocolFeePoolAction = "create" | "spend" | "close_and_recreate";
export interface FeepoolPrepareParams {
  counterpartyPublicKeyHex: string;
  amountSatoshis: number;
  connectSessionId: string;
}
export interface FeepoolPrepareResult {
  operationId: string;
  action: ProtocolFeePoolAction;
  counterpartyPublicKeyHex: string;
  amountSatoshis: number;
  baseTxHex?: string;
  baseTxOutputIndex?: number;
  draftSpendTxHex: string;
  draftClientSignBytes: BinaryField;
  closeDraftTxHex?: string;
  closeClientSignBytes?: BinaryField;
  priorPoolRecord?: unknown;
}
export interface FeepoolCommitParams {
  operationId: string;
  counterpartyPublicKeyHex: string;
  counterpartySignatures: BinaryField[];
  closeCounterpartySignatures?: BinaryField[];
  connectSessionId: string;
}
export interface FeepoolCommitResult {
  operationId: string;
  action: ProtocolFeePoolAction;
  draftTxid: string;
  draftTxHex: string;
  closeDraftTxid?: string;
}
export interface AppIdentityProofV1 {
  version: 1;
  publisherPublicKey: string;
  app: { id: string; name: string };
  signature: string;
}
export interface AppIdentitySnapshot {
  version: 1;
  publisherPublicKeyHex: string;
  appId: string;
  appName: string;
  identityDigestHex: string;
}
export interface ConnectLoginParams {
  text: string;
  claims?: string[];
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
}
export interface ConnectLaunchResult extends ConnectLoginResult {}
export interface BroadcastPublishParams {
  channelId: string;
  protocolId: string;
  clientMessageId: string;
  createdAtMs: number;
  bodyBase64: string;
  connectSessionId: string;
}
export interface BroadcastPublishResult extends Omit<
  BroadcastMessagePublicView,
  "publisherPublicKeyHex"
> {
  publisherPublicKeyHex: string;
}
export interface BroadcastSubscriptionSetParams {
  channelIds: string[];
  connectSessionId: string;
}
export interface BroadcastSubscriptionSetResult {
  channelIds: string[];
}
export interface BroadcastSubscriptionListParams {
  connectSessionId: string;
}
export interface BroadcastSubscriptionListResult {
  channelIds: string[];
}
export const STORAGE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const STORAGE_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const STORAGE_MAX_PARTS = 10000;
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
  etag?: string;
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
  etag?: string;
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
  etag?: string;
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
export interface StorageUploadBeginParams {
  connectSessionId: string;
  path: string;
  contentType?: string;
  size: number;
  overwrite?: boolean;
}
export interface StorageUploadBeginResult {
  uploadId: string;
  partSize: typeof STORAGE_PART_SIZE_BYTES;
  maxParts: typeof STORAGE_MAX_PARTS;
}
export interface StorageUploadPartParams {
  connectSessionId: string;
  uploadId: string;
  partNumber: number;
  content: BinaryField;
}
export interface StorageUploadPartResult {
  uploadId: string;
  partNumber: number;
  size: number;
}
export interface StorageUploadCompleteParams {
  connectSessionId: string;
  uploadId: string;
}
export interface StorageUploadCompleteResult extends StoragePutResult {}
export interface StorageUploadAbortParams {
  connectSessionId: string;
  uploadId: string;
}
export interface StorageUploadAbortResult {
  uploadId: string;
  aborted: true;
}
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
  "appmsg.send": AppMsgSendParams;
  "appmsg.list": AppMsgListParams;
  "appmsg.get": AppMsgGetParams;
  "broadcast.publish": BroadcastPublishParams;
  "broadcast.subscription_set": BroadcastSubscriptionSetParams;
  "broadcast.subscription_list": BroadcastSubscriptionListParams;
  "storage.list": StorageListParams;
  "storage.directory.create": StorageDirectoryParams;
  "storage.directory.delete": StorageDirectoryParams;
  "storage.put": StoragePutParams;
  "storage.get": StorageGetParams;
  "storage.delete": StorageDeleteParams;
  "storage.upload.begin": StorageUploadBeginParams;
  "storage.upload.part": StorageUploadPartParams;
  "storage.upload.complete": StorageUploadCompleteParams;
  "storage.upload.abort": StorageUploadAbortParams;
}
export type MethodParams<M extends ProtocolMethod> = MethodParamsMap[M];
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
  "appmsg.send": AppMsgSendResult;
  "appmsg.list": AppMsgListResult;
  "appmsg.get": AppMsgGetResult;
  "broadcast.publish": BroadcastPublishResult;
  "broadcast.subscription_set": BroadcastSubscriptionSetResult;
  "broadcast.subscription_list": BroadcastSubscriptionListResult;
  "storage.list": StorageListResult;
  "storage.directory.create": StorageDirectoryResult;
  "storage.directory.delete": StorageDirectoryResult;
  "storage.put": StoragePutResult;
  "storage.get": StorageGetResult;
  "storage.delete": StorageDeleteResult;
  "storage.upload.begin": StorageUploadBeginResult;
  "storage.upload.part": StorageUploadPartResult;
  "storage.upload.complete": StorageUploadCompleteResult;
  "storage.upload.abort": StorageUploadAbortResult;
}
export type MethodResult<M extends ProtocolMethod = ProtocolMethod> =
  MethodResultMap[M];
export function isValidPluginEndpointIdShape(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(id)
  );
}
export function isValidExactOriginShape(origin: string): boolean {
  return (
    typeof origin === "string" && /^(https?):\/\/([^/:]+):(\d+)$/.test(origin)
  );
}
export interface DemoSessionSnapshot {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  lastResponse: ConnectLoginResult | ConnectResumeResult | ConnectLaunchResult;
  source: "connect.login" | "connect.resume" | "connect.launch";
  refreshedAt: number;
}
