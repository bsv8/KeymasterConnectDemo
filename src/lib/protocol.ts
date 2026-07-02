// src/lib/protocol.ts
// Keymaster Connect V1 协议 contract 镜像（demo 独立维护）。
//
// 设计缘由（施工单 2026-07-01 001 硬切换：appmsg 协议硬切换一次性迭代）：
//   - demo **不**直接 import `@keymaster/contracts` 充当运行时库；这里只
//     镜像 contract 的外表面（method 名 + params/result 形状 + 错误码 +
//     顶层 message 形态），保持"外部调用方独立性"测试价值。
//   - 协议方法集一次硬切到 14 个：identity.get / intent.sign /
//     cipher.encrypt / cipher.decrypt / p2pkh.transfer /
//     feepool.prepare / feepool.commit / connect.login / connect.resume
//     / connect.logout / connect.launch / appmsg.send / appmsg.list /
//     appmsg.get。
//   - 删除旧 storage.*（put/get/list/listAll/delete）；Demo 不再做现行
//     storage 能力，**不**保留"点击报 unsupported"的伪兼容工作台。
//   - 新增 `appmsg.*`：与 cipher.* / p2pkh.transfer 一样属于 session-bound
//     外部业务方法；强制要求 `connectSessionId`；sender 真值由 service 从
//     `connectSession.ownerPublicKeyHex` + `event.origin` 投影，**不**接受
//     caller 自报 sender owner / sender endpoint。
//   - transport 顶层消息扩到 6 种：`ready` / `request` / `result` /
//     `closing` / `cancel` / `event`。`event` 是 server-pushed 单向推送，
//     不回 result、不占用 in-flight 槽位、不改变连接状态；v1 只支持
//     `appmsg.inbox_dirty` 一种 event。
//   - 删除协议错误码 `not_found`（旧 storage 用过，appmsg.get 不再翻译
//     成 not_found；server 返回的错误码由 server 决定）。
//   - 所有错误信息字面量继续英文；UI 展示由调用方决定。
//
// 字段命名 / 形状与 `/home/david/Workspaces/keymaster.cc/packages/contracts/src/protocol.ts`
// 对齐；具体 CBOR / 签名 / 加解密 / 推送分发都收敛在 keymaster.cc 内部，
// **不**在 demo 这边重复实现。

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_POPUP_PATH = "/protocol/v1/popup" as const;

export interface BinaryField {
  $type: "binary";
  bytes: ArrayBuffer;
  mime?: string;
}

/**
 * Keymaster Connect V1 全量方法集合（施工单 2026-07-01 001 硬切换）：
 *   - 7 个原业务 / 资金能力：identity.get / intent.sign / cipher.encrypt
 *     / cipher.decrypt / p2pkh.transfer / feepool.prepare / feepool.commit
 *   - 4 个 session 生命周期能力：connect.login / connect.resume /
 *     connect.logout / connect.launch
 *   - 3 个 appmsg 应用消息能力：appmsg.send / appmsg.list / appmsg.get
 *
 * 设计缘由：硬切换要求方法集合一次性切到 14 个；旧 storage.* 五种能力
 * 全部硬删除，**不**做"点击报 unsupported"的伪兼容。
 */
export const PROTOCOL_METHODS = [
  "identity.get",
  "intent.sign",
  "cipher.encrypt",
  "cipher.decrypt",
  "p2pkh.transfer",
  "feepool.prepare",
  "feepool.commit",
  "connect.login",
  "connect.resume",
  "connect.logout",
  "connect.launch",
  "appmsg.send",
  "appmsg.list",
  "appmsg.get"
] as const;

export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number];

