import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { bytesToBase64, bytesToHex, bytesToText, ensureTextLines, parseBinaryInput, textToBytes } from "./lib/encoding";
import { makeBinaryField } from "./lib/binary";
import { toDisplayValue } from "./lib/cbor";
import { inspectIdentityResult, inspectIntentResult } from "./lib/verify";
import { normalizeOrigin, ProtocolTransportError, type ProtocolLogEvent } from "./lib/connectClient";
import { PopupSessionClient } from "./lib/popupSessionClient";
import {
  type CipherDecryptResult,
  type CipherEncryptResult,
  type FeepoolCommitParams,
  type FeepoolPrepareResult,
  type IdentityGetResult,
  type IntentSignResult,
  type P2pkhTransferResult,
  type PopupConnectionState,
  type ProtocolErrorCode,
  type ProtocolMethod,
  type ProtocolRequestMessage,
  type ProtocolResultMessage
} from "./lib/protocol";
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
type TabId =
  | "identity"
  | "intent"
  | "encrypt"
  | "decrypt"
  | "p2pkh"
  | "feepool-prepare"
  | "feepool-commit"
  | "tool";

type LogEntry = ProtocolLogEvent & {
  level: "info" | "warn" | "error";
};

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
}

interface EncryptState {
  text: string;
  contentType: string;
  contentText: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: CipherEncryptResult | null;
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
}

interface P2pkhTransferState {
  recipientAddress: string;
  amountSatoshis: string;
  feeRateSatoshisPerKb: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: P2pkhTransferResult | null;
}

interface FeepoolPrepareState {
  counterpartyPublicKeyHex: string;
  amountSatoshis: string;
  status: SectionStatus;
  error: string;
  request: unknown;
  response: ProtocolResultMessage | null;
  result: FeepoolPrepareResult | null;
  /** 总池大小（multisig output 总额）。本地签名需要。 */
  poolTotalAmount: string;
  /** Keymaster active key 压缩公钥 hex（multisig 中的 client 角色，本地签名需要）。 */
  keymasterPublicKeyHex: string;
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
  /** 自动从 prepare 回填：draftTotalAmount */
  draftTotalAmount: string;
  /** Keymaster active key 压缩公钥 hex（multisig 中的 client 角色，手填）。 */
  keymasterPublicKeyHex: string;
  /** 自动从 prepare 回填：action */
  action: string;
}

interface TestWalletState {
  /** 当前测试钱包；null = 还没有。 */
  wallet: TestWallet | null;
  /** WIF 输入（导入路径）。 */
  wifInput: string;
  /** 错误信息（生成/导入失败）。 */
  error: string;
  /** 最近一次 WOC 拉到的 UTXO。 */
  utxos: WocUtxo[];
  utxoStatus: SectionStatus;
  utxoError: string;
  utxoRefreshedAt: number;
}

interface RefundState {
  /** 回款目标地址；缺省用最近一次 Keymaster 地址。 */
  recipientAddress: string;
  amountSatoshis: string;
  feeRateSatoshisPerKb: string;
  status: SectionStatus;
  error: string;
  /** 回款 tx 成功后展示：txid / rawTxHex / fee。 */
  result: { txid: string; rawTxHex: string; feeSatoshis: number } | null;
}

const DEFAULT_READY_TIMEOUT = 10_000;
const DEFAULT_RESULT_TIMEOUT = 60_000;
const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 760;

/**
 * Popup 连接状态机（窗口级别，与 request 级别业务结果无关）：
 *   - `idle`        demo 页面刚加载或上一轮已结束，回到无连接态；
 *   - `opening`     window.open 成功，尚未收到 ready；
 *   - `connected`   收到 ready；
 *   - `disconnected` 收到 closing 或轮询到 popup.closed === true（终态）。
 */
type DemoConnectionState = "idle" | PopupConnectionState;

