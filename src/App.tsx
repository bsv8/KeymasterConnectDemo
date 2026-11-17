import { useEffect, useRef, useState } from "react";
import {
  KeymasterConnectClient, type KeymasterConnectState, type MethodParams,
  type IdentityGetResult, type IntentSignResult, type PaymentPayParams, type CipherEncryptResult,
} from "keymaster-connect";
import { makeBinaryField } from "./lib/binary";
import { inspectIdentityResult, inspectIntentResult } from "./lib/verify";
import { readSmallObjectFile, sanitizeBinaryValue } from "./lib/binaryUi";
import {
  WORKBENCHES, createExamples, editorJson, parseEditor, attachAppProof, exactOrigin, resolveWalletPresets,
  readStartup, consumedLaunchUrl, readPayment, savePayment, assertPaymentContext,
  resultBinary, type DemoMethod, type Workbench,
} from "./lib/sdkDemo";
import "./embedded.css";

/** 观察区不展示一次性启动令牌和完整发行人签名，也不保存 transport binding。 */
function display(value: unknown): string {
  return JSON.stringify(sanitizeBinaryValue(value), (key, entry) =>
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

/**
 * Demo 只负责业务参数和结果观察；窗口、绑定、事件校验与连接生命周期全部交给官方 SDK。
 *
 * 单一 SDK client 由 App 持有，工作台切换不重建；只有钱包目标地址变化才重建。
 * 登录与业务分离：未登录只显示登录界面、连接诊断及错误；登录成功进入 Identity。
 */
export default function App() {
  const [startup] = useState(() => readStartup(window.location.search));
  const embedded = startup.mode === "iframe";
  const launched = startup.mode !== "popup";
  useEffect(() => {
    if (embedded) document.documentElement.dataset.connectDisplay = "iframe";
    return () => { delete document.documentElement.dataset.connectDisplay; };
  }, [embedded]);

  const [presets] = useState(() => resolveWalletPresets());
  const initialTarget = startup.targetOrigin || presets[0].value;
  const [targetOrigin, setTargetOrigin] = useState(initialTarget);
  /** 登录三选一：线上 / 本地 / 自定义；切选项即更新 targetOrigin 并重建 client，不再设“应用地址”。 */
  const [choice, setChoice] = useState<"primary" | "secondary" | "custom">(() => {
    if (!startup.targetOrigin) return "primary";
    if (startup.targetOrigin === presets[0].value) return "primary";
    if (startup.targetOrigin === presets[1].value) return "secondary";
    return "custom";
  });
  const [customInput, setCustomInput] = useState(() =>
    startup.targetOrigin && startup.targetOrigin !== presets[0].value && startup.targetOrigin !== presets[1].value
      ? startup.targetOrigin : "");
  const [customError, setCustomError] = useState("");

  const [workbench, setWorkbench] = useState<Workbench>("Identity");
  const [method, setMethod] = useState<DemoMethod>("identity.get");
  const examples = () => createExamples(window.location.origin);
  const [editor, setEditor] = useState(() => editorJson(examples()["identity.get"]));
  const [state, setState] = useState<KeymasterConnectState>("idle");
  const [identity, setIdentity] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState(startup.error || "");
  const [loginError, setLoginError] = useState("");
  const [observation, setObservation] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [result, setResult] = useState<unknown>(null);
  const [inspection, setInspection] = useState("");
  const [client, setClient] = useState<KeymasterConnectClient | null>(null);
  const [loginNotice, setLoginNotice] = useState("");
  const abort = useRef<AbortController | null>(null);
  const loginAbort = useRef<AbortController | null>(null);
  const launchConsumed = useRef(false);
  const running = useRef(false);
  const loginRunning = useRef(false);
  /** 已建成 client 的目标地址；登录时核对，防止极快点击连到旧地址。 */
  const clientTarget = useRef<string>(initialTarget);

  function choosePreset(index: 0 | 1): void {
    setChoice(index === 0 ? "primary" : "secondary");
    setCustomError("");
    setTargetOrigin(presets[index].value);
    setLoginError("");
    setLoginNotice("");
  }
  function handleCustomInput(value: string): void {
    setCustomInput(value);
    setChoice("custom");
    if (!value.trim()) {
      // 输入清空时不回退旧地址：登录保持禁用，避免用上次地址悄悄登录。
      setCustomError("请输入自定义钱包地址（精确 http(s) origin）。");
      return;
    }
    try {
      const exact = exactOrigin(value);
      setCustomError("");
      setTargetOrigin(exact);
      setLoginError("");
      setLoginNotice("");
    } catch {
      setCustomError("钱包地址必须是精确 http(s) origin，例如 http://127.0.0.1:2100。");
    }
  }

  /** 登录成功必须同时满足 SDK connected 且 networkIdentity 非空；connected 只表示传输就绪。 */
  const loggedIn = state === "connected" && identity != null;

  useEffect(() => {
    if (startup.error) return;
    const current = new KeymasterConnectClient({
      targetOrigin, mode: startup.mode, popupPath: "/",
      onStateChange: next => { setState(next); setIdentity(current.networkIdentity); },
      onEvent: event => { setEvents(previous => [display(event), ...previous].slice(0, 60)); },
    });
    setClient(current); setIdentity(null); setState("idle"); setEvents([]); setResult(null); setObservation(""); setInspection("");
    clientTarget.current = targetOrigin;
    return () => { setClient(null); abort.current?.abort(); loginAbort.current?.abort(); };
  }, [targetOrigin, startup]);

  /** 钱包主动启动时按启动参数自动执行一次 launch；成功删除 URL 令牌，失败不重试不回退。 */
  useEffect(() => {
    if (startup.mode === "popup" || startup.error || !client) return;
    if (launchConsumed.current || loginRunning.current || running.current) return;
    if (!startup.launchToken) return;
    loginRunning.current = true; setLoginBusy(true); setLoginError(""); setLoginNotice("");
    const controller = new AbortController(); loginAbort.current = controller;
    (async () => {
      try {
        const params = attachAppProof("connect.launch", { launchToken: startup.launchToken });
        const response = await client.request("connect.launch", params as unknown as MethodParams<"connect.launch">, { signal: controller.signal });
        setIdentity(client.networkIdentity);
        setObservation(display({ method: "connect.launch", params: { launchToken: "[redacted]" }, result: response }));
        launchConsumed.current = true;
        history.replaceState(null, "", consumedLaunchUrl(location.href));
        setWorkbench("Identity"); setMethod("identity.get"); setEditor(editorJson(examples()["identity.get"]));
      } catch (failure) {
        if (controller.signal.aborted) return;
        setLoginError(errorText(failure));
        setIdentity(client.networkIdentity);
      } finally {
        loginRunning.current = false; loginAbort.current = null; setLoginBusy(false);
      }
    })();
    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, startup]);

  /** 用户直接打开 Demo 时点击执行 connect.login；参数由代码生成，不编辑登录 JSON。 */
  async function doLogin(): Promise<void> {
    const current = client;
    if (!current || loginRunning.current || running.current) return;
    // 未走启动流程时，以当前选中地址为准；与已建 client 不一致说明切换尚未重建完成，
    // 此时先完成切换并请用户再点一次，绝不悄悄连旧地址。
    if (!launched) {
      let desired: string | null = null;
      if (choice === "custom") {
        try {
          desired = exactOrigin(customInput);
        } catch {
          setLoginError("钱包地址必须是精确 http(s) origin，例如 http://127.0.0.1:2100。");
          return;
        }
      } else {
        desired = presets[choice === "primary" ? 0 : 1].value;
      }
      if (desired !== clientTarget.current) {
        setTargetOrigin(desired);
        setLoginNotice(`钱包地址已切换到 ${desired}，请再次点击登录。`);
        return;
      }
    }
    loginRunning.current = true; setLoginBusy(true); setLoginError(""); setLoginNotice("");
    const controller = new AbortController(); loginAbort.current = controller;
    try {
      const params = attachAppProof("connect.login", { text: "连接当前钱包", claims: ["key.label"] });
      const response = await current.request("connect.login", params as unknown as MethodParams<"connect.login">, { signal: controller.signal });
      setIdentity(current.networkIdentity);
      setObservation(display({ method: "connect.login", params, result: response }));
      if (current.state !== "connected" || !current.networkIdentity) throw new Error("Login did not establish a connected session with networkIdentity");
      setWorkbench("Identity"); setMethod("identity.get"); setEditor(editorJson(examples()["identity.get"]));
    } catch (failure) {
      if (!controller.signal.aborted) { setLoginError(errorText(failure)); setIdentity(current.networkIdentity); }
    } finally {
      loginRunning.current = false; loginAbort.current = null; setLoginBusy(false);
    }
  }

  /** 退出登录执行 connect.logout，明确撤销本连接授权。 */
  async function doLogout(): Promise<void> {
    const current = client;
    if (!current || loginRunning.current || running.current) return;
    loginRunning.current = true; setLoginBusy(true); setLoginError(""); setError(""); setLoginNotice("");
    const controller = new AbortController(); loginAbort.current = controller;
    try {
      const response = await current.request("connect.logout", {}, { signal: controller.signal });
      setObservation(display({ method: "connect.logout", params: {}, result: response }));
      // 仅在钱包确认退出成功后清除身份。
      setIdentity(current.networkIdentity);
      setResult(null); setInspection("");
      if (current.networkIdentity) throw new Error("Logout did not clear the session identity");
    } catch (failure) {
      if (!controller.signal.aborted) { setLoginError(errorText(failure)); setError(errorText(failure)); }
    } finally {
      loginRunning.current = false; loginAbort.current = null; setLoginBusy(false);
    }
  }

  /** 切换方法只生成官方类型约束的业务样例，不自行构造 wire 请求。 */
  function choose(next: DemoMethod): void {
    setMethod(next); setResult(null); setInspection(""); setError("");
    setEditor(editorJson(examples()[next]));
  }

  /** 付款在发送前保存原申请；重交必须使用原 ID 和原参数，不自动重试。 */
  async function execute(selected: DemoMethod = method, supplied?: Record<string, unknown>): Promise<void> {
    const current = client;
    if (!current || running.current || loginRunning.current) return;
    const establishing = ["connect.login", "connect.launch"].includes(selected);
    if (!establishing) {
      if (!loggedIn) { setError("请先登录：当前无已连接的钱包身份"); return; }
    }
    running.current = true; setBusy(true); setError(""); setInspection(""); setResult(null); setObservation("");
    const controller = new AbortController(); abort.current = controller;
    try {
      if (selected === "connect.launch" && launchConsumed.current) throw new Error("Launch token already consumed; relaunch from Keymaster");
      const params = attachAppProof(selected, supplied ?? parseEditor(editor));
      if (selected === "payment.pay") {
        const networkIdentity = current.networkIdentity;
        if (!networkIdentity) throw new Error("Login or launch before making a payment");
        const payment = params as unknown as PaymentPayParams;
        if (!payment.clientRequestId || !Array.isArray((payment as unknown as { outputs?: unknown }).outputs)) throw new Error("Payment requires clientRequestId and outputs");
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
      const response = await current.request(selected, params as unknown as MethodParams<typeof selected>, { signal: controller.signal });
      setResult(response); setIdentity(current.networkIdentity);
      setObservation(display({ method: selected, params, result: response }));
      if (selected === "connect.launch") {
        launchConsumed.current = true;
        history.replaceState(null, "", consumedLaunchUrl(location.href)); setEditor("{}");
      }
      if (selected === "connect.logout") { setResult(null); setInspection(""); }
      if (selected === "identity.get") setInspection(display(inspectIdentityResult(response as IdentityGetResult)));
      if (selected === "intent.sign") {
        const content = params.content as { bytes: ArrayBuffer };
        setInspection(display(inspectIntentResult(response as IntentSignResult, new Uint8Array(content.bytes))));
      }
    } catch (failure) {
      if (!controller.signal.aborted) { setError(errorText(failure)); setIdentity(current.networkIdentity); }
    } finally {
      running.current = false; abort.current = null; setBusy(false);
    }
  }

  /** 原申请查询与重交始终从持久记录读取，不消费可编辑表单。 */
  function restorePayment(resubmit: boolean): void {
    try {
      const saved = readPayment(localStorage);
      if (!saved) throw new Error("No saved payment available");
      assertPaymentContext(saved, targetOrigin, client?.networkIdentity || null);
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

  const methods = (name: keyof typeof WORKBENCHES): readonly DemoMethod[] => WORKBENCHES[name];
  const showLogin = !loggedIn;
  /** 自定义地址非法或未填写时禁用登录，避免悄悄连到旧地址。 */
  const customInvalid = choice === "custom" && (!customInput.trim() || customError !== "");
  const loginDisabled = loginBusy || !!startup.error || (!launched && customInvalid);

  return <div className={embedded ? "km km-embedded" : "km"}>
    {embedded && <header className="km-estatus"><span>Connect Demo</span><span data-testid="connection-state" data-state={state}>{state}</span></header>}
    {showLogin ? <main className="km-login" data-testid="login-screen">
      <div className="km-login-card">
      <div className="km-login-brand">
        <p className="km-eyebrow">Keymaster Connect Console</p>
        <h1>控制台登录</h1>
        <div className="km-login-meta">
          {!embedded && <span>官方 SDK · Connect v1 · {startup.mode === "popup" ? "App 主动打开完整钱包" : "钱包弹出 App"}</span>}
          {!embedded && <span className="km-conn" data-testid="connection-state" data-state={state}>{state}</span>}
        </div>
      </div>
      {state === "disconnected" && <p role="status">连接已断开。{launched ? "请从钱包重新打开应用。" : "请重新登录。"}</p>}
      {startup.error && <p role="alert">{startup.error}；请从钱包重新打开。</p>}
      {!startup.error && launched && startup.launchToken && !launchConsumed.current && <>
        <p role="status">{loginBusy ? "正在通过钱包启动登录…" : "已收到钱包启动参数，正在自动登录。"}</p>
        {loginError && <p role="alert">{loginError}</p>}
        <div className="km-row">
          <button disabled={!loginBusy} onClick={() => loginAbort.current?.abort()}>取消请求</button>
        </div>
        <p className="km-hint">连接失败请从钱包重新打开应用。</p>
      </>}
      {!startup.error && launched && (!startup.launchToken || launchConsumed.current) && <>
        <p>连接已断开或启动令牌已使用，请从钱包重新打开应用。</p>
        {loginError && <p role="alert">{loginError}</p>}
        {loginNotice && <p role="status">{loginNotice}</p>}
        <div className="km-row">
          <button disabled={!loginBusy} onClick={() => loginAbort.current?.abort()}>取消请求</button>
        </div>
      </>}
      {!startup.error && !launched && <>
        <p className="km-sub">选择钱包地址后直接登录，切换地址即重建连接。网页版与用户确认的 CLI 地址均在此配置；CLI 端口不扫描、不猜测。</p>
        <fieldset className="km-addr">
          <legend>钱包地址</legend>
          <label className="km-addr-opt">
            <input type="radio" name="wallet-target" value="primary" checked={choice === "primary"} disabled={loginBusy} onChange={() => choosePreset(0)} />
            <span>线上钱包 <code>{presets[0].value}</code>{presets[0].fromEnv ? <em>（环境变量已覆盖）</em> : null}</span>
          </label>
          <label className="km-addr-opt">
            <input type="radio" name="wallet-target" value="secondary" checked={choice === "secondary"} disabled={loginBusy} onChange={() => choosePreset(1)} />
            <span>本地钱包 <code>{presets[1].value}</code>{presets[1].fromEnv ? <em>（环境变量已覆盖）</em> : null}</span>
          </label>
          <label className="km-addr-opt">
            <input type="radio" name="wallet-target" value="custom" checked={choice === "custom"} disabled={loginBusy} onChange={() => { setChoice("custom"); if (customInput.trim()) handleCustomInput(customInput); }} />
            <span className="km-addr-custom">自定义<input aria-label="Keymaster Target Origin" placeholder="http(s) 精确 origin" value={customInput} disabled={loginBusy} onChange={event => handleCustomInput(event.target.value)} onFocus={() => setChoice("custom")} /></span>
          </label>
          {choice === "custom" && customError && <p role="alert">{customError}</p>}
        </fieldset>
        {loginError && <p role="alert">{loginError}</p>}
        {loginNotice && <p role="status">{loginNotice}</p>}
        <div className="km-row km-login-actions">
          <button className="km-btn km-btn-primary" disabled={loginDisabled} onClick={() => void doLogin()}>{loginBusy ? "登录中…" : "使用 Keymaster 登录"}</button>
          <button disabled={!loginBusy} onClick={() => loginAbort.current?.abort()}>取消请求</button>
        </div>
      </>}
      <p className="km-target">模式 {startup.mode} · 目标 {targetOrigin}</p>
      <details className="km-diag">
        <summary>连接诊断</summary>
        <p>当前钱包身份（只读，由 Keymaster 返回）</p><pre data-testid="wallet-identity">{display(identity)}</pre>
        {observation && <><h3>请求 / 结果</h3><pre data-testid="observation">{observation}</pre></>}
        {<><h3>事件（最近 60 条）</h3><pre data-testid="events">{events.join("\n")}</pre></>}
      </details>
      </div>
    </main> : <div data-testid="business-screen" className="km-app">
      <aside className="km-side">
        <div className="km-side-brand">
          <p className="km-eyebrow">Keymaster Connect Console</p>
          <p className="km-side-title">控制台</p>
          <span className="km-conn" data-testid="connection-state" data-state={state}>{state}</span>
        </div>
        <nav className="km-nav" aria-label="工作台">
          {Object.keys(WORKBENCHES).map(name => <button key={name} className="km-nav-item" disabled={busy || loginBusy} aria-pressed={workbench === name} onClick={() => {
            const next = name as Workbench; setWorkbench(next); choose(methods(next)[0]);
          }}>{name}</button>)}
        </nav>
        <div className="km-side-foot">
          <button className="km-btn km-btn-ghost" disabled={loginBusy} onClick={() => void doLogout()}>退出登录</button>
        </div>
      </aside>
      <div className="km-main">
      <header className="km-top">
        <div className="km-id">
          <span className="km-id-label">当前钱包身份（只读）</span>
          <pre data-testid="wallet-identity">{display(identity)}</pre>
        </div>
        <div className="km-top-actions">
          {launched && !embedded && <span className="km-hint">仅连接启动方钱包窗口，不另开钱包。</span>}
        </div>
        {loginError && <p role="alert" className="km-alert">{loginError}</p>}
        {loginNotice && <p role="status" className="km-status">{loginNotice}</p>}
      </header>
      <div className="km-work">
      <main className="km-pane">
        {<>
          {!embedded && <h2 className="km-pane-title">{workbench}</h2>}
          <div className="km-toolbar">
          <label className="km-field">方法<select aria-label="方法" value={method} disabled={busy || loginBusy} onChange={event => choose(event.target.value as DemoMethod)}>
            {methods(workbench).map(name => <option key={name}>{name}</option>)}
          </select></label>
          </div>
          <label className="km-field">业务参数 JSON<textarea aria-label="业务参数 JSON" rows={embedded ? 8 : 14} value={editor} disabled={busy || loginBusy} onChange={event => setEditor(event.target.value)} /></label>
          {["intent.sign", "cipher.encrypt"].includes(method) && <label className="km-field">读取文件到 content<input aria-label="读取文件到 content" type="file" disabled={busy || loginBusy} onChange={event => void loadFile(event.target.files?.[0])} /></label>}
          <div className="km-row">
            <button className="km-btn km-btn-primary" disabled={busy || loginBusy || !!startup.error} onClick={() => void execute()}>{embedded && busy ? "执行中…" : "执行请求"}</button>
            <button className="km-btn" disabled={!busy} onClick={() => abort.current?.abort()}>取消请求</button>
          </div>
          {workbench === "Payment" && <div className="km-note">
            <p>付款按 outputs 数组顺序构造链上输出，找零由钱包追加。只有 accepted / already_known 表示已接收；unknown 等状态必须查询，不自动重试或更换 ID。快捷按钮操作最近一笔；此前原申请按 ID 保留，可在参数中填原 ID 查询或填完整原申请重交。</p>
            <div className="km-row">
              <button className="km-btn" disabled={busy || loginBusy} onClick={() => restorePayment(false)}>查询原付款</button>
              <button className="km-btn" disabled={busy || loginBusy} onClick={() => restorePayment(true)}>重交原付款（原 ID）</button>
            </div>
          </div>}
          {method === "cipher.encrypt" && !!result && <button className="km-btn" disabled={busy || loginBusy} onClick={() => {
            // 直接保留完整密文，不从观察区的有界预览重建数据。
            const encrypted = result as CipherEncryptResult;
            choose("cipher.decrypt");
            setEditor(editorJson({ text: "解密演示内容", nonce: encrypted.nonce, cipherbytes: encrypted.cipherbytes }));
          }}>用此结果填入解密参数</button>}
          {resultBinary(result) && <button className="km-btn" onClick={() => download(result)}>下载完整结果</button>}
        </>}
        {error && <p role="alert" className="km-alert">{error}</p>}
      </main>
      <aside className="km-observe">
        <h2 className="km-pane-title">请求 / 结果</h2>{embedded && !observation ? <p className="km-empty">执行后显示请求与结果。</p> : <pre data-testid="observation" className="km-code">{observation}</pre>}
        {inspection && <><h3>本地验签</h3><pre data-testid="inspection" className="km-code">{inspection}</pre></>}
        {embedded ? <details className="km-events"><summary>事件<span>{events.length}</span></summary><pre data-testid="events" className="km-code">{events.join("\n") || "暂无事件"}</pre></details> : <><h3>事件（最近 60 条）</h3><pre data-testid="events" className="km-code">{events.join("\n")}</pre></>}
      </aside>
      </div>
      </div>
    </div>}
  </div>;
}