/**
 * 协议错误码。`error.message` 走英文；UI 展示由调用方决定。
 *
 * V1 公开错误码集合（施工单 2026-07-01 001 硬切换）：
 *   - invalid_request         顶层 message 结构 / 字段类型 / aud-iat-exp
 *                             规则 / BinaryField 形状不合法；第一条非法
 *                             request 直接被 popup 忽略，不回 result。
 *   - invalid_origin          identity.get / intent.sign 的
 *                             `params.aud !== event.origin`。
 *   - user_rejected           用户在确认页或解锁页点"取消"。
 *   - active_key_unavailable  vault 已 unlocked，但 keyspace 没有 ready
 *                             active key。
 *   - decrypt_failed          cipher.decrypt 失败；origin 不匹配 / nonce
 *                             错误 / 密文被篡改 / 内层结构不合法，V1
 *                             统一为这一种错误。
 *   - internal_error          兜底：用户可见但不属于以上分类的失败。
 *
 * 注意：V1 **不**对外暴露 `wallet_locked` / `not_found`。`not_found` 仅
 * 历史 storage 用过，V1 不再作为公开协议错误码；appmsg.get 找不到时由
 * server 直接返回 `result(ok=true | ok=false)`，Demo 不替它翻译。
 */
export type ProtocolErrorCode =
  | "invalid_request"
  | "invalid_origin"
  | "user_rejected"
  | "active_key_unavailable"
  | "decrypt_failed"
  | "internal_error";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
}

/* ============== AppMsg 外表面 ============== */

/**
 * AppMsg 端点的 kind。V1 仅允许 `origin` / `plugin` 两种。
 *
 * 设计缘由：endpoint 是地址模型的第二维隔离真值；不允许"只按 owner"
 * 做 inbox。
 */
export type AppMsgEndpointKind = "origin" | "plugin";

/**
 * 应用消息端点（地址模型的第二维）。
 *
 * 关键约束：
 *   - `kind = "origin"` 时 `id` = exact origin（scheme + host + port），
 *     port **不可**省略，**不**做 host-only 归一化，**不**做"443 可省略"
 *     平台二次归一化。
 *   - `kind = "plugin"` 时 `id` = 稳定 `pluginEndpointId`，必须全局唯一。
 *   - 不允许存在第三种 `kind`。
 */
export interface AppMsgEndpoint {
  kind: AppMsgEndpointKind;
  id: string;
}

/**
 * 应用消息完整地址（owner + endpoint）。
 *
 * 关键约束：
 *   - `ownerPublicKeyHex` 仍是 owner 根身份真值（与 connect session 同源）；
 *   - endpoint 是第二维隔离真值；没有这一维就不允许实现 inbox；
 *   - sender 与 recipient **都**使用本结构。
 */
export interface AppMsgAddress {
  ownerPublicKeyHex: string;
  endpoint: AppMsgEndpoint;
}

/** V1 支持的消息正文内容类型。 */
export type AppMsgContentType = "text/plain" | "text/markdown";

/** `appmsg.list` 的 box。 */
export type AppMsgListBox = "inbox" | "sent" | "all";

/**
 * 一条应用消息的对外视图。
 *
 * 关键约束：
 *   - sender 与 recipient 都是完整地址（含 endpoint）；
 *   - `clientMessageId` 是调用方幂等键；
 *   - `body` 是明文 / markdown 字符串；V1 不做端到端加密。
 */
export interface AppMsgMessage {
  /** 服务端主键；客户端不可伪造，由 `appmsg.send` 返回。 */
  messageId: string;
  /** 调用方幂等键。 */
  clientMessageId: string;
  /** sender 完整地址。 */
  sender: AppMsgAddress;
  /** recipient 完整地址。 */
  recipient: AppMsgAddress;
  /** 正文内容类型。 */
  contentType: AppMsgContentType;
  /** 正文。V1 不做加密。 */
  body: string;
  /** 客户端声明的创建时间（unix milliseconds）。 */
  createdAtMs: number;
  /** 服务端入库时间（unix milliseconds）；`appmsg.list` / `appmsg.get` 返回。 */
  insertedAtMs: number;
}

