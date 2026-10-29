import { useEffect, useRef, useState } from "react";
import {
  KeymasterConnectClient, type KeymasterConnectState, type MethodParams,
  type IdentityGetResult, type IntentSignResult, type PaymentPayParams, type CipherEncryptResult,
} from "keymaster-connect";
import { readAppIdentityProof } from "./lib/appIdentityProof";
import { makeBinaryField } from "./lib/binary";
import { inspectIdentityResult, inspectIntentResult } from "./lib/verify";
import { readSmallObjectFile, sanitizeStorageValue } from "./lib/storageUi";
import {
  WORKBENCHES, createExamples, editorJson, parseEditor, attachAppProof, exactOrigin,
  readStartup, consumedLaunchUrl, readPayment, savePayment, assertPaymentContext,
  resultBinary, type DemoMethod, type Workbench,
} from "./lib/sdkDemo";
import { TestWalletPanel } from "./TestWalletPanel";

/** 观察区不展示一次性启动令牌和完整发行人签名，也不保存 transport binding。 */
function display(value: unknown): string {
  return JSON.stringify(sanitizeStorageValue(value), (key, entry) =>
    ["launchToken", "signature", "bindingId", "authorizationId"].includes(key) ? "[redacted]" : entry, 2);
}

/** 错误保持 SDK 的英文信息，不把失败或付款 unknown 解释成成功。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 下载只消费完整返回对象，预览摘要不作为文件内容。 */
function download(value: unknown): void {
  const content = resultBinary(value);
  if (!content) return;
  const result = value as { path?: string; contentType?: string };
  const url = URL.createObjectURL(new Blob([content.bytes], { type: result.contentType || content.mime || "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = result.path?.split("/").pop() || "download.bin";
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Demo 只负责业务参数和结果观察；窗口、绑定、事件校验与连接生命周期全部交给官方 SDK。 */
export default function App() {
  const [startup] = useState(() => readStartup(window.location.search));
  const [proof] = useState(() => {
    try { return { value: readAppIdentityProof(), error: "" }; }
    catch (error) { return { value: null, error: errorText(error) }; }
  });
  const [originInput, setOriginInput] = useState(startup.targetOrigin || "https://keymaster.cc");
  const [targetOrigin, setTargetOrigin] = useState(startup.targetOrigin || "https://keymaster.cc");
  const [workbench, setWorkbench] = useState<Workbench>("Connect");
  const [method, setMethod] = useState<DemoMethod>(startup.mode === "appView" ? "connect.launch" : "connect.login");
  const examples = () => createExamples(window.location.origin);
  const [editor, setEditor] = useState(() => editorJson(startup.mode === "appView"
    ? { launchToken: startup.launchToken || "" } : examples()["connect.login"]));
  const [state, setState] = useState<KeymasterConnectState>("idle");
  const [identity, setIdentity] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(startup.error || "");
  const [observation, setObservation] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [result, setResult] = useState<unknown>(null);
  const [inspection, setInspection] = useState("");
  const client = useRef<KeymasterConnectClient | null>(null);
  const abort = useRef<AbortController | null>(null);
  const launchConsumed = useRef(false);
  const running = useRef(false);

  useEffect(() => {
    if (startup.error) return;
    const current = new KeymasterConnectClient({
      targetOrigin, mode: startup.mode, popupPath: "/",
      onStateChange: next => { if (client.current === current) { setState(next); setIdentity(current.networkIdentity); } },
      onEvent: event => { if (client.current === current) setEvents(previous => [display(event), ...previous].slice(0, 60)); },
    });
    client.current = current; setIdentity(null); setState("idle"); setEvents([]); setResult(null); setObservation(""); setInspection("");
    return () => { client.current = null; abort.current?.abort(); current.close(); };
  }, [targetOrigin, startup]);

  /** 切换方法只生成官方类型约束的业务样例，不自行构造 wire 请求。 */
  function choose(next: DemoMethod): void {
    setMethod(next); setResult(null); setInspection(""); setError("");
    setEditor(editorJson(next === "connect.launch" ? { launchToken: launchConsumed.current ? "" : startup.launchToken || "" } : examples()[next]));
  }

  /** 付款在发送前保存原申请；重交必须使用原 ID 和原参数，不自动重试。 */
  async function execute(selected: DemoMethod = method, supplied?: Record<string, unknown>): Promise<void> {
    const current = client.current;
    if (!current || running.current) return;
    running.current = true; setBusy(true); setError(""); setInspection(""); setResult(null); setObservation("");
    const controller = new AbortController(); abort.current = controller;
    try {
      if (selected === "connect.launch" && launchConsumed.current) throw new Error("Launch token already consumed; relaunch from Keymaster");
      const params = attachAppProof(selected, supplied ?? parseEditor(editor), proof.value);
      if (selected === "payment.pay") {
        const networkIdentity = current.networkIdentity;
        if (!networkIdentity) throw new Error("Login, resume or launch before making a payment");
        const payment = params as unknown as PaymentPayParams;
        if (!payment.clientRequestId || !payment.channelId) throw new Error("Payment requires channelId and clientRequestId");
        const previous = readPayment(localStorage, payment.clientRequestId);
        if (previous?.params.clientRequestId === payment.clientRequestId) {
          assertPaymentContext(previous, targetOrigin, networkIdentity);
          if (JSON.stringify(previous.params) !== JSON.stringify(payment)) throw new Error("Original payment parameters must not change when reusing clientRequestId");
        }
        savePayment(localStorage, { targetOrigin, networkIdentity: { ...networkIdentity }, params: payment });
      }
      if (selected === "payment.status") {
        const saved = readPayment(localStorage, String(params.clientRequestId || ""));
        if (!saved || params.clientRequestId !== saved.params.clientRequestId) throw new Error("Restore the original payment before querying status");
        assertPaymentContext(saved, targetOrigin, current.networkIdentity);
      }
      setObservation(display({ method: selected, params }));
      // JSON 编辑器是动态输入边界；不在 Demo 镜像官方 schema，最终业务校验由钱包执行。
      const response = await current.request(selected, params as MethodParams<typeof selected>, { signal: controller.signal });
      if (client.current !== current) return;
      setResult(response); setIdentity(current.networkIdentity);
      setObservation(display({ method: selected, params, result: response }));
      if (selected === "connect.launch") {
        launchConsumed.current = true;
        history.replaceState(null, "", consumedLaunchUrl(location.href)); setEditor("{}");
      }
      if (selected === "identity.get") setInspection(display(inspectIdentityResult(response as IdentityGetResult)));
      if (selected === "intent.sign") {
        const content = params.content as { bytes: ArrayBuffer };
        setInspection(display(inspectIntentResult(response as IntentSignResult, new Uint8Array(content.bytes))));
      }
    } catch (failure) {
      if (client.current === current) { setError(errorText(failure)); setIdentity(current.networkIdentity); }
    } finally {
      running.current = false; abort.current = null; setBusy(false);
    }
  }

  /** 原申请查询与重交始终从持久记录读取，不消费可编辑表单。 */
  function restorePayment(resubmit: boolean): void {
    try {
      const saved = readPayment(localStorage);
      if (!saved) throw new Error("No saved payment available");
      assertPaymentContext(saved, targetOrigin, client.current?.networkIdentity || null);
      const next = resubmit ? "payment.pay" : "payment.status";
      const params = resubmit ? { ...saved.params } : { clientRequestId: saved.params.clientRequestId };
      setMethod(next); setEditor(editorJson(params)); void execute(next, params);
    } catch (failure) { setError(errorText(failure)); }
  }

  /** 读取文件后仍停在编辑器，绝不因选文件就触发请求。 */
  async function loadFile(file?: File): Promise<void> {
    if (!file || running.current) return;
    running.current = true; setBusy(true); setError("");
    try {
      const params = parseEditor(editor);
      params.content = makeBinaryField(new Uint8Array(await readSmallObjectFile(file)), file.type || undefined);
      if ("contentType" in params) params.contentType = file.type || "application/octet-stream";
      setEditor(editorJson(params));
    } catch (failure) { setError(errorText(failure)); }
    finally { running.current = false; setBusy(false); }
  }

  return <div className="app-shell">
    <header className="app-header"><div><h1>Keymaster Connect Demo</h1><p>官方 SDK · Connect v1 · {startup.mode === "popup" ? "App 主动打开完整钱包" : "钱包启动 App"}</p></div><strong data-testid="connection-state">{state}</strong></header>
    <section className="app-mainbody" style={{ padding: 18 }}>
      <p>当前钱包身份（只读，由 Keymaster 返回）</p><pre data-testid="wallet-identity">{display(identity)}</pre>
      {proof.error && <p role="alert">{proof.error}</p>}
      {startup.mode === "appView" && <p>仅连接启动方 Keymaster 钱包窗口，不另开钱包。启动令牌只在成功前可用。</p>}
    </section>
    <div className="workbench-layout">
      <nav className="workbench-nav" style={{ padding: 14 }} aria-label="工作台">
        {[...Object.keys(WORKBENCHES), "Test Wallet"].map(name => <button key={name} disabled={busy} aria-pressed={workbench === name} onClick={() => {
          const next = name as Workbench; setWorkbench(next);
          if (next !== "Test Wallet") choose(WORKBENCHES[next][0]);
        }}>{name}</button>)}
      </nav>
      <main className="workbench-main" style={{ padding: 18 }}>
        {/* 测试私钥只随页面生命周期存在；切换工作台不丢失，也不写持久存储。 */}
        <div hidden={workbench !== "Test Wallet"}><TestWalletPanel /></div>
        {workbench !== "Test Wallet" && <>
          <h2>{workbench}</h2>
          {workbench === "Connect" && <>
            <label>Keymaster Target Origin<input aria-label="Keymaster Target Origin" value={originInput} disabled={startup.mode === "appView" || busy} onChange={event => setOriginInput(event.target.value)} /></label>
            {startup.mode === "popup" && <button disabled={busy} onClick={() => {
              try { setTargetOrigin(exactOrigin(originInput)); setError(""); } catch (failure) { setError(errorText(failure)); }
            }}>应用地址</button>}
            <button disabled={busy} onClick={() => { client.current?.close(); setIdentity(null); setResult(null); }}>暂停连接</button>
            <button disabled={busy} onClick={() => { choose("connect.resume"); void execute("connect.resume", {}); }}>继续连接</button>
            {String(state) === "paused" ? <p role="status">连接已暂停，原授权保留。同一钱包就绪后可自动恢复；钱包已关闭时，请点击「继续连接」。旧业务请求不会自动重放。</p> : null}
          </>}
          <label>方法<select aria-label="方法" value={method} disabled={busy} onChange={event => choose(event.target.value as DemoMethod)}>
            {WORKBENCHES[workbench].map(name => <option key={name}>{name}</option>)}
          </select></label>
          <label>业务参数 JSON<textarea aria-label="业务参数 JSON" rows={18} value={editor} disabled={busy} onChange={event => setEditor(event.target.value)} /></label>
          {["intent.sign", "cipher.encrypt", "storage.put"].includes(method) && <label>读取文件到 content<input aria-label="读取文件到 content" type="file" disabled={busy} onChange={event => void loadFile(event.target.files?.[0])} /></label>}
          <button disabled={busy || !!startup.error} onClick={() => void execute()}>执行请求</button>
          <button disabled={!busy} onClick={() => abort.current?.abort()}>取消请求</button>
          {workbench === "Payment" && <>
            <p>先注册渠道，再将返回的 channelId 填入付款申请。只有 accepted / already_known 表示已接收；unknown 等状态必须查询，不自动重试或更换 ID。快捷按钮操作最近一笔；此前原申请按 ID 保留，可在参数中填原 ID 查询或填完整原申请重交。</p>
            <button disabled={busy} onClick={() => restorePayment(false)}>查询原付款</button>
            <button disabled={busy} onClick={() => restorePayment(true)}>重交原付款（原 ID）</button>
          </>}
          {method === "cipher.encrypt" && !!result && <button disabled={busy} onClick={() => {
            // 直接保留完整密文，不从观察区的有界预览重建数据。
            const encrypted = result as CipherEncryptResult;
            choose("cipher.decrypt");
            setEditor(editorJson({ text: "解密演示内容", nonce: encrypted.nonce, cipherbytes: encrypted.cipherbytes }));
          }}>用此结果填入解密参数</button>}
          {resultBinary(result) && <button onClick={() => download(result)}>下载完整结果</button>}
        </>}
        {error && <p role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
      </main>
      <aside className="workbench-observer" style={{ padding: 18, minWidth: 0 }}>
        <h2>请求 / 结果</h2><pre data-testid="observation">{observation}</pre>
        {inspection && <><h3>本地验签</h3><pre>{inspection}</pre></>}
        <h3>事件（最近 60 条）</h3><pre data-testid="events">{events.join("\n")}</pre>
      </aside>
    </div>
  </div>;
}
