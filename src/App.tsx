// src/App.tsx
// session-first demo 工作台主入口（施工单 2026-06-29 002 硬切换）。
//
// 设计缘由：
//   - 六类工作台：Connect / Identity / Cipher / Transfer / Storage /
//     Test Wallet；不把 16 个方法做成平铺 16 个一级 tab。
//   - 业务方法（identity.get / intent.sign / cipher.* / p2pkh.transfer /
//     feepool.* / storage.*）全部走"当前 sessionId + 可手改"策略。
//   - 观察区继续展示 request / response / inspection / protocol log；
//     当前激活方法切换时观察区一起重挂载。
//   - 状态机由 PopupSessionClient 持有；App.tsx 只消费它暴露的
//     connectionState / runRequest / cancelCurrentRequest。

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { bytesToBase64, bytesToHex, bytesToText, ensureTextLines, parseBinaryInput, textToBytes } from "./lib/encoding";
import { makeBinaryField } from "./lib/binary";
import { toDisplayValue } from "./lib/cbor";
import { inspectIdentityResult, inspectIntentResult } from "./lib/verify";
import { normalizeOrigin, ProtocolTransportError, type ProtocolLogEvent } from "./lib/connectClient";
import { PopupSessionClient } from "./lib/popupSessionClient";
import {
  type BinaryField,
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
  type P2pkhTransferResult,
  type PopupConnectionState,
  type ProtocolErrorCode,
  type ProtocolMethod,
  type ProtocolRequestMessage,
  type ProtocolResultMessage,
  type ResolvedClaimValue,
  type StorageDeleteResult,
  type StorageGetResult,
  type StorageListResult,
  type StoragePutResult
} from "./lib/protocol";
import {
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
  buildP2pkhTransferRequest,
  buildStorageDeleteRequest,
  buildStorageGetRequest,
  buildStorageListAllRequest,
  buildStorageListRequest,
  buildStoragePutRequest
} from "./lib/requestBuilders";
import { clearCachedSessionHint, readCachedSessionHint, writeCachedSessionHint, type CachedSessionHint } from "./lib/sessionCache";
import {
  generateTestWallet,
  importTestWallet,
  isValidWif,
  type TestWallet
} from "./lib/testWallet";
import { buildFeepoolCommitParams, projectFeepoolCommitInput, actionLabel } from "./lib/feepool";
import { buildAndSignP2pkhTransfer, defaultFeeRateSatoshisPerKb, validateTransferParams, wocUtxosToTestWalletUtxos } from "./lib/p2pkhTool";
import { createWocClient, type WocUtxo } from "./lib/woc";

type SectionStatus = "idle" | "loading" | "success" | "error";

type WorkbenchId =
  | "connect"
  | "identity"
  | "cipher"
  | "transfer"
  | "storage"
  | "wallet";

type LogEntry = ProtocolLogEvent & {
  level: "info" | "warn" | "error";
};

/* ============== Session state (5.4) ============== */

/**
 * demo 自己的 session 共享上下文（页面级 useState）。
 *
 * 不抽象成 context / reducer：单页单组件直接读写足够；过度抽象只会把
 * "sessionId 当前是啥" 这个事实分散掉。
 */
interface SessionState {
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
    connectSessionId: "",
    ownerPublicKeyHex: "",
    resolvedClaims: {},
    source: "",
    refreshedAt: 0,
    lastConnectResponse: null
  };
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

/* ============== Storage 区状态 ============== */

interface StoragePutState {
  path: string;
  contentType: string;
  contentText: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: StoragePutResult | null;
  sessionId: string;
}

interface StorageGetState {
  path: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: StorageGetResult | null;
  /** 上一次展示的明文文本（如可 UTF-8 解码）。 */
  decodedText: string;
  sessionId: string;
}

interface StorageListState {
  prefix: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: StorageListResult | null;
  sessionId: string;
}

interface StorageListAllState {
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: StorageListResult | null;
  sessionId: string;
}

interface StorageDeleteState {
  path: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: StorageDeleteResult | null;
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
 * 从当前 URL `?launchToken=<id>` 取一次性 launchToken。
 *
 * 设计缘由（5.6 / 7.5）：demo 不伪造 launcher bootstrap；这里只把 URL
 * 上 launcher 写入的真实 token 自动回填，缺省时让用户手填。
 */
function readLaunchTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("launchToken") ?? "";
  } catch {
    return "";
  }
}