/**
 * 对外 `appmsg.inbox_dirty` event payload。
 *
 * 关键约束：
 *   - V1 对外 event 只推送 dirty hint（owner + endpoint + atMs），
 *     **不**携带完整消息正文；
 *   - 接收方按 `ownerPublicKeyHex + endpoint` 识别 dirty box，
 *     然后调 `appmsg.list` / `appmsg.get` 拉正文；
 *   - 推送给"当前 exact origin 对应 endpoint"的 caller；其它 endpoint
 *     收不到自己的 dirty 事件。
 */
export interface AppMsgInboxDirtyEventData {
  ownerPublicKeyHex: string;
  endpoint: AppMsgEndpoint;
  /** dirty 提示时间（unix milliseconds）；不保证递增，仅作为去重 / 排序参考。 */
  atMs: number;
}

/** `appmsg.send` 成功结果。 */
export interface AppMsgSendResult {
  messageId: string;
  createdAtMs: number;
}

/** `appmsg.list` 成功结果。 */
export interface AppMsgListResult {
  items: AppMsgMessage[];
  /** 当前 box 还有更多记录。 */
  hasMore: boolean;
}

/** `appmsg.get` 成功结果。 */
export interface AppMsgGetResult {
  message: AppMsgMessage;
}

/* ============== 顶层 message ============== */

export interface ProtocolReadyMessage {
  v: typeof PROTOCOL_VERSION;
  type: "ready";
}

/**
 * 顶层 `closing` 报文：popup 生命周期结束信号。
 *
 * 与 `ready` 对偶。`closing` 只承载连接结束语义：
 *   - 不携带业务结果；
 *   - 不替代 `result`；
 *   - 不携带 `error` / `ok` / `id` 等业务字段。
 *
 * client 侧状态机规则：
 *   - 收到 `closing` → 收敛到 `disconnected`；
 *   - 轮询到 `popup.closed === true` → 收敛到 `disconnected`；
 *   - 两者并联幂等。
 */
export interface ProtocolClosingMessage {
  v: typeof PROTOCOL_VERSION;
  type: "closing";
}

/**
 * 顶层 `cancel` 报文（施工单 2026-06-29 002 硬切换）。
 *
 * 设计缘由：
 *   - cancel 是 transport 控制消息，**不是**业务 method；不允许做成
 *     `method: "cancel"` 的伪 request。
 *   - `cancel.id` 指向**已经发出**的 `request.id`；popup 只尝试取消
 *     当前会话中绑定的那条 request。被取消的是原 request，所以最终
 *     仍由原 request 回 `result(ok=false)`。
 *   - cancel 自己**不**回一条新 result；这条不变量是 cancel 与普通
 *     request 的关键边界。
 *   - 校验失败（缺 v / id / type 不匹配）走 `invalid_request`。
 */
export interface ProtocolCancelMessage {
  v: typeof PROTOCOL_VERSION;
  type: "cancel";
  /** 要取消的原 `request.id`。 */
  id: string;
}

/**
 * 顶层 `event` 报文（server-pushed）。
 *
 * 设计缘由（施工单 2026-07-01 001 硬切换）：
 *   - V1 只引入一种 event：`appmsg.inbox_dirty`；新消息到达时由 server
 *     向当前 exact origin 对应 endpoint 的 caller 推送 dirty hint；
 *     **不**直接把完整消息正文作为对外 event 真值。
 *   - 完整消息正文由 caller 通过 `appmsg.list` / `appmsg.get` 取；
 *     dirty event 只负责"通知对方有变化"。
 *   - event 是单向推送，**不**回 result；与 `result` 不混淆。
 *   - event **不**占用 in-flight request 槽位；**不**改变连接状态；
 *     在 popup 生命周期内长期到达，与 result 可交错。
 *   - 当前 V1 仅允许 `event === "appmsg.inbox_dirty"`；`data` 是
 *     `AppMsgInboxDirtyEventData`。
 */
