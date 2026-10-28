import {
  type AppIdentityProofV1, type BinaryField, type MethodParams, type NetworkIdentity,
  type PaymentPayParams, type ProtocolMethod, STORAGE_MAX_PAYLOAD_BYTES,
  validateNetworkIdentity,
} from "keymaster-connect";
import { base64ToBytes, bytesToBase64 } from "./encoding";
import { makeBinaryField } from "./binary";

/** Demo 演示当前可用方法；生产禁用的旧转账不再作为付款入口。 */
export const WORKBENCHES = {
  Connect: ["connect.login", "connect.resume", "connect.logout", "connect.launch"],
  Identity: ["identity.get", "intent.sign"],
  Cipher: ["cipher.encrypt", "cipher.decrypt"],
  Payment: ["payment.channel.register", "payment.pay", "payment.status"],
  Channel: ["channel.publish", "channel.subscription_set"],
  Storage: ["storage.list", "storage.directory.create", "storage.directory.delete", "storage.put", "storage.get", "storage.delete"],
  MSFile: ["msfile.stat", "msfile.seed.read", "msfile.block.read"],
} as const satisfies Record<string, readonly ProtocolMethod[]>;
export type DemoMethod = (typeof WORKBENCHES)[keyof typeof WORKBENCHES][number];
export type Workbench = keyof typeof WORKBENCHES | "Test Wallet";

/** 样例直接受官方 SDK 类型检查，不再定义 Demo 自己的协议字段。 */
export function createExamples(origin: string, now = Math.floor(Date.now() / 1000)) {
  const content = makeBinaryField(new TextEncoder().encode("Hello from Connect Demo"));
  return {
    "connect.login": { text: "连接当前钱包", claims: ["key.label"] },
    "connect.resume": {}, "connect.logout": {}, "connect.launch": { launchToken: "" },
    "identity.get": { aud: origin, iat: now, exp: now + 300, text: "确认身份", claims: ["key.label"] },
    "intent.sign": { aud: origin, iat: now, exp: now + 300, text: "签署演示内容", contentType: "text/plain", content },
    "cipher.encrypt": { text: "加密演示内容", contentType: "text/plain", content },
    "cipher.decrypt": { text: "解密演示内容", nonce: makeBinaryField(new Uint8Array(12)), cipherbytes: makeBinaryField(new Uint8Array()) },
    "payment.channel.register": { channelName: "checkout", paymentType: "p2pkh" },
    "payment.pay": { channelId: "", clientRequestId: crypto.randomUUID(), paymentType: "p2pkh", businessKind: "demo.checkout", amountSatoshis: 1000, feeRateSatoshisPerKb: 100, recipient: { type: "p2pkh", address: "" } },
    "payment.status": { clientRequestId: "" },
    "channel.publish": { channel: "demo.channel", content: { text: "Hello from Demo" } },
    "channel.subscription_set": { channels: ["demo.channel"] },
    "storage.list": { prefix: "", limit: 20 },
    "storage.directory.create": { path: "demo", overwrite: true },
    "storage.directory.delete": { path: "demo" },
    "storage.put": { path: "demo.txt", content, contentType: "text/plain", overwrite: true },
    "storage.get": { path: "demo.txt" }, "storage.delete": { path: "demo.txt" },
    "msfile.stat": { seedHashHex: "ab".repeat(32) },
    "msfile.seed.read": { sourceId: "local-bitfs", seedHashHex: "ab".repeat(32) },
    "msfile.block.read": { sourceId: "local-bitfs", seedHashHex: "ab".repeat(32), blockHashHex: "cd".repeat(32) },
  } satisfies { [M in DemoMethod]: Omit<MethodParams<M>, "appIdentity"> };
}

/** 编辑器用 base64 展示完整业务二进制；它不是传给钱包的 wire 形状。 */
export function editorJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && entry.$type === "binary" && entry.bytes instanceof ArrayBuffer) {
      return { $type: "binary", base64: bytesToBase64(new Uint8Array(entry.bytes)), ...(entry.mime ? { mime: entry.mime } : {}) };
    }
    return entry;
  }, 2);
}