export default function App() {
  const currentOrigin = typeof window === "undefined" ? "" : window.location.origin;

  // 启动时尝试从 localStorage 恢复最近一次 session hint；
  // 用它去预填 targetOrigin / 表单默认 sessionId。
  const initialHint = useMemo<CachedSessionHint | null>(() => readCachedSessionHint(), []);

  const [targetOrigin, setTargetOrigin] = useState(
    initialHint?.targetOrigin || "https://keymaster.cc"
  );
  const [popupWidth, setPopupWidth] = useState(DEFAULT_POPUP_WIDTH);
  const [popupHeight, setPopupHeight] = useState(DEFAULT_POPUP_HEIGHT);
  const [readyTimeoutMs, setReadyTimeoutMs] = useState(DEFAULT_READY_TIMEOUT);
  const [resultTimeoutMs, setResultTimeoutMs] = useState(DEFAULT_RESULT_TIMEOUT);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  /* ----- Session (5.4) ----- */
  const [session, setSession] = useState<SessionState>(emptySession);

  /* ----- Connect ----- */
  const [login, setLogin] = useState<ConnectLoginState>({
    text: "请确认登录到当前站点并创建 connect session",
    claimsText: "key.label\nprofile.nickname\nprofile.avatar.image\nwallet.bsv.address.main",
    status: "idle",
    error: "",
    request: null,
    response: null
  });
  const [resume, setResume] = useState<ConnectResumeState>({
    connectSessionId: initialHint?.connectSessionId ?? "",
    status: "idle",
    error: "",
    request: null,
    response: null
  });
  const [logout, setLogout] = useState<ConnectLogoutState>({
    connectSessionId: initialHint?.connectSessionId ?? "",
    status: "idle",
    error: "",
    request: null,
    response: null
  });
  const [launch, setLaunch] = useState<ConnectLaunchState>({
    launchToken: readLaunchTokenFromUrl(),
    status: "idle",
    error: "",
    request: null,
    response: null
  });

  /* ----- Identity ----- */
  const [identity, setIdentity] = useState<IdentityState>({
    text: "请确认把身份信息提供给当前站点",
    claimsText: "key.label\nprofile.nickname\nprofile.avatar.image\nwallet.bsv.address.main",
    ttlSeconds: 300,
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    inspection: null,
    lastKeymasterAddress: "",
    sessionId: initialHint?.connectSessionId ?? ""
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
    sessionId: initialHint?.connectSessionId ?? ""
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
    sessionId: initialHint?.connectSessionId ?? ""
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
    sessionId: initialHint?.connectSessionId ?? ""
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
    sessionId: initialHint?.connectSessionId ?? ""
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
    sessionId: initialHint?.connectSessionId ?? ""
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
    sessionId: initialHint?.connectSessionId ?? ""
  });

  /* ----- Storage ----- */
  const [storagePut, setStoragePut] = useState<StoragePutState>({
    path: "notes/hello.txt",
    contentType: "text/plain",
    contentText: "hello from keymaster connect demo",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? ""
  });
  const [storageGet, setStorageGet] = useState<StorageGetState>({
    path: "notes/hello.txt",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    decodedText: "",
    sessionId: initialHint?.connectSessionId ?? ""
  });
  const [storageList, setStorageList] = useState<StorageListState>({
    prefix: "notes/",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? ""
  });
  const [storageListAll, setStorageListAll] = useState<StorageListAllState>({
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? ""
  });
  const [storageDelete, setStorageDelete] = useState<StorageDeleteState>({
    path: "notes/hello.txt",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    sessionId: initialHint?.connectSessionId ?? ""
  });

  /* ----- Test wallet ----- */
  const [testWalletState, setTestWalletState] = useState<TestWalletState>({
    wallet: null,
    wifInput: "",
    error: "",
    utxos: [],
    utxoStatus: "idle",
    utxoError: "",
    utxoRefreshedAt: 0
  });
  const [refund, setRefund] = useState<RefundState>({
    recipientAddress: "",
    amountSatoshis: "0",
    feeRateSatoshisPerKb: String(defaultFeeRateSatoshisPerKb()),
    status: "idle",
    error: "",
    result: null
  });

  const [activeWorkbench, setActiveWorkbench] = useState<WorkbenchId>("connect");
  const [connectionState, setConnectionState] = useState<DemoConnectionState>("idle");
  const [anyBusy, setAnyBusy] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [showSessionEditor, setShowSessionEditor] = useState(false);

  const sessionClientRef = useRef<PopupSessionClient | null>(null);
  function getSessionClient(): PopupSessionClient {
    if (!sessionClientRef.current) {
      sessionClientRef.current = new PopupSessionClient({
        targetOrigin,
        popupWidth,
        popupHeight,
        readyTimeoutMs,
        resultTimeoutMs,
        onLog: pushLog,
        onConnectionStateChange: setConnectionState
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

  /* ----- targetOrigin / 超时变化 → 关闭旧 session，保留表单 ----- */
  useEffect(() => {
    if (sessionClientRef.current) {
      sessionClientRef.current.closeSession();
      sessionClientRef.current = null;
      setAnyBusy(false);
    }
  }, [targetOrigin, popupWidth, popupHeight, readyTimeoutMs, resultTimeoutMs]);

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
    setStoragePut((prev) => ({ ...prev, sessionId: sid }));
    setStorageGet((prev) => ({ ...prev, sessionId: sid }));
    setStorageList((prev) => ({ ...prev, sessionId: sid }));
    setStorageListAll((prev) => ({ ...prev, sessionId: sid }));
    setStorageDelete((prev) => ({ ...prev, sessionId: sid }));
  }, [session.connectSessionId]);

  /* ----- 加密 → 解密自动回填 ----- */
  useEffect(() => {
    const r = encrypt.result;
    if (r) {
      setDecrypt((prev) => ({
        ...prev,
        nonceInput: bytesToHex(new Uint8Array(r.nonce.bytes)),
        cipherbytesInput: bytesToHex(new Uint8Array(r.cipherbytes.bytes))
      }));
    }
  }, [encrypt.result]);

  /* ----- 测试钱包 → p2pkh 默认收款 / feepool 默认 counterparty ----- */
  useEffect(() => {
    const w = testWalletState.wallet;
    if (!w) return;
    setP2pkh((prev) => (prev.recipientAddress === "" ? { ...prev, recipientAddress: w.address } : prev));
    setFeepoolPrepare((prev) =>
      prev.counterpartyPublicKeyHex === "" ? { ...prev, counterpartyPublicKeyHex: w.publicKeyHex } : prev
    );
  }, [testWalletState.wallet]);

  /* ----- 最近一次 keymaster main address → 回款默认收款 ----- */
  useEffect(() => {
    if (identity.lastKeymasterAddress && refund.recipientAddress === "") {
      setRefund((prev) => ({ ...prev, recipientAddress: identity.lastKeymasterAddress }));
    }
  }, [identity.lastKeymasterAddress, refund.recipientAddress]);

  /* ----- 页面级 mount 钩子：全局 error / unhandledrejection 上报 ----- */
  useEffect(() => {
    console.info("[keymaster-connect-demo] page mounted", {
      currentOrigin: typeof window === "undefined" ? "" : window.location.origin,
      pathname: typeof window === "undefined" ? "" : window.location.pathname
    });

    const onError = (event: ErrorEvent) => {
      console.error("[keymaster-connect-demo] window error", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error("[keymaster-connect-demo] unhandled rejection", {
        reason: event.reason
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  function pushLog(entry: ProtocolLogEvent, level: LogEntry["level"] = "info") {
    const method = entry.method ?? "system";
    const prefix = `[keymaster-connect-demo][${method}][${entry.stage}]`;
    if (level === "error") {
      console.error(prefix, entry);
    } else if (level === "warn") {
      console.warn(prefix, entry);
    } else {
      console.debug(prefix, entry);
    }
    setLogs((current) => [{ ...entry, level }, ...current].slice(0, 60));
  }

  function extractKeymasterMainAddress(claims: Record<string, ResolvedClaimValue> | undefined): string {
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
    request: ProtocolRequestMessage<M>
  ): Promise<ProtocolResultMessage> {
    return getSessionClient().runRequest(request);
  }

  function adoptSessionFromResponse(
    response:
      | ConnectLoginResult
      | ConnectResumeResult
      | ConnectLaunchResult,
    source: "connect.login" | "connect.resume" | "connect.launch"
  ) {
    const sid = response.connectSessionId;
    setSession({
      connectSessionId: sid,
      ownerPublicKeyHex: response.ownerPublicKeyHex,
      resolvedClaims: response.resolvedClaims,
      source,
      refreshedAt: response.resolvedAt,
      lastConnectResponse: response
    });
    // 写入本地缓存，便于刷新后手动 `connect.resume`。
    writeCachedSessionHint({
      connectSessionId: sid,
      targetOrigin,
      ownerPublicKeyHex: response.ownerPublicKeyHex
    });
  }

  function clearSession() {
    setSession(emptySession());
    clearCachedSessionHint();
  }

  /* ============== Connect handlers ============== */

  async function submitConnectLogin() {
    if (anyBusy) return;
    const claims = ensureTextLines(login.claimsText);
    const request = buildConnectLoginRequest({ text: login.text, claims });
    setLogin((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null }));
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
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setLogin((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "connect.login", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitConnectResume() {
    if (anyBusy) return;
    if (!resume.connectSessionId) {
      setResume((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    const request = buildConnectResumeRequest({ connectSessionId: resume.connectSessionId });
    setResume((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null }));
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
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setResume((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "connect.resume", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitConnectLogout() {
    if (anyBusy) return;
    if (!logout.connectSessionId) {
      setLogout((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    const request = buildConnectLogoutRequest({ connectSessionId: logout.connectSessionId });
    setLogout((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null }));
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
          connectSessionId: "",
          ownerPublicKeyHex: "",
          resolvedClaims: {},
          source: "",
          refreshedAt: result.revokedAt,
          lastConnectResponse: result
        });
        setLogout((prev) => ({ ...prev, status: "success", response }));
      } else {
        setLogout((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setLogout((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "connect.logout", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitConnectLaunch() {
    if (anyBusy) return;
    if (!launch.launchToken) {
      setLaunch((prev) => ({
        ...prev,
        status: "error",
        error: "launchToken is required. Without a real launcher bootstrap this call will fail."
      }));
      return;
    }
    const request = buildConnectLaunchRequest({ launchToken: launch.launchToken });
    setLaunch((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as ConnectLaunchResult;
        adoptSessionFromResponse(result, "connect.launch");
        setLaunch((prev) => ({ ...prev, status: "success", response }));
      } else {
        setLaunch((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setLaunch((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "connect.launch", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Identity handlers ============== */

  async function submitIdentity() {
    if (anyBusy) return;
    if (!identity.sessionId) {
      setIdentity((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
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
        connectSessionId: identity.sessionId
      });
    } catch (error) {
      setIdentity((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setIdentity((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null, inspection: null }));
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
          lastKeymasterAddress: mainAddr || prev.lastKeymasterAddress
        }));
      } else {
        setIdentity((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setIdentity((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error),
        response: null
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "identity.get", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitIntent() {
    if (anyBusy) return;
    if (!intent.sessionId) {
      setIntent((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
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
        content: makeBinaryField(textToBytes(intent.contentText), intent.contentType),
        connectSessionId: intent.sessionId
      });
    } catch (error) {
      setIntent((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setIntent((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null, inspection: null }));
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
          inspection: inspectIntentResult(result, textToBytes(intent.contentText))
        }));
      } else {
        setIntent((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setIntent((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "intent.sign", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Cipher handlers ============== */

  async function submitEncrypt() {
    if (anyBusy) return;
    if (!encrypt.sessionId) {
      setEncrypt((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    let request: ProtocolRequestMessage<"cipher.encrypt">;
    try {
      request = buildCipherEncryptRequest({
        text: encrypt.text,
        contentType: encrypt.contentType,
        content: makeBinaryField(textToBytes(encrypt.contentText), encrypt.contentType),
        connectSessionId: encrypt.sessionId
      });
    } catch (error) {
      setEncrypt((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setEncrypt((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setEncrypt((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as CipherEncryptResult
        }));
      } else {
        setEncrypt((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setEncrypt((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "cipher.encrypt", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitDecrypt() {
    if (anyBusy) return;
    if (!decrypt.sessionId) {
      setDecrypt((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
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
        error: error instanceof Error ? error.message : "Failed to parse binary input"
      }));
      return;
    }
    let request: ProtocolRequestMessage<"cipher.decrypt">;
    try {
      request = buildCipherDecryptRequest({
        text: decrypt.text,
        nonce: makeBinaryField(nonce),
        cipherbytes: makeBinaryField(cipherbytes),
        connectSessionId: decrypt.sessionId
      });
    } catch (error) {
      setDecrypt((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setDecrypt((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null }));
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
          sessionId: decrypt.sessionId
        }));
        setDecrypt((prev) => ({ ...prev, status: "success", response, result }));
        // 同时把内容文本写回右侧观察区可以看的 "decodedText"。
        // 这里我们把它写回 decrypt.result 自带的位置，不另开字段。
        void decodedText;
      } else {
        setDecrypt((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setDecrypt((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "cipher.decrypt", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Transfer handlers ============== */

  async function submitP2pkh() {
    if (anyBusy) return;
    if (!p2pkh.sessionId) {
      setP2pkh((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    const amountSatoshis = Number(p2pkh.amountSatoshis);
    const feeRateSatoshisPerKb = Number(p2pkh.feeRateSatoshisPerKb);
    if (!Number.isFinite(amountSatoshis) || amountSatoshis <= 0) {
      setP2pkh((prev) => ({ ...prev, status: "error", error: "amountSatoshis must be a positive integer" }));
      return;
    }
    if (!Number.isFinite(feeRateSatoshisPerKb) || feeRateSatoshisPerKb < 1) {
      setP2pkh((prev) => ({ ...prev, status: "error", error: "feeRateSatoshisPerKb must be >= 1" }));
      return;
    }
    if (!p2pkh.recipientAddress) {
      setP2pkh((prev) => ({ ...prev, status: "error", error: "recipientAddress is required" }));
      return;
    }
    let request: ProtocolRequestMessage<"p2pkh.transfer">;
    try {
      request = buildP2pkhTransferRequest({
        recipientAddress: p2pkh.recipientAddress,
        amountSatoshis,
        feeRateSatoshisPerKb,
        connectSessionId: p2pkh.sessionId
      });
    } catch (error) {
      setP2pkh((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setP2pkh((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setP2pkh((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as P2pkhTransferResult
        }));
      } else {
        setP2pkh((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setP2pkh((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "p2pkh.transfer", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitFeepoolPrepare() {
    if (anyBusy) return;
    if (!feepoolPrepare.sessionId) {
      setFeepoolPrepare((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    const amountSatoshis = Number(feepoolPrepare.amountSatoshis);
    let request: ProtocolRequestMessage<"feepool.prepare">;
    try {
      request = buildFeepoolPrepareRequest({
        counterpartyPublicKeyHex: feepoolPrepare.counterpartyPublicKeyHex,
        amountSatoshis,
        connectSessionId: feepoolPrepare.sessionId
      });
    } catch (error) {
      setFeepoolPrepare((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setFeepoolPrepare((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as FeepoolPrepareResult;
        setFeepoolPrepare((prev) => ({ ...prev, status: "success", response, result }));
        let autoTotal = feepoolPrepare.poolTotalAmount;
        if (result.priorPoolRecord?.totalAmount) {
          autoTotal = String(result.priorPoolRecord.totalAmount);
        }
        setFeepoolCommit((prev) => ({
          ...prev,
          operationId: result.operationId,
          counterpartyPublicKeyHex: result.counterpartyPublicKeyHex,
          action: result.action,
          draftTotalAmount: autoTotal
        }));
      } else {
        setFeepoolPrepare((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setFeepoolPrepare((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "feepool.prepare", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitFeepoolCommit() {
    if (anyBusy) return;
    if (!feepoolCommit.sessionId) {
      setFeepoolCommit((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    const prepareResult = feepoolPrepare.result;
    if (!prepareResult) {
      setFeepoolCommit((prev) => ({ ...prev, status: "error", error: "No feepool.prepare result to commit. Run feepool.prepare first." }));
      return;
    }
    if (!testWalletState.wallet) {
      setFeepoolCommit((prev) => ({ ...prev, status: "error", error: "Test wallet is required for local counter-signing. Generate or import one in the Wallet workbench." }));
      return;
    }
    if (testWalletState.wallet.publicKeyHex !== prepareResult.counterpartyPublicKeyHex) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error:
          `Test wallet public key does not match feepool.prepare counterpartyPublicKeyHex. ` +
          `Expected ${prepareResult.counterpartyPublicKeyHex}, got ${testWalletState.wallet!.publicKeyHex}. ` +
          `Re-run feepool.prepare with the current test wallet, or re-import the original wallet.`
      }));
      return;
    }
    if (!feepoolCommit.keymasterPublicKeyHex || !/^[0-9a-fA-F]{66}$/.test(feepoolCommit.keymasterPublicKeyHex)) {
      setFeepoolCommit((prev) => ({ ...prev, status: "error", error: "keymasterPublicKeyHex is required (33-byte compressed hex). Fill it manually if not known." }));
      return;
    }
    const draftTotal = Number(feepoolCommit.draftTotalAmount);
    if (!Number.isFinite(draftTotal) || draftTotal <= 0) {
      setFeepoolCommit((prev) => ({ ...prev, status: "error", error: "draftTotalAmount must be a positive integer (pool size)." }));
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
        connectSessionId: feepoolCommit.sessionId
      });
      commitParams = local;
    } catch (error) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : "Failed to build feepool.commit params"
      }));
      return;
    }

    setFeepoolCommit((prev) => ({
      ...prev,
      counterpartySignatures: commitParams.counterpartySignatures
        .map((s) => bytesToHex(new Uint8Array(s.bytes)))
        .join("\n"),
      closeCounterpartySignatures: commitParams.closeCounterpartySignatures
        ? commitParams.closeCounterpartySignatures.map((s) => bytesToHex(new Uint8Array(s.bytes))).join("\n")
        : prev.closeCounterpartySignatures
    }));

    let request: ProtocolRequestMessage<"feepool.commit">;
    try {
      request = buildFeepoolCommitRequest({
        operationId: commitParams.operationId,
        counterpartyPublicKeyHex: commitParams.counterpartyPublicKeyHex,
        counterpartySignatures: commitParams.counterpartySignatures,
        closeCounterpartySignatures: commitParams.closeCounterpartySignatures,
        connectSessionId: feepoolCommit.sessionId
      });
    } catch (error) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : "Failed to build feepool.commit request"
      }));
      return;
    }

    setFeepoolCommit((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setFeepoolCommit((prev) => ({ ...prev, status: "success", response }));
      } else {
        setFeepoolCommit((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "feepool.commit", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Storage handlers ============== */

  async function submitStoragePut() {
    if (anyBusy) return;
    if (!storagePut.sessionId) {
      setStoragePut((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    let request: ProtocolRequestMessage<"storage.put">;
    try {
      request = buildStoragePutRequest({
        path: storagePut.path,
        contentType: storagePut.contentType || undefined,
        content: makeBinaryField(textToBytes(storagePut.contentText), storagePut.contentType || undefined),
        connectSessionId: storagePut.sessionId
      });
    } catch (error) {
      setStoragePut((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setStoragePut((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setStoragePut((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as StoragePutResult
        }));
      } else {
        setStoragePut((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setStoragePut((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "storage.put", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitStorageGet() {
    if (anyBusy) return;
    if (!storageGet.sessionId) {
      setStorageGet((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    let request: ProtocolRequestMessage<"storage.get">;
    try {
      request = buildStorageGetRequest({ path: storageGet.path, connectSessionId: storageGet.sessionId });
    } catch (error) {
      setStorageGet((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setStorageGet((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null, decodedText: "" }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        const result = response.result as StorageGetResult;
        let decodedText = "";
        try {
          decodedText = bytesToText(new Uint8Array(result.content.bytes));
        } catch {
          decodedText = "(invalid utf-8)";
        }
        setStorageGet((prev) => ({ ...prev, status: "success", response, result, decodedText }));
      } else {
        setStorageGet((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setStorageGet((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "storage.get", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitStorageList() {
    if (anyBusy) return;
    if (!storageList.sessionId) {
      setStorageList((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    let request: ProtocolRequestMessage<"storage.list">;
    try {
      request = buildStorageListRequest({ prefix: storageList.prefix, connectSessionId: storageList.sessionId });
    } catch (error) {
      setStorageList((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setStorageList((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setStorageList((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as StorageListResult
        }));
      } else {
        setStorageList((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setStorageList((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "storage.list", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitStorageListAll() {
    if (anyBusy) return;
    if (!storageListAll.sessionId) {
      setStorageListAll((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    let request: ProtocolRequestMessage<"storage.listAll">;
    try {
      request = buildStorageListAllRequest({ connectSessionId: storageListAll.sessionId });
    } catch (error) {
      setStorageListAll((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setStorageListAll((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setStorageListAll((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as StorageListResult
        }));
      } else {
        setStorageListAll((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setStorageListAll((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "storage.listAll", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  async function submitStorageDelete() {
    if (anyBusy) return;
    if (!storageDelete.sessionId) {
      setStorageDelete((prev) => ({ ...prev, status: "error", error: "connectSessionId is required" }));
      return;
    }
    let request: ProtocolRequestMessage<"storage.delete">;
    try {
      request = buildStorageDeleteRequest({ path: storageDelete.path, connectSessionId: storageDelete.sessionId });
    } catch (error) {
      setStorageDelete((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setStorageDelete((prev) => ({ ...prev, status: "loading", error: "", request: request.params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest(request);
      if (response.ok) {
        setStorageDelete((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as StorageDeleteResult
        }));
      } else {
        setStorageDelete((prev) => ({
          ...prev,
          status: "error",
          error: formatProtocolError(response.error.code, response.error.message),
          response
        }));
      }
    } catch (error) {
      setStorageDelete((prev) => ({
        ...prev,
        status: "error",
        error: formatTransportError(error)
      }));
      pushLog({ at: Date.now(), stage: "timeout", method: "storage.delete", detail: error }, "error");
    } finally {
      setAnyBusy(false);
    }
  }

  /* ============== Test wallet handlers（保留旧实现） ============== */

  function generateNewTestWallet() {
    try {
      const w = generateTestWallet();
      setTestWalletState((prev) => ({ ...prev, wallet: w, wifInput: w.wif, error: "" }));
    } catch (err) {
      setTestWalletState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err)
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
        error: err instanceof Error ? err.message : String(err)
      }));
    }
  }

  function forgetTestWallet() {
    setTestWalletState((prev) => ({ ...prev, wallet: null, wifInput: "", utxos: [], utxoError: "", utxoStatus: "idle" }));
  }

  async function refreshTestWalletUtxos() {
    const w = testWalletState.wallet;
    if (!w) return;
    setTestWalletState((prev) => ({ ...prev, utxoStatus: "loading", utxoError: "" }));
    try {
      const client = createWocClient();
      const utxos = await client.listConfirmedUtxos(w.address);
      setTestWalletState((prev) => ({
        ...prev,
        utxos,
        utxoStatus: "success",
        utxoError: "",
        utxoRefreshedAt: Date.now()
      }));
    } catch (err) {
      setTestWalletState((prev) => ({
        ...prev,
        utxoStatus: "error",
        utxoError: err instanceof Error ? err.message : String(err)
      }));
    }
  }

  async function submitRefund() {
    if (toolBusy) return;
    const w = testWalletState.wallet;
    if (!w) {
      setRefund((prev) => ({ ...prev, status: "error", error: "Test wallet is required for refund tool." }));
      return;
    }
    if (!refund.recipientAddress) {
      setRefund((prev) => ({ ...prev, status: "error", error: "recipientAddress is required for refund." }));
      return;
    }
    const amountSatoshis = Number(refund.amountSatoshis);
    const feeRateSatoshisPerKb = Number(refund.feeRateSatoshisPerKb);
    if (!Number.isFinite(amountSatoshis) || amountSatoshis <= 0) {
      setRefund((prev) => ({ ...prev, status: "error", error: "amountSatoshis must be a positive integer" }));
      return;
    }
    if (!Number.isFinite(feeRateSatoshisPerKb) || feeRateSatoshisPerKb < 1) {
      setRefund((prev) => ({ ...prev, status: "error", error: "feeRateSatoshisPerKb must be >= 1" }));
      return;
    }
    setRefund((prev) => ({ ...prev, status: "loading", error: "", result: null }));
    setToolBusy(true);
    try {
      const woc = createWocClient();
      const utxos = await woc.listConfirmedUtxos(w.address);
      setTestWalletState((prev) => ({ ...prev, utxos, utxoRefreshedAt: Date.now(), utxoStatus: "success", utxoError: "" }));
      const validation = validateTransferParams({
        amountSatoshis,
        feeRateSatoshisPerKb,
        recipientAddress: refund.recipientAddress
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
        feeRateSatoshisPerKb
      });
      const receipt = await woc.broadcast(transfer.rawTxHex);
      setRefund((prev) => ({
        ...prev,
        status: "success",
        result: {
          txid: receipt.canonicalTxid,
          rawTxHex: transfer.rawTxHex,
          feeSatoshis: transfer.feeSatoshis
        }
      }));
      void refreshTestWalletUtxos();
    } catch (error) {
      setRefund((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
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
          message: err instanceof Error ? err.message : String(err)
        },
        "warn"
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
      methods: ["connect.login", "connect.resume", "connect.logout", "connect.launch"],
      status:
        login.status === "loading" || resume.status === "loading" || logout.status === "loading" || launch.status === "loading"
          ? "loading"
          : login.status === "success" || resume.status === "success"
          ? "success"
          : login.status === "error" || resume.status === "error" || logout.status === "error" || launch.status === "error"
          ? "error"
          : "idle"
    },
    {
      id: "identity",
      label: "Identity",
      methods: ["identity.get", "intent.sign"],
      status: identity.status === "loading" || intent.status === "loading"
        ? "loading"
        : identity.status === "success" || intent.status === "success"
        ? "success"
        : identity.status === "error" || intent.status === "error"
        ? "error"
        : "idle"
    },
    {
      id: "cipher",
      label: "Cipher",
      methods: ["cipher.encrypt", "cipher.decrypt"],
      status: encrypt.status === "loading" || decrypt.status === "loading"
        ? "loading"
        : encrypt.status === "success" || decrypt.status === "success"
        ? "success"
        : encrypt.status === "error" || decrypt.status === "error"
        ? "error"
        : "idle"
    },
    {
      id: "transfer",
      label: "Transfer",
      methods: ["p2pkh.transfer", "feepool.prepare", "feepool.commit"],
      status:
        p2pkh.status === "loading" || feepoolPrepare.status === "loading" || feepoolCommit.status === "loading"
          ? "loading"
          : p2pkh.status === "success" || feepoolPrepare.status === "success" || feepoolCommit.status === "success"
          ? "success"
          : p2pkh.status === "error" || feepoolPrepare.status === "error" || feepoolCommit.status === "error"
          ? "error"
          : "idle"
    },
    {
      id: "storage",
      label: "Storage",
      methods: ["storage.put", "storage.get", "storage.list", "storage.listAll", "storage.delete"],
      status:
        storagePut.status === "loading" ||
        storageGet.status === "loading" ||
        storageList.status === "loading" ||
        storageListAll.status === "loading" ||
        storageDelete.status === "loading"
          ? "loading"
          : storagePut.status === "success" ||
            storageGet.status === "success" ||
            storageList.status === "success" ||
            storageListAll.status === "success" ||
            storageDelete.status === "success"
          ? "success"
          : storagePut.status === "error" ||
            storageGet.status === "error" ||
            storageList.status === "error" ||
            storageListAll.status === "error" ||
            storageDelete.status === "error"
          ? "error"
          : "idle"
    },
    {
      id: "wallet",
      label: "Test Wallet",
      methods: ["generate / import WIF", "WOC UTXOs", "manual refund"],
      status: toolBusy ? "loading" : testWalletState.utxoStatus
    }
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
      case "storage":
        return renderStorageMain();
      case "wallet":
        return renderWalletMain();
    }
  }

  function renderConnectMain(): ReactNode {
    return (
      <div className="connect-grid">
        <SessionSummary
          session={session}
          targetOrigin={normalizedTargetOrigin}
          onEdit={() => setShowSessionEditor((v) => !v)}
          showEditor={showSessionEditor}
          onClearSession={clearSession}
        />

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
                onChange={(e) => setLogin((prev) => ({ ...prev, text: e.target.value }))}
                rows={3}
              />
            </label>
            <label className="field field-wide">
              <span>claims (one per line)</span>
              <textarea
                value={login.claimsText}
                onChange={(e) => setLogin((prev) => ({ ...prev, claimsText: e.target.value }))}
                rows={4}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "sessionId", value: session.lastConnectResponse ? "connectSessionId" in session.lastConnectResponse ? session.lastConnectResponse.connectSessionId : "" : "" },
              { label: "ownerPublicKeyHex", value: session.lastConnectResponse && "ownerPublicKeyHex" in session.lastConnectResponse ? session.lastConnectResponse.ownerPublicKeyHex : "" }
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
                onChange={(e) => setResume((prev) => ({ ...prev, connectSessionId: e.target.value }))}
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
                onChange={(e) => setLogout((prev) => ({ ...prev, connectSessionId: e.target.value }))}
              />
            </label>
          </div>
        </ProtocolSection>

        <ProtocolSection
          title="connect.launch"
          subtitle="appView mode 首登入口。launchToken 由 launcher 一次性 bootstrap 写入 URL；demo 不伪造 launcher。"
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
                onChange={(e) => setLaunch((prev) => ({ ...prev, launchToken: e.target.value }))}
                placeholder="from ?launchToken= URL or manual input"
              />
            </label>
          </div>
          <p className="hint-note">
            没有真实 launchToken 时失败是预期行为；demo <strong>不</strong>伪造成功路径。
          </p>
        </ProtocolSection>
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
                onChange={(e) => setIdentity((prev) => ({ ...prev, text: e.target.value }))}
                rows={3}
              />
            </label>
            <label className="field field-wide">
              <span>claims (one per line)</span>
              <textarea
                value={identity.claimsText}
                onChange={(e) => setIdentity((prev) => ({ ...prev, claimsText: e.target.value }))}
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
                onChange={(e) => setIdentity((prev) => ({ ...prev, ttlSeconds: Number(e.target.value || 0) }))}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "subject.publicKey", value: identity.inspection?.publicKeyHex ?? "n/a" },
              { label: "signature", value: identity.inspection?.signatureHex ?? "n/a" },
              { label: "local verify", value: identity.inspection ? (identity.inspection.ok ? "pass" : "fail") : "n/a" },
              { label: "claims projection", value: identity.inspection?.claimsProjection ?? "n/a" },
              { label: "last keymaster main address", value: identity.lastKeymasterAddress || "n/a" }
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
                onChange={(e) => setIntent((prev) => ({ ...prev, text: e.target.value }))}
                rows={3}
              />
            </label>
            <label className="field">
              <span>contentType</span>
              <input
                value={intent.contentType}
                onChange={(e) => setIntent((prev) => ({ ...prev, contentType: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>ttlSeconds</span>
              <input
                type="number"
                min={1}
                step={1}
                value={intent.ttlSeconds}
                onChange={(e) => setIntent((prev) => ({ ...prev, ttlSeconds: Number(e.target.value || 0) }))}
              />
            </label>
            <label className="field field-wide">
              <span>contentText</span>
              <textarea
                value={intent.contentText}
                onChange={(e) => setIntent((prev) => ({ ...prev, contentText: e.target.value }))}
                rows={4}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "contentSha256 (local)", value: intent.inspection?.computedContentSha256Hex ?? "n/a" },
              { label: "contentSha256 (envelope)", value: intent.inspection?.envelopeContentSha256Hex ?? "n/a" },
              { label: "local verify", value: intent.inspection ? (intent.inspection.ok ? "pass" : "fail") : "n/a" },
              { label: "subject.publicKey", value: intent.inspection?.publicKeyHex ?? "n/a" }
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
                onChange={(e) => setEncrypt((prev) => ({ ...prev, text: e.target.value }))}
                rows={3}
              />
            </label>
            <label className="field">
              <span>contentType</span>
              <input
                value={encrypt.contentType}
                onChange={(e) => setEncrypt((prev) => ({ ...prev, contentType: e.target.value }))}
              />
            </label>
            <label className="field field-wide">
              <span>contentText</span>
              <textarea
                value={encrypt.contentText}
                onChange={(e) => setEncrypt((prev) => ({ ...prev, contentText: e.target.value }))}
                rows={4}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "nonce hex", value: encrypt.result ? bytesToHex(new Uint8Array(encrypt.result.nonce.bytes)) : "n/a" },
              { label: "nonce base64", value: encrypt.result ? bytesToBase64(new Uint8Array(encrypt.result.nonce.bytes)) : "n/a" },
              { label: "cipherbytes hex", value: encrypt.result ? bytesToHex(new Uint8Array(encrypt.result.cipherbytes.bytes)) : "n/a" },
              { label: "cipherbytes base64", value: encrypt.result ? bytesToBase64(new Uint8Array(encrypt.result.cipherbytes.bytes)) : "n/a" }
            ]}
          />
        </ProtocolSection>

        <ProtocolSection
          title="cipher.decrypt"
          subtitle="支持手工粘贴 nonce / cipherbytes；缺 `not_found` / `decrypt_failed` 是预期的协议错误。"
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
                onChange={(e) => setDecrypt((prev) => ({ ...prev, text: e.target.value }))}
                rows={3}
              />
            </label>
            <label className="field field-wide">
              <span>nonce</span>
              <textarea
                value={decrypt.nonceInput}
                onChange={(e) => setDecrypt((prev) => ({ ...prev, nonceInput: e.target.value }))}
                rows={2}
                placeholder="hex or base64"
              />
            </label>
            <label className="field field-wide">
              <span>cipherbytes</span>
              <textarea
                value={decrypt.cipherbytesInput}
                onChange={(e) => setDecrypt((prev) => ({ ...prev, cipherbytesInput: e.target.value }))}
                rows={4}
                placeholder="hex or base64"
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "contentType", value: decrypt.result?.contentType ?? "n/a" },
              { label: "content hex", value: decrypt.result ? bytesToHex(new Uint8Array(decrypt.result.content.bytes)) : "n/a" },
              { label: "content text", value: decrypt.result ? safeBytesToText(new Uint8Array(decrypt.result.content.bytes)) : "n/a" }
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
                onChange={(e) => setP2pkh((prev) => ({ ...prev, recipientAddress: e.target.value }))}
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
                onChange={(e) => setP2pkh((prev) => ({ ...prev, amountSatoshis: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>feeRateSatoshisPerKb</span>
              <input
                type="number"
                min={1}
                step={1}
                value={p2pkh.feeRateSatoshisPerKb}
                onChange={(e) => setP2pkh((prev) => ({ ...prev, feeRateSatoshisPerKb: e.target.value }))}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "txid", value: p2pkh.result?.txid ?? "n/a" },
              { label: "rawTxHex (head)", value: p2pkh.result ? truncateHex(p2pkh.result.rawTxHex, 64) : "n/a" },
              { label: "feeSatoshis", value: p2pkh.result?.feeSatoshis ?? "n/a" }
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
                    prepare.priorPoolRecord?.totalAmount?.toString() ?? prev.draftTotalAmount
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
            onChange={(v) => setFeepoolPrepare((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>counterpartyPublicKeyHex</span>
              <input
                value={feepoolPrepare.counterpartyPublicKeyHex}
                onChange={(e) => setFeepoolPrepare((prev) => ({ ...prev, counterpartyPublicKeyHex: e.target.value }))}
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
                onChange={(e) => setFeepoolPrepare((prev) => ({ ...prev, amountSatoshis: e.target.value }))}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "operationId", value: feepoolPrepare.result?.operationId ?? "n/a" },
              { label: "action", value: feepoolPrepare.result ? actionLabel(feepoolPrepare.result.action) : "n/a" },
              { label: "draftSpendTxHex (head)", value: feepoolPrepare.result ? truncateHex(feepoolPrepare.result.draftSpendTxHex, 64) : "n/a" },
              { label: "baseTxHex", value: feepoolPrepare.result?.baseTxHex ? truncateHex(feepoolPrepare.result.baseTxHex, 64) : "n/a" },
              { label: "priorPool.totalAmount", value: feepoolPrepare.result?.priorPoolRecord?.totalAmount ?? "n/a" }
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
            onChange={(v) => setFeepoolCommit((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>operationId (auto from prepare)</span>
              <input
                value={feepoolCommit.operationId}
                onChange={(e) => setFeepoolCommit((prev) => ({ ...prev, operationId: e.target.value }))}
                placeholder="from feepool.prepare result"
              />
            </label>
            <label className="field field-wide">
              <span>counterpartyPublicKeyHex</span>
              <input
                value={feepoolCommit.counterpartyPublicKeyHex}
                onChange={(e) => setFeepoolCommit((prev) => ({ ...prev, counterpartyPublicKeyHex: e.target.value }))}
              />
            </label>
            <label className="field field-wide">
              <span>action (read-only, from prepare)</span>
              <input value={feepoolCommit.action} readOnly />
            </label>
            <label className="field field-wide">
              <span>keymasterPublicKeyHex (Keymaster multisig client pubkey)</span>
              <input
                value={feepoolCommit.keymasterPublicKeyHex}
                onChange={(e) => setFeepoolCommit((prev) => ({ ...prev, keymasterPublicKeyHex: e.target.value }))}
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
                onChange={(e) => setFeepoolCommit((prev) => ({ ...prev, draftTotalAmount: e.target.value }))}
                placeholder="multisig output total"
              />
            </label>
            <label className="field field-wide">
              <span>counterpartySignatures (auto-computed, hex, one per line)</span>
              <textarea value={feepoolCommit.counterpartySignatures} readOnly rows={3} />
            </label>
            {feepoolCommit.closeCounterpartySignatures ? (
              <label className="field field-wide">
                <span>closeCounterpartySignatures (auto-computed, hex, one per line)</span>
                <textarea value={feepoolCommit.closeCounterpartySignatures} readOnly rows={3} />
              </label>
            ) : null}
          </div>
          <ResultGrid
            items={[
              { label: "result.operationId", value: resultFromFeepoolCommit(feepoolCommit.response, "operationId") ?? "n/a" },
              { label: "result.action", value: resultFromFeepoolCommit(feepoolCommit.response, "action") ?? "n/a" },
              { label: "result.draftTxid", value: resultFromFeepoolCommit(feepoolCommit.response, "draftTxid") ?? "n/a" },
              { label: "result.draftTxHex (head)", value: resultFromFeepoolCommit(feepoolCommit.response, "draftTxHexHead") ?? "n/a" }
            ]}
          />
        </ProtocolSection>
      </div>
    );
  }

  function renderStorageMain(): ReactNode {
    return (
      <div className="workbench-grid">
        <ProtocolSection
          title="storage.put"
          subtitle="写入明文对象；Keymaster 在 Session Window 内透明加密。"
          status={storagePut.status}
          onSubmit={submitStoragePut}
          submitLabel="Run storage.put"
          error={storagePut.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={storagePut.sessionId}
            onChange={(v) => setStoragePut((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>path</span>
              <input
                value={storagePut.path}
                onChange={(e) => setStoragePut((prev) => ({ ...prev, path: e.target.value }))}
                placeholder="e.g. notes/hello.txt"
              />
            </label>
            <label className="field">
              <span>contentType</span>
              <input
                value={storagePut.contentType}
                onChange={(e) => setStoragePut((prev) => ({ ...prev, contentType: e.target.value }))}
              />
            </label>
            <label className="field field-wide">
              <span>contentText</span>
              <textarea
                value={storagePut.contentText}
                onChange={(e) => setStoragePut((prev) => ({ ...prev, contentText: e.target.value }))}
                rows={4}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "objectKey", value: storagePut.result?.objectKey ?? "n/a" },
              { label: "updatedAt", value: storagePut.result ? new Date(storagePut.result.updatedAt).toLocaleString() : "n/a" }
            ]}
          />
        </ProtocolSection>

        <ProtocolSection
          title="storage.get"
          subtitle="对象不存在时返回 `not_found`，这是有效的协议错误。"
          status={storageGet.status}
          onSubmit={submitStorageGet}
          submitLabel="Run storage.get"
          error={storageGet.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={storageGet.sessionId}
            onChange={(v) => setStorageGet((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>path</span>
              <input
                value={storageGet.path}
                onChange={(e) => setStorageGet((prev) => ({ ...prev, path: e.target.value }))}
                placeholder="e.g. notes/hello.txt"
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "contentType", value: storageGet.result?.contentType ?? "n/a" },
              { label: "content hex", value: storageGet.result ? bytesToHex(new Uint8Array(storageGet.result.content.bytes)) : "n/a" },
              { label: "content text", value: storageGet.result ? safeBytesToText(new Uint8Array(storageGet.result.content.bytes)) : storageGet.decodedText || "n/a" }
            ]}
          />
        </ProtocolSection>

        <ProtocolSection
          title="storage.list"
          subtitle="按 prefix 列对象；空 prefix 列当前虚拟桶根。"
          status={storageList.status}
          onSubmit={submitStorageList}
          submitLabel="Run storage.list"
          error={storageList.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={storageList.sessionId}
            onChange={(v) => setStorageList((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>prefix</span>
              <input
                value={storageList.prefix}
                onChange={(e) => setStorageList((prev) => ({ ...prev, prefix: e.target.value }))}
                placeholder="e.g. notes/"
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "entryCount", value: storageList.result?.entries.length ?? "n/a" }
            ]}
          />
          <ResultPanel title="entries" value={storageList.result?.entries ?? null} />
        </ProtocolSection>

        <ProtocolSection
          title="storage.listAll"
          subtitle="列当前 session 虚拟桶下所有对象。"
          status={storageListAll.status}
          onSubmit={submitStorageListAll}
          submitLabel="Run storage.listAll"
          error={storageListAll.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={storageListAll.sessionId}
            onChange={(v) => setStorageListAll((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <ResultGrid
            items={[
              { label: "entryCount", value: storageListAll.result?.entries.length ?? "n/a" }
            ]}
          />
          <ResultPanel title="entries" value={storageListAll.result?.entries ?? null} />
        </ProtocolSection>

        <ProtocolSection
          title="storage.delete"
          subtitle="删除对象；对象不存在时返回 `not_found`。"
          status={storageDelete.status}
          onSubmit={submitStorageDelete}
          submitLabel="Run storage.delete"
          error={storageDelete.error}
          disabled={anyBusy}
        >
          <SessionIdField
            value={storageDelete.sessionId}
            onChange={(v) => setStorageDelete((prev) => ({ ...prev, sessionId: v }))}
            currentSessionId={session.connectSessionId}
          />
          <div className="form-grid">
            <label className="field field-wide">
              <span>path</span>
              <input
                value={storageDelete.path}
                onChange={(e) => setStorageDelete((prev) => ({ ...prev, path: e.target.value }))}
                placeholder="e.g. notes/hello.txt"
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "deleted", value: storageDelete.result?.deleted ? "true" : "n/a" },
              { label: "updatedAt", value: storageDelete.result ? new Date(storageDelete.result.updatedAt).toLocaleString() : "n/a" }
            ]}
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
                  onChange={(e) => setTestWalletState((prev) => ({ ...prev, wifInput: e.target.value }))}
                  placeholder="mainnet WIF"
                />
                <button type="button" className="secondary-button" onClick={importWif} disabled={anyBusy || toolBusy}>
                  Import
                </button>
              </div>
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "address", value: testWalletState.wallet?.address ?? "n/a" },
              { label: "publicKeyHex", value: testWalletState.wallet?.publicKeyHex ?? "n/a" },
              { label: "wif", value: testWalletState.wallet?.wif ?? "n/a" }
            ]}
          />
          <p className="hint-note">测试钱包私钥默认只在内存里；刷新页面后丢失。demo 不持久化私钥。</p>
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
                  ? new Date(testWalletState.utxoRefreshedAt).toLocaleTimeString()
                  : "n/a"
              },
              { label: "utxoCount", value: testWalletState.utxos.length },
              { label: "totalValue", value: testWalletState.utxos.reduce((sum, u) => sum + u.value, 0) }
            ]}
          />
          <ResultPanel
            title="UTXO list"
            value={testWalletState.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }))}
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
                onChange={(e) => setRefund((prev) => ({ ...prev, recipientAddress: e.target.value }))}
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
                onChange={(e) => setRefund((prev) => ({ ...prev, amountSatoshis: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>feeRateSatoshisPerKb</span>
              <input
                type="number"
                min={1}
                step={1}
                value={refund.feeRateSatoshisPerKb}
                onChange={(e) => setRefund((prev) => ({ ...prev, feeRateSatoshisPerKb: e.target.value }))}
              />
            </label>
          </div>
          <ResultGrid
            items={[
              { label: "txid", value: refund.result?.txid ?? "n/a" },
              { label: "rawTxHex (head)", value: refund.result ? truncateHex(refund.result.rawTxHex, 64) : "n/a" },
              { label: "feeSatoshis", value: refund.result?.feeSatoshis ?? "n/a" }
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
            <ResultPanel title="current session" value={describeSession(session)} />
            <ResultPanel title="connect.login raw result" value={login.response} />
            <ResultPanel title="connect.resume raw result" value={resume.response} />
            <ResultPanel title="connect.logout raw result" value={logout.response} />
            <ResultPanel title="connect.launch raw result" value={launch.response} />
          </>
        );
      case "identity":
        return (
          <>
            <ResultPanel title="identity.get request" value={identity.request} />
            <ResultPanel title="identity.get raw result" value={identity.response} />
            <ResultPanel
              title="identity.get decoded envelope"
              value={identity.inspection?.decodedEnvelope}
              pretty={identity.inspection?.decodedEnvelopePretty}
            />
            <ResultPanel title="identity.get resolvedClaims" value={identity.result?.resolvedClaims} />
            <ResultPanel title="intent.sign request" value={intent.request} />
            <ResultPanel title="intent.sign raw result" value={intent.response} />
          </>
        );
      case "cipher":
        return (
          <>
            <ResultPanel title="cipher.encrypt request" value={encrypt.request} />
            <ResultPanel title="cipher.encrypt raw result" value={encrypt.response} />
            <ResultPanel title="cipher.decrypt request" value={decrypt.request} />
            <ResultPanel title="cipher.decrypt raw result" value={decrypt.response} />
          </>
        );
      case "transfer":
        return (
          <>
            <ResultPanel title="p2pkh.transfer request" value={p2pkh.request} />
            <ResultPanel title="p2pkh.transfer raw result" value={p2pkh.response} />
            <ResultPanel title="feepool.prepare request" value={feepoolPrepare.request} />
            <ResultPanel title="feepool.prepare raw result" value={feepoolPrepare.response} />
            <ResultPanel title="feepool.prepare result (full)" value={feepoolPrepare.result} />
            <ResultPanel title="feepool.commit request" value={feepoolCommit.request} />
            <ResultPanel title="feepool.commit raw result" value={feepoolCommit.response} />
          </>
        );
      case "storage":
        return (
          <>
            <ResultPanel title="storage.put request" value={storagePut.request} />
            <ResultPanel title="storage.put raw result" value={storagePut.response} />
            <ResultPanel title="storage.get request" value={storageGet.request} />
            <ResultPanel title="storage.get raw result" value={storageGet.response} />
            <ResultPanel title="storage.list raw result" value={storageList.response} />
            <ResultPanel title="storage.listAll raw result" value={storageListAll.response} />
            <ResultPanel title="storage.delete raw result" value={storageDelete.response} />
          </>
        );
      case "wallet":
        return (
          <>
            <div className="observer-summary">
              <div className="observer-summary__label">test wallet</div>
              <ResultGrid
                items={[
                  { label: "address", value: testWalletState.wallet?.address ?? "n/a" },
                  { label: "publicKeyHex", value: testWalletState.wallet?.publicKeyHex ?? "n/a" }
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
                      ? new Date(testWalletState.utxoRefreshedAt).toLocaleTimeString()
                      : "n/a"
                  },
                  { label: "utxoCount", value: testWalletState.utxos.length },
                  { label: "totalValue", value: testWalletState.utxos.reduce((sum, u) => sum + u.value, 0) }
                ]}
              />
              <ResultPanel
                title="UTXO list (full)"
                value={testWalletState.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }))}
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
                    feeSatoshis: refund.result.feeSatoshis
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

  const activeItem = workbenchItems.find((item) => item.id === activeWorkbench) ?? workbenchItems[0];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__title">
          <p className="eyebrow">Keymaster Connect V1 demo</p>
          <h1>Session-first 外部调用方验证台</h1>
          <p className="app-header__sub">
            工作台：Connect / Identity / Cipher / Transfer / Storage / Test Wallet（覆盖 16 个协议方法）
          </p>
        </div>
        <div className="app-header__status">
          <ConnectionIndicator state={connectionState} />
          <div className="app-header__chip" title="Keymaster popup 目标 origin">
            <span className="app-header__chip-label">target origin</span>
            <strong>{normalizedTargetOrigin || "invalid"}</strong>
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

      <section className="app-mainbody" aria-label="Global config and shared context">
        <div className="global-config">
          <h2>Runtime config</h2>
          <div className="config-grid">
            <label>
              <span>Keymaster Target Origin</span>
              <input value={targetOrigin} onChange={(e) => setTargetOrigin(e.target.value)} />
            </label>
            <label>
              <span>Popup Width</span>
              <input
                type="number"
                min={320}
                step={1}
                value={popupWidth}
                onChange={(e) => setPopupWidth(Number(e.target.value || DEFAULT_POPUP_WIDTH))}
              />
            </label>
            <label>
              <span>Popup Height</span>
              <input
                type="number"
                min={320}
                step={1}
                value={popupHeight}
                onChange={(e) => setPopupHeight(Number(e.target.value || DEFAULT_POPUP_HEIGHT))}
              />
            </label>
            <label>
              <span>Ready Timeout(ms)</span>
              <input
                type="number"
                min={1000}
                step={100}
                value={readyTimeoutMs}
                onChange={(e) => setReadyTimeoutMs(Number(e.target.value || DEFAULT_READY_TIMEOUT))}
              />
            </label>
            <label>
              <span>Result Timeout(ms)</span>
              <input
                type="number"
                min={1000}
                step={100}
                value={resultTimeoutMs}
                onChange={(e) => setResultTimeoutMs(Number(e.target.value || DEFAULT_RESULT_TIMEOUT))}
              />
            </label>
          </div>
        </div>
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
                  <span className={`status-pill status-${item.status}`}>{statusText(item.status)}</span>
                </span>
                <span className="nav-item__hint">{item.methods.join(" / ")}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="workbench-main">{renderActiveMain()}</main>

        <aside className="workbench-observer" aria-label="Observer">
          <section className="observer-pane" key={activeWorkbench}>
            <header className="observer-pane__head">
              <h2>Observer</h2>
              <p>当前工作台：{activeItem.label}</p>
            </header>
            <div className="observer-pane__body">{renderActiveObserver()}</div>
          </section>
          <section className="observer-log">
            <header className="observer-log__head">
              <h2>Protocol log</h2>
              <p>最近 60 条全局事件</p>
            </header>
            <div className="log-list">
              {logs.length === 0 ? (
                <p className="log-empty">No protocol events yet.</p>
              ) : (
                logs.map((entry, index) => (
                  <article
                    className={`log-entry level-${entry.level}`}
                    key={`${entry.at}-${entry.stage}-${index}`}
                  >
                    <div className="log-meta">
                      <span>{new Date(entry.at).toLocaleTimeString()}</span>
                      <span>{entry.method ?? "system"}</span>
                      <span>{entry.stage}</span>
                    </div>
                    {entry.message ? <div className="log-message">{entry.message}</div> : null}
                    {entry.detail !== undefined ? <pre>{prettySerializable(entry.detail)}</pre> : null}
                  </article>
                ))
              )}
            </div>
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
  targetOrigin: string;
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
          <button type="button" className="secondary-button" onClick={props.onEdit}>
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
          { label: "connectSessionId", value: has ? session.connectSessionId : "n/a" },
          { label: "ownerPublicKeyHex", value: session.ownerPublicKeyHex || "n/a" },
          { label: "source", value: session.source || "n/a" },
          {
            label: "refreshedAt",
            value: session.refreshedAt ? new Date(session.refreshedAt).toLocaleString() : "n/a"
          },
          { label: "targetOrigin", value: props.targetOrigin || "n/a" }
        ]}
      />
      {props.showEditor ? (
        <ResultPanel title="resolvedClaims snapshot" value={session.resolvedClaims} />
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

function ResultPanel({ title, value, pretty }: { title: string; value: unknown; pretty?: string }) {
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
  const prefix: Record<ProtocolErrorCode, string> = {
    invalid_request: "Invalid request",
    invalid_origin: "Invalid origin",
    user_rejected: "User rejected",
    active_key_unavailable: "Active key unavailable",
    decrypt_failed: "Decrypt failed",
    not_found: "Not found",
    internal_error: "Internal error"
  };
  return `${prefix[code]}: ${message}`;
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

function resultFromFeepoolCommit(response: ProtocolResultMessage | null, field: string): string | null {
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
      return typeof r.draftTxHex === "string" ? truncateHex(r.draftTxHex, 64) : null;
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
    lastResponse: session.lastConnectResponse
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