export interface ProtocolEventMessage {
  v: typeof PROTOCOL_VERSION;
  type: "event";
  /** 事件名；V1 仅 `appmsg.inbox_dirty`。 */
  event: "appmsg.inbox_dirty";
  data: AppMsgInboxDirtyEventData;
}

export interface ProtocolRequestMessage<M extends ProtocolMethod = ProtocolMethod> {
  v: typeof PROTOCOL_VERSION;
  type: "request";
  id: string;
  method: M;
  params: MethodParams<M>;
}

export type ProtocolResultMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      type: "result";
      id: string;
      ok: true;
      result: MethodResult;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      type: "result";
      id: string;
      ok: false;
      error: ProtocolError;
    };

/**
 * 顶层报文 union。
 *
 * 报文按语义分两类：
 *   - 连接状态报文：`ready`（连接建立）、`closing`（连接结束）。
 *   - 业务报文：`request` / `result`。
 *   - 控制报文：`cancel`（取消在途 request）。
 *   - 推送报文：`event`（server-pushed；V1 仅 `appmsg.inbox_dirty`）。
 *
 * 不变量：
 *   - `ready` 是 transport-ready 信号，**不**表示用户已授权；
 *   - `closing` 是 popup 生命周期结束信号，**不**替代 `result`；
 *   - `result` 是 request 的业务结果，**不**代表连接已断开；
 *   - `event` 是带外推送，**不**回 result、**不**占用 in-flight 槽位、
 *     **不**改变连接状态；
 *   - `cancel` 是 transport 控制消息，**不**单独产出第二条 result。
 */
export type ProtocolMessage =
  | ProtocolReadyMessage
  | ProtocolRequestMessage
  | ProtocolResultMessage
  | ProtocolClosingMessage
  | ProtocolCancelMessage
  | ProtocolEventMessage;

/**
 * popup 连接状态机（窗口级别，与 request 级别无关）。
 *
 * 转移规则：
 *   - `window.open(...)` 成功 → `opening`；
 *   - 收到 `ready` → `connected`；
 *   - 收到 `closing` → `disconnected`；
 *   - 轮询到 `popup.closed === true` → `disconnected`；
 *   - 重复 `closing` / 重复 `popup.closed === true` 幂等忽略；
 *   - `disconnected` 是终态。
 *   - 收到 `event` **不**改变 state。
 *
 * 不做心跳，不引入 MessageChannel。
 */
export type PopupConnectionState = "opening" | "connected" | "disconnected";

/* ============== identity.get ============== */

/**
 * `identity.get` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - `connectSessionId` 是**强制**输入字段；所有外部业务方法都属于
 *     某个 `connectSessionId`（仅 `connect.login` 例外）。缺该字段直接
 *     `invalid_request` 拒绝。
 *   - `identity.get` 不再是"推荐登录入口"；登录走 `connect.login`。
 *     `identity.get` 是"会话内身份断言能力"——`subject` 取自 session
 *     绑定 owner，不是当前钱包 active key。
 */
export interface IdentityGetParams {
  /** 目标站点 origin；必须等于 `event.origin`，否则 `invalid_origin`。 */
  aud: string;
  /** 签发时间（unix seconds）。 */
  iat: number;
  /** 过期时间（unix seconds）；必须严格大于 iat。 */
  exp: number;
  /** 人类可读确认文案。 */
  text: string;
  /** 请求索要的 claim 名列表；缺省 = 不返回任何 claim。 */
  claims?: string[];
  /** `connect.login` 返回的 sessionId。**必填**。 */
  connectSessionId: string;
}

export type ResolvedClaimValue =
  | string
  | number
  | boolean
  | null
  | BinaryField
  | ResolvedClaimValue[]
  | { [key: string]: ResolvedClaimValue };

export interface IdentityGetResult {
  identityEnvelope: BinaryField;
  signature: BinaryField;
  subject: { publicKey: BinaryField };
  resolvedClaims: Record<string, ResolvedClaimValue>;
}