export default function App() {
  const currentOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const [targetOrigin, setTargetOrigin] = useState("https://keymaster.cc");
  const [popupWidth, setPopupWidth] = useState(DEFAULT_POPUP_WIDTH);
  const [popupHeight, setPopupHeight] = useState(DEFAULT_POPUP_HEIGHT);
  const [readyTimeoutMs, setReadyTimeoutMs] = useState(DEFAULT_READY_TIMEOUT);
  const [resultTimeoutMs, setResultTimeoutMs] = useState(DEFAULT_RESULT_TIMEOUT);
  const [logs, setLogs] = useState<LogEntry[]>([]);

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
    lastKeymasterAddress: ""
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
    inspection: null
  });

  const [encrypt, setEncrypt] = useState<EncryptState>({
    text: "请确认加密以下内容",
    contentType: "demo.note.v1",
    contentText: "Secret message from the demo page.",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null
  });

  const [decrypt, setDecrypt] = useState<DecryptState>({
    text: "请确认解密这段内容",
    nonceInput: "",
    cipherbytesInput: "",
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null
  });

  const [p2pkh, setP2pkh] = useState<P2pkhTransferState>({
    recipientAddress: "",
    amountSatoshis: "1000",
    feeRateSatoshisPerKb: String(defaultFeeRateSatoshisPerKb()),
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null
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
    keymasterPublicKeyHex: ""
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
    /** Keymaster active key 压缩公钥 hex（multisig 中的 client 角色）。
     * SDK `keymaster-multisig-pool` 中称为 `clientPublicKey` / `clientPrivateKey`；
     * demo 不知道 Keymaster 的 privkey，需要手动输入它的 pubkey 才能正确构造
     * redeemScript 的 sighash。
     */
    keymasterPublicKeyHex: "",
    action: ""
  });

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

  const [activeTab, setActiveTab] = useState<TabId>("identity");

  const [connectionState, setConnectionState] = useState<DemoConnectionState>("idle");
  const [anyBusy, setAnyBusy] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);

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

  useEffect(() => {
    if (sessionClientRef.current) {
      sessionClientRef.current.closeSession();
      sessionClientRef.current = null;
      setAnyBusy(false);
    }
  }, [targetOrigin, popupWidth, popupHeight, readyTimeoutMs, resultTimeoutMs]);

  useEffect(() => {
    const latestEncryptResult = encrypt.result;
    if (latestEncryptResult) {
      setDecrypt((prev) => ({
        ...prev,
        nonceInput: bytesToHex(new Uint8Array(latestEncryptResult.nonce.bytes)),
        cipherbytesInput: bytesToHex(new Uint8Array(latestEncryptResult.cipherbytes.bytes))
      }));
    }
  }, [encrypt.result]);

  // p2pkh.transfer 默认收款地址 = 测试钱包地址（如果存在）
  useEffect(() => {
    const w = testWalletState.wallet;
    if (w && p2pkh.recipientAddress === "") {
      setP2pkh((prev) => ({ ...prev, recipientAddress: w.address }));
    }
  }, [testWalletState.wallet, p2pkh.recipientAddress]);

  // feepool.prepare 默认 counterparty pubkey = 测试钱包公钥（如果存在）
  useEffect(() => {
    const w = testWalletState.wallet;
    if (w && feepoolPrepare.counterpartyPublicKeyHex === "") {
      setFeepoolPrepare((prev) => ({ ...prev, counterpartyPublicKeyHex: w.publicKeyHex }));
    }
  }, [testWalletState.wallet, feepoolPrepare.counterpartyPublicKeyHex]);

  // 回款默认收款地址 = 最近一次 Keymaster 主网地址（如果有）
  useEffect(() => {
    if (identity.lastKeymasterAddress && refund.recipientAddress === "") {
      setRefund((prev) => ({ ...prev, recipientAddress: identity.lastKeymasterAddress }));
    }
  }, [identity.lastKeymasterAddress, refund.recipientAddress]);

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

  function makeRequestId() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function extractKeymasterMainAddress(claims: Record<string, unknown> | undefined): string {
    if (!claims) return "";
    const v = claims["wallet.bsv.address.main"];
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      // BinaryField { $type, bytes } — try decode as text
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
    method: M,
    params: import("./lib/protocol").MethodParams<M>
  ): Promise<ProtocolResultMessage> {
    const request: ProtocolRequestMessage<M> = {
      v: 1,
      type: "request",
      id: makeRequestId(),
      method,
      params
    };
    return getSessionClient().runRequest(request);
  }

  async function submitIdentity() {
    if (!normalizedTargetOrigin) {
      setIdentity((prev) => ({ ...prev, status: "error", error: "Target origin is not a valid origin." }));
      return;
    }
    if (anyBusy) {
      pushLog({ at: Date.now(), stage: "busy_rejected", method: "identity.get" }, "warn");
      return;
    }
    const claims = ensureTextLines(identity.claimsText);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + Number(identity.ttlSeconds || 0);
    const params: import("./lib/protocol").IdentityGetParams = {
      aud: currentOrigin,
      iat,
      exp,
      text: identity.text,
      claims
    };
    setIdentity((prev) => ({ ...prev, status: "loading", error: "", request: params, response: null, result: null, inspection: null }));
    setAnyBusy(true);
    pushLog({ at: Date.now(), stage: "waiting_ready", method: "identity.get", requestId: "pending", detail: { params } }, "info");
    try {
      const response = await runProtocolRequest("identity.get", params);
      setIdentity((prev) => ({ ...prev, status: response.ok ? "success" : "error", response }));
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
    if (anyBusy) {
      pushLog({ at: Date.now(), stage: "busy_rejected", method: "intent.sign" }, "warn");
      return;
    }
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + Number(intent.ttlSeconds || 0);
    const params: import("./lib/protocol").IntentSignParams = {
      aud: currentOrigin,
      iat,
      exp,
      text: intent.text,
      contentType: intent.contentType,
      content: makeBinaryField(textToBytes(intent.contentText), intent.contentType)
    };
    setIntent((prev) => ({ ...prev, status: "loading", error: "", request: params, response: null, result: null, inspection: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest("intent.sign", params);
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

  async function submitEncrypt() {
    if (anyBusy) {
      pushLog({ at: Date.now(), stage: "busy_rejected", method: "cipher.encrypt" }, "warn");
      return;
    }
    const params: import("./lib/protocol").CipherEncryptParams = {
      text: encrypt.text,
      contentType: encrypt.contentType,
      content: makeBinaryField(textToBytes(encrypt.contentText), encrypt.contentType)
    };
    setEncrypt((prev) => ({ ...prev, status: "loading", error: "", request: params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest("cipher.encrypt", params);
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
    if (anyBusy) {
      pushLog({ at: Date.now(), stage: "busy_rejected", method: "cipher.decrypt" }, "warn");
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
    const params: import("./lib/protocol").CipherDecryptParams = {
      text: decrypt.text,
      nonce: makeBinaryField(nonce),
      cipherbytes: makeBinaryField(cipherbytes)
    };
    setDecrypt((prev) => ({ ...prev, status: "loading", error: "", request: params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest("cipher.decrypt", params);
      if (response.ok) {
        setDecrypt((prev) => ({
          ...prev,
          status: "success",
          response,
          result: response.result as CipherDecryptResult
        }));
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

  function copyEncryptToDecrypt() {
    const latestEncryptResult = encrypt.result;
    if (!latestEncryptResult) return;
    setDecrypt((prev) => ({
      ...prev,
      nonceInput: bytesToHex(new Uint8Array(latestEncryptResult.nonce.bytes)),
      cipherbytesInput: bytesToHex(new Uint8Array(latestEncryptResult.cipherbytes.bytes))
    }));
  }

  async function submitP2pkh() {
    if (anyBusy) {
      pushLog({ at: Date.now(), stage: "busy_rejected", method: "p2pkh.transfer" }, "warn");
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
    if (!p2pkh.recipientAddress || p2pkh.recipientAddress.length === 0) {
      setP2pkh((prev) => ({ ...prev, status: "error", error: "recipientAddress is required" }));
      return;
    }
    const params: import("./lib/protocol").P2pkhTransferParams = {
      recipientAddress: p2pkh.recipientAddress,
      amountSatoshis,
      feeRateSatoshisPerKb
    };
    setP2pkh((prev) => ({ ...prev, status: "loading", error: "", request: params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest("p2pkh.transfer", params);
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
    if (anyBusy) {
      pushLog({ at: Date.now(), stage: "busy_rejected", method: "feepool.prepare" }, "warn");
      return;
    }
    const amountSatoshis = Number(feepoolPrepare.amountSatoshis);
    if (!Number.isFinite(amountSatoshis) || amountSatoshis <= 0) {
      setFeepoolPrepare((prev) => ({ ...prev, status: "error", error: "amountSatoshis must be a positive integer" }));
      return;
    }
    if (!/^[0-9a-fA-F]{66}$/.test(feepoolPrepare.counterpartyPublicKeyHex)) {
      setFeepoolPrepare((prev) => ({ ...prev, status: "error", error: "counterpartyPublicKeyHex must be 33-byte compressed hex (66 chars)" }));
      return;
    }
    const params: import("./lib/protocol").FeepoolPrepareParams = {
      counterpartyPublicKeyHex: feepoolPrepare.counterpartyPublicKeyHex,
      amountSatoshis
    };
    setFeepoolPrepare((prev) => ({ ...prev, status: "loading", error: "", request: params, response: null, result: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest("feepool.prepare", params);
      if (response.ok) {
        const result = response.result as FeepoolPrepareResult;
        setFeepoolPrepare((prev) => ({ ...prev, status: "success", response, result }));
        // 自动回填到 commit 区（prepare 成功后）。
        // draftTotalAmount = pool 大小 = prior.totalAmount 或新建池时的 base output 总额。
        // 没有 prior 也没有 baseTxHex 时让用户手填（create 的极简 fallback）。
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
    if (anyBusy) {
      pushLog({ at: Date.now(), stage: "busy_rejected", method: "feepool.commit" }, "warn");
      return;
    }
    const prepareResult = feepoolPrepare.result;
    if (!prepareResult) {
      setFeepoolCommit((prev) => ({ ...prev, status: "error", error: "No feepool.prepare result to commit. Run feepool.prepare first." }));
      return;
    }
    if (!testWalletState.wallet) {
      setFeepoolCommit((prev) => ({ ...prev, status: "error", error: "Test wallet is required for local counter-signing. Generate or import one in the Tool tab." }));
      return;
    }
    // 防错 1：测试钱包公钥必须等于 prepare 阶段的 counterparty 公钥。
    // 否则签名会与 request 字段的角色不一致 → Keymaster 验签一定失败且对调用方不透明。
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
      commitParams = buildFeepoolCommitParams({
        prepare: prepareResult,
        counterpartyPrivateKeyHex: testWalletState.wallet.privateKeyHex,
        counterpartyPublicKeyHex: testWalletState.wallet.publicKeyHex,
        keymasterPublicKeyHex: feepoolCommit.keymasterPublicKeyHex,
        draftTotalAmount: draftTotal
      });
    } catch (error) {
      setFeepoolCommit((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : "Failed to build feepool.commit params"
      }));
      return;
    }

    // 把签名 hex 同步显示在 UI 上（方便排查）。
    setFeepoolCommit((prev) => ({
      ...prev,
      counterpartySignatures: commitParams.counterpartySignatures
        .map((s) => bytesToHex(new Uint8Array(s.bytes)))
        .join("\n"),
      closeCounterpartySignatures: commitParams.closeCounterpartySignatures
        ? commitParams.closeCounterpartySignatures.map((s) => bytesToHex(new Uint8Array(s.bytes))).join("\n")
        : prev.closeCounterpartySignatures
    }));

    setFeepoolCommit((prev) => ({ ...prev, status: "loading", error: "", request: commitParams, response: null }));
    setAnyBusy(true);
    try {
      const response = await runProtocolRequest("feepool.commit", commitParams);
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
    if (!refund.recipientAddress || refund.recipientAddress.length === 0) {
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
      // 自动刷新 UTXO（不阻塞）。
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

  function autoFillCommitFromPrepare() {
    const prepareResult = feepoolPrepare.result;
    if (!prepareResult) return;
    const projected = projectFeepoolCommitInput(prepareResult);
    let draftTotal = feepoolCommit.draftTotalAmount;
    if (prepareResult.priorPoolRecord?.totalAmount) {
      draftTotal = String(prepareResult.priorPoolRecord.totalAmount);
    }
    setFeepoolCommit((prev) => ({
      ...prev,
      operationId: projected.operationId,
      counterpartyPublicKeyHex: projected.counterpartyPublicKeyHex,
      action: prepareResult.action,
      draftTotalAmount: draftTotal
    }));
  }

  const tabItems: Array<{
    id: TabId;
    label: string;
    hint: string;
    status: SectionStatus;
  }> = [
    { id: "identity", label: "identity.get", hint: "身份断言", status: identity.status },
    { id: "intent", label: "intent.sign", hint: "内容签名", status: intent.status },
    { id: "encrypt", label: "cipher.encrypt", hint: "内容加密", status: encrypt.status },
    { id: "decrypt", label: "cipher.decrypt", hint: "内容解密", status: decrypt.status },
    { id: "p2pkh", label: "p2pkh.transfer", hint: "主网 P2PKH 转账", status: p2pkh.status },
    {
      id: "feepool-prepare",
      label: "feepool.prepare",
      hint: "费用池准备",
      status: feepoolPrepare.status
    },
    {
      id: "feepool-commit",
      label: "feepool.commit",
      hint: "费用池提交",
      status: feepoolCommit.status
    },
    {
      id: "tool",
      label: "test wallet",
      hint: "测试钱包 + 手动回款",
      status: toolBusy ? "loading" : testWalletState.utxoStatus
    }
  ];

  function effectiveBusyFor(targetStatus: SectionStatus): boolean {
    return anyBusy || toolBusy || targetStatus === "loading";
  }

  function renderActiveTab() {
    switch (activeTab) {
      case "identity":
        return (
          <ProtocolSection
            title="identity.get"
            subtitle="请求身份断言，自动使用当前页面 origin 作为 aud。"
            status={identity.status}
            onSubmit={submitIdentity}
            submitLabel="Run identity.get"
            error={identity.error}
            disabled={effectiveBusyFor(identity.status)}
          >
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
                <span>claims</span>
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
            <ResultPanel title="Request preview" value={identity.request} />
            <ResultPanel title="Raw result" value={identity.response} />
            <ResultPanel title="Decoded envelope" value={identity.inspection?.decodedEnvelope} pretty={identity.inspection?.decodedEnvelopePretty} />
            <ResultGrid
              items={[
                { label: "subject.publicKey", value: identity.inspection?.publicKeyHex ?? "n/a" },
                { label: "signature", value: identity.inspection?.signatureHex ?? "n/a" },
                {
                  label: "local verify",
                  value: identity.inspection ? (identity.inspection.ok ? "pass" : "fail") : "n/a"
                },
                { label: "claims projection", value: identity.inspection?.claimsProjection ?? "n/a" },
                {
                  label: "last keymaster main address",
                  value: identity.lastKeymasterAddress || "n/a"
                }
              ]}
            />
            <ResultPanel title="resolvedClaims" value={identity.result?.resolvedClaims} />
          </ProtocolSection>
        );
      case "intent":
        return (
          <ProtocolSection
            title="intent.sign"
            subtitle="签名二进制内容，结果里展示 contentSha256 与本地验签。"
            status={intent.status}
            onSubmit={submitIntent}
            submitLabel="Run intent.sign"
            error={intent.error}
            disabled={effectiveBusyFor(intent.status)}
          >
            <div className="form-grid">
              <label className="field field-wide">
                <span>text</span>
                <textarea value={intent.text} onChange={(e) => setIntent((prev) => ({ ...prev, text: e.target.value }))} rows={3} />
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
            <ResultPanel title="Request preview" value={intent.request} />
            <ResultPanel title="Raw result" value={intent.response} />
            <ResultPanel title="Decoded envelope" value={intent.inspection?.decodedEnvelope} pretty={intent.inspection?.decodedEnvelopePretty} />
            <ResultGrid
              items={[
                { label: "contentSha256 (local)", value: intent.inspection?.computedContentSha256Hex ?? "n/a" },
                { label: "contentSha256 (envelope)", value: intent.inspection?.envelopeContentSha256Hex ?? "n/a" },
                { label: "local verify", value: intent.inspection ? (intent.inspection.ok ? "pass" : "fail") : "n/a" },
                { label: "subject.publicKey", value: intent.inspection?.publicKeyHex ?? "n/a" }
              ]}
            />
          </ProtocolSection>
        );
      case "encrypt":
        return (
          <ProtocolSection
            title="cipher.encrypt"
            subtitle="保存 nonce + cipherbytes，支持一键回填到解密区。"
            status={encrypt.status}
            onSubmit={submitEncrypt}
            submitLabel="Run cipher.encrypt"
            error={encrypt.error}
            disabled={effectiveBusyFor(encrypt.status)}
            extraAction={
              <button type="button" className="secondary-button" onClick={copyEncryptToDecrypt} disabled={!encrypt.result}>
                Fill decrypt inputs
              </button>
            }
          >
            <div className="form-grid">
              <label className="field field-wide">
                <span>text</span>
                <textarea value={encrypt.text} onChange={(e) => setEncrypt((prev) => ({ ...prev, text: e.target.value }))} rows={3} />
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
            <ResultPanel title="Request preview" value={encrypt.request} />
            <ResultPanel title="Raw result" value={encrypt.response} />
            <ResultGrid
              items={[
                {
                  label: "nonce hex",
                  value: encrypt.result ? bytesToHex(new Uint8Array(encrypt.result.nonce.bytes)) : "n/a"
                },
                {
                  label: "nonce base64",
                  value: encrypt.result ? bytesToBase64(new Uint8Array(encrypt.result.nonce.bytes)) : "n/a"
                },
                {
                  label: "cipherbytes hex",
                  value: encrypt.result ? bytesToHex(new Uint8Array(encrypt.result.cipherbytes.bytes)) : "n/a"
                },
                {
                  label: "cipherbytes base64",
                  value: encrypt.result ? bytesToBase64(new Uint8Array(encrypt.result.cipherbytes.bytes)) : "n/a"
                }
              ]}
            />
          </ProtocolSection>
        );
      case "decrypt":
        return (
          <ProtocolSection
            title="cipher.decrypt"
            subtitle="支持手工粘贴 nonce / cipherbytes，也可直接回填上一轮加密结果。"
            status={decrypt.status}
            onSubmit={submitDecrypt}
            submitLabel="Run cipher.decrypt"
            error={decrypt.error}
            disabled={effectiveBusyFor(decrypt.status)}
          >
            <div className="form-grid">
              <label className="field field-wide">
                <span>text</span>
                <textarea value={decrypt.text} onChange={(e) => setDecrypt((prev) => ({ ...prev, text: e.target.value }))} rows={3} />
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
            <ResultPanel title="Request preview" value={decrypt.request} />
            <ResultPanel title="Raw result" value={decrypt.response} />
            <ResultGrid
              items={[
                { label: "contentType", value: decrypt.result?.contentType ?? "n/a" },
                {
                  label: "content hex",
                  value: decrypt.result ? bytesToHex(new Uint8Array(decrypt.result.content.bytes)) : "n/a"
                },
                {
                  label: "content text",
                  value: decrypt.result ? safeBytesToText(new Uint8Array(decrypt.result.content.bytes)) : "n/a"
                }
              ]}
            />
          </ProtocolSection>
        );
      case "p2pkh":
        return (
          <ProtocolSection
            title="p2pkh.transfer"
            subtitle="主网 P2PKH 转账。收款地址默认填入测试钱包地址。"
            status={p2pkh.status}
            onSubmit={submitP2pkh}
            submitLabel="Run p2pkh.transfer"
            error={p2pkh.error}
            disabled={effectiveBusyFor(p2pkh.status)}
          >
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
            <ResultPanel title="Request preview" value={p2pkh.request} />
            <ResultPanel title="Raw result" value={p2pkh.response} />
            <ResultGrid
              items={[
                { label: "txid", value: p2pkh.result?.txid ?? "n/a" },
                {
                  label: "rawTxHex (head)",
                  value: p2pkh.result ? truncateHex(p2pkh.result.rawTxHex, 64) : "n/a"
                },
                { label: "feeSatoshis", value: p2pkh.result?.feeSatoshis ?? "n/a" }
              ]}
            />
          </ProtocolSection>
        );
      case "feepool-prepare":
        return (
          <ProtocolSection
            title="feepool.prepare"
            subtitle="提交对端公钥 + 本次金额。action（create / spend / close_and_recreate）由 Keymaster 单边决定。"
            status={feepoolPrepare.status}
            onSubmit={submitFeepoolPrepare}
            submitLabel="Run feepool.prepare"
            error={feepoolPrepare.error}
            disabled={effectiveBusyFor(feepoolPrepare.status)}
            extraAction={
              <button type="button" className="secondary-button" onClick={autoFillCommitFromPrepare} disabled={!feepoolPrepare.result}>
                Fill commit inputs
              </button>
            }
          >
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
            <ResultPanel title="Request preview" value={feepoolPrepare.request} />
            <ResultPanel title="Raw result" value={feepoolPrepare.response} />
            <ResultGrid
              items={[
                { label: "operationId", value: feepoolPrepare.result?.operationId ?? "n/a" },
                { label: "action", value: feepoolPrepare.result ? actionLabel(feepoolPrepare.result.action) : "n/a" },
                {
                  label: "draftSpendTxHex (head)",
                  value: feepoolPrepare.result ? truncateHex(feepoolPrepare.result.draftSpendTxHex, 64) : "n/a"
                },
                {
                  label: "baseTxHex",
                  value: feepoolPrepare.result?.baseTxHex ? truncateHex(feepoolPrepare.result.baseTxHex, 64) : "n/a"
                },
                {
                  label: "priorPool.totalAmount",
                  value: feepoolPrepare.result?.priorPoolRecord?.totalAmount ?? "n/a"
                }
              ]}
            />
            <ResultPanel title="prepare result (full)" value={feepoolPrepare.result} />
          </ProtocolSection>
        );
      case "feepool-commit":
        return (
          <ProtocolSection
            title="feepool.commit"
            subtitle="消费 feepool.prepare 的 operationId + counterparty sigs。测试钱包私钥必须在 Tool 区准备好。"
            status={feepoolCommit.status}
            onSubmit={submitFeepoolCommit}
            submitLabel="Run feepool.commit"
            error={feepoolCommit.error}
            disabled={effectiveBusyFor(feepoolCommit.status)}
          >
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
            <ResultPanel title="Request preview" value={feepoolCommit.request} />
            <ResultPanel title="Raw result" value={feepoolCommit.response} />
            <ResultGrid
              items={[
                { label: "result.operationId", value: resultFromFeepoolCommit(feepoolCommit.response, "operationId") ?? "n/a" },
                {
                  label: "result.action",
                  value: resultFromFeepoolCommit(feepoolCommit.response, "action") ?? "n/a"
                },
                {
                  label: "result.draftTxid",
                  value: resultFromFeepoolCommit(feepoolCommit.response, "draftTxid") ?? "n/a"
                },
                {
                  label: "result.draftTxHex (head)",
                  value: resultFromFeepoolCommit(feepoolCommit.response, "draftTxHexHead") ?? "n/a"
                }
              ]}
            />
          </ProtocolSection>
        );
      case "tool":
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
                <button type="button" className="secondary-button" onClick={forgetTestWallet} disabled={!testWalletState.wallet || anyBusy || toolBusy}>
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
                      ? new Date(testWalletState.utxoRefreshedAt).toLocaleTimeString()
                      : "n/a"
                  },
                  {
                    label: "utxoCount",
                    value: testWalletState.utxos.length
                  },
                  {
                    label: "totalValue",
                    value: testWalletState.utxos.reduce((sum, u) => sum + u.value, 0)
                  }
                ]}
              />
              <ResultPanel title="UTXO list" value={testWalletState.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }))} />
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
                  {
                    label: "rawTxHex (head)",
                    value: refund.result ? truncateHex(refund.result.rawTxHex, 64) : "n/a"
                  },
                  { label: "feeSatoshis", value: refund.result?.feeSatoshis ?? "n/a" }
                ]}
              />
            </ProtocolSection>
          </div>
        );
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <div className="hero-topline">
            <p className="eyebrow">Keymaster Connect V1 demo</p>
            <ConnectionIndicator state={connectionState} />
          </div>
          <h1>外部调用方协议验证台</h1>
          <p className="hero-text">
            验证 Keymaster Connect V1 的 7 个方法：identity.get / intent.sign / cipher.encrypt / cipher.decrypt / p2pkh.transfer / feepool.prepare / feepool.commit。附带测试钱包与手动回款工具。
          </p>
        </div>
        <div className="hero-panel">
          <div className="hero-row">
            <span>Current origin</span>
            <strong>{currentOrigin || "n/a"}</strong>
          </div>
          <div className="hero-row">
            <span>Target origin</span>
            <strong>{normalizedTargetOrigin || "invalid"}</strong>
          </div>
          <div className="hero-row">
            <span>Popup</span>
            <strong>
              {popupWidth} × {popupHeight}
            </strong>
          </div>
          <div className="hero-row">
            <span>Timeouts</span>
            <strong>
              ready {readyTimeoutMs} ms / result {resultTimeoutMs} ms
            </strong>
          </div>
        </div>
      </header>

      <section className="config-strip">
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
      </section>

      <div className="workspace-layout">
        <div className="tab-stage">
          <section className="tab-strip" aria-label="Protocol tests">
            {tabItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`tab-button ${activeTab === item.id ? "is-active" : ""}`}
                onClick={() => setActiveTab(item.id)}
              >
                <span className="tab-button__label">{item.label}</span>
                <span className={`status-pill status-${item.status}`}>{statusText(item.status)}</span>
                <span className="tab-button__hint">{item.hint}</span>
              </button>
            ))}
          </section>

          <main className="workspace">{renderActiveTab()}</main>
        </div>

        <section className="log-rail">
          <div className="log-head">
            <div>
              <h2>Protocol log</h2>
              <p>只保留最近 60 条事件。</p>
            </div>
            <p className="log-active-tab">Active tab: {tabItems.find((item) => item.id === activeTab)?.label}</p>
          </div>
          <div className="log-list">
            {logs.length === 0 ? (
              <p className="log-empty">No protocol events yet.</p>
            ) : (
              logs.map((entry, index) => (
                <article className={`log-entry level-${entry.level}`} key={`${entry.at}-${entry.stage}-${index}`}>
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
      </div>
    </div>
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

function ConnectionIndicator({ state }: { state: DemoConnectionState }) {
  const lit = state === "connected";
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