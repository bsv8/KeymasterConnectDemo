// src/App.tsx
// session-first demo 工作台主入口（施工单 2026-06-29 002 硬切换 +
//                  施工单 2026-06-30 001 appView child ready + opener launch 硬切换 +
//                  施工单 2026-07-02 001 connect runtime config 硬切换一次性迭代 +
//                  施工单 2026-07-02 002 appView manual launch transport 硬切换一次性迭代 +
//                  施工单 2026-09-18 001 Keymaster 26 方法 / Channel / MSFile 硬切换）。
//
// 设计缘由：
//   - 八类工作台：Connect / Identity / Cipher / Transfer / Channel /
//     Storage / MSFile / Test Wallet；不把 26 个协议方法 + 1 类顶层 event
//     做成平铺一级 tab。
//   - 业务方法（identity.get / intent.sign / cipher.* / p2pkh.transfer /
//     feepool.* / storage.* / msfile.*）全部走"当前 sessionId + 可手改"策略。
//   - **Channel 例外**：channel.* 的 connect session 属于 Session Window
//     transport context，params 不带 connectSessionId；工作台不提供
//     sessionId 输入框，只提示先在该窗口完成 login / resume。
//   - 观察区继续展示 request / response / inspection；
//     当前激活方法切换时观察区一起重挂载。
//   - 状态机由 PopupSessionClient 持有；App.tsx 只消费它暴露的
//     connectionState / runRequest / cancelCurrentRequest / onEvent。
//   - 启动模式（direct / appView）：
//     - `direct`   = URL 不带 `launchToken`，仍是手工 `connect.launch` 表单。
//     - `appView`  = URL 带 `launchToken` 且 `window.opener` 存在；demo 把自己
//       当作 child app，按"先发 ready，再发 connect.launch"顺序走真实
//       appView 启动链路。失败一律 fail-closed，**不**自动降级到 direct login。
//   - 顶层 `event` 收包：PopupSessionClient 在 listener 里消费 `event`，
//     通过 `onEvent` 回调把 `channel.message_received` 投到本页队列；不在
//     in-flight 槽位上、不会切连接状态、与 result 可交错。
//   - MSFile 工作台只提交 supplier / hash：金额与价格策略全部在
//     Keymaster 内部，Form 上不出现金额字段。
//   - Storage / Channel 工作台按当前协议提供可验证的请求与事件视图。
//   - 页面顶部不再保留全局 `Runtime config` 区块；transport 缺省参数
//     （`popupWidth` / `popupHeight` / `readyTimeoutMs` / `resultTimeoutMs`）
//     不再暴露 UI 编辑入口，统一使用 `DEFAULT_*` 常量。
//     `Keymaster Target Origin` 移入 `Connect / Popup / Direct 登录` 分组，
//     仅服务 direct / popup 登录链路；`connect.launch` 仍只读
//     `sessionWindowOrigin`，**不**消费 `targetOrigin`。

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  bytesToBase64,
  bytesToHex,
  bytesToText,
  ensureTextLines,
  parseBinaryInput,
  textToBytes,
} from "./lib/encoding";
import { makeBinaryField } from "./lib/binary";
import { toDisplayValue } from "./lib/cbor";
import { inspectIdentityResult, inspectIntentResult } from "./lib/verify";
import {
  normalizeOrigin,
  ProtocolTransportError,
  readLaunchTokenFromUrl,
  readSessionWindowOriginFromUrl,
  stripLaunchTokenFromUrl,
  type ProtocolLogEvent,
} from "./lib/connectClient";
import { PopupSessionClient } from "./lib/popupSessionClient";
import { prepareAppViewTransportOrFail } from "./lib/appViewLaunch";
import { readAppIdentityProof } from "./lib/appIdentityProof";
import {
  type AppIdentityProofV1,
  type ChannelMessageReceivedEventData,
  type ChannelPublishResult,
  type ChannelSubscriptionSetResult,
  type CipherDecryptResult,
  type CipherEncryptResult,
  type ConnectLaunchResult,
  type ConnectLoginResult,
  type ConnectLogoutResult,
  type ConnectResumeResult,
  type FeepoolCommitParams,
  type FeepoolPrepareResult,
  type IdentityGetResult,
  type IntentSignResult,
  type JSONValue,
  type MsFileReadResult,
  type MsFileStatResult,
  type P2pkhTransferResult,
  type PopupConnectionState,
  type ProtocolErrorCode,
  type ProtocolEventMessage,
  type ProtocolMethod,
  type ProtocolRequestMessage,
  type ProtocolResultMessage,
  type ResolvedClaimValue,
  type StorageGetResult,
} from "./lib/protocol";
import {
  buildChannelPublishRequest,
  buildChannelSubscriptionSetRequest,
  buildCipherDecryptRequest,
  buildCipherEncryptRequest,
  buildConnectLaunchRequest,
  buildConnectLoginRequest,
  buildConnectLogoutRequest,
  buildConnectResumeRequest,
  buildFeepoolCommitRequest,
  buildFeepoolPrepareRequest,
  buildIdentityGetRequest,
  buildIntentSignRequest,
  buildMsFileBlockReadRequest,
  buildMsFileSeedReadRequest,
  buildMsFileStatRequest,
  buildP2pkhTransferRequest,
  buildStorageListRequest,
  buildStorageDirectoryCreateRequest,
  buildStorageDirectoryDeleteRequest,
  buildStoragePutRequest,
  buildStorageGetRequest,
  buildStorageDeleteRequest,
  buildStorageUploadBeginRequest,
  buildStorageUploadPartRequest,
  buildStorageUploadCompleteRequest,
  buildStorageUploadAbortRequest,
} from "./lib/requestBuilders";
import {
  clearCachedSessionHint,
  readCachedSessionHint,
  writeCachedSessionHint,
  type CachedSessionHint,
} from "./lib/sessionCache";
import {
  generateTestWallet,
  importTestWallet,
  isValidWif,
  type TestWallet,
} from "./lib/testWallet";
import {
  buildFeepoolCommitParams,
  projectFeepoolCommitInput,
  actionLabel,
  priorPoolTotalAmount,
} from "./lib/feepool";
import {
  buildAndSignP2pkhTransfer,
  defaultFeeRateSatoshisPerKb,
  validateTransferParams,
  wocUtxosToTestWalletUtxos,
} from "./lib/p2pkhTool";
import { createWocClient, type WocUtxo } from "./lib/woc";
import {
  readSmallObjectFile,
  sanitizeStorageValue,
  sliceMultipartPart,
  storageDownloadMetadata,
} from "./lib/storageUi";

/**
 * Channel 工作台状态。
 *
 * 设计缘由：channel.* 的 connect session 属于 Session Window transport
 * context，因此这里**不**保留 sessionId 输入框；调用方必须先在 Connect
 * 工作台完成 login / resume，能否执行由 Keymaster 按当前窗口会话裁决。
 */
interface ChannelWorkbenchState {
  channel: string;
  contentText: string;
  subscriptions: string;
  publishResult: ChannelPublishResult | null;
  setResult: ChannelSubscriptionSetResult | null;
  error: string;
  status: SectionStatus;
}

/**
 * MSFile 工作台状态。
 *
 * 设计缘由：msfile.* 与 storage.* 同为 session-bound、要求已验签 App
 * 身份；金额策略全部在 Keymaster 内部，Demo 只提交 hash / supplier。
 */
interface MsFileWorkbenchState {
  sessionId: string;
  seedHashHex: string;
  blockHashHex: string;
  supplierPublicKeyHex: string;
  statResult: MsFileStatResult | null;
  seedResult: MsFileReadResult | null;
  blockResult: MsFileReadResult | null;
  error: string;
  status: SectionStatus;
}
interface StorageWorkbenchState {
  sessionId: string;
  path: string;
  prefix: string;
  cursor: string;
  limit: string;
  uploadId: string;
  partNumber: string;
  partSize: string;
  maxParts: string;
  offset: string;
  length: string;
  ifMatch: string;
  contentType: string;
  overwrite: boolean;
  contentText: string;
  status: string;
  error: string;
  result: unknown;
  history: unknown[];
}
type StorageAction =
  | "list"
  | "directory.create"
  | "directory.delete"
  | "put"
  | "get"
  | "delete"
  | "upload.begin"
  | "upload.part"
  | "upload.complete"
  | "upload.abort";

type SectionStatus = "idle" | "loading" | "success" | "error";

type WorkbenchId =
  | "connect"
  | "identity"
  | "cipher"
  | "transfer"
  | "channel"
  | "storage"
  | "msfile"
  | "wallet";

/* ============== Session state (5.4) ============== */

/**
 * demo 自己的 session 共享上下文（页面级 useState）。
 *
 * 不抽象成 context / reducer：单页单组件直接读写足够；过度抽象只会把
 * "sessionId 当前是啥" 这个事实分散掉。
 */
interface SessionState {
  appIdentity: import("./lib/protocol").AppIdentitySnapshot | null;
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  source: "" | "connect.login" | "connect.resume" | "connect.launch";
  refreshedAt: number;
  /** 最近一次 connect.* 返回完整 payload；用于右栏复核。 */
  lastConnectResponse:
    | ConnectLoginResult
    | ConnectResumeResult
    | ConnectLaunchResult
    | ConnectLogoutResult
    | null;
}

function emptySession(): SessionState {
  return {
    appIdentity: null,
    connectSessionId: "",
    ownerPublicKeyHex: "",
    resolvedClaims: {},
    source: "",
    refreshedAt: 0,
    lastConnectResponse: null,
  };
}

/** 观察区只展示 proof 结构，避免 UI 请求快照成为完整签名日志。 */
function redactAppIdentityForDisplay(
  proof: AppIdentityProofV1 | undefined,
): AppIdentityProofV1 | undefined {
  if (!proof) return proof;
  return { ...proof, signature: "[redacted]" };
}

/* ============== Connect 区状态 ============== */

interface ConnectLoginState {
  text: string;
  claimsText: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
}

interface ConnectResumeState {
  /** resume 用 sessionId；缺省从当前 session 同步。 */
  connectSessionId: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
}

interface ConnectLogoutState {
  connectSessionId: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
}

interface ConnectLaunchState {
  /** 优先取自 URL ?launchToken=；缺省手填。 */
  launchToken: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
}

/* ============== Identity 区状态 ============== */

interface IdentityState {
  text: string;
  claimsText: string;
  ttlSeconds: number;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: IdentityGetResult | null;
  inspection: ReturnType<typeof inspectIdentityResult> | null;
  lastKeymasterAddress: string;
  /** 允许用户手改 sessionId；缺省从当前 session 同步。 */
  sessionId: string;
}

interface IntentState {
  text: string;
  contentType: string;
  contentText: string;
  ttlSeconds: number;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: IntentSignResult | null;
  inspection: ReturnType<typeof inspectIntentResult> | null;
  sessionId: string;
}

/* ============== Cipher 区状态 ============== */

interface EncryptState {
  text: string;
  contentType: string;
  contentText: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: CipherEncryptResult | null;
  sessionId: string;
}

interface DecryptState {
  text: string;
  nonceInput: string;
  cipherbytesInput: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: CipherDecryptResult | null;
  sessionId: string;
}

/* ============== Transfer 区状态 ============== */

interface P2pkhTransferState {
  recipientAddress: string;
  amountSatoshis: string;
  feeRateSatoshisPerKb: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: P2pkhTransferResult | null;
  sessionId: string;
}

interface FeepoolPrepareState {
  counterpartyPublicKeyHex: string;
  amountSatoshis: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: FeepoolPrepareResult | null;
  poolTotalAmount: string;
  keymasterPublicKeyHex: string;
  sessionId: string;
}

interface FeepoolCommitState {
  operationId: string;
  counterpartyPublicKeyHex: string;
  counterpartySignatures: string;
  closeCounterpartySignatures: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  draftTotalAmount: string;
  keymasterPublicKeyHex: string;
  action: string;
  sessionId: string;
}

/* ============== Channel 区状态 ============== */

/**
 * Channel 工作台只保留"发布 / 替换订阅 / 订阅物理状态"三块状态，加一个
 * 长期入站事件队列。
 *
 * 设计缘由：channel.* 不再携带 connectSessionId；工作台不再提供 sessionId
 * 输入框，避免把"会话属于窗口"这条协议真值表现成 App 可自报的字段。
 */
interface ChannelPublishFormState {
  channel: string;
  contentText: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: ChannelPublishResult | null;
}

interface ChannelSubscriptionFormState {
  channelsText: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: ChannelSubscriptionSetResult | null;
}

interface ChannelEventEntry {
  receivedAt: number;
  data: ChannelMessageReceivedEventData;
}

/* ============== MSFile 区状态 ============== */

/**
 * MSFile 三个方法各自独立状态；sessionId 沿用"当前 session 默认填充，
 * 但允许手改"策略（与其它 session-bound 业务方法一致）。
 */
interface MsFileStatState {
  seedHashHex: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: MsFileStatResult | null;
  sessionId: string;
}

interface MsFileReadState {
  supplierPublicKeyHex: string;
  hashHex: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: MsFileReadResult | null;
  sessionId: string;
}

/* ============== Test wallet 区状态（与旧版一致） ============== */

interface TestWalletState {
  wallet: TestWallet | null;
  wifInput: string;
  error: string;
  utxos: WocUtxo[];
  utxoStatus: SectionStatus;
  utxoError: string;
  utxoRefreshedAt: number;
}

interface RefundState {
  recipientAddress: string;
  amountSatoshis: string;
  feeRateSatoshisPerKb: string;
  status: SectionStatus;
  error: string;
  result: { txid: string; rawTxHex: string; feeSatoshis: number } | null;
}

const DEFAULT_READY_TIMEOUT = 10_000;
const DEFAULT_RESULT_TIMEOUT = 60_000;
const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 760;

type DemoConnectionState = "idle" | PopupConnectionState;

/**
 * demo 启动模式（施工单 2026-06-30 001 appView child ready + opener launch
 * 硬切换第 4.1 / 5.一 / 7.不能怎么做 章）。
 *
 *   - `direct`   = URL 不带 `launchToken`；demo 走手工测试台。
 *   - `appView`  = URL 带 `launchToken`；demo 作为 Session Window 打开的
 *     child app，必须复用 `window.opener`，先发顶层 `ready`，再自动发
 *     `connect.launch`。失败一律 fail-closed，不自动降级到 direct。
 *
 * 本单固定这两条；不引入第三种"childReadyMode"本地模式。
 */
type StartupMode = "direct" | "appView";

/**
 * appView 启动期阶段（施工单 2026-06-30 001 第 3.4 / 4.3 / 5.二 / 7.章）。
 *
 *   - `null`     ⇒ 非 appView 模式 / 已完成启动；
 *   - `"launching"` ⇒ 已识别 `launchToken`，正在"准备 transport → 发 ready
 *     → 发 connect.launch"的串联中；
 *   - `"failed"`    ⇒ 启动失败（opener 不可用 / 发 ready 失败 / connect.launch
 *     协议错误 / transport 错误），UI 进入失败态，明确告诉用户"请从
 *     Keymaster 重新启动 app"。
 */
type AppViewPhase = "launching" | "failed";