/* ============== intent.sign ============== */

/**
 * `intent.sign` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - `connectSessionId` 是**强制**输入字段；签名主体公钥取自 session
 *     绑定 owner。
 */
export interface IntentSignParams {
  aud: string;
  iat: number;
  exp: number;
  text: string;
  contentType: string;
  content: BinaryField;
  connectSessionId: string;
}

export interface IntentSignResult {
  signedEnvelope: BinaryField;
  signature: BinaryField;
}

/* ============== cipher.encrypt / cipher.decrypt ============== */

/**
 * `cipher.encrypt` 请求参数。
 *
 * 设计缘由：`connectSessionId` 强制；cipher 不再读取全局 active key。
 */
export interface CipherEncryptParams {
  text: string;
  contentType: string;
  content: BinaryField;
  connectSessionId: string;
}

export interface CipherEncryptResult {
  nonce: BinaryField;
  cipherbytes: BinaryField;
}

/**
 * `cipher.decrypt` 请求参数。
 *
 * 设计缘由：与 `cipher.encrypt` 对称——`connectSessionId` 强制。
 */
export interface CipherDecryptParams {
  text: string;
  nonce: BinaryField;
  cipherbytes: BinaryField;
  connectSessionId: string;
}

export interface CipherDecryptResult {
  contentType: string;
  content: BinaryField;
}

/* ============== p2pkh.transfer ============== */

/**
 * `p2pkh.transfer` 请求参数。
 *
 * 设计缘由：
 *   - 仅支持主网 P2PKH（base58check，version 0x00）。
 *   - `aud` 由 popup 端按 `event.origin` 自动绑定，site 不传。
 *   - `feeRateSatoshisPerKb` 可选；缺省走 service 保守默认值。
 *   - `connectSessionId` 强制；资金 owner 取自 session 绑定 owner。
 */
export interface P2pkhTransferParams {
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb?: number;
  connectSessionId: string;
}

export interface P2pkhTransferResult {
  /** canonical txid（双 sha256 + 字节序反转）。 */
  txid: string;
  /** 已签名交易 raw hex。 */
  rawTxHex: string;
  /** 实际花费的 fee satoshis。 */
  feeSatoshis: number;
}

/* ============== feepool.prepare / feepool.commit ============== */

/** fee pool 三种 action。Keymaster 单边决定，site 不传。 */
export type ProtocolFeePoolAction = "create" | "spend" | "close_and_recreate";

/**
 * `feepool.prepare` 请求参数。
 *
 * 设计缘由：
 *   - site 只提交对端公钥 + 本次金额。
 *   - action（create / spend / close_and_recreate）和 lockHeight 由
 *     Keymaster 单边决定。
 *   - `connectSessionId` 强制；fee pool 按 (origin + ownerPublicKeyHex
 *     + counterpartyPublicKeyHex) 三个维度归档，不同 owner 不串池。
 */
export interface FeepoolPrepareParams {
  /** 33-byte compressed secp256k1 公钥 hex（66 字符）。 */
  counterpartyPublicKeyHex: string;
  /** 本次想转给对端的金额（satoshis，正整数）。 */
  amountSatoshis: number;
  connectSessionId: string;
}

/**
 * `feepool.prepare` 成功结果。
 *
 * 三种 action 共有的字段：
 *   - `draftSpendTxHex`：当前 B-Tx 草稿（site 与 server 持续协商的对象）。
 *   - `draftClientSignBytes`：当前草稿上 Keymaster（client 角色）的部分签名。
 *
 * 仅 `create` / `close_and_recreate` 出现：
 *   - `baseTxHex` / `baseTxOutputIndex`：建池那笔 A-Tx。
 *
 * 仅 `close_and_recreate` 出现：
 *   - `closeDraftTxHex` / `closeClientSignBytes`：旧池的 close 版本草稿与签名。
 */