/** 将编辑器二进制转换成官方 BinaryField，旧钱包选择参数由 SDK 再次拒绝。 */
export function parseEditor(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text, (_key, entry) => {
    if (!entry || entry.$type !== "binary") return entry;
    if (typeof entry.base64 !== "string" || Object.keys(entry).some(key => !["$type", "base64", "mime"].includes(key))) throw new Error("Binary editor values require base64 and optional mime");
    if (entry.mime !== undefined && typeof entry.mime !== "string") throw new Error("Binary MIME must be a string");
    if (entry.base64.length > Math.ceil(STORAGE_MAX_PAYLOAD_BYTES / 3) * 4) throw new Error("Binary content exceeds the SDK payload limit");
    // 零字节文件也是合法业务二进制；通用文本输入工具仍拒绝空输入。
    const bytes = entry.base64 === "" ? new Uint8Array() : base64ToBytes(entry.base64);
    if (bytes.byteLength > STORAGE_MAX_PAYLOAD_BYTES) throw new Error("Binary content exceeds the SDK payload limit");
    return makeBinaryField(bytes, entry.mime);
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parameters must be a JSON object");
  return value as Record<string, unknown>;
}

/** App proof 固定来自入口 HTML，不让编辑器改写发行人身份。 */
export function attachAppProof(method: DemoMethod, params: Record<string, unknown>, proof: AppIdentityProofV1 | null): Record<string, unknown> {
  if (!["connect.login", "connect.resume", "connect.launch"].includes(method)) return params;
  if (!proof) throw new Error("App identity proof is unavailable; check HTML metadata");
  if ("appIdentity" in params) throw new Error("App identity is supplied by HTML metadata, not the editor");
  return { ...params, appIdentity: proof };
}

export interface Startup {
  mode: "popup" | "appView";
  targetOrigin: string | null;
  launchToken: string | null;
  error: string | null;
}
/** 只接受精确 HTTP(S) origin；appView 不能回退默认 origin 或 popup。 */
export function exactOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) throw new Error("Keymaster origin must be an exact HTTP(S) origin");
  return value;
}
/** URL 启动状态仅解析一次；token 无效时不尝试自动登录。 */
export function readStartup(search: string): Startup {
  const query = new URLSearchParams(search);
  const appView = query.has("launchToken") || query.has("sessionWindowOrigin") || query.get("mode") === "appView";
  if (!appView) return { mode: "popup", targetOrigin: null, launchToken: null, error: null };
  try {
    const origin = exactOrigin(query.get("sessionWindowOrigin") ?? "");
    return { mode: "appView", targetOrigin: origin, launchToken: query.get("launchToken"), error: null };
  } catch {
    return { mode: "appView", targetOrigin: null, launchToken: null, error: "Invalid or missing sessionWindowOrigin; relaunch from Keymaster" };
  }
}
/** 成功后移除一次性 token，保留 appView 标记，刷新不偷偷改成 popup。 */
export function consumedLaunchUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("launchToken"); url.searchParams.set("mode", "appView");
  return url.href;
}

export interface SavedPayment { targetOrigin: string; networkIdentity: NetworkIdentity; params: PaymentPayParams; }
const PAYMENT_KEY = "keymaster-connect-demo.payment.v1";
/** 仅保存公开付款事实；不缓存授权、binding、claims 或私钥。 */
export function readPayment(storage: Pick<Storage, "getItem">, clientRequestId?: string): SavedPayment | null {
  try {
    const key = clientRequestId === undefined ? PAYMENT_KEY : `${PAYMENT_KEY}.${encodeURIComponent(clientRequestId)}`;
    const value = JSON.parse(storage.getItem(key) ?? "null") as SavedPayment | null;
    if (!value || !value.params || typeof value.params.clientRequestId !== "string" || !value.params.clientRequestId) return null;
    if (clientRequestId !== undefined && value.params.clientRequestId !== clientRequestId) return null;
    exactOrigin(value.targetOrigin); validateNetworkIdentity(value.networkIdentity);
    return value;
  } catch { return null; }
}
/** 签名前先持久保存原申请；持久化失败就不付款，不自动换 ID。 */
export function savePayment(storage: Pick<Storage, "setItem">, value: SavedPayment): void {
  const serialized = JSON.stringify(value);
  // 每个原 ID 单独保留，开始另一笔付款不会抹掉 unknown 申请的恢复事实。
  storage.setItem(`${PAYMENT_KEY}.${encodeURIComponent(value.params.clientRequestId)}`, serialized);
  storage.setItem(PAYMENT_KEY, serialized);
}
/** 查询/重交原申请前核对钱包、网络和部署来源。 */
export function assertPaymentContext(saved: SavedPayment, targetOrigin: string, identity: Readonly<NetworkIdentity> | null): void {
  if (!identity || saved.targetOrigin !== targetOrigin || saved.networkIdentity.bsvNetwork !== identity.bsvNetwork || saved.networkIdentity.publicKeyHex.toLowerCase() !== identity.publicKeyHex.toLowerCase()) throw new Error("Original payment belongs to a different wallet, network or Keymaster origin");
}
/** 仅完整下载对象保留二进制；观察和历史显示由有界摘要处理。 */
export function resultBinary(value: unknown): BinaryField | null {
  if (!value || typeof value !== "object" || !("content" in value)) return null;
  const content = (value as { content?: BinaryField }).content;
  return content?.$type === "binary" && content.bytes instanceof ArrayBuffer ? content : null;
}