export default function App() {
  const currentOrigin =
    typeof window === "undefined" ? "" : window.location.origin;

  const appIdentityProofState = useMemo<{
    proof: AppIdentityProofV1 | null;
    error: string;
  }>(() => {
    try {
      return { proof: readAppIdentityProof(), error: "" };
    } catch (error) {
      return {
        proof: null,
        error: error instanceof Error ? error.message : "App identity proof is unavailable",
      };
    }
  }, []);
  const appIdentityProof = appIdentityProofState.proof;

  // 启动时尝试从 localStorage 恢复最近一次 session hint；
  // 用它去预填 targetOrigin / 表单默认 sessionId。
  const initialHint = useMemo<CachedSessionHint | null>(
    () => readCachedSessionHint(),
    [],
  );

  const [targetOrigin, setTargetOrigin] = useState(
    initialHint?.targetOrigin || "https://keymaster.cc",
  );
  const [popupWidth, setPopupWidth] = useState(DEFAULT_POPUP_WIDTH);
  const [popupHeight, setPopupHeight] = useState(DEFAULT_POPUP_HEIGHT);
  const [readyTimeoutMs, setReadyTimeoutMs] = useState(DEFAULT_READY_TIMEOUT);
  const [resultTimeoutMs, setResultTimeoutMs] = useState(
    DEFAULT_RESULT_TIMEOUT,
  );
  /* ----- Session (5.4) ----- */
  const [session, setSession] = useState<SessionState>(emptySession);

  /* ----- Connect ----- */
  const [login, setLogin] = useState<ConnectLoginState>({
    text: "请确认登录到当前站点并创建 connect session",
    claimsText:
      "key.label\nprofile.nickname\nprofile.avatar.image\nwallet.bsv.address.main",
    status: "idle",
    error: "",
    request: null,
    response: null,
  });
  const [resume, setResume] = useState<ConnectResumeState>({
    connectSessionId: initialHint?.connectSessionId ?? "",
    status: "idle",
    error: "",
    request: null,
    response: null,
  });
  const [logout, setLogout] = useState<ConnectLogoutState>({
    connectSessionId: initialHint?.connectSessionId ?? "",
    status: "idle",
    error: "",
    request: null,
    response: null,
  });
  const [launch, setLaunch] = useState<ConnectLaunchState>(() => ({
    launchToken: readLaunchTokenFromUrl() ?? "",
    status: "idle",
    error: "",
    request: null,
    response: null,
  }));

  /* ----- Identity ----- */
  const [identity, setIdentity] = useState<IdentityState>({
    text: "请确认把身份信息提供给当前站点",
    claimsText:
      "key.label\nprofile.nickname\nprofile.avatar.image\nwallet.bsv.address.main",
    ttlSeconds: 300,
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    inspection: null,
    lastKeymasterAddress: "",
    sessionId: initialHint?.connectSessionId ?? "",
  });
  const [intent, setIntent] = useState<IntentState>({
    text: "请确认签名这段内容",
    contentType: "demo.note.v1",
    contentText: "This is the content to sign.",
    ttlSeconds: 300,
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    inspection: null,
    sessionId: initialHint?.connectSessionId ?? "",
  });

  /* ----- Cipher ----- */
  const [encrypt, setEncrypt] = useState<EncryptState>({
    text: "请确认加密以下内容",
    contentType: "demo.note.v1",
    contentText: "Secret message from the demo page.",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? "",
  });
  const [decrypt, setDecrypt] = useState<DecryptState>({
    text: "请确认解密这段内容",
    nonceInput: "",
    cipherbytesInput: "",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? "",
  });

  /* ----- Transfer ----- */
  const [p2pkh, setP2pkh] = useState<P2pkhTransferState>({
    recipientAddress: "",
    amountSatoshis: "1000",
    feeRateSatoshisPerKb: String(defaultFeeRateSatoshisPerKb()),
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? "",
  });
  const [feepoolPrepare, setFeepoolPrepare] = useState<FeepoolPrepareState>({
    counterpartyPublicKeyHex: "",
    amountSatoshis: "1000",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    poolTotalAmount: "",
    keymasterPublicKeyHex: "",
    sessionId: initialHint?.connectSessionId ?? "",
  });
  const [feepoolCommit, setFeepoolCommit] = useState<FeepoolCommitState>({
    operationId: "",
    counterpartyPublicKeyHex: "",
    counterpartySignatures: "",
    closeCounterpartySignatures: "",
    status: "idle",
    error: "",
    request: null,
    response: null,
    draftTotalAmount: "",
    keymasterPublicKeyHex: "",
    action: "",
    sessionId: initialHint?.connectSessionId ?? "",
  });

  /* ----- Channel ----- */
  const [channelPublishForm, setChannelPublishForm] =
    useState<ChannelPublishFormState>({
      channel: "demo.channel",
      contentText: '{\n  "type": "demo",\n  "text": "hello from keymaster connect demo"\n}',
      status: "idle",
      error: "",
      request: null,
      response: null,
      result: null,
    });
  const [channelSubscriptionForm, setChannelSubscriptionForm] =
    useState<ChannelSubscriptionFormState>({
      channelsText: "demo.channel",
      status: "idle",
      error: "",
      request: null,
      response: null,
      result: null,
    });
  /** 页面级 channel 入站事件队列；新到在前；上限 60。 */
  const [channelEvents, setChannelEvents] = useState<ChannelEventEntry[]>([]);

  /* ----- MSFile ----- */
  const [msfileStat, setMsFileStat] = useState<MsFileStatState>({
    seedHashHex: "",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? "",
  });
  const [msfileSeedRead, setMsFileSeedRead] = useState<MsFileReadState>({
    supplierPublicKeyHex: "",
    hashHex: "",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? "",
  });
  const [msfileBlockRead, setMsFileBlockRead] = useState<MsFileReadState>({
    supplierPublicKeyHex: "",
    hashHex: "",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? "",
  });
  const [storageState, setStorageState] = useState<StorageWorkbenchState>({
    sessionId: initialHint?.connectSessionId ?? "",
    path: "demo.txt",
    prefix: "",
    cursor: "",
    limit: "",
    uploadId: "",
    partNumber: "1",
    partSize: "",
    maxParts: "",
    offset: "",
    length: "",
    ifMatch: "",
    contentType: "text/plain",
    overwrite: true,
    contentText: "",
    status: "idle",
    error: "",
    result: null,
    history: [],
  });
  const [storageFile, setStorageFile] = useState<File | null>(null);
  const storageRawGetRef = useRef<StorageGetResult | null>(null);
  useEffect(() => {
    const sid = session.connectSessionId;
    setStorageState((s) => ({ ...s, sessionId: sid }));
  }, [session.connectSessionId]);

  /* ----- Test wallet ----- */
  const [testWalletState, setTestWalletState] = useState<TestWalletState>({
    wallet: null,
    wifInput: "",
    error: "",
    utxos: [],
    utxoStatus: "idle",
    utxoError: "",
    utxoRefreshedAt: 0,
  });
  const [refund, setRefund] = useState<RefundState>({
    recipientAddress: "",
    amountSatoshis: "0",
    feeRateSatoshisPerKb: String(defaultFeeRateSatoshisPerKb()),
    status: "idle",
    error: "",
    result: null,
  });

  const [activeWorkbench, setActiveWorkbench] =
    useState<WorkbenchId>("connect");
  const [connectionState, setConnectionState] =
    useState<DemoConnectionState>("idle");
  const [anyBusy, setAnyBusy] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [showSessionEditor, setShowSessionEditor] = useState(false);

  /* ----- 启动模式 + appView 启动期阶段（施工单 2026-06-30 001 第 4 / 5 章） -----
   *
   * - 启动模式**仅**由 URL `?launchToken=` 决定；首次 mount 时一次性计算。
   * - 启动期阶段只有两条：`launching` / `failed`；完成后立刻降回 null，让
   *   工作台 UI 接管。
   * - appView 失败态必须保留到页面关闭 / 重新拉起，**不**自动归零到
   *   direct 模式。
   */
  const [startupMode] = useState<StartupMode>(() =>
    readLaunchTokenFromUrl() !== null ? "appView" : "direct",
  );
  /**
   * launch / appView 模式的 transport 真值（施工单 2026-06-30 002 +
   * 依赖项目 keymaster.cc 施工单 004）：
   *   = 打开本 child app 的 Session Window 在 `openClientApp()` 时显式写进
   *     URL 的 `sessionWindowOrigin`。
   *
   * 与 `targetOrigin`（popup / direct 模式真值）**严格分开**：launch 链路
   * 一律读这个，**不**回退到 `targetOrigin`、**不**回退默认
   * `https://keymaster.cc`。首次 mount 一次性计算；URL 缺失 / 非法 → null，
   * appView 模式下据此 fail-closed。
   */
  const [sessionWindowOrigin] = useState<string | null>(() =>
    readSessionWindowOriginFromUrl(),
  );
  const [appViewPhase, setAppViewPhase] = useState<AppViewPhase | null>(
    startupMode === "appView" ? "launching" : null,
  );
  const [appViewFailureReason, setAppViewFailureReason] = useState<
    string | null
  >(null);

  /**
   * 当前页面会话使用的 transport origin（postMessage 的 targetOrigin 实参）。
   *   - `appView` 模式 ⇒ `sessionWindowOrigin`（launch 真值）；
   *   - `direct`  模式 ⇒ 用户输入 / UI 默认的 `targetOrigin`（popup 真值）。
   * 两种模式互斥（appView 一律 fail-closed，绝不降级回 direct），所以同一时刻
   * 只会有一个真值驱动 PopupSessionClient。
   */
  const transportOrigin =
    startupMode === "appView" ? (sessionWindowOrigin ?? "") : targetOrigin;

  const sessionClientRef = useRef<PopupSessionClient | null>(null);
  function getSessionClient(): PopupSessionClient {
    if (!sessionClientRef.current) {
      sessionClientRef.current = new PopupSessionClient({
        // popup/direct ⇒ targetOrigin；appView/launch ⇒ sessionWindowOrigin。
        // 由 `transportOrigin` 统一收口，launch 链路不再吃 targetOrigin。
        targetOrigin: transportOrigin,
        popupWidth,
        popupHeight,
        readyTimeoutMs,
        resultTimeoutMs,
        onLog: pushLog,
        onConnectionStateChange: setConnectionState,
        // 顶层 message_received event 收包：不占用 in-flight 槽位、不会切连接状态。
        onEvent: handleProtocolEvent,
        // appView 锁定（施工单 2026-07-02 002 第 5.三 / 6.一 / 7.4 章）：
        //   - appView 模式下：transport 真值是 `window.opener`，**绝不**
        //     允许 `ensureSession()` 偷偷走 `window.open(...)`；
        //   - direct / popup 模式下（默认）：维持旧行为不变；
        //   - 一旦置 `true`，opener 关闭后任何业务 request 都会抛
        //     `appview_session_lost`，由 App.tsx 写失败态（"请从
        //     Keymaster 重新拉起"），**不**会偷偷开第二扇 popup。
        appViewOnly: startupMode === "appView",
      });
    }
    return sessionClientRef.current;
  }

  const normalizedTargetOrigin = useMemo(() => {
    try {
      return normalizeOrigin(targetOrigin);
    } catch {
      return "";
    }
  }, [targetOrigin]);

  /* ----- targetOrigin / 超时变化 → 关闭旧 session，保留表单 -----
   *
   * appView 模式保护（施工单 2026-06-30 002 第 4.2 / 5.二 章）：launch 链路
   * 的 transport 真值是 `sessionWindowOrigin`，**不**吃 `targetOrigin`。用户
   * 在 direct 工作台手改 `targetOrigin`（或 popup 尺寸 / 超时）时，不得连带
   * 关掉已收养 Session Window 的 appView 会话——否则会误杀正在进行 / 已完成
   * 的 launch。故 appView 模式下本 effect 直接短路。
   */
  useEffect(() => {
    if (startupMode === "appView") return;
    if (sessionClientRef.current) {
      sessionClientRef.current.closeSession();
      sessionClientRef.current = null;
      setAnyBusy(false);
    }
  }, [
    startupMode,
    targetOrigin,
    popupWidth,
    popupHeight,
    readyTimeoutMs,
    resultTimeoutMs,
  ]);

  /* ----- 把当前 sessionId 同步到各业务方法表单（5.5） -----
   *
   * 设计缘由：connect.login / connect.resume / connect.launch 拿到新 session
   * 后，旧的 connectSessionId 必须立刻作废，业务表单继续保留旧 sessionId 会
   * 出现"页面显示 A，旧表单偷偷在用 A"的双 session 真值。
   *
   * 因此：每当 session.connectSessionId 变化（成功 login / resume / launch
   * 都会触发），把全部业务方法表单的 sessionId 强制覆盖到当前 sessionId。
   * 用户对单条业务方法的 sessionId 手改只在该 session 生命周期内生效；一旦
   * session 切换，旧手改自然失效，与 README "自动同步" 的承诺一致。
   */
  useEffect(() => {
    const sid = session.connectSessionId;
    setResume((prev) => ({ ...prev, connectSessionId: sid }));
    setLogout((prev) => ({ ...prev, connectSessionId: sid }));
    setIdentity((prev) => ({ ...prev, sessionId: sid }));
    setIntent((prev) => ({ ...prev, sessionId: sid }));
    setEncrypt((prev) => ({ ...prev, sessionId: sid }));
    setDecrypt((prev) => ({ ...prev, sessionId: sid }));
    setP2pkh((prev) => ({ ...prev, sessionId: sid }));
    setFeepoolPrepare((prev) => ({ ...prev, sessionId: sid }));
    setFeepoolCommit((prev) => ({ ...prev, sessionId: sid }));
    setMsFileStat((prev) => ({ ...prev, sessionId: sid }));
    setMsFileSeedRead((prev) => ({ ...prev, sessionId: sid }));
    setMsFileBlockRead((prev) => ({ ...prev, sessionId: sid }));
  }, [session.connectSessionId]);

  /* ----- 加密 → 解密自动回填 ----- */
  useEffect(() => {
    const r = encrypt.result;
    if (r) {
      setDecrypt((prev) => ({
        ...prev,
        nonceInput: bytesToHex(new Uint8Array(r.nonce.bytes)),
        cipherbytesInput: bytesToHex(new Uint8Array(r.cipherbytes.bytes)),
      }));
    }
  }, [encrypt.result]);

  /* ----- 测试钱包 → p2pkh 默认收款 / feepool 默认 counterparty ----- */
  useEffect(() => {
    const w = testWalletState.wallet;
    if (!w) return;
    setP2pkh((prev) =>
      prev.recipientAddress === ""
        ? { ...prev, recipientAddress: w.address }
        : prev,
    );
    setFeepoolPrepare((prev) =>
      prev.counterpartyPublicKeyHex === ""
        ? { ...prev, counterpartyPublicKeyHex: w.publicKeyHex }
        : prev,
    );
  }, [testWalletState.wallet]);

  /* ----- 最近一次 keymaster main address → 回款默认收款 ----- */
  useEffect(() => {
    if (identity.lastKeymasterAddress && refund.recipientAddress === "") {
      setRefund((prev) => ({
        ...prev,
        recipientAddress: identity.lastKeymasterAddress,
      }));
    }
  }, [identity.lastKeymasterAddress, refund.recipientAddress]);

  /* ----- 页面级 mount 钩子：全局 error / unhandledrejection 上报 ----- */
  useEffect(() => {
    console.info("[keymaster-connect-demo] page mounted", {
      currentOrigin:
        typeof window === "undefined" ? "" : window.location.origin,
      pathname: typeof window === "undefined" ? "" : window.location.pathname,
    });

    const onError = (event: ErrorEvent) => {
      console.error("[keymaster-connect-demo] window error", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error,
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error("[keymaster-connect-demo] unhandled rejection", {
        reason: event.reason,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  /* ----- appView 启动期 → 自动走 performAppViewLaunch(launchToken) -----
   *
   * 设计缘由（施工单 2026-06-30 001 第 3.4 / 5.二 / 6.不能怎么做 章 +
   *          StrictMode 双挂载保护）：
   *   - 仅在 `startupMode === "appView"` 且阶段仍是 `"launching"` 时启动；
   *     防止 reload 重复消费一次性 launchToken；
   *   - URL 里没有 `launchToken` 时，本 effect 不做事，工作台维持手工
   *     `connect.launch` 面板；
   *   - 失败由 `performAppViewLaunch` 内部把 `appViewPhase` 改 `"failed"`,
   *     UI 切到失败态；本 effect 不重置、**不**回退到 direct。
   *   - **StrictMode 双挂载保护**：`main.tsx` 启用了 `React.StrictMode`，
   *     开发态下 mount effect 会双跑（mount → unmount → mount）。本 effect
   *     **不**做 async 副作用清理、且用空依赖数组——如果不加 ref 守卫，第
   *     二次 mount 会再次跑 `performAppViewLaunch(launchToken)`，向 opener
   *     **重复发 ready**、重复发 `connect.launch`，污染 appView 会话。
   *     用 `appViewLaunchStartedRef` 做一次性硬守卫：第一次 mount 同步置
   *     true；后续（包括 StrictMode replay / 手动 reload）若 token 已被
   *     strip、phase 已不是 `launching`，自然短路。
   */
  const appViewLaunchStartedRef = useRef(false);
  /**
   * 标记本 effect 是否在自身被 unmount 之前仍处于"在飞"。StrictMode
   * 双挂载的第二轮 mount 看到 `inFlightRef.current === true` 时主动让出
   * （ref 守卫已是最后防线，这里只是给一个观察窗）。
   */
  const appViewLaunchInFlightRef = useRef(false);
  useEffect(() => {
    if (appViewLaunchStartedRef.current) return;
    if (startupMode !== "appView") return;
    if (appViewPhase !== "launching") return;
    const launchToken = readLaunchTokenFromUrl();
    if (!launchToken) {
      setAppViewFailureReason(
        "launchToken missing in URL; cannot launch in appView mode.",
      );
      setAppViewPhase("failed");
      appViewLaunchStartedRef.current = true;
      return;
    }
    // 同步置 true，挡住同一次 / 紧随其后的二次 mount；effect 内不依赖 React
    // state 变化、不会被 batching 影响。
    appViewLaunchStartedRef.current = true;
    appViewLaunchInFlightRef.current = true;
    void performAppViewLaunch(launchToken).finally(() => {
      appViewLaunchInFlightRef.current = false;
    });
    // 仅在 mount 时跑一次；后续阶段由 performAppViewLaunch 自身切。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * StrictMode dev 双挂载：第一轮 mount 启动 launch 后立即 unmount，本
   * cleanup 仅做"暂停观察"；**不**主动关 session client / 不取消在途
   * request——appView 失败 / 成功是协议层语义，cancel 走的是 transport
   * 自己的 cancelCurrentRequest，demo 不在这里埋第二条 cancel 路径。
   */
  useEffect(() => {
    return () => {
      // 卸载观察：仅记录到日志，便于开发态定位双挂载时序。
      if (appViewLaunchInFlightRef.current) {
        console.info(
          "[keymaster-connect-demo] appView auto-launch effect unmounted while in flight",
        );
      }
    };
  }, []);

  function pushLog(
    entry: ProtocolLogEvent,
    level: "info" | "warn" | "error" = "info",
  ) {
    const method = entry.method ?? "system";
    const prefix = `[keymaster-connect-demo][${method}][${entry.stage}]`;
    if (level === "error") {
      console.error(prefix, entry);
    } else if (level === "warn") {
      console.warn(prefix, entry);
    } else {
      console.debug(prefix, entry);
    }
  }

  /** 顶层 channel.message_received event 收包；按到达时间倒序保留最近 60 条。 */
  function handleProtocolEvent(message: ProtocolEventMessage) {
    if (message.event !== "channel.message_received") return;
    const entry: ChannelEventEntry = {
      receivedAt: Date.now(),
      data: message.data,
    };
    setChannelEvents((current) => [entry, ...current].slice(0, 60));
  }

  function extractKeymasterMainAddress(
    claims: Record<string, ResolvedClaimValue> | undefined,
  ): string {
    if (!claims) return "";
    const v = claims["wallet.bsv.address.main"];
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const obj = v as { $type?: string; bytes?: ArrayBuffer };
      if (obj.$type === "binary" && obj.bytes instanceof ArrayBuffer) {
        try {
          return bytesToText(new Uint8Array(obj.bytes));
        } catch {
          return "";
        }
      }
    }
    return "";
  }

  async function runProtocolRequest<M extends ProtocolMethod>(
    request: ProtocolRequestMessage<M>,
  ): Promise<ProtocolResultMessage> {
    return getSessionClient().runRequest(request);
  }

  /* ============== appView 启动期：先 ready 再 connect.launch ============== */

  /**
   * appView 启动期入口（施工单 2026-06-30 001 appView child ready + opener
   * launch 硬切换第 4.2 / 4.3 / 5.一 / 5.二 / 5.三 / 6.三 / 7.不能怎么做
   * 章 + 施工单 2026-07-02 002 appView manual launch transport 硬切换
   * 一次性迭代第 5.一 / 5.二 / 5.三 / 6.不能怎么做 / 7.4 / 10.1 章）：
   *
   *   1. 复用页面级 `prepareAppViewTransportOrFail()` 完成
   *      `adoptOpener + postReadyToOpener` 预备动作（自动 launch 与
   *      手工 launch 共用同一条 transport 链）；
   *   2. 复用 opener transport 走 `connect.launch({ launchToken })`；
   *   3. 成功后 `adoptSessionFromResponse(...)` 写当前 session，并
   *      `stripLaunchTokenFromUrl()` 清掉 URL 里的一次性 token；
   *   4. 任意一步失败 → 进入 appView 失败态，**不**自动回退到 direct
   *      login / connect.login，**不**自动改走 `connect.login`，
   *      **不**主动 `window.open(...)` 新开一扇 popup。
   *
   * 注意：本函数只接受 URL 解析阶段得到的 launchToken；不允许调用方在
   * appView 路径里手工再塞值进来——那样会绕过 URL 真值。
   */
  async function performAppViewLaunch(launchToken: string): Promise<void> {
    const target = sessionWindowOrigin;
    if (!appIdentityProof) {
      const reason = appIdentityProofState.error || "App identity proof is unavailable";
      setAppViewFailureReason(reason);
      setAppViewPhase("failed");
      setLaunch((prev) => ({ ...prev, status: "error", error: reason }));
      return;
    }
    // transportOrigin 此时 === sessionWindowOrigin（appView 分支），client 据此
    // 收养 opener / 发 ready / 发 connect.launch，全程不碰 targetOrigin。
    setLaunch((prev) => ({
      ...prev,
      launchToken,
      status: "loading",
      error: "",
      request: { launchToken, sessionWindowOrigin: target ?? "" },
      response: null,
    }));
    const prep = await prepareAppViewTransportOrFail({
      sessionWindowOrigin,
      getSessionClient,
    });
    if (!prep.ok) {
      pushLog(
        {
          at: Date.now(),
          stage: "no_opener",
          method: "connect.launch",
          detail: { manual: false, code: prep.code, reason: prep.reason },
        },
        "error",
      );
      setAppViewFailureReason(prep.reason);
      setAppViewPhase("failed");
      setLaunch((prev) => ({
        ...prev,
        status: "error",
        error: prep.reason,
      }));
      return;
    }
    pushLog({
      at: Date.now(),
      stage: "ready_sent",
      method: "connect.launch",
      message: "sent top-level ready to opener (auto-launch)",
    });
    // 3) 复用 opener transport 走 `connect.launch`。
    const popup = prep.popup;
    const request = buildConnectLaunchRequest({ launchToken, appIdentity: appIdentityProof });
    setAnyBusy(true);
    try {
      const response = await popup.runRequest(request);
      if (response.ok) {
        const result = response.result as ConnectLaunchResult;
        adoptSessionFromResponse(result, "connect.launch");
        // 4) URL 里清掉一次性 launchToken，避免刷新后再次消费。
        stripLaunchTokenFromUrl();
        setAppViewPhase(null);
        setAppViewFailureReason(null);
        setLaunch((prev) => ({
          ...prev,
          status: "success",
          response,
          request: {
            ...request.params,
            appIdentity: redactAppIdentityForDisplay(request.params.appIdentity),
          },
        }));
      } else {
        const reason = formatProtocolError(
          response.error.code,
          response.error.message,
        );
        pushLog(
          {
            at: Date.now(),
            stage: "result_received",
            method: "connect.launch",
            detail: response.error,
          },
          "error",
        );
        setAppViewFailureReason(reason);
        setAppViewPhase("failed");
        setLaunch((prev) => ({
          ...prev,
          status: "error",
          error: reason,
          response,
        }));
      }
    } catch (error) {
      const reason = formatTransportError(error);
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "connect.launch",
          detail: error,
        },
        "error",
      );
      setAppViewFailureReason(reason);
      setAppViewPhase("failed");
      setLaunch((prev) => ({
        ...prev,
        status: "error",
        error: reason,
        response: null,
      }));
    } finally {
      setAnyBusy(false);
    }
  }

  function adoptSessionFromResponse(
    response: ConnectLoginResult | ConnectResumeResult | ConnectLaunchResult,
    source: "connect.login" | "connect.resume" | "connect.launch",
  ) {
    const sid = response.connectSessionId;
    setSession({
      appIdentity: response.appIdentity ?? null,
      connectSessionId: sid,
      ownerPublicKeyHex: response.ownerPublicKeyHex,
      resolvedClaims: response.resolvedClaims,
      source,
      refreshedAt: response.resolvedAt,
      lastConnectResponse: response,
    });
    // 写入本地缓存，便于刷新后手动 `connect.resume`。缓存里记的是该会话真正
    // 使用的 transport origin：popup/direct ⇒ targetOrigin；appView/launch ⇒
    // sessionWindowOrigin。这样刷新后（launchToken 已被 strip）走 direct resume
    // 时能连回会话真正所在的 origin，而不是误用一个无关的默认 targetOrigin。
    writeCachedSessionHint({
      connectSessionId: sid,
      targetOrigin: transportOrigin,
      ownerPublicKeyHex: response.ownerPublicKeyHex,
    });
  }

  function clearSession() {
    setSession(emptySession());
    clearCachedSessionHint();
  }
  /* ============== Connect handlers ============== */

  async function runChannelPublish() {
    if (anyBusy) return;
    setAnyBusy(true);
    setChannelPublishForm((s) => ({ ...s, status: "loading", error: "" }));
    try {
      let content: JSONValue;
      try {
        content = JSON.parse(channelPublishForm.contentText) as JSONValue;
      } catch (e) {
        throw new Error(
          `content must be valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const req = buildChannelPublishRequest({
        channel: channelPublishForm.channel,
        content,
      });
      const res = await runProtocolRequest(req);
      if (res.ok)
        setChannelPublishForm((s) => ({
          ...s,
          status: "success",
          request: req,
          response: res,
          result: res.result as ChannelPublishResult,
          error: "",
        }));
      else
        setChannelPublishForm((s) => ({
          ...s,
          status: "error",
          request: req,
          response: res,
          error: formatProtocolError(res.error.code, res.error.message),
        }));
    } catch (e) {
      setChannelPublishForm((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setAnyBusy(false);
    }
  }

  async function runChannelSubscriptionSet() {
    if (anyBusy) return;
    setAnyBusy(true);
    setChannelSubscriptionForm((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const channels = channelSubscriptionForm.channelsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const req = buildChannelSubscriptionSetRequest({ channels });
      const res = await runProtocolRequest(req);
      if (res.ok)
        setChannelSubscriptionForm((s) => ({
          ...s,
          status: "success",
          request: req,
          response: res,
          result: res.result as ChannelSubscriptionSetResult,
          error: "",
        }));
      else
        setChannelSubscriptionForm((s) => ({
          ...s,
          status: "error",
          request: req,
          response: res,
          error: formatProtocolError(res.error.code, res.error.message),
        }));
    } catch (e) {
      setChannelSubscriptionForm((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setAnyBusy(false);
    }
  }
  async function runStorage(method: StorageAction, loadNext = false) {
    if (anyBusy) return;
    setAnyBusy(true);
    const s = storageState;
    try {
      const common = {
        connectSessionId: s.sessionId || session.connectSessionId,
      };
      let req: ProtocolRequestMessage;
      if (method === "list")
        req = buildStorageListRequest({
          ...common,
          prefix: s.prefix || undefined,
          cursor: loadNext && s.cursor ? s.cursor : undefined,
          limit: parseOptionalSafeInteger(s.limit, "limit"),
        });
      else if (method === "directory.create")
        req = buildStorageDirectoryCreateRequest({
          ...common,
          path: s.path,
          overwrite: s.overwrite,
        });
      else if (method === "directory.delete")
        req = buildStorageDirectoryDeleteRequest({ ...common, path: s.path });
      else if (method === "put") {
        const bytes = storageFile
          ? await readSmallObjectFile(storageFile)
          : new TextEncoder().encode(s.contentText).buffer;
        req = buildStoragePutRequest({
          ...common,
          path: s.path,
          content: { $type: "binary", bytes },
          contentType: storageFile?.type || s.contentType || undefined,
          overwrite: s.overwrite,
        });
      } else if (method === "get") {
        storageRawGetRef.current = null;
        req = buildStorageGetRequest({
          ...common,
          path: s.path,
          offset: parseOptionalSafeInteger(s.offset, "offset"),
          length: parseOptionalSafeInteger(s.length, "length"),
          ifMatch: s.ifMatch || undefined,
        });
      } else if (method === "delete")
        req = buildStorageDeleteRequest({ ...common, path: s.path });
      else if (method === "upload.begin") {
        if (!storageFile) throw new Error("Select a file before begin");
        req = buildStorageUploadBeginRequest({
          ...common,
          path: s.path,
          size: storageFile.size,
          contentType: storageFile.type || s.contentType,
          overwrite: s.overwrite,
        });
      } else if (method === "upload.part") {
        if (!storageFile || !s.uploadId)
          throw new Error("File, uploadId and partSize are required");
        const n = parseOptionalSafeInteger(s.partNumber, "partNumber");
        const partSize = parseOptionalSafeInteger(s.partSize, "partSize");
        const maxParts = parseOptionalSafeInteger(s.maxParts, "maxParts");
        if (n === undefined || partSize === undefined)
          throw new Error("File, uploadId and partSize are required");
        if (maxParts !== undefined && n > maxParts)
          throw new Error("partNumber exceeds maxParts");
        const bytes = await sliceMultipartPart(storageFile, n, partSize);
        req = buildStorageUploadPartRequest({
          ...common,
          uploadId: s.uploadId,
          partNumber: n,
          content: { $type: "binary", bytes },
        });
      } else if (method === "upload.complete")
        req = buildStorageUploadCompleteRequest({
          ...common,
          uploadId: s.uploadId,
        });
      else if (method === "upload.abort")
        req = buildStorageUploadAbortRequest({
          ...common,
          uploadId: s.uploadId,
        });
      else throw new Error("Unknown storage method");
      const response = await runProtocolRequest(req);
      if (method === "get")
        storageRawGetRef.current = response.ok
          ? (response.result as StorageGetResult)
          : null;
      setStorageState((x) => ({
        ...x,
        status: response.ok ? "success" : "error",
        error: response.ok
          ? ""
          : formatProtocolError(response.error.code, response.error.message),
        cursor:
          method === "list" && response.ok
            ? ((response.result as { nextCursor?: string }).nextCursor ?? "")
            : x.cursor,
        result: response.ok ? sanitizeStorageValue(response.result) : response,
        uploadId:
          method === "upload.begin" && response.ok
            ? (response.result as { uploadId: string }).uploadId
            : x.uploadId,
        partSize:
          method === "upload.begin" && response.ok
            ? String((response.result as { partSize: number }).partSize)
            : x.partSize,
        maxParts:
          method === "upload.begin" && response.ok
            ? String((response.result as { maxParts: number }).maxParts)
            : x.maxParts,
        partNumber:
          method === "upload.part" && response.ok
            ? String(Number(x.partNumber) + 1)
            : x.partNumber,
        history: [
          {
            method,
            request: sanitizeStorageValue(req.params),
            response: response.ok
              ? sanitizeStorageValue(response.result)
              : { error: response.error.code },
            at: Date.now(),
          },
          ...x.history,
        ].slice(0, 30),
      }));
    } catch (e) {
      setStorageState((x) => ({
        ...x,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setAnyBusy(false);
    }
  }
  function downloadStorageGet() {
    const value = storageRawGetRef.current;
    if (!value?.content?.bytes) return;
    const metadata = storageDownloadMetadata(value);
    const url = URL.createObjectURL(
      new Blob([value.content.bytes], {
        type: metadata.mime,
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = metadata.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function submitConnectLogin() {
    if (anyBusy) return;
    if (!appIdentityProof) {
      setLogin((prev) => ({
        ...prev,
        status: "error",
        error: appIdentityProofState.error || "App identity proof is unavailable",
      }));
      return;
    }
    const claims = ensureTextLines(login.claimsText);
    const request = buildConnectLoginRequest({
      text: login.text,
      claims,
      appIdentity: appIdentityProof,
    });
    setLogin((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: {
        ...request.params,
        appIdentity: redactAppIdentityForDisplay(request.params.appIdentity),
      },
      response: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as ConnectLoginResult;
        adoptSessionFromResponse(result, "connect.login");
        setLogin((prev) => ({ ...prev, status: "success", response }));
      } else {
        setLogin((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setLogin((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null,
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "connect.login",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitConnectResume() {
    if (anyBusy) return;
    if (!resume.connectSessionId) {
      setResume((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    const request = buildConnectResumeRequest({
      connectSessionId: resume.connectSessionId,
    });
    setResume((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as ConnectResumeResult;
        adoptSessionFromResponse(result, "connect.resume");
        setResume((prev) => ({ ...prev, status: "success", response }));
      } else {
        setResume((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setResume((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null,
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "connect.resume",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitConnectLogout() {
    if (anyBusy) return;
    if (!logout.connectSessionId) {
      setLogout((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    const request = buildConnectLogoutRequest({
      connectSessionId: logout.connectSessionId,
    });
    setLogout((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as ConnectLogoutResult;
        // logout 成功后必须清空 in-memory session 摘要，**不**只清本地缓存：
        //   - demo 不能继续把"已 revoked 的 connectSessionId"显示成"当前 session"；
        //   - useEffect 在 session.connectSessionId 变空时会把所有业务方法表单
        //     的 sessionId 同步清掉，避免拿一个已注销的 id 继续跑业务方法；
        //   - 不主动 reconnect，不自动 fallback 到 connect.login。
        // 仅保留 logout result 作为本轮操作的可观察证据；不再承载为"当前 session"。
        clearCachedSessionHint();
        setSession({
          appIdentity: null,
          connectSessionId: "",
          ownerPublicKeyHex: "",
          resolvedClaims: {},
          source: "",
          refreshedAt: result.revokedAt,
          lastConnectResponse: result,
        });
        setLogout((prev) => ({ ...prev, status: "success", response }));
      } else {
        setLogout((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setLogout((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null,
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "connect.logout",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitConnectLaunch() {
    if (anyBusy) return;
    if (!appIdentityProof) {
      const reason = appIdentityProofState.error || "App identity proof is unavailable";
      setLaunch((prev) => ({ ...prev, status: "error", error: reason }));
      return;
    }
    if (!launch.launchToken) {
      setLaunch((prev) => ({
        ...prev,
        status: "error",
        error:
          "launchToken is required. Without a real launcher bootstrap this call will fail.",
      }));
      return;
    }
    // launch 的 transport 真值是 sessionWindowOrigin（URL 显式注入），**不**是
    // targetOrigin。仅当 appView 模式（startupMode 由 URL launchToken 决定）且
    // sessionWindowOrigin 合法时才放行；否则 fail-closed，**不**降级到
    // targetOrigin popup。
    if (startupMode !== "appView" || !sessionWindowOrigin) {
      setLaunch((prev) => ({
        ...prev,
        status: "error",
        error:
          "connect.launch requires appView mode with a valid sessionWindowOrigin injected into the URL " +
          "by the opening Session Window. launch never falls back to targetOrigin.",
      }));
      return;
    }
    const target = sessionWindowOrigin;
    // 1) 共用 transport 预备动作（与自动 launch 完全相同）：校验 origin →
    //    收养 opener → 发 ready。这一步**不**调 `runProtocolRequest`，确保
    //    `ensureSession()` / `window.open(...)` 这条 popup 回退路径在 appView
    //    手工 launch 里**永远走不到**（施工单 2026-07-02 002 第 4 / 5.一 /
    //    6.一 / 6.四 章）。
    const prep = await prepareAppViewTransportOrFail({
      sessionWindowOrigin,
      getSessionClient,
    });
    if (!prep.ok) {
      pushLog(
        {
          at: Date.now(),
          stage: "no_opener",
          method: "connect.launch",
          detail: { manual: true, code: prep.code, reason: prep.reason },
        },
        "error",
      );
      // 失败态：直接写 UI 错误，**不**调 `runProtocolRequest`，**不**
      // 让 `ensureSession()` 触发 `window.open`。appView 失败时不重置
      // appViewPhase（与 auto-launch 不同：手工 panel 是一个独立调试入口，
      // 它的失败态不应污染自动 launch 的失败态；后者由自己管）。
      setLaunch((prev) => ({
        ...prev,
        status: "error",
        error: prep.reason,
        request: {
          launchToken: launch.launchToken,
          sessionWindowOrigin: target,
        },
      }));
      return;
    }
    pushLog({
      at: Date.now(),
      stage: "ready_sent",
      method: "connect.launch",
      message: "sent top-level ready to opener (manual launch via reconnect)",
    });
    // 2) 复用 opener transport 走 `connect.launch` request。client 内部
    //    runtime 已 `connected`，`popup.runRequest()` 内部 `ensureSession()`
    //    会走 "已 connected 且持有同一扇 popup" 的快路径，**不**会再次
    //    `window.open(...)`，**不**会走 popup 回退。
    const popup = prep.popup;
    const request = buildConnectLaunchRequest({
      launchToken: launch.launchToken,
      appIdentity: appIdentityProof,
    });
    setLaunch((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: {
        ...request.params,
        appIdentity: redactAppIdentityForDisplay(request.params.appIdentity),
        sessionWindowOrigin: target,
      },
      response: null,
    }));
    setAnyBusy(true);
    try {
      const response = await popup.runRequest(request);
      if (response.ok) {
        const result = response.result as ConnectLaunchResult;
        adoptSessionFromResponse(result, "connect.launch");
        // 手工 launch 成功也 strip URL：避免刷新后 URL 里还残留一个
        // 已消费的 token 给 `useEffect` 再自动跑一次 auto-launch。
        stripLaunchTokenFromUrl();
        setLaunch((prev) => ({
          ...prev,
          status: "success",
          response,
          request: {
            ...request.params,
            appIdentity: redactAppIdentityForDisplay(request.params.appIdentity),
          },
        }));
      } else {
        const reason = formatProtocolError(
          response.error.code,
          response.error.message,
        );
        pushLog(
          {
            at: Date.now(),
            stage: "result_received",
            method: "connect.launch",
            detail: response.error,
          },
          "error",
        );
        setLaunch((prev) => ({
          ...prev,
          status: "error",
          error: reason,
          response,
        }));
      }
    } catch (error) {
      const reason = formatTransportError(error);
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "connect.launch",
          detail: error,
        },
        "error",
      );
      setLaunch((prev) => ({
        ...prev,
        status: "error",
        error: reason,
        response: null,
      }));
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Identity handlers ============== */

  async function submitIdentity() {
    if (anyBusy) return;
    if (!identity.sessionId) {
      setIdentity((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    const claims = ensureTextLines(identity.claimsText);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + Number(identity.ttlSeconds || 0);
    let request: ProtocolRequestMessage<"identity.get">;
    try {
      request = buildIdentityGetRequest({
        aud: currentOrigin,
        iat,
        exp,
        text: identity.text,
        claims,
        connectSessionId: identity.sessionId,
      });
    } catch (error) {
      setIdentity((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    setIdentity((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
      result: null,
      inspection: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as IdentityGetResult;
        const mainAddr = extractKeymasterMainAddress(result.resolvedClaims);
        setIdentity((prev) => ({
          ...prev,
          status: "success",
          response,
          result,
          inspection: inspectIdentityResult(result),
          lastKeymasterAddress: mainAddr || prev.lastKeymasterAddress,
        }));
      } else {
        setIdentity((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setIdentity((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null,
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "identity.get",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitIntent() {
    if (anyBusy) return;
    if (!intent.sessionId) {
      setIntent((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + Number(intent.ttlSeconds || 0);
    let request: ProtocolRequestMessage<"intent.sign">;
    try {
      request = buildIntentSignRequest({
        aud: currentOrigin,
        iat,
        exp,
        text: intent.text,
        contentType: intent.contentType,
        content: makeBinaryField(
          textToBytes(intent.contentText),
          intent.contentType,
        ),
        connectSessionId: intent.sessionId,
      });
    } catch (error) {
      setIntent((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    setIntent((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
      result: null,
      inspection: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as IntentSignResult;
        setIntent((prev) => ({
          ...prev,
          status: "success",
          response,
          result,
          inspection: inspectIntentResult(
            result,
            textToBytes(intent.contentText),
          ),
        }));
      } else {
        setIntent((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setIntent((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "intent.sign",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Cipher handlers ============== */

  async function submitEncrypt() {
    if (anyBusy) return;
    if (!encrypt.sessionId) {
      setEncrypt((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    let request: ProtocolRequestMessage<"cipher.encrypt">;
    try {
      request = buildCipherEncryptRequest({
        text: encrypt.text,
        contentType: encrypt.contentType,
        content: makeBinaryField(
          textToBytes(encrypt.contentText),
          encrypt.contentType,
        ),
        connectSessionId: encrypt.sessionId,
      });
    } catch (error) {
      setEncrypt((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    setEncrypt((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
      result: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setEncrypt((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as CipherEncryptResult,
        }));
      } else {
        setEncrypt((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setEncrypt((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "cipher.encrypt",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitDecrypt() {
    if (anyBusy) return;
    if (!decrypt.sessionId) {
      setDecrypt((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    let nonce: Uint8Array;
    let cipherbytes: Uint8Array;
    try {
      nonce = parseBinaryInput(decrypt.nonceInput);
      cipherbytes = parseBinaryInput(decrypt.cipherbytesInput);
    } catch (error) {
      setDecrypt((prev) => ({
        ...prev,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to parse binary input",
      }));
      return;
    }
    let request: ProtocolRequestMessage<"cipher.decrypt">;
    try {
      request = buildCipherDecryptRequest({
        text: decrypt.text,
        nonce: makeBinaryField(nonce),
        cipherbytes: makeBinaryField(cipherbytes),
        connectSessionId: decrypt.sessionId,
      });
    } catch (error) {
      setDecrypt((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    setDecrypt((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
      result: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as CipherDecryptResult;
        let decodedText = "";
        try {
          decodedText = bytesToText(new Uint8Array(result.content.bytes));
        } catch {
          decodedText = "(invalid utf-8)";
        }
        setDecrypt((prev) => ({
          ...prev,
          status: "success",
          response,
          result,
          sessionId: decrypt.sessionId,
        }));
        setDecrypt((prev) => ({
          ...prev,
          status: "success",
          response,
          result,
        }));
        // 同时把内容文本写回右侧观察区可以看的 "decodedText"。
        // 这里我们把它写回 decrypt.result 自带的位置，不另开字段。
        void decodedText;
      } else {
        setDecrypt((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setDecrypt((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "cipher.decrypt",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Transfer handlers ============== */

  async function submitP2pkh() {
    if (anyBusy) return;
    if (!p2pkh.sessionId) {
      setP2pkh((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    const amountSatoshis = Number(p2pkh.amountSatoshis);
    const feeRateSatoshisPerKb = Number(p2pkh.feeRateSatoshisPerKb);
    if (!Number.isFinite(amountSatoshis) || amountSatoshis <= 0) {
      setP2pkh((prev) => ({
        ...prev,
        status: "error",
        error: "amountSatoshis must be a positive integer",
      }));
      return;
    }
    if (!Number.isFinite(feeRateSatoshisPerKb) || feeRateSatoshisPerKb < 1) {
      setP2pkh((prev) => ({
        ...prev,
        status: "error",
        error: "feeRateSatoshisPerKb must be >= 1",
      }));
      return;
    }
    if (!p2pkh.recipientAddress) {
      setP2pkh((prev) => ({
        ...prev,
        status: "error",
        error: "recipientAddress is required",
      }));
      return;
    }
    let request: ProtocolRequestMessage<"p2pkh.transfer">;
    try {
      request = buildP2pkhTransferRequest({
        recipientAddress: p2pkh.recipientAddress,
        amountSatoshis,
        feeRateSatoshisPerKb,
        connectSessionId: p2pkh.sessionId,
      });
    } catch (error) {
      setP2pkh((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    setP2pkh((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
      result: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setP2pkh((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as P2pkhTransferResult,
        }));
      } else {
        setP2pkh((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setP2pkh((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "p2pkh.transfer",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitFeepoolPrepare() {
    if (anyBusy) return;
    if (!feepoolPrepare.sessionId) {
      setFeepoolPrepare((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    const amountSatoshis = Number(feepoolPrepare.amountSatoshis);
    let request: ProtocolRequestMessage<"feepool.prepare">;
    try {
      request = buildFeepoolPrepareRequest({
        counterpartyPublicKeyHex: feepoolPrepare.counterpartyPublicKeyHex,
        amountSatoshis,
        connectSessionId: feepoolPrepare.sessionId,
      });
    } catch (error) {
      setFeepoolPrepare((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    setFeepoolPrepare((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
      result: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as FeepoolPrepareResult;
        setFeepoolPrepare((prev) => ({
          ...prev,
          status: "success",
          response,
          result,
        }));
        let autoTotal = feepoolPrepare.poolTotalAmount;
        const priorTotal = priorPoolTotalAmount(result.priorPoolRecord);
        if (priorTotal !== null) {
          autoTotal = String(priorTotal);
        }
        setFeepoolCommit((prev) => ({
          ...prev,
          operationId: result.operationId,
          counterpartyPublicKeyHex: result.counterpartyPublicKeyHex,
          action: result.action,
          draftTotalAmount: autoTotal,
        }));
      } else {
        setFeepoolPrepare((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setFeepoolPrepare((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "feepool.prepare",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitFeepoolCommit() {
    if (anyBusy) return;
    if (!feepoolCommit.sessionId) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error: "connectSessionId is required",
      }));
      return;
    }
    const prepareResult = feepoolPrepare.result;
    if (!prepareResult) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error:
          "No feepool.prepare result to commit. Run feepool.prepare first.",
      }));
      return;
    }
    if (!testWalletState.wallet) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error:
          "Test wallet is required for local counter-signing. Generate or import one in the Wallet workbench.",
      }));
      return;
    }
    if (
      testWalletState.wallet.publicKeyHex !==
      prepareResult.counterpartyPublicKeyHex
    ) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error:
          `Test wallet public key does not match feepool.prepare counterpartyPublicKeyHex. ` +
          `Expected ${prepareResult.counterpartyPublicKeyHex}, got ${testWalletState.wallet!.publicKeyHex}. ` +
          `Re-run feepool.prepare with the current test wallet, or re-import the original wallet.`,
      }));
      return;
    }
    if (
      !feepoolCommit.keymasterPublicKeyHex ||
      !/^[0-9a-fA-F]{66}$/.test(feepoolCommit.keymasterPublicKeyHex)
    ) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error:
          "keymasterPublicKeyHex is required (33-byte compressed hex). Fill it manually if not known.",
      }));
      return;
    }
    const draftTotal = Number(feepoolCommit.draftTotalAmount);
    if (!Number.isFinite(draftTotal) || draftTotal <= 0) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error: "draftTotalAmount must be a positive integer (pool size).",
      }));
      return;
    }

    let commitParams: FeepoolCommitParams;
    try {
      // 用本地签名辅助函数实际签名 draftSpendTxHex / closeDraftTxHex。
      // buildFeepoolCommitParams 是 demo 自己的 helper，不属于协议 contract。
      const local = buildFeepoolCommitParams({
        prepare: prepareResult,
        counterpartyPrivateKeyHex: testWalletState.wallet.privateKeyHex,
        counterpartyPublicKeyHex: testWalletState.wallet.publicKeyHex,
        keymasterPublicKeyHex: feepoolCommit.keymasterPublicKeyHex,
        draftTotalAmount: draftTotal,
        connectSessionId: feepoolCommit.sessionId,
      });
      commitParams = local;
    } catch (error) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to build feepool.commit params",
      }));
      return;
    }

    setFeepoolCommit((prev) => ({
      ...prev,
      counterpartySignatures: commitParams.counterpartySignatures
        .map((s) => bytesToHex(new Uint8Array(s.bytes)))
        .join("\n"),
      closeCounterpartySignatures: commitParams.closeCounterpartySignatures
        ? commitParams.closeCounterpartySignatures
            .map((s) => bytesToHex(new Uint8Array(s.bytes)))
            .join("\n")
        : prev.closeCounterpartySignatures,
    }));

    let request: ProtocolRequestMessage<"feepool.commit">;
    try {
      request = buildFeepoolCommitRequest({
        operationId: commitParams.operationId,
        counterpartyPublicKeyHex: commitParams.counterpartyPublicKeyHex,
        counterpartySignatures: commitParams.counterpartySignatures,
        closeCounterpartySignatures: commitParams.closeCounterpartySignatures,
        connectSessionId: feepoolCommit.sessionId,
      });
    } catch (error) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to build feepool.commit request",
      }));
      return;
    }

    setFeepoolCommit((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      request: request.params,
      response: null,
    }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setFeepoolCommit((prev) => ({ ...prev, status: "success", response }));
      } else {
        setFeepoolCommit((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(
            response.error.code,
            response.error.message,
          ),
          response,
        }));
      }
    } catch (error) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
      }));
      pushLog(
        {
          at: Date.now(),
          stage: "timeout",
          method: "feepool.commit",
          detail: error,
        },
        "error",
      );
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== MSFile handlers ============== */

  /**
   * `msfile.stat`：只提交 seed hash。
   *
   * 设计缘由：Demo **不**做供应商选择策略；把 stat 结果原样展示，测试人员
   * 再挑 supplier 去 read，保持外部调用方视角。
   */
  async function submitMsFileStat() {
    if (anyBusy) return;
    setAnyBusy(true);
    setMsFileStat((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const req = buildMsFileStatRequest({
        connectSessionId: msfileStat.sessionId,
        seedHashHex: msfileStat.seedHashHex.trim(),
      });
      const res = await runProtocolRequest(req);
      if (res.ok)
        setMsFileStat((s) => ({
          ...s,
          status: "success",
          request: req,
          response: res,
          result: res.result as MsFileStatResult,
          error: "",
        }));
      else
        setMsFileStat((s) => ({
          ...s,
          status: "error",
          request: req,
          response: res,
          error: formatProtocolError(res.error.code, res.error.message),
        }));
    } catch (e) {
      setMsFileStat((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setAnyBusy(false);
    }
  }

  /** `msfile.seed.read`：按 supplier + seed hash 读取；金额由 Keymaster 决定。 */
  async function submitMsFileSeedRead() {
    if (anyBusy) return;
    setAnyBusy(true);
    setMsFileSeedRead((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const req = buildMsFileSeedReadRequest({
        connectSessionId: msfileSeedRead.sessionId,
        supplierPublicKeyHex: msfileSeedRead.supplierPublicKeyHex.trim(),
        seedHashHex: msfileSeedRead.hashHex.trim(),
      });
      const res = await runProtocolRequest(req);
      if (res.ok)
        setMsFileSeedRead((s) => ({
          ...s,
          status: "success",
          request: req,
          response: res,
          result: res.result as MsFileReadResult,
          error: "",
        }));
      else
        setMsFileSeedRead((s) => ({
          ...s,
          status: "error",
          request: req,
          response: res,
          error: formatProtocolError(res.error.code, res.error.message),
        }));
    } catch (e) {
      setMsFileSeedRead((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setAnyBusy(false);
    }
  }

  /** `msfile.block.read`：按 supplier + block hash 读取；金额由 Keymaster 决定。 */
  async function submitMsFileBlockRead() {
    if (anyBusy) return;
    setAnyBusy(true);
    setMsFileBlockRead((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const req = buildMsFileBlockReadRequest({
        connectSessionId: msfileBlockRead.sessionId,
        supplierPublicKeyHex: msfileBlockRead.supplierPublicKeyHex.trim(),
        blockHashHex: msfileBlockRead.hashHex.trim(),
      });
      const res = await runProtocolRequest(req);
      if (res.ok)
        setMsFileBlockRead((s) => ({
          ...s,
          status: "success",
          request: req,
          response: res,
          result: res.result as MsFileReadResult,
          error: "",
        }));
      else
        setMsFileBlockRead((s) => ({
          ...s,
          status: "error",
          request: req,
          response: res,
          error: formatProtocolError(res.error.code, res.error.message),
        }));
    } catch (e) {
      setMsFileBlockRead((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Test wallet handlers（保留旧实现） ============== */

  function generateNewTestWallet() {
    try {
      const w = generateTestWallet();
      setTestWalletState((prev) => ({
        ...prev,
        wallet: w,
        wifInput: w.wif,
        error: "",
      }));
    } catch (err) {
      setTestWalletState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  function importWif() {
    if (!isValidWif(testWalletState.wifInput)) {
      setTestWalletState((prev) => ({ ...prev, error: "WIF is not valid" }));
      return;
    }
    try {
      const w = importTestWallet(testWalletState.wifInput);
      setTestWalletState((prev) => ({ ...prev, wallet: w, error: "" }));
    } catch (err) {
      setTestWalletState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  function forgetTestWallet() {
    setTestWalletState((prev) => ({
      ...prev,
      wallet: null,
      wifInput: "",
      utxos: [],
      utxoError: "",
      utxoStatus: "idle",
    }));
  }

  async function refreshTestWalletUtxos() {
    const w = testWalletState.wallet;
    if (!w) return;
    setTestWalletState((prev) => ({
      ...prev,
      utxoStatus: "loading",
      utxoError: "",
    }));
    try {
      const client = createWocClient();
      const utxos = await client.listConfirmedUtxos(w.address);
      setTestWalletState((prev) => ({
        ...prev,
        utxos,
        utxoStatus: "success",
        utxoError: "",
        utxoRefreshedAt: Date.now(),
      }));
    } catch (err) {
      setTestWalletState((prev) => ({
        ...prev,
        utxoStatus: "error",
        utxoError: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function submitRefund() {
    if (toolBusy) return;
    const w = testWalletState.wallet;
    if (!w) {
      setRefund((prev) => ({
        ...prev,
        status: "error",
        error: "Test wallet is required for refund tool.",
      }));
      return;
    }
    if (!refund.recipientAddress) {
      setRefund((prev) => ({
        ...prev,
        status: "error",
        error: "recipientAddress is required for refund.",
      }));
      return;
    }
    const amountSatoshis = Number(refund.amountSatoshis);
    const feeRateSatoshisPerKb = Number(refund.feeRateSatoshisPerKb);
    if (!Number.isFinite(amountSatoshis) || amountSatoshis <= 0) {
      setRefund((prev) => ({
        ...prev,
        status: "error",
        error: "amountSatoshis must be a positive integer",
      }));
      return;
    }
    if (!Number.isFinite(feeRateSatoshisPerKb) || feeRateSatoshisPerKb < 1) {
      setRefund((prev) => ({
        ...prev,
        status: "error",
        error: "feeRateSatoshisPerKb must be >= 1",
      }));
      return;
    }
    setRefund((prev) => ({
      ...prev,
      status: "loading",
      error: "",
      result: null,
    }));
    setToolBusy(true);
    try {
      const woc = createWocClient();
      const utxos = await woc.listConfirmedUtxos(w.address);
      setTestWalletState((prev) => ({
        ...prev,
        utxos,
        utxoRefreshedAt: Date.now(),
        utxoStatus: "success",
        utxoError: "",
      }));
      const validation = validateTransferParams({
        amountSatoshis,
        feeRateSatoshisPerKb,
        recipientAddress: refund.recipientAddress,
      });
      if (validation) {
        throw new Error(validation.message);
      }
      const walletUtxos = wocUtxosToTestWalletUtxos(utxos, w.address);
      const transfer = await buildAndSignP2pkhTransfer({
        wallet: w,
        utxos: walletUtxos,
        recipientAddress: refund.recipientAddress,
        amountSatoshis,
        feeRateSatoshisPerKb,
      });
      const receipt = await woc.broadcast(transfer.rawTxHex);
      setRefund((prev) => ({
        ...prev,
        status: "success",
        result: {
          txid: receipt.canonicalTxid,
          rawTxHex: transfer.rawTxHex,
          feeSatoshis: transfer.feeSatoshis,
        },
      }));
      void refreshTestWalletUtxos();
    } catch (error) {
      setRefund((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setToolBusy(false);
    }
  }

  /* ============== Cancel current request (7.4) ============== */

  function cancelCurrent() {
    try {
      getSessionClient().cancelCurrentRequest();
    } catch (err) {
      // no_in_flight / popup 已死：把提示推到日志面板，**不**当作协议错误。
      pushLog(
        {
          at: Date.now(),
          stage: "busy_rejected",
          message: err instanceof Error ? err.message : String(err),
        },
        "warn",
      );
    }
  }

  /* ============== 侧栏工作台清单 ============== */

  const workbenchItems: Array<{
    id: WorkbenchId;
    label: string;
    methods: string[];
    status: SectionStatus;
  }> = [
    {
      id: "connect",
      label: "Connect",
      methods: [
        "connect.login",
        "connect.resume",
        "connect.logout",
        "connect.launch",
      ],
      status:
        login.status === "loading" ||
        resume.status === "loading" ||
        logout.status === "loading" ||
        launch.status === "loading"
          ? "loading"
          : login.status === "success" || resume.status === "success"
            ? "success"
            : login.status === "error" ||
                resume.status === "error" ||
                logout.status === "error" ||
                launch.status === "error"
              ? "error"
              : "idle",
    },
    {
      id: "identity",
      label: "Identity",
      methods: ["identity.get", "intent.sign"],
      status:
        identity.status === "loading" || intent.status === "loading"
          ? "loading"
          : identity.status === "success" || intent.status === "success"
            ? "success"
            : identity.status === "error" || intent.status === "error"
              ? "error"
              : "idle",
    },
    {
      id: "cipher",
      label: "Cipher",
      methods: ["cipher.encrypt", "cipher.decrypt"],
      status:
        encrypt.status === "loading" || decrypt.status === "loading"
          ? "loading"
          : encrypt.status === "success" || decrypt.status === "success"
            ? "success"
            : encrypt.status === "error" || decrypt.status === "error"
              ? "error"
              : "idle",
    },
    {
      id: "transfer",
      label: "Transfer",
      methods: ["p2pkh.transfer", "feepool.prepare", "feepool.commit"],
      status:
        p2pkh.status === "loading" ||
        feepoolPrepare.status === "loading" ||
        feepoolCommit.status === "loading"
          ? "loading"
          : p2pkh.status === "success" ||
              feepoolPrepare.status === "success" ||
              feepoolCommit.status === "success"
            ? "success"
            : p2pkh.status === "error" ||
                feepoolPrepare.status === "error" ||
                feepoolCommit.status === "error"
              ? "error"
              : "idle",
    },
    {
      id: "channel",
      label: "Channel",
      methods: [
        "channel.publish",
        "channel.subscription_set",
        "event: channel.message_received",
      ],
      status:
        channelPublishForm.status === "loading" ||
        channelSubscriptionForm.status === "loading"
          ? "loading"
          : channelPublishForm.status === "success" ||
              channelSubscriptionForm.status === "success"
            ? "success"
            : channelPublishForm.status === "error" ||
                channelSubscriptionForm.status === "error"
              ? "error"
              : channelEvents.length > 0
                ? "success"
                : "idle",
    },
    {
      id: "storage",
      label: "Storage",
      methods: [
        "storage.list",
        "storage.directory.*",
        "storage.put/get/delete",
        "storage.upload.*",
      ],
      status: "idle",
    },
    {
      id: "msfile",
      label: "MSFile",
      methods: ["msfile.stat", "msfile.seed.read", "msfile.block.read"],
      status:
        msfileStat.status === "loading" ||
        msfileSeedRead.status === "loading" ||
        msfileBlockRead.status === "loading"
          ? "loading"
          : msfileStat.status === "success" ||
              msfileSeedRead.status === "success" ||
              msfileBlockRead.status === "success"
            ? "success"
            : msfileStat.status === "error" ||
                msfileSeedRead.status === "error" ||
                msfileBlockRead.status === "error"
              ? "error"
              : "idle",
    },
    {
      id: "wallet",
      label: "Test Wallet",
      methods: ["generate / import WIF", "WOC UTXOs", "manual refund"],
      status: toolBusy ? "loading" : testWalletState.utxoStatus,
    },
  ];

  /* ============== 主区渲染 ============== */

  function renderActiveMain(): ReactNode {
    switch (activeWorkbench) {
      case "connect":
        return renderConnectMain();
      case "identity":
        return renderIdentityMain();
      case "cipher":
        return renderCipherMain();
      case "transfer":
        return renderTransferMain();
      case "channel":
        return renderChannelMain();
      case "msfile":
        return renderMsFileMain();
      case "storage":
        return (
          <div className="protocol-section">
            <h2>Storage (S3-backed)</h2>
            <p className="hint-note">
              Storage exposes app-relative paths only; provider and bucket
              details remain hidden.
            </p>
            <SessionIdField
              value={storageState.sessionId}
              onChange={(v) => setStorageState((s) => ({ ...s, sessionId: v }))}
              currentSessionId={session.connectSessionId}
            />
            <h3>Browse</h3>
            <div className="form-grid">
              <label className="field">
                <span>prefix</span>
                <input
                  value={storageState.prefix}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, prefix: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>limit</span>
                <input
                  value={storageState.limit}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, limit: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>cursor</span>
                <input
                  value={storageState.cursor}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, cursor: e.target.value }))
                  }
                />
              </label>
            </div>
            <button onClick={() => runStorage("list")} disabled={anyBusy}>
              Run list
            </button>
            <button
              onClick={() => runStorage("list", true)}
              disabled={anyBusy || !storageState.cursor}
            >
              Load next
            </button>
            <h3>Directory</h3>
            <label className="field">
              <span>directory path</span>
              <input
                value={storageState.path}
                onChange={(e) =>
                  setStorageState((s) => ({ ...s, path: e.target.value }))
                }
              />
            </label>
            <label className="field">
              <span>overwrite</span>
              <input
                type="checkbox"
                checked={storageState.overwrite}
                onChange={(e) =>
                  setStorageState((s) => ({
                    ...s,
                    overwrite: e.target.checked,
                  }))
                }
              />
            </label>
            <div className="button-row">
              <button
                onClick={() => runStorage("directory.create")}
                disabled={anyBusy}
              >
                Run create
              </button>
              <button
                onClick={() => runStorage("directory.delete")}
                disabled={anyBusy}
              >
                Run delete
              </button>
            </div>
            <h3>Small object</h3>
            <div className="form-grid">
              <label className="field field-wide">
                <span>path</span>
                <input
                  value={storageState.path}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, path: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>offset</span>
                <input
                  value={storageState.offset}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, offset: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>length</span>
                <input
                  value={storageState.length}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, length: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>ifMatch</span>
                <input
                  value={storageState.ifMatch}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, ifMatch: e.target.value }))
                  }
                />
              </label>
              <label className="field field-wide">
                <span>content text</span>
                <textarea
                  value={storageState.contentText}
                  onChange={(e) =>
                    setStorageState((s) => ({
                      ...s,
                      contentText: e.target.value,
                    }))
                  }
                  placeholder="text content"
                />
              </label>
              <label className="field field-wide">
                <span>File</span>
                <input
                  type="file"
                  onChange={(e) => setStorageFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            <label className="field">
              <span>contentType</span>
              <input
                value={storageState.contentType}
                onChange={(e) =>
                  setStorageState((s) => ({
                    ...s,
                    contentType: e.target.value,
                  }))
                }
              />
            </label>
            <label className="field">
              <span>overwrite</span>
              <input
                type="checkbox"
                checked={storageState.overwrite}
                onChange={(e) =>
                  setStorageState((s) => ({
                    ...s,
                    overwrite: e.target.checked,
                  }))
                }
              />
            </label>
            <div className="button-row">
              <button onClick={() => runStorage("put")} disabled={anyBusy}>
                Put
              </button>
              <button onClick={() => runStorage("get")} disabled={anyBusy}>
                Get
              </button>
              <button onClick={() => runStorage("delete")} disabled={anyBusy}>
                Delete
              </button>
              <button
                onClick={downloadStorageGet}
                disabled={!storageRawGetRef.current}
              >
                Download
              </button>
            </div>
            <h3>Multipart</h3>
            <div className="form-grid">
              <label className="field field-wide">
                <span>path</span>
                <input
                  value={storageState.path}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, path: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>contentType</span>
                <input
                  value={storageState.contentType}
                  onChange={(e) =>
                    setStorageState((s) => ({
                      ...s,
                      contentType: e.target.value,
                    }))
                  }
                />
              </label>
              <label className="field">
                <span>overwrite</span>
                <input
                  type="checkbox"
                  checked={storageState.overwrite}
                  onChange={(e) =>
                    setStorageState((s) => ({
                      ...s,
                      overwrite: e.target.checked,
                    }))
                  }
                />
              </label>
              <label className="field field-wide">
                <span>File selection</span>
                <input
                  type="file"
                  onChange={(e) => setStorageFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <label className="field field-wide">
                <span>selected file summary</span>
                <input
                  value={
                    storageFile
                      ? `${storageFile.name} (${storageFile.size} bytes, ${storageFile.type || "unknown"})`
                      : "No file selected"
                  }
                  readOnly
                />
              </label>
              <label className="field">
                <span>uploadId</span>
                <input
                  value={storageState.uploadId}
                  onChange={(e) =>
                    setStorageState((s) => ({ ...s, uploadId: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>partNumber</span>
                <input
                  value={storageState.partNumber}
                  onChange={(e) =>
                    setStorageState((s) => ({
                      ...s,
                      partNumber: e.target.value,
                    }))
                  }
                />
              </label>
              <label className="field">
                <span>partSize</span>
                <input value={storageState.partSize} readOnly />
              </label>
              <label className="field">
                <span>maxParts</span>
                <input value={storageState.maxParts} readOnly />
              </label>
            </div>
            <div className="button-row">
              <button
                onClick={() => runStorage("upload.begin")}
                disabled={anyBusy}
              >
                Begin
              </button>
              <button
                onClick={() => runStorage("upload.part")}
                disabled={anyBusy}
              >
                Part
              </button>
              <button
                onClick={() => runStorage("upload.complete")}
                disabled={anyBusy}
              >
                Complete
              </button>
              <button
                onClick={() => runStorage("upload.abort")}
                disabled={anyBusy}
              >
                Abort
              </button>
            </div>
            {storageState.error && (
              <p className="error-text">{storageState.error}</p>
            )}
            <ResultPanel title="result preview" value={storageState.result} />
            <ResultPanel title="history" value={storageState.history} />
          </div>
        );
      case "wallet":
        return renderWalletMain();
    }
  }

  function renderConnectMain(): ReactNode {
    const sessionIsLaunch = session.source === "connect.launch";
    return (
      <div className="connect-grid">
        <SessionSummary
          session={session}
          transportLabel={
            sessionIsLaunch ? "sessionWindowOrigin" : "targetOrigin"
          }
          transportOrigin={
            sessionIsLaunch
              ? (sessionWindowOrigin ?? "")
              : normalizedTargetOrigin
          }
          onEdit={() => setShowSessionEditor((v) => !v)}
          showEditor={showSessionEditor}
          onClearSession={clearSession}
        />

        {/* popup / direct 登录：真值 = targetOrigin（用户输入 / UI 默认）。
            与 launch 登录是两套独立方式、参数不同，UI 上分组隔开，避免混淆。
            `Keymaster Target Origin` 字段在施工单 2026-07-02 001 后移入本分组，
            仅服务 direct / popup 登录链路；`connect.launch` 不读该字段。 */}
        <div className="login-method-group">
          <header className="login-method-group__head">
            <h2>Popup / Direct 登录</h2>
            <p>
              普通站点 popup 登录方式。transport 真值取自当前分组内配置的
              Keymaster Target Origin。
            </p>
            <dl className="login-method-group__params">
              <div className="login-method-group__param">
                <dt>transport</dt>
                <dd>targetOrigin</dd>
              </div>
              <div className="login-method-group__param">
                <dt>origin</dt>
                <dd>{normalizedTargetOrigin || "invalid"}</dd>
              </div>
              <div className="login-method-group__param">
                <dt>methods</dt>
                <dd>connect.login / connect.resume / connect.logout</dd>
              </div>
            </dl>
          </header>

          {/* Keymaster Target Origin 输入区：施工单 2026-07-02 001 之前位于顶部
              全局 Runtime config；现在作为 Popup / Direct 登录分组的组内配置。
              页面不再提供 popup 尺寸 / 超时的 UI 入口，相关常量由代码固定。 */}
          <section className="runtime-config-inline">
            <header className="runtime-config-inline__head">
              <h3>Popup / Direct 登录 transport</h3>
              <p>
                仅服务 direct / popup 登录链路；launch / appView
                路径不读此字段。
              </p>
            </header>
            <div className="form-grid">
              <label className="field field-wide">
                <span>Keymaster Target Origin</span>
                <input
                  value={targetOrigin}
                  onChange={(e) => setTargetOrigin(e.target.value)}
                  placeholder="https://keymaster.cc"
                />
              </label>
            </div>
            <p className="hint-note">
              popup 尺寸（520 × 760）与 ready / result 超时（10000 ms / 60000
              ms）由代码固定，不在本页面暴露。
            </p>
          </section>

          <ProtocolSection
            title="connect.login"
            subtitle="普通站点首次登录入口；user 在 popup UI 上选 key。成功后写入 demo session 摘要与 localStorage 缓存。"
            status={login.status}
            onSubmit={submitConnectLogin}
            submitLabel="Run connect.login"
            error={login.error}
            disabled={anyBusy}
          >
            <div className="form-grid">
              <label className="field field-wide">
                <span>text</span>
                <textarea
                  value={login.text}
                  onChange={(e) =>
                    setLogin((prev) => ({ ...prev, text: e.target.value }))
                  }
                  rows={3}
                />
              </label>
              <label className="field field-wide">
                <span>claims (one per line)</span>
                <textarea
                  value={login.claimsText}
                  onChange={(e) =>
                    setLogin((prev) => ({
                      ...prev,
                      claimsText: e.target.value,
                    }))
                  }
                  rows={4}
                />
              </label>
            </div>
            <ResultGrid
              items={[
                {
                  label: "sessionId",
                  value: session.lastConnectResponse
                    ? "connectSessionId" in session.lastConnectResponse
                      ? session.lastConnectResponse.connectSessionId
                      : ""
                    : "",
                },
                {
                  label: "ownerPublicKeyHex",
                  value:
                    session.lastConnectResponse &&
                    "ownerPublicKeyHex" in session.lastConnectResponse
                      ? session.lastConnectResponse.ownerPublicKeyHex
                      : "",
                },
              ]}
            />
          </ProtocolSection>

          <ProtocolSection
            title="connect.resume"
            subtitle="手动 `connect.resume` 用最近一次 sessionId。刷新后由 localStorage 缓存自动回填。"
            status={resume.status}
            onSubmit={submitConnectResume}
            submitLabel="Run connect.resume"
            error={resume.error}
            disabled={anyBusy}
          >
            <div className="form-grid">
              <label className="field field-wide">
                <span>connectSessionId</span>
                <input
                  value={resume.connectSessionId}
                  onChange={(e) =>
                    setResume((prev) => ({
                      ...prev,
                      connectSessionId: e.target.value,
                    }))
                  }
                  placeholder="from localStorage cache or manual input"
                />
              </label>
            </div>
          </ProtocolSection>

          <ProtocolSection
            title="connect.logout"
            subtitle="仅吊销 sessionId；成功后会清掉 demo 的本地缓存，但不主动重连。"
            status={logout.status}
            onSubmit={submitConnectLogout}
            submitLabel="Run connect.logout"
            error={logout.error}
            disabled={anyBusy}
          >
            <div className="form-grid">
              <label className="field field-wide">
                <span>connectSessionId</span>
                <input
                  value={logout.connectSessionId}
                  onChange={(e) =>
                    setLogout((prev) => ({
                      ...prev,
                      connectSessionId: e.target.value,
                    }))
                  }
                />
              </label>
            </div>
          </ProtocolSection>
        </div>

        {/* launch / appView 登录：真值 = sessionWindowOrigin（打开本 child app 的
            Session Window 显式注入 URL）。**不**读 targetOrigin。参数与 popup 登录
            完全不同，UI 上独立成组展示。 */}
        <div className="login-method-group login-method-group--launch">
          <header className="login-method-group__head">
            <h2>Launch / appView 登录</h2>
            <p>
              child app 被 Session Window 打开后的启动登录方式。transport
              真值取自 URL 注入的 sessionWindowOrigin，<strong>不</strong>使用
              targetOrigin。
            </p>
            <dl className="login-method-group__params">
              <div className="login-method-group__param">
                <dt>transport</dt>
                <dd>sessionWindowOrigin</dd>
              </div>
              <div className="login-method-group__param">
                <dt>origin</dt>
                <dd>{sessionWindowOrigin ?? "（URL 未注入 / 非法）"}</dd>
              </div>
              <div className="login-method-group__param">
                <dt>startup mode</dt>
                <dd>{startupMode}</dd>
              </div>
              <div className="login-method-group__param">
                <dt>methods</dt>
                <dd>connect.launch</dd>
              </div>
            </dl>
          </header>

          <ProtocolSection
            title="connect.launch"
            subtitle="appView mode 首登入口。launchToken 由 launcher 一次性 bootstrap 写入 URL；transport 走 sessionWindowOrigin，自动 / 手工 launch 共用同一条 opener transport，demo 不再为手工 launch 新开 protocol popup。"
            status={launch.status}
            onSubmit={submitConnectLaunch}
            submitLabel="Run connect.launch"
            error={launch.error}
            disabled={anyBusy}
          >
            <div className="form-grid">
              <label className="field field-wide">
                <span>launchToken</span>
                <input
                  value={launch.launchToken}
                  onChange={(e) =>
                    setLaunch((prev) => ({
                      ...prev,
                      launchToken: e.target.value,
                    }))
                  }
                  placeholder="from ?launchToken= URL or manual input"
                />
              </label>
              <label className="field field-wide">
                <span>sessionWindowOrigin (read-only, URL-injected)</span>
                <input
                  value={sessionWindowOrigin ?? ""}
                  readOnly
                  placeholder="injected by the opening Session Window; not editable here"
                />
              </label>
            </div>
            <p className="hint-note">
              手工触发时仍复用已打开的 Session Window 作为 transport 对端，
              <strong>不</strong>会新开
              <code>/protocol/v1/popup</code>；没有真实 launchToken
              时失败是预期行为；缺少合法 sessionWindowOrigin 或 opener 不可用时
              launch 直接 fail-closed，要求从 Keymaster 重新拉起。
            </p>
          </ProtocolSection>
        </div>
      </div>
    );
  }

  function renderIdentityMain(): ReactNode {
    return (
      <div className="workbench-grid">
        <ProtocolSection
          title="identity.get"
          subtitle="会话内身份断言；subject 取自当前 session 绑定 owner。"
          status={identity.status}
          onSubmit={submitIdentity}
          submitLabel="Run identity.get"
          error={identity.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={identity.sessionId}
            onChange={(v) => setIdentity((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>text</span>
              <textarea
                value={identity.text}
                onChange={(e) =>
                  setIdentity((prev) => ({ ...prev, text: e.target.value }))
                }
                rows={3}
              />
            </label>
            <label className="field field-wide">
              <span>claims (one per line)</span>
              <textarea
                value={identity.claimsText}
                onChange={(e) =>
                  setIdentity((prev) => ({
                    ...prev,
                    claimsText: e.target.value,
                  }))
                }
                rows={4}
              />
            </label>
            <label className="field">
              <span>ttlSeconds</span>
              <input
                type="number"
                min={1}
                step={1}
                value={identity.ttlSeconds}
                onChange={(e) =>
                  setIdentity((prev) => ({
                    ...prev,
                    ttlSeconds: Number(e.target.value || 0),
                  }))
                }
              />
            </label>
          </div>
          <ResultGrid
            items={[
              {
                label: "subject.publicKey",
                value: identity.inspection?.publicKeyHex ?? "n/a",
              },
              {
                label: "signature",
                value: identity.inspection?.signatureHex ?? "n/a",
              },
              {
                label: "local verify",
                value: identity.inspection
                  ? identity.inspection.ok
                    ? "pass"
                    : "fail"
                  : "n/a",
              },
              {
                label: "claims projection",
                value: identity.inspection?.claimsProjection ?? "n/a",
              },
              {
                label: "last keymaster main address",
                value: identity.lastKeymasterAddress || "n/a",
              },
            ]}
          />
        </ProtocolSection>

        <ProtocolSection
          title="intent.sign"
          subtitle="会话内签名；签名主体公钥取自 session owner。"
          status={intent.status}
          onSubmit={submitIntent}
          submitLabel="Run intent.sign"
          error={intent.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={intent.sessionId}
            onChange={(v) => setIntent((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>text</span>
              <textarea
                value={intent.text}
                onChange={(e) =>
                  setIntent((prev) => ({ ...prev, text: e.target.value }))
                }
                rows={3}
              />
            </label>
            <label className="field">
              <span>contentType</span>
              <input
                value={intent.contentType}
                onChange={(e) =>
                  setIntent((prev) => ({
                    ...prev,
                    contentType: e.target.value,
                  }))
                }
              />
            </label>
            <label className="field">
              <span>ttlSeconds</span>
              <input
                type="number"
                min={1}
                step={1}
                value={intent.ttlSeconds}
                onChange={(e) =>
                  setIntent((prev) => ({
                    ...prev,
                    ttlSeconds: Number(e.target.value || 0),
                  }))
                }
              />
            </label>
            <label className="field field-wide">
              <span>contentText</span>
              <textarea
                value={intent.contentText}
                onChange={(e) =>
                  setIntent((prev) => ({
                    ...prev,
                    contentText: e.target.value,
                  }))
                }
                rows={4}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              {
                label: "contentSha256 (local)",
                value: intent.inspection?.computedContentSha256Hex ?? "n/a",
              },
              {
                label: "contentSha256 (envelope)",
                value: intent.inspection?.envelopeContentSha256Hex ?? "n/a",
              },
              {
                label: "local verify",
                value: intent.inspection
                  ? intent.inspection.ok
                    ? "pass"
                    : "fail"
                  : "n/a",
              },
              {
                label: "subject.publicKey",
                value: intent.inspection?.publicKeyHex ?? "n/a",
              },
            ]}
          />
        </ProtocolSection>
      </div>
    );
  }

  function renderCipherMain(): ReactNode {
    return (
      <div className="workbench-grid">
        <ProtocolSection
          title="cipher.encrypt"
          subtitle="站点绑定加解密；encrypt 成功后自动回填到 decrypt 区。"
          status={encrypt.status}
          onSubmit={submitEncrypt}
          submitLabel="Run cipher.encrypt"
          error={encrypt.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={encrypt.sessionId}
            onChange={(v) => setEncrypt((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>text</span>
              <textarea
                value={encrypt.text}
                onChange={(e) =>
                  setEncrypt((prev) => ({ ...prev, text: e.target.value }))
                }
                rows={3}
              />
            </label>
            <label className="field">
              <span>contentType</span>
              <input
                value={encrypt.contentType}
                onChange={(e) =>
                  setEncrypt((prev) => ({
                    ...prev,
                    contentType: e.target.value,
                  }))
                }
              />
            </label>
            <label className="field field-wide">
              <span>contentText</span>
              <textarea
                value={encrypt.contentText}
                onChange={(e) =>
                  setEncrypt((prev) => ({
                    ...prev,
                    contentText: e.target.value,
                  }))
                }
                rows={4}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              {
                label: "nonce hex",
                value: encrypt.result
                  ? bytesToHex(new Uint8Array(encrypt.result.nonce.bytes))
                  : "n/a",
              },
              {
                label: "nonce base64",
                value: encrypt.result
                  ? bytesToBase64(new Uint8Array(encrypt.result.nonce.bytes))
                  : "n/a",
              },
              {
                label: "cipherbytes hex",
                value: encrypt.result
                  ? bytesToHex(new Uint8Array(encrypt.result.cipherbytes.bytes))
                  : "n/a",
              },
              {
                label: "cipherbytes base64",
                value: encrypt.result
                  ? bytesToBase64(
                      new Uint8Array(encrypt.result.cipherbytes.bytes),
                    )
                  : "n/a",
              },
            ]}
          />
        </ProtocolSection>

        <ProtocolSection
          title="cipher.decrypt"
          subtitle="支持手工粘贴 nonce / cipherbytes；`decrypt_failed` 是预期的协议错误。"
          status={decrypt.status}
          onSubmit={submitDecrypt}
          submitLabel="Run cipher.decrypt"
          error={decrypt.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={decrypt.sessionId}
            onChange={(v) => setDecrypt((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>text</span>
              <textarea
                value={decrypt.text}
                onChange={(e) =>
                  setDecrypt((prev) => ({ ...prev, text: e.target.value }))
                }
                rows={3}
              />
            </label>
            <label className="field field-wide">
              <span>nonce</span>
              <textarea
                value={decrypt.nonceInput}
                onChange={(e) =>
                  setDecrypt((prev) => ({
                    ...prev,
                    nonceInput: e.target.value,
                  }))
                }
                rows={2}
                placeholder="hex or base64"
              />
            </label>
            <label className="field field-wide">
              <span>cipherbytes</span>
              <textarea
                value={decrypt.cipherbytesInput}
                onChange={(e) =>
                  setDecrypt((prev) => ({
                    ...prev,
                    cipherbytesInput: e.target.value,
                  }))
                }
                rows={4}
                placeholder="hex or base64"
              />
            </label>
          </div>
          <ResultGrid
            items={[
              {
                label: "contentType",
                value: decrypt.result?.contentType ?? "n/a",
              },
              {
                label: "content hex",
                value: decrypt.result
                  ? bytesToHex(new Uint8Array(decrypt.result.content.bytes))
                  : "n/a",
              },
              {
                label: "content text",
                value: decrypt.result
                  ? safeBytesToText(
                      new Uint8Array(decrypt.result.content.bytes),
                    )
                  : "n/a",
              },
            ]}
          />
        </ProtocolSection>
      </div>
    );
  }

  function renderTransferMain(): ReactNode {
    return (
      <div className="workbench-grid">
        <ProtocolSection
          title="p2pkh.transfer"
          subtitle="主网 P2PKH 转账。`aud` 由 popup 端按 event.origin 自动绑定。"
          status={p2pkh.status}
          onSubmit={submitP2pkh}
          submitLabel="Run p2pkh.transfer"
          error={p2pkh.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={p2pkh.sessionId}
            onChange={(v) => setP2pkh((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>recipientAddress</span>
              <input
                value={p2pkh.recipientAddress}
                onChange={(e) =>
                  setP2pkh((prev) => ({
                    ...prev,
                    recipientAddress: e.target.value,
                  }))
                }
                placeholder="mainnet P2PKH address"
              />
            </label>
            <label className="field">
              <span>amountSatoshis</span>
              <input
                type="number"
                min={1}
                step={1}
                value={p2pkh.amountSatoshis}
                onChange={(e) =>
                  setP2pkh((prev) => ({
                    ...prev,
                    amountSatoshis: e.target.value,
                  }))
                }
              />
            </label>
            <label className="field">
              <span>feeRateSatoshisPerKb</span>
              <input
                type="number"
                min={1}
                step={1}
                value={p2pkh.feeRateSatoshisPerKb}
                onChange={(e) =>
                  setP2pkh((prev) => ({
                    ...prev,
                    feeRateSatoshisPerKb: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "txid", value: p2pkh.result?.txid ?? "n/a" },
              {
                label: "rawTxHex (head)",
                value: p2pkh.result
                  ? truncateHex(p2pkh.result.rawTxHex, 64)
                  : "n/a",
              },
              {
                label: "feeSatoshis",
                value: p2pkh.result?.feeSatoshis ?? "n/a",
              },
            ]}
          />
        </ProtocolSection>

        <ProtocolSection
          title="feepool.prepare"
          subtitle="action 由 Keymaster 单边决定；prepare 成功后回填 operationId / counterparty 到 commit 区。"
          status={feepoolPrepare.status}
          onSubmit={submitFeepoolPrepare}
          submitLabel="Run feepool.prepare"
          error={feepoolPrepare.error}
          disabled={anyBusy}
          extraAction={
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                const prepare = feepoolPrepare.result;
                if (!prepare) return;
                const projected = projectFeepoolCommitInput(prepare);
                if (!projected) return;
                setFeepoolCommit((prev) => ({
                  ...prev,
                  operationId: projected.operationId,
                  counterpartyPublicKeyHex: projected.counterpartyPublicKeyHex,
                  action: prepare.action,
                  draftTotalAmount:
                    priorPoolTotalAmount(prepare.priorPoolRecord)?.toString() ??
                    prev.draftTotalAmount,
                }));
              }}
              disabled={!feepoolPrepare.result}
            >
              Fill commit inputs
            </button>
          }
        >
          <SessionIdField
            value={feepoolPrepare.sessionId}
            onChange={(v) =>
              setFeepoolPrepare((prev) => ({ ...prev, sessionId: v }))
            }
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>counterpartyPublicKeyHex</span>
              <input
                value={feepoolPrepare.counterpartyPublicKeyHex}
                onChange={(e) =>
                  setFeepoolPrepare((prev) => ({
                    ...prev,
                    counterpartyPublicKeyHex: e.target.value,
                  }))
                }
                placeholder="33-byte compressed secp256k1 hex"
              />
            </label>
            <label className="field">
              <span>amountSatoshis</span>
              <input
                type="number"
                min={1}
                step={1}
                value={feepoolPrepare.amountSatoshis}
                onChange={(e) =>
                  setFeepoolPrepare((prev) => ({
                    ...prev,
                    amountSatoshis: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          <ResultGrid
            items={[
              {
                label: "operationId",
                value: feepoolPrepare.result?.operationId ?? "n/a",
              },
              {
                label: "action",
                value: feepoolPrepare.result
                  ? actionLabel(feepoolPrepare.result.action)
                  : "n/a",
              },
              {
                label: "draftSpendTxHex (head)",
                value: feepoolPrepare.result
                  ? truncateHex(feepoolPrepare.result.draftSpendTxHex, 64)
                  : "n/a",
              },
              {
                label: "baseTxHex",
                value: feepoolPrepare.result?.baseTxHex
                  ? truncateHex(feepoolPrepare.result.baseTxHex, 64)
                  : "n/a",
              },
              {
                label: "priorPool.totalAmount",
                value:
                  priorPoolTotalAmount(
                    feepoolPrepare.result?.priorPoolRecord,
                  ) ?? "n/a",
              },
            ]}
          />
        </ProtocolSection>

        <ProtocolSection
          title="feepool.commit"
          subtitle="消费 feepool.prepare 的 operationId + counterparty sigs。测试钱包私钥必须在 Test Wallet 区准备好。"
          status={feepoolCommit.status}
          onSubmit={submitFeepoolCommit}
          submitLabel="Run feepool.commit"
          error={feepoolCommit.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={feepoolCommit.sessionId}
            onChange={(v) =>
              setFeepoolCommit((prev) => ({ ...prev, sessionId: v }))
            }
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>operationId (auto from prepare)</span>
              <input
                value={feepoolCommit.operationId}
                onChange={(e) =>
                  setFeepoolCommit((prev) => ({
                    ...prev,
                    operationId: e.target.value,
                  }))
                }
                placeholder="from feepool.prepare result"
              />
            </label>
            <label className="field field-wide">
              <span>counterpartyPublicKeyHex</span>
              <input
                value={feepoolCommit.counterpartyPublicKeyHex}
                onChange={(e) =>
                  setFeepoolCommit((prev) => ({
                    ...prev,
                    counterpartyPublicKeyHex: e.target.value,
                  }))
                }
              />
            </label>
            <label className="field field-wide">
              <span>action (read-only, from prepare)</span>
              <input value={feepoolCommit.action} readOnly />
            </label>
            <label className="field field-wide">
              <span>
                keymasterPublicKeyHex (Keymaster multisig client pubkey)
              </span>
              <input
                value={feepoolCommit.keymasterPublicKeyHex}
                onChange={(e) =>
                  setFeepoolCommit((prev) => ({
                    ...prev,
                    keymasterPublicKeyHex: e.target.value,
                  }))
                }
                placeholder="33-byte compressed secp256k1 hex (Keymaster active key pubkey)"
              />
            </label>
            <label className="field">
              <span>draftTotalAmount (pool size)</span>
              <input
                type="number"
                min={1}
                step={1}
                value={feepoolCommit.draftTotalAmount}
                onChange={(e) =>
                  setFeepoolCommit((prev) => ({
                    ...prev,
                    draftTotalAmount: e.target.value,
                  }))
                }
                placeholder="multisig output total"
              />
            </label>
            <label className="field field-wide">
              <span>
                counterpartySignatures (auto-computed, hex, one per line)
              </span>
              <textarea
                value={feepoolCommit.counterpartySignatures}
                readOnly
                rows={3}
              />
            </label>
            {feepoolCommit.closeCounterpartySignatures ? (
              <label className="field field-wide">
                <span>
                  closeCounterpartySignatures (auto-computed, hex, one per line)
                </span>
                <textarea
                  value={feepoolCommit.closeCounterpartySignatures}
                  readOnly
                  rows={3}
                />
              </label>
            ) : null}
          </div>
          <ResultGrid
            items={[
              {
                label: "result.operationId",
                value:
                  resultFromFeepoolCommit(
                    feepoolCommit.response,
                    "operationId",
                  ) ?? "n/a",
              },
              {
                label: "result.action",
                value:
                  resultFromFeepoolCommit(feepoolCommit.response, "action") ??
                  "n/a",
              },
              {
                label: "result.draftTxid",
                value:
                  resultFromFeepoolCommit(
                    feepoolCommit.response,
                    "draftTxid",
                  ) ?? "n/a",
              },
              {
                label: "result.draftTxHex (head)",
                value:
                  resultFromFeepoolCommit(
                    feepoolCommit.response,
                    "draftTxHexHead",
                  ) ?? "n/a",
              },
            ]}
          />
        </ProtocolSection>
      </div>
    );
  }

  /**
   * Channel 工作台。
   *
   * 设计缘由：channel.* 的 connect session 来自 Session Window transport
   * context，params **不**带 connectSessionId；因此这里**不**提供 sessionId
   * 输入框，避免把窗口真值表现成 App 可自报字段。
   */
  function renderChannelMain(): ReactNode {
    const latestEvent = channelEvents[0] ?? null;
    return (
      <div className="workbench-grid">
        <ProtocolSection
          title="channel.publish"
          subtitle="向精确频道发布已签名 JSON；不支持通配符，owner、签名和 messageId 由 Keymaster 生成。"
          status={channelPublishForm.status}
          onSubmit={runChannelPublish}
          submitLabel="Run channel.publish"
          error={channelPublishForm.error}
          disabled={anyBusy}
        >
          <p className="hint-note">
            channel.* 的 connect session 来自当前 Session Window；请先在
            Connect 工作台完成 login / resume。
          </p>
          <label className="field field-wide">
            <span>channel (exact, ≤256 UTF-8 bytes)</span>
            <input
              value={channelPublishForm.channel}
              onChange={(e) =>
                setChannelPublishForm((s) => ({
                  ...s,
                  channel: e.target.value,
                }))
              }
              placeholder="demo.channel"
            />
          </label>
          <label className="field field-wide">
            <span>content (JSON, ≤16 levels)</span>
            <textarea
              value={channelPublishForm.contentText}
              onChange={(e) =>
                setChannelPublishForm((s) => ({
                  ...s,
                  contentText: e.target.value,
                }))
              }
              rows={8}
              placeholder='{"type":"demo"}'
            />
          </label>
          <ResultPanel
            title="publish result"
            value={channelPublishForm.result}
          />
        </ProtocolSection>

        <ProtocolSection
          title="channel.subscription_set"
          subtitle="替换当前 caller 的完整精确频道集合；空行 = 释放全部订阅；最多 64 个且不得重复。"
          status={channelSubscriptionForm.status}
          onSubmit={runChannelSubscriptionSet}
          submitLabel="Run channel.subscription_set"
          error={channelSubscriptionForm.error}
          disabled={anyBusy}
        >
          <label className="field field-wide">
            <span>channels (one exact channel per line)</span>
            <textarea
              value={channelSubscriptionForm.channelsText}
              onChange={(e) =>
                setChannelSubscriptionForm((s) => ({
                  ...s,
                  channelsText: e.target.value,
                }))
              }
              rows={4}
              placeholder="demo.channel"
            />
          </label>
          <ResultPanel
            title="accepted channels"
            value={channelSubscriptionForm.result?.channels ?? null}
          />
          <ResultPanel
            title="subscription statuses (physical snapshot)"
            value={channelSubscriptionForm.result?.statuses ?? null}
          />
        </ProtocolSection>

        <ProtocolSection
          title="channel.message_received"
          subtitle="唯一 server-pushed 事件；只发送给当前已精确订阅的频道，不占用 in-flight 槽位。"
          status="idle"
          onSubmit={() => undefined}
          submitLabel="(passive)"
          error=""
          disabled
        >
          <ResultGrid
            items={[
              { label: "queue length", value: channelEvents.length },
              {
                label: "latest receivedAt",
                value: latestEvent
                  ? new Date(latestEvent.receivedAt).toLocaleString()
                  : "n/a",
              },
              {
                label: "latest messageId",
                value: latestEvent?.data.messageId ?? "n/a",
              },
            ]}
          />
          <ResultPanel
            title="latest event data"
            value={latestEvent?.data ?? null}
          />
          <ResultPanel
            title="event queue (latest first)"
            value={channelEvents.map((entry) => ({
              receivedAt: new Date(entry.receivedAt).toLocaleString(),
              ...entry.data,
            }))}
          />
        </ProtocolSection>
      </div>
    );
  }

  /**
   * MSFile 下载：完整字节只从原始 result 读取，不走展示层预览。
   *
   * 设计缘由：Seed Read 上限 16 MiB；若把完整字节塞进 ResultPanel 会把
   * DOM 撑爆，因此展示统一走 `sanitizeStorageValue` 的 256 字节预览。
   */
  function downloadMsFileRead(result: MsFileReadResult | null) {
    if (!result?.content?.bytes) return;
    const url = URL.createObjectURL(
      new Blob([result.content.bytes], {
        type: result.content.mime || "application/octet-stream",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.contentHashHex.slice(0, 16) || "msfile"}.bin`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /**
   * MSFile 工作台：Stat / Seed Read / Block Read。
   *
   * 设计缘由：msfile.* 与 storage.* 同为 session-bound、要求已验签 App
   * 身份；Demo 不接受金额参数，只提交 supplier + hash。
   */
  function renderMsFileMain(): ReactNode {
    return (
      <div className="workbench-grid">
        <ProtocolSection
          title="msfile.stat"
          subtitle="查询哪些 Supplier 有目标 Seed、文件大小和报价；供应商与金额策略由 Keymaster 管理。"
          status={msfileStat.status}
          onSubmit={submitMsFileStat}
          submitLabel="Run msfile.stat"
          error={msfileStat.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={msfileStat.sessionId}
            onChange={(v) => setMsFileStat((s) => ({ ...s, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <label className="field field-wide">
            <span>seedHashHex (64 lowercase hex)</span>
            <input
              value={msfileStat.seedHashHex}
              onChange={(e) =>
                setMsFileStat((s) => ({ ...s, seedHashHex: e.target.value }))
              }
              placeholder="sha256 content hash"
            />
          </label>
          <ResultPanel
            title="suppliers"
            value={msfileStat.result?.suppliers ?? null}
          />
        </ProtocolSection>

        <ProtocolSection
          title="msfile.seed.read"
          subtitle="读取并校验最多 16 MiB 的 Seed；不接受调用方金额上限，超额由 Keymaster 内部确认。"
          status={msfileSeedRead.status}
          onSubmit={submitMsFileSeedRead}
          submitLabel="Run msfile.seed.read"
          error={msfileSeedRead.error}
          disabled={anyBusy}
          extraAction={
            <button
              type="button"
              className="secondary-button"
              onClick={() => downloadMsFileRead(msfileSeedRead.result)}
              disabled={!msfileSeedRead.result}
            >
              Download
            </button>
          }
        >
          <SessionIdField
            value={msfileSeedRead.sessionId}
            onChange={(v) =>
              setMsFileSeedRead((s) => ({ ...s, sessionId: v }))
            }
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>supplierPublicKeyHex (02/03 + 64 lowercase hex)</span>
              <input
                value={msfileSeedRead.supplierPublicKeyHex}
                onChange={(e) =>
                  setMsFileSeedRead((s) => ({
                    ...s,
                    supplierPublicKeyHex: e.target.value,
                  }))
                }
                placeholder="from msfile.stat result"
              />
            </label>
            <label className="field field-wide">
              <span>seedHashHex (64 lowercase hex)</span>
              <input
                value={msfileSeedRead.hashHex}
                onChange={(e) =>
                  setMsFileSeedRead((s) => ({ ...s, hashHex: e.target.value }))
                }
              />
            </label>
          </div>
          <ResultGrid
            items={[
              {
                label: "contentHashHex",
                value: msfileSeedRead.result?.contentHashHex ?? "n/a",
              },
              {
                label: "content bytes",
                value:
                  msfileSeedRead.result?.content.bytes.byteLength ?? "n/a",
              },
            ]}
          />
          <ResultPanel
            title="content preview (first 256 bytes)"
            value={
              msfileSeedRead.result
                ? sanitizeStorageValue(msfileSeedRead.result)
                : null
            }
          />
        </ProtocolSection>

        <ProtocolSection
          title="msfile.block.read"
          subtitle="读取并校验最多 256 KiB 的 Block；不接受调用方金额上限。"
          status={msfileBlockRead.status}
          onSubmit={submitMsFileBlockRead}
          submitLabel="Run msfile.block.read"
          error={msfileBlockRead.error}
          disabled={anyBusy}
          extraAction={
            <button
              type="button"
              className="secondary-button"
              onClick={() => downloadMsFileRead(msfileBlockRead.result)}
              disabled={!msfileBlockRead.result}
            >
              Download
            </button>
          }
        >
          <SessionIdField
            value={msfileBlockRead.sessionId}
            onChange={(v) =>
              setMsFileBlockRead((s) => ({ ...s, sessionId: v }))
            }
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>supplierPublicKeyHex (02/03 + 64 lowercase hex)</span>
              <input
                value={msfileBlockRead.supplierPublicKeyHex}
                onChange={(e) =>
                  setMsFileBlockRead((s) => ({
                    ...s,
                    supplierPublicKeyHex: e.target.value,
                  }))
                }
                placeholder="from msfile.stat result"
              />
            </label>
            <label className="field field-wide">
              <span>blockHashHex (64 lowercase hex)</span>
              <input
                value={msfileBlockRead.hashHex}
                onChange={(e) =>
                  setMsFileBlockRead((s) => ({
                    ...s,
                    hashHex: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          <ResultGrid
            items={[
              {
                label: "contentHashHex",
                value: msfileBlockRead.result?.contentHashHex ?? "n/a",
              },
              {
                label: "content bytes",
                value:
                  msfileBlockRead.result?.content.bytes.byteLength ?? "n/a",
              },
            ]}
          />
          <ResultPanel
            title="content preview (first 256 bytes)"
            value={
              msfileBlockRead.result
                ? sanitizeStorageValue(msfileBlockRead.result)
                : null
            }
          />
        </ProtocolSection>
      </div>
    );
  }

  function renderWalletMain(): ReactNode {
    return (
      <div className="tool-grid">
        <ProtocolSection
          title="Test wallet"
          subtitle="demo 自己的内存态测试钱包；私钥只服务于本 demo，不接触 Keymaster 私钥。"
          status={testWalletState.wallet ? "success" : "idle"}
          onSubmit={generateNewTestWallet}
          submitLabel="Generate new test wallet"
          error={testWalletState.error}
          disabled={anyBusy || toolBusy}
          extraAction={
            <button
              type="button"
              className="secondary-button"
              onClick={forgetTestWallet}
              disabled={!testWalletState.wallet || anyBusy || toolBusy}
            >
              Forget wallet
            </button>
          }
        >
          <div className="form-grid">
            <label className="field field-wide">
              <span>import WIF</span>
              <div className="inline-row">
                <input
                  value={testWalletState.wifInput}
                  onChange={(e) =>
                    setTestWalletState((prev) => ({
                      ...prev,
                      wifInput: e.target.value,
                    }))
                  }
                  placeholder="mainnet WIF"
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={importWif}
                  disabled={anyBusy || toolBusy}
                >
                  Import
                </button>
              </div>
            </label>
          </div>
          <ResultGrid
            items={[
              {
                label: "address",
                value: testWalletState.wallet?.address ?? "n/a",
              },
              {
                label: "publicKeyHex",
                value: testWalletState.wallet?.publicKeyHex ?? "n/a",
              },
              { label: "wif", value: testWalletState.wallet?.wif ?? "n/a" },
            ]}
          />
          <p className="hint-note">
            测试钱包私钥默认只在内存里；刷新页面后丢失。demo 不持久化私钥。
          </p>
        </ProtocolSection>

        <ProtocolSection
          title="Test wallet UTXOs (WOC)"
          subtitle="通过 WhatsOnChain (`/address/.../confirmed/unspent`) 拉测试钱包地址的 UTXO 列表。失败就报错。"
          status={testWalletState.utxoStatus}
          onSubmit={refreshTestWalletUtxos}
          submitLabel="Refresh UTXOs"
          error={testWalletState.utxoError}
          disabled={!testWalletState.wallet || anyBusy || toolBusy}
        >
          <ResultGrid
            items={[
              {
                label: "refreshedAt",
                value: testWalletState.utxoRefreshedAt
                  ? new Date(
                      testWalletState.utxoRefreshedAt,
                    ).toLocaleTimeString()
                  : "n/a",
              },
              { label: "utxoCount", value: testWalletState.utxos.length },
              {
                label: "totalValue",
                value: testWalletState.utxos.reduce(
                  (sum, u) => sum + u.value,
                  0,
                ),
              },
            ]}
          />
          <ResultPanel
            title="UTXO list"
            value={testWalletState.utxos.map((u) => ({
              txid: u.txid,
              vout: u.vout,
              value: u.value,
            }))}
          />
        </ProtocolSection>

        <ProtocolSection
          title="Manual one-click refund"
          subtitle="把测试钱包里的 satoshis 转回最近一次 Keymaster 主网地址（缺省时手填）。失败就报错，不自动重试。"
          status={refund.status}
          onSubmit={submitRefund}
          submitLabel="Run one-click refund"
          error={refund.error}
          disabled={!testWalletState.wallet || anyBusy || toolBusy}
        >
          <div className="form-grid">
            <label className="field field-wide">
              <span>recipientAddress</span>
              <input
                value={refund.recipientAddress}
                onChange={(e) =>
                  setRefund((prev) => ({
                    ...prev,
                    recipientAddress: e.target.value,
                  }))
                }
                placeholder="default: last identity.get wallet.bsv.address.main"
              />
            </label>
            <label className="field">
              <span>amountSatoshis</span>
              <input
                type="number"
                min={1}
                step={1}
                value={refund.amountSatoshis}
                onChange={(e) =>
                  setRefund((prev) => ({
                    ...prev,
                    amountSatoshis: e.target.value,
                  }))
                }
              />
            </label>
            <label className="field">
              <span>feeRateSatoshisPerKb</span>
              <input
                type="number"
                min={1}
                step={1}
                value={refund.feeRateSatoshisPerKb}
                onChange={(e) =>
                  setRefund((prev) => ({
                    ...prev,
                    feeRateSatoshisPerKb: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "txid", value: refund.result?.txid ?? "n/a" },
              {
                label: "rawTxHex (head)",
                value: refund.result
                  ? truncateHex(refund.result.rawTxHex, 64)
                  : "n/a",
              },
              {
                label: "feeSatoshis",
                value: refund.result?.feeSatoshis ?? "n/a",
              },
            ]}
          />
        </ProtocolSection>
      </div>
    );
  }

  /* ============== 观察区（按当前 workbench 切换） ============== */

  function renderActiveObserver(): ReactNode {
    switch (activeWorkbench) {
      case "connect":
        return (
          <>
            <ResultPanel
              title="current session"
              value={describeSession(session)}
            />
            <div className="observer-summary">
              <div className="observer-summary__label">popup / direct 登录</div>
              <ResultPanel
                title="connect.login raw result"
                value={login.response}
              />
              <ResultPanel
                title="connect.resume raw result"
                value={resume.response}
              />
              <ResultPanel
                title="connect.logout raw result"
                value={logout.response}
              />
            </div>
            <div className="observer-summary">
              <div className="observer-summary__label">
                launch / appView 登录
              </div>
              <ResultPanel
                title="connect.launch request"
                value={launch.request}
              />
              <ResultPanel
                title="connect.launch raw result"
                value={launch.response}
              />
            </div>
          </>
        );
      case "identity":
        return (
          <>
            <ResultPanel
              title="identity.get request"
              value={identity.request}
            />
            <ResultPanel
              title="identity.get raw result"
              value={identity.response}
            />
            <ResultPanel
              title="identity.get decoded envelope"
              value={identity.inspection?.decodedEnvelope}
              pretty={identity.inspection?.decodedEnvelopePretty}
            />
            <ResultPanel
              title="identity.get resolvedClaims"
              value={identity.result?.resolvedClaims}
            />
            <ResultPanel title="intent.sign request" value={intent.request} />
            <ResultPanel
              title="intent.sign raw result"
              value={intent.response}
            />
          </>
        );
      case "cipher":
        return (
          <>
            <ResultPanel
              title="cipher.encrypt request"
              value={encrypt.request}
            />
            <ResultPanel
              title="cipher.encrypt raw result"
              value={encrypt.response}
            />
            <ResultPanel
              title="cipher.decrypt request"
              value={decrypt.request}
            />
            <ResultPanel
              title="cipher.decrypt raw result"
              value={decrypt.response}
            />
          </>
        );
      case "transfer":
        return (
          <>
            <ResultPanel title="p2pkh.transfer request" value={p2pkh.request} />
            <ResultPanel
              title="p2pkh.transfer raw result"
              value={p2pkh.response}
            />
            <ResultPanel
              title="feepool.prepare request"
              value={feepoolPrepare.request}
            />
            <ResultPanel
              title="feepool.prepare raw result"
              value={feepoolPrepare.response}
            />
            <ResultPanel
              title="feepool.prepare result (full)"
              value={feepoolPrepare.result}
            />
            <ResultPanel
              title="feepool.commit request"
              value={feepoolCommit.request}
            />
            <ResultPanel
              title="feepool.commit raw result"
              value={feepoolCommit.response}
            />
          </>
        );
      case "channel":
        return (
          <>
            <ResultPanel
              title="channel.publish request"
              value={channelPublishForm.request}
            />
            <ResultPanel
              title="channel.publish raw result"
              value={channelPublishForm.response}
            />
            <ResultPanel
              title="channel.subscription_set request"
              value={channelSubscriptionForm.request}
            />
            <ResultPanel
              title="channel.subscription_set raw result"
              value={channelSubscriptionForm.response}
            />
            <div className="observer-summary">
              <div className="observer-summary__label">
                channel.message_received 观察（独立面板）
              </div>
              <ResultGrid
                items={[
                  { label: "queue length", value: channelEvents.length },
                  {
                    label: "latest receivedAt",
                    value: channelEvents[0]
                      ? new Date(channelEvents[0].receivedAt).toLocaleString()
                      : "n/a",
                  },
                  {
                    label: "latest messageId",
                    value: channelEvents[0]?.data.messageId ?? "n/a",
                  },
                ]}
              />
              <ResultPanel
                title="event queue (latest first)"
                value={channelEvents.map((entry) => ({
                  receivedAt: new Date(entry.receivedAt).toLocaleString(),
                  ...entry.data,
                }))}
              />
            </div>
          </>
        );
      case "msfile":
        return (
          <>
            <ResultPanel
              title="msfile.stat request"
              value={msfileStat.request}
            />
            <ResultPanel
              title="msfile.stat raw result"
              value={msfileStat.response}
            />
            <ResultPanel
              title="msfile.seed.read request"
              value={msfileSeedRead.request}
            />
            <ResultPanel
              title="msfile.seed.read raw result (256-byte preview)"
              value={
                msfileSeedRead.response
                  ? sanitizeStorageValue(msfileSeedRead.response)
                  : null
              }
            />
            <ResultPanel
              title="msfile.block.read request"
              value={msfileBlockRead.request}
            />
            <ResultPanel
              title="msfile.block.read raw result (256-byte preview)"
              value={
                msfileBlockRead.response
                  ? sanitizeStorageValue(msfileBlockRead.response)
                  : null
              }
            />
          </>
        );
      case "wallet":
        return (
          <>
            <div className="observer-summary">
              <div className="observer-summary__label">test wallet</div>
              <ResultGrid
                items={[
                  {
                    label: "address",
                    value: testWalletState.wallet?.address ?? "n/a",
                  },
                  {
                    label: "publicKeyHex",
                    value: testWalletState.wallet?.publicKeyHex ?? "n/a",
                  },
                ]}
              />
            </div>
            <div className="observer-summary">
              <div className="observer-summary__label">test wallet UTXOs</div>
              <ResultGrid
                items={[
                  {
                    label: "refreshedAt",
                    value: testWalletState.utxoRefreshedAt
                      ? new Date(
                          testWalletState.utxoRefreshedAt,
                        ).toLocaleTimeString()
                      : "n/a",
                  },
                  { label: "utxoCount", value: testWalletState.utxos.length },
                  {
                    label: "totalValue",
                    value: testWalletState.utxos.reduce(
                      (sum, u) => sum + u.value,
                      0,
                    ),
                  },
                ]}
              />
              <ResultPanel
                title="UTXO list (full)"
                value={testWalletState.utxos.map((u) => ({
                  txid: u.txid,
                  vout: u.vout,
                  value: u.value,
                }))}
              />
            </div>
            <div className="observer-summary">
              <div className="observer-summary__label">refund result</div>
              {refund.result ? (
                <ResultPanel
                  title="refund tx"
                  value={{
                    txid: refund.result.txid,
                    rawTxHex: truncateHex(refund.result.rawTxHex, 96),
                    feeSatoshis: refund.result.feeSatoshis,
                  }}
                />
              ) : (
                <p className="observer-empty__hint">尚无回款结果。</p>
              )}
            </div>
          </>
        );
    }
  }

  /* ============== 渲染 ============== */

  const activeItem =
    workbenchItems.find((item) => item.id === activeWorkbench) ??
    workbenchItems[0];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__title">
          <p className="eyebrow">Keymaster Connect V1 demo</p>
          <h1>Session-first 外部调用方验证台</h1>
          <p className="app-header__sub">
            工作台：Connect / Identity / Cipher / Transfer / Channel / Storage
            / MSFile / Test Wallet（覆盖 26 个协议方法 + 1 个顶层 event）
          </p>
        </div>
        <div className="app-header__status">
          <ConnectionIndicator state={connectionState} />
          <div
            className="app-header__chip"
            title={
              startupMode === "appView"
                ? "appView/launch transport origin（URL 注入的 sessionWindowOrigin）"
                : "Keymaster popup 目标 origin（targetOrigin）"
            }
          >
            <span className="app-header__chip-label">
              {startupMode === "appView"
                ? "sessionWindowOrigin"
                : "target origin"}
            </span>
            <strong>
              {startupMode === "appView"
                ? (sessionWindowOrigin ?? "missing")
                : normalizedTargetOrigin || "invalid"}
            </strong>
          </div>
          <div className="app-header__chip" title="当前 active 工作台">
            <span className="app-header__chip-label">active</span>
            <strong>{activeItem.label}</strong>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={cancelCurrent}
            disabled={!anyBusy}
            title="对当前在途 request 发顶层 cancel；不单独产生第二条 result"
          >
            Cancel in-flight
          </button>
        </div>
      </header>

      <section className="app-mainbody" aria-label="Shared context">
        <div className="shared-context">
          <h2>Shared context</h2>
          <div className="shared-context__grid">
            <div className="shared-context__row">
              <span>current connectSessionId</span>
              <strong>{session.connectSessionId || "n/a"}</strong>
            </div>
            <div className="shared-context__row">
              <span>current ownerPublicKeyHex</span>
              <strong>{session.ownerPublicKeyHex || "n/a"}</strong>
            </div>
            <div className="shared-context__row">
              <span>session verified app identity snapshot</span>
              <strong>
                {session.appIdentity
                  ? `${session.appIdentity.appId} / ${session.appIdentity.appName} / ${session.appIdentity.publisherPublicKeyHex} / digest ${session.appIdentity.identityDigestHex}`
                  : "missing"}
              </strong>
            </div>
            <div className="shared-context__row">
              <span>test wallet address</span>
              <strong>{testWalletState.wallet?.address ?? "n/a"}</strong>
            </div>
            <div className="shared-context__row">
              <span>test wallet publicKeyHex</span>
              <strong>{testWalletState.wallet?.publicKeyHex ?? "n/a"}</strong>
            </div>
            <div className="shared-context__row">
              <span>last keymaster main address</span>
              <strong>{identity.lastKeymasterAddress || "n/a"}</strong>
            </div>
            <div className="shared-context__row">
              <span>current origin</span>
              <strong>{currentOrigin || "n/a"}</strong>
            </div>
            <div className="shared-context__row">
              <span>HTML app identity proof</span>
              <strong title={appIdentityProof ? undefined : appIdentityProofState.error}>
                {appIdentityProof ? "ready" : `blocked: ${appIdentityProofState.error}`}
              </strong>
            </div>
          </div>
        </div>
      </section>

      <div className="workbench-layout">
        <aside className="workbench-nav" aria-label="Workbenches">
          <h2>Workbenches</h2>
          <nav className="nav-menu">
            {workbenchItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${activeWorkbench === item.id ? "is-active" : ""}`}
                onClick={() => setActiveWorkbench(item.id)}
                aria-current={activeWorkbench === item.id ? "page" : undefined}
              >
                <span className="nav-item__row">
                  <span className="nav-item__label">{item.label}</span>
                  <span className={`status-pill status-${item.status}`}>
                    {statusText(item.status)}
                  </span>
                </span>
                <span className="nav-item__hint">
                  {item.methods.join(" / ")}
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="workbench-main">
          {appViewPhase === "launching" ? (
            <div
              className="appview-launch-shell"
              role="status"
              aria-live="polite"
            >
              <h2>appView launch in progress</h2>
              <p>
                demo is the child app launched by Keymaster Session Window. It
                will send a top-level
                <code> ready </code>to <code>window.opener</code> and then run
                <code> connect.launch </code>automatically. Manual fall-back is
                disabled.
              </p>
            </div>
          ) : null}
          {appViewPhase === "failed" ? (
            <div
              className="appview-launch-shell appview-launch-shell--failed"
              role="alert"
            >
              <h2>appView launch failed</h2>
              <p>{appViewFailureReason ?? "Unknown failure."}</p>
              <p>
                Please relaunch this app from Keymaster. The demo does not
                automatically fall back to direct login / connect.login in
                appView mode.
              </p>
            </div>
          ) : null}
          {renderActiveMain()}
        </main>

        <aside className="workbench-observer" aria-label="Observer">
          <section className="observer-pane" key={activeWorkbench}>
            <header className="observer-pane__head">
              <h2>Observer</h2>
              <p>当前工作台：{activeItem.label}</p>
            </header>
            <div className="observer-pane__body">{renderActiveObserver()}</div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ============== 子组件 ============== */

function SessionIdField(props: {
  value: string;
  onChange: (v: string) => void;
  currentSessionId: string;
}) {
  const isSynced = props.value === props.currentSessionId;
  return (
    <div className="form-grid">
      <label className="field field-wide">
        <span>
          connectSessionId{" "}
          {props.currentSessionId ? (
            <button
              type="button"
              className="inline-link"
              onClick={() => props.onChange(props.currentSessionId)}
              disabled={isSynced}
            >
              {isSynced ? "(current)" : "(use current)"}
            </button>
          ) : null}
        </span>
        <input
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="required for this method"
        />
      </label>
    </div>
  );
}

function SessionSummary(props: {
  session: SessionState;
  transportLabel: string;
  transportOrigin: string;
  onEdit: () => void;
  showEditor: boolean;
  onClearSession: () => void;
}) {
  const { session } = props;
  const has = session.connectSessionId.length > 0;
  return (
    <section className="session-summary">
      <div className="session-summary__head">
        <h2>Current session</h2>
        <div className="session-summary__actions">
          <button
            type="button"
            className="secondary-button"
            onClick={props.onEdit}
          >
            {props.showEditor ? "Hide details" : "Show details"}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={props.onClearSession}
            disabled={!has}
          >
            Clear
          </button>
        </div>
      </div>
      <ResultGrid
        items={[
          {
            label: "connectSessionId",
            value: has ? session.connectSessionId : "n/a",
          },
          {
            label: "ownerPublicKeyHex",
            value: session.ownerPublicKeyHex || "n/a",
          },
          { label: "source", value: session.source || "n/a" },
          {
            label: "refreshedAt",
            value: session.refreshedAt
              ? new Date(session.refreshedAt).toLocaleString()
              : "n/a",
          },
          // 当前会话的 transport origin 跟随其登录方式：popup/direct ⇒ targetOrigin；
          // launch ⇒ sessionWindowOrigin。两套真值不混显。
          {
            label: props.transportLabel,
            value: props.transportOrigin || "n/a",
          },
        ]}
      />
      {props.showEditor ? (
        <ResultPanel
          title="resolvedClaims snapshot"
          value={session.resolvedClaims}
        />
      ) : null}
    </section>
  );
}

function ProtocolSection(props: {
  title: string;
  subtitle: string;
  status: SectionStatus;
  error: string;
  submitLabel: string;
  onSubmit: () => Promise<void> | void;
  children: ReactNode;
  extraAction?: ReactNode;
  disabled?: boolean;
}) {
  const disabled = props.disabled ?? props.status === "loading";
  return (
    <section className="section-block">
      <div className="section-header">
        <div>
          <h2>{props.title}</h2>
          <p>{props.subtitle}</p>
        </div>
        <div className="section-actions">
          {props.extraAction}
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              if (disabled) return;
              void props.onSubmit();
            }}
            disabled={disabled}
          >
            {props.status === "loading" ? "Running..." : props.submitLabel}
          </button>
        </div>
      </div>
      {props.error ? <p className="section-error">{props.error}</p> : null}
      {props.children}
    </section>
  );
}

function ResultPanel({
  title,
  value,
  pretty,
}: {
  title: string;
  value: unknown;
  pretty?: string;
}) {
  return (
    <div className="result-panel">
      <div className="result-title">{title}</div>
      <pre>{pretty ?? prettySerializable(value)}</pre>
    </div>
  );
}

function ResultGrid({ items }: { items: { label: string; value: unknown }[] }) {
  return (
    <div className="result-grid">
      {items.map((item) => (
        <div className="result-stat" key={item.label}>
          <span>{item.label}</span>
          <strong>{prettyScalar(item.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function prettySerializable(value: unknown): string {
  return JSON.stringify(toDisplayValue(value), null, 2);
}

function prettyScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return prettySerializable(value);
}

function formatProtocolError(code: ProtocolErrorCode, message: string): string {
  const prefix: Partial<Record<ProtocolErrorCode, string>> = {
    invalid_request: "Invalid request",
    invalid_origin: "Invalid origin",
    user_rejected: "User rejected",
    active_key_unavailable: "Active key unavailable",
    decrypt_failed: "Decrypt failed",
    internal_error: "Internal error",
  };
  return `${prefix[code] ?? code}: ${message}`;
}

function formatTransportError(error: unknown): string {
  if (error instanceof ProtocolTransportError) {
    return `${error.name}(${error.code}): ${error.message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function parseOptionalSafeInteger(
  text: string,
  field: string,
): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return value;
}

function safeBytesToText(bytes: Uint8Array): string {
  try {
    return bytesToText(bytes);
  } catch {
    return "(invalid utf-8)";
  }
}

function statusText(status: SectionStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "loading":
      return "Running";
    case "success":
      return "Success";
    case "error":
      return "Error";
  }
}

function truncateHex(hex: string, head: number): string {
  if (hex.length <= head + 6) return hex;
  return `${hex.slice(0, head)}…(${hex.length / 2} bytes)`;
}

function resultFromFeepoolCommit(
  response: ProtocolResultMessage | null,
  field: string,
): string | null {
  if (!response || !response.ok) return null;
  const r = response.result as unknown as Record<string, unknown> | undefined;
  if (!r) return null;
  switch (field) {
    case "operationId":
      return typeof r.operationId === "string" ? r.operationId : null;
    case "action":
      return typeof r.action === "string" ? r.action : null;
    case "draftTxid":
      return typeof r.draftTxid === "string" ? r.draftTxid : null;
    case "draftTxHexHead":
      return typeof r.draftTxHex === "string"
        ? truncateHex(r.draftTxHex, 64)
        : null;
    default:
      return null;
  }
}

function describeSession(session: SessionState): unknown {
  return {
    connectSessionId: session.connectSessionId || null,
    ownerPublicKeyHex: session.ownerPublicKeyHex || null,
    source: session.source || null,
    refreshedAt: session.refreshedAt || null,
    lastResponse: session.lastConnectResponse,
  };
}

function ConnectionIndicator({ state }: { state: DemoConnectionState }) {
  const label = connectionLabel(state);
  const tooltip = connectionTooltip(state);
  return (
    <div
      className={`conn-indicator conn-indicator--${state}`}
      role="status"
      aria-live="polite"
      title={tooltip}
      data-state={state}
    >
      <span className="conn-indicator__dot" aria-hidden="true" />
      <span className="conn-indicator__label">{label}</span>
    </div>
  );
}

function connectionLabel(state: DemoConnectionState): string {
  switch (state) {
    case "idle":
      return "Idle";
    case "opening":
      return "Opening";
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
  }
}

function connectionTooltip(state: DemoConnectionState): string {
  switch (state) {
    case "idle":
      return "Popup connection: idle (no window.open yet)";
    case "opening":
      return "Popup connection: opening (waiting for ready)";
    case "connected":
      return "Popup connection: connected (ready received)";
    case "disconnected":
      return "Popup connection: disconnected (closing or popup.closed)";
  }
}
