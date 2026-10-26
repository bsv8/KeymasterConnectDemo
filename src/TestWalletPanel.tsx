import { useRef, useState } from "react";
import { generateTestWallet, importTestWallet, type TestWallet, type TestWalletNetwork } from "./lib/testWallet";
import { buildAndSignP2pkhTransfer, wocUtxosToTestWalletUtxos, type BuildP2pkhTransferOutput } from "./lib/p2pkhTool";
import { createWocClient, type WocUtxo } from "./lib/woc";

/** 独立内存测试钱包：不选择 Keymaster 网络、不写私钥日志、不自动广播或重试。 */
export function TestWalletPanel() {
  const [network, setNetwork] = useState<TestWalletNetwork>("test");
  const [wallet, setWallet] = useState<TestWallet | null>(null);
  const [wif, setWif] = useState("");
  const [utxos, setUtxos] = useState<WocUtxo[]>([]);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1000");
  const [fee, setFee] = useState("100");
  const [built, setBuilt] = useState<BuildP2pkhTransferOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const running = useRef(false);

  /** 所有异步操作互斥；钱包变更和广播后清掉旧 UTXO/交易，失败不自动重跑。 */
  async function perform(action: () => Promise<void> | void): Promise<void> {
    if (running.current) return;
    running.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Test wallet operation failed"); }
    finally { running.current = false; setBusy(false); }
  }

  /** 只保留派生钱包于组件内存，导入后立即清空输入框。 */
  function replaceWallet(next: TestWallet): void {
    setWallet(next); setNetwork(next.network); setWif(""); setUtxos([]); setBuilt(null); setReceipt("");
  }

  return <section>
    <h2>Test Wallet</h2><p>独立测试钱包，与 Keymaster 无关。私钥只存页面内存；默认测试网，广播会产生真实链上交易。</p>
    <fieldset disabled={busy}>
      <label>测试钱包网络<select aria-label="测试钱包网络" value={network} onChange={event => setNetwork(event.target.value as TestWalletNetwork)}><option value="test">test</option><option value="main">main</option></select></label>
      <button onClick={() => void perform(() => replaceWallet(generateTestWallet(network)))}>生成测试钱包</button>
      <label>导入 WIF<input aria-label="导入 WIF" type="password" autoComplete="off" value={wif} onChange={event => setWif(event.target.value)} /></label>
      <button onClick={() => void perform(() => replaceWallet(importTestWallet(wif)))}>导入测试钱包</button>
      <button onClick={() => { setWallet(null); setWif(""); setUtxos([]); setBuilt(null); setReceipt(""); }}>清除测试钱包</button>
      {wallet && <>
        <p>实际钱包网络：{wallet.network}</p><p data-testid="test-wallet-address">{wallet.address}</p><p>{wallet.publicKeyHex}</p>
        <button onClick={() => void perform(async () => { setUtxos([]); setBuilt(null); setUtxos(await createWocClient({ network: wallet.network }).listConfirmedUtxos(wallet.address)); })}>查询 UTXO</button>
        <pre>{JSON.stringify(utxos, null, 2)}</pre>
        <label>收款地址<input aria-label="收款地址" value={recipient} onChange={event => { setRecipient(event.target.value); setBuilt(null); }} /></label>
        <label>金额（聪）<input aria-label="金额（聪）" value={amount} onChange={event => { setAmount(event.target.value); setBuilt(null); }} /></label>
        <label>费率（sat/kB）<input aria-label="费率（sat/kB）" value={fee} onChange={event => { setFee(event.target.value); setBuilt(null); }} /></label>
        <button onClick={() => void perform(async () => {
          setBuilt(null); setReceipt("");
          setBuilt(await buildAndSignP2pkhTransfer({ wallet, utxos: wocUtxosToTestWalletUtxos(utxos, wallet.address), recipientAddress: recipient, amountSatoshis: Number(amount), feeRateSatoshisPerKb: Number(fee), assetId: wallet.network === "test" ? "bsv-testnet" : "bsv-mainnet" }));
        })}>构造并签名（不广播）</button>
        {built && <>
          <pre>{JSON.stringify(built, null, 2)}</pre>
          <button onClick={() => {
            if (!window.confirm(`Broadcast a real transaction on ${wallet.network}?`)) return;
            void perform(async () => {
              // 广播结果可能未知；无论成败都废弃旧选币视图，不自动重播。
              setUtxos([]); setBuilt(null); setReceipt("");
              setReceipt(JSON.stringify(await createWocClient({ network: wallet.network }).broadcast(built.rawTxHex), null, 2));
            });
          }}>确认广播</button>
        </>}
      </>}
    </fieldset>
    {receipt && <pre>{receipt}</pre>}{error && <p role="alert">{error}</p>}
  </section>;
}
