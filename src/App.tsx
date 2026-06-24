import { useEffect, useMemo, useState } from "react";
import { bytesToBase64, bytesToHex, bytesToText, ensureTextLines, parseBinaryInput, textToBytes } from "./lib/encoding";
import { makeBinaryField } from "./lib/binary";
import { toDisplayValue } from "./lib/cbor";
import {
  inspectIdentityResult,
  inspectIntentResult,
} from "./lib/verify";
import {
  normalizeOrigin,
  ProtocolTransportError,
  runPopupProtocolRequest,
  type ProtocolLogEvent
} from "./lib/connectClient";
import type {
  CipherDecryptResult,
  CipherEncryptResult,
  IdentityGetResult,
  IntentSignResult,
  ProtocolErrorCode,
  ProtocolRequestMessage,
  ProtocolResultMessage
} from "./lib/protocol";
import type { ReactNode } from "react";

type SectionStatus = "idle" | "loading" | "success" | "error";
type TabId = "identity" | "intent" | "encrypt" | "decrypt";

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

const DEFAULT_READY_TIMEOUT = 10_000;
const DEFAULT_RESULT_TIMEOUT = 60_000;
const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 760;

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
    claimsText: "key.label\nprofile.nickname\nprofile.avatar.image",
    ttlSeconds: 300,
    status: "idle",
    error: "",
    request: null,
    response: null,
    result: null,
    inspection: null
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
  const [activeTab, setActiveTab] = useState<TabId>("identity");

  const normalizedTargetOrigin = useMemo(() => {
    try {
      return normalizeOrigin(targetOrigin);
    } catch {
      return "";
    }
  }, [targetOrigin]);

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

  async function submitIdentity() {
    if (!normalizedTargetOrigin) {
      setIdentity((prev) => ({ ...prev, status: "error", error: "Target origin is not a valid origin." }));
      return;
    }
    const claims = ensureTextLines(identity.claimsText);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + Number(identity.ttlSeconds || 0);
    const request: ProtocolRequestMessage<"identity.get"> = {
      v: 1,
      type: "request",
      id: makeRequestId(),
      method: "identity.get",
      params: {
        aud: currentOrigin,
        iat,
        exp,
        text: identity.text,
        claims
      }
    };

    console.info("[keymaster-connect-demo] submit identity.get", {
      requestId: request.id,
      targetOrigin,
      currentOrigin,
      params: {
        aud: request.params.aud,
        iat: request.params.iat,
        exp: request.params.exp,
        claims: request.params.claims
      }
    });
    setIdentity((prev) => ({ ...prev, status: "loading", error: "", request, response: null, result: null, inspection: null }));
    pushLog({ at: Date.now(), stage: "waiting_ready", method: "identity.get", requestId: request.id, detail: request }, "info");

    try {
      const response = await runPopupProtocolRequest({
        targetOrigin,
        popupWidth,
        popupHeight,
        readyTimeoutMs,
        resultTimeoutMs,
        request,
        onLog: pushLog
      });
      setIdentity((prev) => ({ ...prev, status: response.ok ? "success" : "error", response }));
      if (response.ok) {
        const result = response.result as IdentityGetResult;
        setIdentity((prev) => ({
          ...prev,
          status: "success",
          response,
          result,
          inspection: inspectIdentityResult(result)
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
      pushLog(
        { at: Date.now(), stage: "timeout", method: "identity.get", requestId: request.id, detail: error },
        "error"
      );
    }
  }

  async function submitIntent() {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + Number(intent.ttlSeconds || 0);
    const request: ProtocolRequestMessage<"intent.sign"> = {
      v: 1,
      type: "request",
      id: makeRequestId(),
      method: "intent.sign",
      params: {
        aud: currentOrigin,
        iat,
        exp,
        text: intent.text,
        contentType: intent.contentType,
        content: makeBinaryField(textToBytes(intent.contentText), intent.contentType)
      }
    };

    console.info("[keymaster-connect-demo] submit intent.sign", {
      requestId: request.id,
      targetOrigin,
      currentOrigin,
      params: {
        aud: request.params.aud,
        iat: request.params.iat,
        exp: request.params.exp,
        contentType: request.params.contentType,
        contentBytes: request.params.content.bytes.byteLength
      }
    });
    setIntent((prev) => ({ ...prev, status: "loading", error: "", request, response: null, result: null, inspection: null }));

    try {
      const response = await runPopupProtocolRequest({
        targetOrigin,
        popupWidth,
        popupHeight,
        readyTimeoutMs,
        resultTimeoutMs,
        request,
        onLog: pushLog
      });
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
      pushLog(
        { at: Date.now(), stage: "timeout", method: "intent.sign", requestId: request.id, detail: error },
        "error"
      );
    }
  }

  async function submitEncrypt() {
    const request: ProtocolRequestMessage<"cipher.encrypt"> = {
      v: 1,
      type: "request",
      id: makeRequestId(),
      method: "cipher.encrypt",
      params: {
        text: encrypt.text,
        contentType: encrypt.contentType,
        content: makeBinaryField(textToBytes(encrypt.contentText), encrypt.contentType)
      }
    };

    console.info("[keymaster-connect-demo] submit cipher.encrypt", {
      requestId: request.id,
      targetOrigin,
      currentOrigin,
      params: {
        contentType: request.params.contentType,
        contentBytes: request.params.content.bytes.byteLength
      }
    });
    setEncrypt((prev) => ({ ...prev, status: "loading", error: "", request, response: null, result: null }));

    try {
      const response = await runPopupProtocolRequest({
        targetOrigin,
        popupWidth,
        popupHeight,
        readyTimeoutMs,
        resultTimeoutMs,
        request,
        onLog: pushLog
      });
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
      pushLog(
        { at: Date.now(), stage: "timeout", method: "cipher.encrypt", requestId: request.id, detail: error },
        "error"
      );
    }
  }

  async function submitDecrypt() {
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

    const request: ProtocolRequestMessage<"cipher.decrypt"> = {
      v: 1,
      type: "request",
      id: makeRequestId(),
      method: "cipher.decrypt",
      params: {
        text: decrypt.text,
        nonce: makeBinaryField(nonce),
        cipherbytes: makeBinaryField(cipherbytes)
      }
    };

    console.info("[keymaster-connect-demo] submit cipher.decrypt", {
      requestId: request.id,
      targetOrigin,
      currentOrigin,
      params: {
        nonceBytes: request.params.nonce.bytes.byteLength,
        cipherbytesBytes: request.params.cipherbytes.bytes.byteLength
      }
    });
    setDecrypt((prev) => ({ ...prev, status: "loading", error: "", request, response: null, result: null }));

    try {
      const response = await runPopupProtocolRequest({
        targetOrigin,
        popupWidth,
        popupHeight,
        readyTimeoutMs,
        resultTimeoutMs,
        request,
        onLog: pushLog
      });
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
      pushLog(
        { at: Date.now(), stage: "timeout", method: "cipher.decrypt", requestId: request.id, detail: error },
        "error"
      );
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

  const tabItems: Array<{
    id: TabId;
    label: string;
    hint: string;
    status: SectionStatus;
  }> = [
    { id: "identity", label: "identity.get", hint: "身份断言", status: identity.status },
    { id: "intent", label: "intent.sign", hint: "内容签名", status: intent.status },
    { id: "encrypt", label: "cipher.encrypt", hint: "内容加密", status: encrypt.status },
    { id: "decrypt", label: "cipher.decrypt", hint: "内容解密", status: decrypt.status }
  ];

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
                { label: "claims projection", value: identity.inspection?.claimsProjection ?? "n/a" }
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
          >
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
            extraAction={
              <button type="button" className="secondary-button" onClick={copyEncryptToDecrypt} disabled={!encrypt.result}>
                Fill decrypt inputs
              </button>
            }
          >
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
          >
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
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Keymaster Connect V1 demo</p>
          <h1>外部调用方协议验证台</h1>
          <p className="hero-text">
            只验证 popup + postMessage + ready/request/result，直接暴露 origin、BinaryField、签名和站点绑定结果。
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

      <div className="workspace-layout">
        <main className="workspace">{renderActiveTab()}</main>

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
  onSubmit: () => Promise<void>;
  children: ReactNode;
  extraAction?: ReactNode;
}) {
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
              void props.onSubmit();
            }}
            disabled={props.status === "loading"}
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

function makeRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