export interface FeepoolPrepareResult {
  operationId: string;
  action: ProtocolFeePoolAction;
  counterpartyPublicKeyHex: string;
  amountSatoshis: number;
  /** A-Tx hex；仅 create / close_and_recreate。 */
  baseTxHex?: string;
  /** multisig output 在 A-Tx 里的 vout index；仅 create / close_and_recreate。 */
  baseTxOutputIndex?: number;
  /** 当前 B-Tx 草稿 hex（持续协商对象，不是真广播的 tx）。 */
  draftSpendTxHex: string;
  /** 当前草稿上 Keymaster（client 角色）的部分签名。 */
  draftClientSignBytes: BinaryField;
  /** close_and_recreate 的 close 部分草稿 hex。 */
  closeDraftTxHex?: string;
  /** close 部分草稿上的 client 部分签名。 */
  closeClientSignBytes?: BinaryField;
  /** 决策时参考的旧池快照（仅 spend / close_and_recreate）。 */
  priorPoolRecord?: {
    baseTxid: string;
    totalAmount: number;
    serverAmount: number;
    draftSpendTxHex?: string;
  } | null;
}

/**
 * `feepool.commit` 请求参数。
 *
 * 设计缘由：
 *   - `operationId` 只在当前 popup 会话内有效；popup 关闭后失效。
 *   - `connectSessionId` 强制；`feepool.commit` 必须按
 *     `connectSessionId + origin + ownerPublicKeyHex` 校验 pending op。
 *   - `closeCounterpartySignatures` 仅 `close_and_recreate` 路径下传入。
 */
export interface FeepoolCommitParams {
  /** 由 prepare 阶段返回的 operationId；只在本 popup 会话内有效。 */
  operationId: string;
  /** 33-byte compressed secp256k1 公钥 hex。 */
  counterpartyPublicKeyHex: string;
  /** 主 B-Tx 草稿上的对端（counterparty）签名数组。 */
  counterpartySignatures: BinaryField[];
  /** 仅 close_and_recreate 的 close 部分对端签名。 */
  closeCounterpartySignatures?: BinaryField[];
  connectSessionId: string;
}

/** `feepool.commit` 成功结果。 */
export interface FeepoolCommitResult {
  operationId: string;
  action: ProtocolFeePoolAction;
  /** 当前主 B-Tx 草稿的 txid。 */
  draftTxid: string;
  /** 当前主 B-Tx 草稿的 raw tx hex。 */
  draftTxHex: string;
  /** 仅 close_and_recreate：旧池 close 草稿的 txid。 */
  closeDraftTxid?: string;
}

/* ============== connect.login / connect.resume / connect.logout ============== */

/**
 * `connect.login` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - **不**在 params 里携带 ownerPublicKeyHex：owner 是用户在 popup UI
 *     上选定的，caller 不能代替用户决定。
 *   - caller 只传 `text` + 可选 `claims`。
 *   - `origin` 走 `event.origin`，params 不允许覆盖。
 */
export interface ConnectLoginParams {
  /** 人类可读确认文案。 */
  text: string;
  /** 请求索要的 claim 名列表（与 `identity.get` 同语义）。 */
  claims?: string[];
}

/**
 * `connect.login` 成功结果。
 *
 * 设计缘由：返回 sessionId + owner + resolvedClaims 三元组；caller 把
 * sessionId 持久化在本地，后续 connect.resume / 业务方法都用它。
 *
 * **不**再返回 `ownerKeyId`；owner 唯一真值 = `ownerPublicKeyHex`。
 */
export interface ConnectLoginResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** 本次解析时间（unix milliseconds）。 */
  resolvedAt: number;
}

/**
 * `connect.resume` 请求参数。
 *
 * 设计缘由：resume 必须显式传入 sessionId；service 按
 * `event.origin` + sessionId 查 session 记录。
 */
export interface ConnectResumeParams {
  connectSessionId: string;
}

