const MAX_BINARY_BYTES = 16 * 1024 * 1024;
import {
  type BinaryField, type KeymasterConnectClient, type KeymasterRequestOptions, type MethodParams, type NetworkIdentity,
  type PaymentPayParams, type ProtocolMethod,
  validateNetworkIdentity,
} from "keymaster-connect";
import { base64ToBytes, bytesToBase64 } from "./encoding";
import { makeBinaryField } from "./binary";

/** 连接方法与业务导航分离：登录/恢复/退出/启动由专用界面控制，不占用业务工作台。 */
export const CONNECT_METHODS = ["connect.login", "connect.logout", "connect.launch"] as const satisfies readonly ProtocolMethod[];
export type ConnectMethod = (typeof CONNECT_METHODS)[number];

/** Demo 演示当前可用业务方法；旧渠道注册与单收款方转账已移除。 */
export const WORKBENCHES = {
  Identity: ["identity.get", "intent.sign"],
  Cipher: ["cipher.encrypt", "cipher.decrypt"],
  Payment: ["payment.pay", "payment.status"],
  Channel: ["channel.publish", "channel.subscription_set"],
  MSFile: ["msfile.content.read", "msfile.stat", "msfile.seed.read", "msfile.block.read", "msfile.import", "msfile.seller.status"],
} as const satisfies Record<string, readonly ProtocolMethod[]>;
export type Workbench = keyof typeof WORKBENCHES;
type WorkbenchMethod = (typeof WORKBENCHES)[keyof typeof WORKBENCHES][number];
export type DemoMethod = WorkbenchMethod | ConnectMethod;

/** 界面显示 SDK 方法名，观察区仍保留实际协议方法名。 */
export const MSFILE_LABELS: Readonly<Partial<Record<DemoMethod, string>>> = {
  "msfile.content.read": "msfile.read",
  "msfile.seed.read": "msfile.readSeed",
  "msfile.block.read": "msfile.readBlock",
  "msfile.seller.status": "msfile.sellerStatus",
};

/** 文件工作台调用统一的 SDK 门面，其余工作台继续按协议方法执行。 */
export function executeDemoMethod(client: KeymasterConnectClient, method: DemoMethod, params: Record<string, unknown>, options: KeymasterRequestOptions) {
  switch (method) {
    case "msfile.content.read": return client.msfile.read(params.seedHashHex as string, options);
    case "msfile.stat": return client.msfile.stat(params as unknown as MethodParams<"msfile.stat">, options);
    case "msfile.seed.read": return client.msfile.readSeed(params as unknown as MethodParams<"msfile.seed.read">, options);
    case "msfile.block.read": return client.msfile.readBlock(params as unknown as MethodParams<"msfile.block.read">, options);
    case "msfile.import": return client.msfile.import(params as unknown as MethodParams<"msfile.import">, options);
    case "msfile.seller.status": return client.msfile.sellerStatus(options);
    default: return client.request(method, params as unknown as MethodParams<typeof method>, options);
  }
}

/** 样例直接受官方 SDK 类型检查，不再定义 Demo 自己的协议字段。 */
export function createExamples(origin: string, now = Math.floor(Date.now() / 1000)) {
  const content = makeBinaryField(new TextEncoder().encode("Hello from Connect Demo"));
  return {
    "connect.login": { text: "连接当前钱包", claims: ["key.label"] },
    "connect.logout": {}, "connect.launch": { launchToken: "" },
    "identity.get": { aud: origin, iat: now, exp: now + 300, text: "确认身份", claims: ["key.label"] },
    "intent.sign": { aud: origin, iat: now, exp: now + 300, text: "签署演示内容", contentType: "text/plain", content },
    "cipher.encrypt": { text: "加密演示内容", contentType: "text/plain", content },
    "cipher.decrypt": { text: "解密演示内容", nonce: makeBinaryField(new Uint8Array(12)), cipherbytes: makeBinaryField(new Uint8Array()) },
    "payment.pay": { clientRequestId: crypto.randomUUID(), outputs: [{ amount: 0, script: "" }] },
    "payment.status": { clientRequestId: "" },
    "channel.publish": { channel: "demo.channel", content: { text: "Hello from Demo" } },
    "channel.subscription_set": { channels: ["demo.channel"] },
    "msfile.content.read": { seedHashHex: "ab".repeat(32) },
    "msfile.import": { fileName: "demo.txt", content },
    "msfile.seller.status": {},
    "msfile.stat": { seedHashHex: "ab".repeat(32) },
    "msfile.seed.read": { sourceId: "local-bitfs", seedHashHex: "ab".repeat(32) },
    "msfile.block.read": { sourceId: "local-bitfs", seedHashHex: "ab".repeat(32), blockHashHex: "cd".repeat(32) },
  } satisfies { [M in DemoMethod]: MethodParams<M> };
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
    if (entry.base64.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4) throw new Error("Binary content exceeds the SDK payload limit");
    // 零字节文件也是合法业务二进制；通用文本输入工具仍拒绝空输入。
    const bytes = entry.base64 === "" ? new Uint8Array() : base64ToBytes(entry.base64);
    if (bytes.byteLength > MAX_BINARY_BYTES) throw new Error("Binary content exceeds the SDK payload limit");
    return makeBinaryField(bytes, entry.mime);
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parameters must be a JSON object");
  return value as Record<string, unknown>;
}

