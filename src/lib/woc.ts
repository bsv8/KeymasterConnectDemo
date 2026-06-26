// src/lib/woc.ts
// 链上查询与广播：直接走 WhatsOnChain（"主网"）。
//
// 设计缘由（施工单 p2pkh / feepool 硬切换）：
//   - 测试钱包工具区只做 demo 自己的链上辅助；不调用 Keymaster popup。
//   - UTXO 查询与广播都走 WOC（`https://api.whatsonchain.com/v1/bsv`）。
//   - 不做：自建后端代理、自建 mempool、多 provider 兜底、provider 切换、
//     自动重试。失败就原样把英文错误抛回去。
//   - 单点 API：fetchJson；不做 rate limit；不做 Web Locks 协调。
//   - 这一层**不**与 Keymaster 协议耦合；纯 demo 测试工具。

/** WOC 单 UTXO 真值（取主网 `confirmed/unspent` 字段）。 */
export interface WocUtxo {
  txid: string;
  vout: number;
  value: number;
  height: number;
  script?: string;
}

/** WOC 广播回执。canonical txid 是上层唯一应消费的 txid。 */
export interface WocBroadcastReceipt {
  accepted: true;
  canonicalTxid: string;
  providerReturnedTxidRaw: string;
  providerReturnedTxidNormalized: string;
  txidIntegrity: "exact" | "reversed" | "mismatch" | "missing";
}

export interface WocClientOptions {
  /** WOC 根 URL；默认 `https://api.whatsonchain.com/v1/bsv`。 */
  baseUrl?: string;
  /** 默认 15000ms。 */
  timeoutMs?: number;
  /** 自定义 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
}

/** 工具区用的 WOC client。仅两个端点：listUtxos + broadcast。 */
export interface WocClient {
  listConfirmedUtxos(address: string): Promise<WocUtxo[]>;
  broadcast(rawTxHex: string): Promise<WocBroadcastReceipt>;
}

export function createWocClient(opts: WocClientOptions = {}): WocClient {
  const baseUrl = (opts.baseUrl ?? "https://api.whatsonchain.com/v1/bsv").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const defaultFetch = typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  if (!fetchImpl) {
    throw new Error("No fetch implementation available in this environment");
  }
  const doFetch: typeof fetch = fetchImpl;

  async function getJson<T>(path: string): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`WOC timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: "GET",
        signal: ctl.signal
      });
      if (res.status === 404) {
        throw new Error(`WOC 404 Not Found: ${path}`);
      }
      if (!res.ok) {
        throw new Error(`WOC ${res.status} ${res.statusText}: ${path}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`WOC timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      if (!res.ok) {
        throw new Error(`WOC ${res.status} ${res.statusText}: ${path}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listConfirmedUtxos(address: string): Promise<WocUtxo[]> {
      if (!address || address.length === 0) {
        throw new Error("WOC listConfirmedUtxos: address is empty");
      }
      let raw: {
        result: Array<{ tx_hash: string; tx_pos: number; value: number; height: number; script?: string }>;
      };
      try {
        raw = await getJson<typeof raw>(`/address/${encodeURIComponent(address)}/confirmed/unspent`);
      } catch (err) {
        if (err instanceof Error && /^WOC 404/.test(err.message)) return [];
        throw err;
      }
      return raw.result.map((u) => ({
        txid: u.tx_hash,
        vout: u.tx_pos,
        value: u.value,
        height: u.height,
        script: u.script
      }));
    },
    async broadcast(rawTxHex: string): Promise<WocBroadcastReceipt> {
      if (!rawTxHex || rawTxHex.length === 0) {
        throw new Error("WOC broadcast: rawTxHex is empty");
      }
      const res = await postJson<{ txid?: string }>(`/tx/raw`, { txhex: rawTxHex });
      const providerReturnedTxidRaw = res.txid ?? "";
      const providerReturnedTxidNormalized = providerReturnedTxidRaw.toLowerCase();
      const canonicalTxid = await calcCanonicalTxidFromRawTxHex(rawTxHex);
      let txidIntegrity: WocBroadcastReceipt["txidIntegrity"] = "missing";
      if (providerReturnedTxidNormalized.length > 0) {
        if (providerReturnedTxidNormalized === canonicalTxid) {
          txidIntegrity = "exact";
        } else {
          const reversed = reverseHexBytes(providerReturnedTxidNormalized);
          if (reversed === canonicalTxid) txidIntegrity = "reversed";
          else txidIntegrity = "mismatch";
        }
      }
      return {
        accepted: true,
        canonicalTxid,
        providerReturnedTxidRaw,
        providerReturnedTxidNormalized,
        txidIntegrity
      };
    }
  };
}

/** 把 hex 字符串转成字节数组。 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(out[i])) {
      throw new Error("Invalid hex string");
    }
  }
  return out;
}

/** 把字节数组转成 hex 字符串。 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 反转 hex 字节序；输入非法时返回 undefined。 */
function reverseHexBytes(hex: string): string | undefined {
  const clean = hex.toLowerCase();
  if (clean.length === 0) return "";
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return undefined;
  const parts = clean.match(/../g);
  return parts ? parts.reverse().join("") : undefined;
}

/** 计算 rawTxHex 的 canonical txid（double-SHA256 后字节序反转）。 */
export async function calcCanonicalTxidFromRawTxHex(rawTxHex: string): Promise<string> {
  // 用 WebCrypto 异步算；browser 和 node 18+ 都有。
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("No WebCrypto subtle available; cannot compute canonical txid");
  }
  const bytes = hexToBytes(rawTxHex);
  // 复制成纯 ArrayBuffer 视图，避免 SharedArrayBuffer 推断问题。
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const first = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buffer));
  const second = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", first));
  second.reverse();
  return bytesToHex(second);
}