/** `connect.resume` 成功结果（与 `connect.login` 对称）。 */
export interface ConnectResumeResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** 本次 resume 时间戳，**不**是 connect.login 时的快照时间。 */
  resolvedAt: number;
}

/**
 * `connect.logout` 请求参数。
 *
 * 设计缘由：logout 只需要 sessionId。
 */
export interface ConnectLogoutParams {
  connectSessionId: string;
}

/** `connect.logout` 成功结果。 */
export interface ConnectLogoutResult {
  connectSessionId: string;
  /** 吊销时间（unix milliseconds）。 */
  revokedAt: number;
}

/* ============== connect.launch ============== */

/**
 * `connect.launch` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - `connect.launch` 是 `appView` mode 下 client app 的**唯一**首登
 *     入口；消费 launcher 交给 client app 的 `launchToken`。
 *   - 不传 aud / iat / exp —— login 时机由 launcher 一次性 bootstrap
 *     阶段决定。
 *   - 失败按 fail-closed：launchToken 缺失 / 已消费 / 当前 Session Window
 *     不在 `appView` mode / caller origin 与 bootstrap 期记录不一致 →
 *     拒掉；**不**允许 fallback 到 `connect.login`。
 *   - demo **不**伪造 launcher bootstrap；没有真实 launchToken 时失败
 *     是预期行为。
 */
export interface ConnectLaunchParams {
  /** 由 launcher 写入 client app 启动 URL 的 launchToken。一次性消费。 */
  launchToken: string;
}

/** `connect.launch` 成功结果（与 `connect.login` 对齐）。 */
export interface ConnectLaunchResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
}

/* ============== appmsg.send / appmsg.list / appmsg.get ============== */

/**
 * appmsg 对外方法族。
 *
 * 设计缘由（施工单 2026-07-01 001 硬切换）：
 *   - 与 `cipher.*` / `p2pkh.transfer` 一样属于 session-bound 外部业务
 *     方法；强制要求 `connectSessionId`；
 *   - sender 真值由 service 从 `connectSession.ownerPublicKeyHex` +
 *     `event.origin` 投影，**不**接受 caller 自报 sender owner / sender
 *     endpoint；表单里不允许出现 sender owner / sender endpoint 字段；
 *   - caller 只能指定 `recipientOwnerPublicKeyHex` + `recipientEndpoint`；
 *     `recipientEndpoint` 是 `{ kind: "origin", id: exactOrigin }` 或
 *     `{ kind: "plugin", id: pluginEndpointId }`；
 *   - 字段命名使用 `appmsg.*`，**不**使用 `hubmsg.*`；`HubMsg` 仅作为
 *     底层承载背景存在。
 *   - V1 内容边界：`contentType = "text/plain" | "text/markdown"`；不支
 *     持附件、二进制正文、未读计数、已读回执、撤回、群聊。
 *   - V1 仅暴露 `appmsg.inbox_dirty` 作为对外 event；完整正文由
 *     `appmsg.list` / `appmsg.get` 拉。
 */

/** `appmsg.send` 请求参数。 */
export interface AppMsgSendParams {
  recipientOwnerPublicKeyHex: string;
  recipientEndpoint: AppMsgEndpoint;
  contentType: AppMsgContentType;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
  /** 必填：当前 connectSessionId。 */
  connectSessionId: string;
}

/** `appmsg.list` 请求参数。 */
export interface AppMsgListParams {
  box: AppMsgListBox;
  afterMessageId?: string;
  beforeMessageId?: string;
  limit?: number;
  /** 必填：当前 connectSessionId。 */
  connectSessionId: string;
}

/** `appmsg.get` 请求参数。 */
export interface AppMsgGetParams {
  messageId: string;
  /** 必填：当前 connectSessionId。 */
  connectSessionId: string;
}

/* ============== Method dispatch ============== */