/** 可信来源属于 Receiver 上下文；Demo 不再提交任何身份字段，编辑器也不得自报身份。 */
export function attachAppProof(method: DemoMethod, params: Record<string, unknown>): Record<string, unknown> {
  void method;
  if ("appIdentity" in params) throw new Error("App identity fields are removed; trusted origin comes from the Receiver context");
  return params;
}

export interface Startup {
  mode: "popup" | "appView" | "iframe";
  targetOrigin: string | null;
  launchToken: string | null;
  error: string | null;
}
/** 只接受精确 HTTP(S) origin；规范化遵循 WHATWG origin 序列化，路径仍拒绝。 */
export function exactOrigin(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || url.origin === "null") {
    throw new Error("Wallet origin must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  return url.origin;
}

/**
 * 登录页三选一的钱包地址预设：线上 / 本地。
 * dev 覆盖通过环境变量注入，不入 Git：`VITE_CONNECT_WALLET_PRIMARY` 覆盖线上预设，
 * `VITE_CONNECT_WALLET_SECONDARY` 覆盖本地预设；为空或非法时回退内置默认。
 */
export const DEFAULT_WALLET_PRESETS = ["https://keymaster.cc", "http://127.0.0.1:2100"] as const;
export interface WalletPreset { id: "primary" | "secondary"; value: string; fromEnv: boolean; }
function presetFromEnv(raw: string | undefined, fallback: string, id: WalletPreset["id"]): WalletPreset {
  if (raw && raw.trim()) {
    try {
      return { id, value: exactOrigin(raw), fromEnv: true };
    } catch {
      // 非法覆盖不让页面崩溃，回退默认；登录页仍可走自定义输入。
    }
  }
  return { id, value: fallback, fromEnv: false };
}
export function resolveWalletPresets(env: Record<string, string | undefined> = import.meta.env as unknown as Record<string, string | undefined>): [WalletPreset, WalletPreset] {
  return [
    presetFromEnv(env.VITE_CONNECT_WALLET_PRIMARY, DEFAULT_WALLET_PRESETS[0], "primary"),
    presetFromEnv(env.VITE_CONNECT_WALLET_SECONDARY, DEFAULT_WALLET_PRESETS[1], "secondary"),
  ];
}
/** URL 启动状态仅解析一次；token 无效时不尝试自动登录。 */
export function readStartup(search: string): Startup {
  const query = new URLSearchParams(search);
  const requestedMode = query.get("mode");
  const appView = query.has("launchToken") || query.has("sessionWindowOrigin") || requestedMode === "appView" || requestedMode === "iframe";
  if (!appView) return { mode: "popup", targetOrigin: null, launchToken: null, error: null };
  const mode = requestedMode === "iframe" ? "iframe" : "appView";
  try {
    const origin = exactOrigin(query.get("sessionWindowOrigin") ?? "");
    return { mode, targetOrigin: origin, launchToken: query.get("launchToken"), error: null };
  } catch {
    return { mode, targetOrigin: null, launchToken: null, error: "Invalid or missing sessionWindowOrigin; relaunch from Keymaster" };
  }
}
/** 成功后移除一次性 token，保留 appView 标记，刷新不偷偷改成 popup。 */
export function consumedLaunchUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("launchToken");
  if (url.searchParams.get("mode") !== "iframe") url.searchParams.set("mode", "appView");
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