export interface MethodParamsMap {
  "identity.get": IdentityGetParams;
  "intent.sign": IntentSignParams;
  "cipher.encrypt": CipherEncryptParams;
  "cipher.decrypt": CipherDecryptParams;
  "p2pkh.transfer": P2pkhTransferParams;
  "feepool.prepare": FeepoolPrepareParams;
  "feepool.commit": FeepoolCommitParams;
  "connect.login": ConnectLoginParams;
  "connect.resume": ConnectResumeParams;
  "connect.logout": ConnectLogoutParams;
  "connect.launch": ConnectLaunchParams;
  "appmsg.send": AppMsgSendParams;
  "appmsg.list": AppMsgListParams;
  "appmsg.get": AppMsgGetParams;
}

export type MethodParams<M extends ProtocolMethod> = M extends keyof MethodParamsMap
  ? MethodParamsMap[M]
  : never;

export interface MethodResultMap {
  "identity.get": IdentityGetResult;
  "intent.sign": IntentSignResult;
  "cipher.encrypt": CipherEncryptResult;
  "cipher.decrypt": CipherDecryptResult;
  "p2pkh.transfer": P2pkhTransferResult;
  "feepool.prepare": FeepoolPrepareResult;
  "feepool.commit": FeepoolCommitResult;
  "connect.login": ConnectLoginResult;
  "connect.resume": ConnectResumeResult;
  "connect.logout": ConnectLogoutResult;
  "connect.launch": ConnectLaunchResult;
  "appmsg.send": AppMsgSendResult;
  "appmsg.list": AppMsgListResult;
  "appmsg.get": AppMsgGetResult;
}

export type MethodResult<M extends ProtocolMethod = ProtocolMethod> = M extends keyof MethodResultMap
  ? MethodResultMap[M]
  : never;

/* ============== AppMsg endpoint 字段命名校验 ============== */

/**
 * 在 Demo 侧判断 `pluginEndpointId` 字段命名的有效性。
 *
 * 关键约束（与 keymaster.cc 当前 shape 对齐）：
 *   - 必须以小写字母开头；
 *   - 允许小写字母 / 数字 / 下划线 + 至少一个点分隔段；
 *   - 整体长度上限 128；
 *   - 不允许连续点；不允许以点结尾。
 */
export function isValidPluginEndpointIdShape(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.length > 128) return false;
  const re = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
  return re.test(id);
}

/**
 * 在 Demo 侧判断 exact origin 字段命名的有效性。
 *
 * 关键约束：
 *   - port 是 origin 的一部分；
 *   - 不做 host-only 归一化；
 *   - 不做"443 可省略"二次归一化；
 *   - scheme 仅允许 http / https。
 */
export function isValidExactOriginShape(origin: string): boolean {
  if (typeof origin !== "string" || origin.length === 0) return false;
  const re = /^(https?):\/\/([^/:]+):(\d+)$/;
  return re.test(origin);
}

/* ============== Demo session ============== */

/**
 * 当前 demo session 的最小真值。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - session = `connectSessionId` + `ownerPublicKeyHex` + `resolvedClaims`
 *     摘要；
 *   - 后续业务方法表单默认引用当前 sessionId；用户仍可手改用于故障路径
 *     测试。
 *   - 只在 demo 自己内存 / localStorage 里存这一份最小字段；**不**存
 *     unlock runtime，**不**存 Keymaster 敏感材料。
 */
export interface DemoSessionSnapshot {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  /** 最近一次解析得到的 claims 摘要；按 method 分桶存最后一次快照。 */
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** 最近一次登录 / 恢复 / launch 的结果对象；用于 UI 展示。 */
  lastResponse: ConnectLoginResult | ConnectResumeResult | ConnectLaunchResult;
  /** 最近一次 session 真值的产生方式。 */
  source: "connect.login" | "connect.resume" | "connect.launch";
  /** 最近一次刷新时间（unix milliseconds）。 */
  refreshedAt: number;
}