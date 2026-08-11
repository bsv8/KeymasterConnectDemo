# KeymasterConnectDemo 27 方法 + Storage / Broadcast / App Identity 硬切换施工单

> 日期：2026-08-10
> 状态：代码实施、Demo 浏览器 E2E、Keymaster 服务层定向测试、真实 Broadcast / S3 Provider smoke 全部通过
> 实施方式：`luna_worker` 负责代码修改；主代理负责协议设计、实施核查、阻断问题回退与文档验收。
> 依赖真值：`/home/david/Workspaces/keymaster.cc/packages/contracts/src` 与 `packages/plugin-protocol/src` 当前代码。

## 1. 背景

KeymasterConnectDemo 当前仍镜像旧的 14 方法协议，并保留了以下已经过期的真值：

- `storage.*` 被描述为已删除；
- 未覆盖 `broadcast.*`；
- AppMsg 仍使用 generic endpoint 与 `appmsg.inbox_dirty`；
- `connect.login` 不能携带 App Identity；
- 顶层 event 只识别旧 dirty hint。

Keymaster 当前 Connect contract 已经硬切换到 27 个方法与两种完整消息 event：

- 原有身份、签名、加密、转账、FeePool、Connect：11 个；
- AppMsg：3 个；
- Broadcast：3 个；
- Storage：10 个；
- event：`appmsg.message_received`、`broadcast.message_received`。

本施工单要求 Demo 一次性镜像当前真值，不保留旧 AppMsg / Storage 兼容壳。

## 2. 目标

1. Demo 的 `PROTOCOL_METHODS` 与 Keymaster 当前 27 方法逐项一致。
2. 增加可真实操作、可观察、可复核的 Broadcast 与 Storage 工作台。
3. AppMsg 硬切到当前参数和完整消息 event。
4. 页面首次启动生成随机 secp256k1 publisher 私钥并持久化到 localStorage；刷新后维持同一 App Identity 与 Storage namespace。
5. 重新生成 publisher 私钥时先真实 logout，成功后把所有 session-bound 状态硬重置到初始态。
6. 保持 popup 常驻复用、appView opener transport、单 in-flight、顶层 cancel 与 exact-origin event 校验不回退。
7. 大文件 / 二进制测试不得把完整内容复制到日志、历史或 `<pre>`。

## 3. 非目标

- 不在 Demo 配置或展示 S3 Provider、Bucket、Endpoint、物理 Key、Access Key、Secret 或 Presigned URL。
- 不引入 Keymaster 内部 contracts 包作为运行时依赖；Demo 继续独立镜像公开 contract。
- 不做自动重试、自动 multipart 重传、自动 complete、自动递归删除或自动清理。
- 不让 Storage API 接受 caller 自报 publisher、app、namespace 或 provider 信息。
- 不在本次新增 mock server 或后端。
- 不把随机 publisher 私钥用于 Keymaster 钱包、Test Wallet 或链上签名。

## 4. 当前协议集合

### 4.1 27 个方法

```text
identity.get
intent.sign
cipher.encrypt
cipher.decrypt
p2pkh.transfer
feepool.prepare
feepool.commit
connect.login
connect.resume
connect.logout
connect.launch
appmsg.send
appmsg.list
appmsg.get
broadcast.publish
broadcast.subscription_set
broadcast.subscription_list
storage.list
storage.directory.create
storage.directory.delete
storage.put
storage.get
storage.delete
storage.upload.begin
storage.upload.part
storage.upload.complete
storage.upload.abort
```

### 4.2 顶层 event

- `appmsg.message_received`：携带完整公开 `AppMsgMessage`。
- `broadcast.message_received`：携带完整公开 Broadcast message，body 使用 base64。

两种 event 都是 server-pushed 单向消息：不回 result、不占用 in-flight 槽位、不改变连接状态。错误 origin、未知 event 或非法 data 必须 fail closed。

## 5. AppMsg 硬切换

### 5.1 `appmsg.send`

发送目标改为：

```text
recipientPublicKeyHex
recipientOrigin?   # exact origin
recipientAppId?    # plugin/app id
```

`recipientOrigin` 与 `recipientAppId` 必须恰好存在一个。删除旧的 `recipientOwnerPublicKeyHex + recipientEndpoint` 输入形态。

### 5.2 `appmsg.list`

只保留：

```text
connectSessionId
limit?
afterMessageId?
```

删除旧 `box` 与 `beforeMessageId`。

### 5.3 event

删除 `appmsg.inbox_dirty` 队列、类型、校验与文案，改为最多 60 条完整 `appmsg.message_received` 观察队列。

## 6. Broadcast 工作台

新增独立 Broadcast 工作台：

### 6.1 `broadcast.publish`

- `channelId`、`protocolId`、`clientMessageId` 非空；
- `createdAtMs` 为正安全整数；
- UI 输入正文文本，构包时编码为 base64；
- caller 不得自报 publisher 公钥；结果中的 `publisherPublicKeyHex` 来自 session owner 真值。

### 6.2 `broadcast.subscription_set`

- `channelIds` 是 exact string 集合；
- 语义是 replace，不是增量 add/remove；
- 空数组表示清空当前 caller 订阅；
- 不支持 wildcard / prefix。

### 6.3 `broadcast.subscription_list`

返回当前 connect session caller 自己贡献的订阅集合，不冒充 provider 全局订阅集合。

### 6.4 event 观察

保存最近 60 条 `broadcast.message_received`：channel、protocol、clientMessageId、时间、publisher、公用 base64 正文与有限文本预览。event 不伪装成 request result。

## 7. 持久化随机 App Identity

### 7.1 初始化

固定 localStorage key：

```text
keymaster-connect-demo.publisher-private-key.v1
```

页面启动：

1. 读取并验证已有 32-byte secp256k1 私钥；
2. 不存在或损坏时随机生成并写入；
3. localStorage 不可写时明确失败，不能声称身份已持久化；
4. React StrictMode 不得导致重复覆盖。

App 信息固定为：

```json
{
  "id": "keymaster-connect-demo",
  "name": "Keymaster Connect Demo"
}
```

签名规则：canonical JSON payload，前置 UTF-8 `keymaster-app-identity:v1` + `0x00`，SHA-256，secp256k1 compact 64-byte signature，公钥与签名使用小写 hex。

私钥只允许存在于 localStorage 和当前内存；不得进入 UI、日志、request、错误消息或协议观察历史。

### 7.2 `connect.login`

默认自动携带当前生成的 App Identity proof。成功后单独展示 Keymaster 返回的 verified snapshot，并比较本地 publisher/app/digest 与 session snapshot 是否一致。

`connect.resume` / `connect.launch` 只读取 session 已持久化的 snapshot；不得用本地 proof 偷偷升级旧 session。appView 的 Identity 由 launcher bootstrap 决定。

### 7.3 Regenerate publisher key

页首提供重新生成按钮。状态机固定为：

```text
busy                     -> 禁用
appView                   -> fail closed / 禁用并说明必须从 Keymaster 重新拉起
无 current session       -> 生成并持久化新 key -> 本地硬重置
有 current session       -> connect.logout
  logout 失败/取消       -> 不换 key、不清状态
  logout 成功            -> 生成并持久化新 key -> 本地硬重置
```

硬重置必须清除：

- 当前 session 与 sessionCache；
- popup/opener client 当前连接；
- 所有业务表单 sessionId、session-bound status/result/runtime；
- AppMsg / Broadcast event 队列；
- Broadcast subscription 表单真值；
- Storage cursor、uploadId、multipart file/progress、操作历史与下载 runtime。

硬重置保留：

- target origin / transport 配置；
- Test Wallet 与其 UTXO / 回款工具状态。

重新生成不自动 login。确认提示必须要求测试人员先删除测试对象并 abort multipart。

## 8. Storage 工作台

对外名称使用 `Storage (S3-backed)`。Demo 只处理相对 App namespace path。

### 8.1 Browse

`storage.list` 输入 `prefix/cursor/limit`；cursor 保持 opaque；结果显示 directories/files/markerPath/nextCursor，并允许显式回填下一页与文件 path/etag。

### 8.2 Directory marker

- `storage.directory.create(path, overwrite?)`
- `storage.directory.delete(path)`

删除 marker 不递归删除子对象。Demo 不提供递归删除按钮。

### 8.3 Small object

- `storage.put`：文本 / File、contentType、overwrite；
- `storage.get`：path、offset、length、ifMatch；
- `storage.delete`：幂等删除。

get 结果提供元数据、有限预览与显式 Download。最多 16 MiB 的正文不得全量 hex/base64 渲染。

### 8.4 Multipart

- begin 从 File 读取 path/contentType/size/overwrite；
- part 按 begin 返回的 partSize 与手工 partNumber 切 `File.slice`；
- 成功后可以推进下一 partNumber；
- complete / abort 必须手工触发；
- popup/session/provider generation 改变后，旧 uploadId 失败就直接暴露，不自动 begin。

### 8.5 路径与限制

- 相对路径；总长不超过 1024；segment 不超过 255；
- 禁止 leading slash、反斜线、NUL、控制字符、Unicode slash lookalike、空 segment、`.`、`..`；
- object path 不允许尾 slash；
- 单次 put/get/part 最大 16 MiB；
- list limit 1..1000；partNumber 1..10000；
- size/offset/length 使用 JS safe integer，并拒绝 range 溢出。

### 8.6 观察与内存

Storage 操作历史最多 30 条，只保存 sanitized params/result。二进制只展示 byteLength、mime 与有限 preview。文件对象、完整正文、credential、物理 key 不进入历史或持久化。

## 9. 工作台与共享 transport

最终 8 个工作台：

1. Connect
2. Identity
3. Cipher
4. Transfer
5. AppMsg
6. Broadcast
7. Storage
8. Test Wallet

27 个方法共用现有页面级 `PopupSessionClient`：popup 常驻复用、同一时刻单 in-flight、target origin 改变关闭旧连接、appView 只走 opener、顶层 cancel 保持现行语义。

## 10. 自动测试门槛

必须覆盖：

- 精确 27 方法集合；
- App Identity golden digest、签名验签、localStorage 复用、损坏恢复、不可写失败；
- regenerate 中 logout 失败不换 key、logout 成功才换 key并硬重置；
- 当前 AppMsg builders 与完整 event；
- Broadcast 三个 builder、replace/empty 语义与 event；
- Storage 十个 builder、路径、limit/range/part、File chunk 与 binary sanitize；
- 两种 event 的合法 origin、非法 origin、未知 event、与 result 交错、不改变连接状态；
- 既有 appView、popup reuse、cancel、identity/cipher/p2pkh/feepool/Test Wallet 回归测试。

合并门槛：

```bash
npm run test
npm run typecheck
npm run build
npm run test:e2e
npm run test:broadcast:smoke
```

五条命令必须全绿。真实 Provider I/O 另以 Keymaster 仓库的 opt-in
Storage smoke 执行，不得用纯前端单测冒充。

## 11. 端到端验收主路径

1. Demo production preview + Chromium：首次启动生成 publisher key，刷新后
   key 不变；`connect.login` proof 合法且 session snapshot matched。
2. Demo 经真实 `window.open` / popup / `postMessage` / `PopupSessionClient`：
   Broadcast set/list/publish 成功并收到完整 event。
3. Demo UI：Storage 目录 create/delete、put/list/get range/download/delete，
   multipart begin/part/complete/abort 全部经过生产 handler 与 builder。
4. Regenerate：实际发送 logout，popup 关闭，session、Storage、Broadcast、
   event/result/runtime 全部回初始态，同时保留 target origin；不会自动 login。
5. 第二次手工 login：publisher key / proof 已改变，session snapshot 仍 matched。
6. 真实 Provider：HubCast 两条 WSS 连接完成 bind、set/list、publish/receive、
   clear/close；AWS S3、Cloudflare R2 与 S3-compatible 完成隔离前缀下的
   probe/list/conditional put/range/multipart complete/abort/cancel/cleanup。

## 12. 实施记录

### 12.1 实施结果

已由 `luna_worker` 完成代码实施，主代理按本施工单逐项核查并多轮退回阻断问题。最终落地：

- `src/lib/protocol.ts`
  - 镜像当前 27 方法、两种完整消息 event、App Identity、Broadcast、Storage 类型与错误码；
  - 删除旧 AppMsg endpoint / dirty event 合同。
- `src/lib/requestBuilders.ts`
  - AppMsg 硬切当前 send/list 参数；
  - 增加 Broadcast 3 个与 Storage 10 个 builder；
  - 对 session、XOR target、base64、路径、limit、range、payload、part 与 uploadId fail closed。
- `src/lib/popupSessionClient.ts`
  - exact-origin 接收两种完整 event；
  - 对 AppMsg / Broadcast 完整公开字段做类型、XOR、时间、公钥与 base64 校验；
  - malformed / unknown / wrong-origin event 不影响 connection 或 in-flight result。
- `src/lib/appIdentity.ts`
  - 页面级持久化随机 secp256k1 publisher key；
  - RFC 8785 受限 payload canonicalization、domain-separated SHA-256 与 compact signature；
  - 支持原子生成并覆盖新 publisher key。
- `src/lib/regenerate.ts`
  - 固化 `logout -> replace key -> hard reset` 顺序；logout / replace 失败不进入后续阶段。
- `src/lib/storageUi.ts`
  - 二进制有限预览与递归脱敏；
  - multipart File slice 与 safe-integer overflow 防线。
- `src/App.tsx`
  - 8 个工作台覆盖 27 方法；
  - 页首 Publisher App Identity、session snapshot 匹配状态与 Regenerate；
  - Broadcast 3 方法与完整 event 队列；
  - Storage 10 方法、文件、range download、cursor、multipart 和有限历史；
  - AppMsg 当前字段与完整 message event；
  - Regenerate 成功后完整清理 session-bound 状态，同时保留 target origin 与 Test Wallet。
- 自动测试新增或扩展：
  - `appIdentity.test.ts`
  - `regenerate.test.ts`
  - `broadcast.test.ts`
  - `storage.test.ts`
  - `connectClient.test.ts`
  - `feepool.test.ts`

### 12.2 主代理独立验收

2026-08-10 在 `/home/david/Workspaces/KeymasterConnectDemo` 完成实施验收；随后按用户要求再次做协议真值、启动接线、transport source/origin 与 Storage 文件路径专项复查。最终独立重跑：

```text
npm run test       -> 11 test files passed, 155 tests passed
npm run typecheck  -> passed, 0 TypeScript errors
npm run build      -> passed
npm run test:e2e   -> production preview + Chromium, 1 passed
npm run test:broadcast:smoke -> real HubCast WSS, 1 passed
git diff --check   -> passed
```

静态硬切换扫描通过：`src` 不再包含旧 `appmsg.inbox_dirty`、
`recipientEndpoint`、`recipientOwnerPublicKeyHex`、`beforeMessageId`、
`AppMsgDirty`、14/16 方法旧说明或代码级 `any`。

与 `/home/david/Workspaces/keymaster.cc/packages/contracts/src/protocol.ts`
逐项比较，`PROTOCOL_METHODS` 顺序与内容完全一致，共 27 项；本次用于比较的
上游 protocol / appIdentity / appmsg / storage 真值文件没有未提交修改。

### 12.3 复查发现与修复闭环

本次复查没有只依赖原有全绿测试，而是重新检查了 App 的真实接线与浏览器
消息边界，发现并闭环以下问题：

1. **刷新覆盖 publisher key（阻断）**：App 启动曾误接
   `generateAndStorePublisherPrivateKey()`，会在每次刷新覆盖 localStorage。
   已改为生产路径调用 `loadOrCreatePublisherIdentity()`；只有 Regenerate
   才强制生成覆盖。新增连续两次启动身份稳定、损坏 key 才替换、不可写
   fail-closed 测试。
2. **消息只绑 origin、未绑 source（安全阻断）**：result、closing 与两种
   event 已统一要求 `event.source === 当前 popup/opener` 且 origin 精确匹配；
   wrong-source、非字符串、`null`、opaque 与非法 origin 均忽略，不改变
   connection / in-flight。新增四类 wrong-source 与非法 origin 回归测试。
3. **日志与文件 I/O 收口**：`connect.login` 发出的真实 request 仍带完整
   App Identity proof，但 console/onLog 视图会把 signature 写成
   `[redacted]`。Small object File 在读取前先按 16 MiB 上限预检，超限直接
   提示使用 multipart；Download 使用 `storage.get` 响应的真实 path 与
   contentType/mime，raw bytes 仍不进入 result/history/state。

生产构建仍有 Vite 的单 chunk `> 500 kB` 警告；这是非阻断性能提示，不影响本次协议正确性验收。

### 12.4 分层端到端实测结果

本轮已执行，不再保留“待人工”施工项：

- **Demo 浏览器生产路径**：`npm run test:e2e`，Playwright Chromium 1/1
  通过。受控 popup harness 只替代交互式用户确认页，实际使用 Demo 的生产
  build、UI、`window.open`、`postMessage`、source/origin 校验、
  `PopupSessionClient`、handlers 与状态重置，不直接调用 request builders
  冒充 E2E。
- **Keymaster 浏览器基础环境**：在 `keymaster.cc` 执行 `pnpm test:e2e`，
  production build + Chromium 1/1 通过，IndexedDB / WebCrypto 可用。
- **Keymaster 服务层**：定向执行 App Identity、Broadcast、Storage
  `protocolService` 测试，3 files / 20 tests 全部通过。
- **真实 Broadcast Provider**：`npm run test:broadcast:smoke` 对默认
  `wss://cast.keymaster.cc/ws/v1` 执行双 signer，bind、subscription
  set/list、publish、另一端 receive、clear/close，1/1 通过。
- **真实 S3 Provider**：在 `keymaster.cc` 以
  `KEYMASTER_STORAGE_SMOKE_PROVIDER=all pnpm test:storage:smoke` 执行；
  AWS S3、Cloudflare R2、S3-compatible 3/3 通过。每家都使用唯一
  `keymaster-smoke/<runId>/` 子树并在 `finally` 清理。

受控 harness、HubCast smoke 与 Provider smoke 都不会记录或输出私钥、
S3 credential。真实 S3 `.env` 保持 `0600` 且由 Git ignore。

### 12.5 未提交文件最终 Review 闭环

最终 Review 继续采用“主代理设计与核查、`luna_worker` 实施”的职责边界，
补齐以下三个阻断问题：

1. **result 日志泄漏二进制**：`result_received` 现在对完整结果递归执行
   `sanitizeValue` 后再写日志，Storage / Cipher 等 `BinaryField` 只保留类型与
   `byteLength` 摘要；业务 Promise 仍解析原始消息，下载等运行时路径不受影响。
2. **AppMsg endpoint 显式 `undefined` 被误拒绝**：endpoint 二选一只把
   非 `undefined` 的有效字段计为已提供；空串、`null`、非法 origin / appId
   以及两个有效 endpoint 仍 fail closed。测试同时覆盖 origin 与 appId 两条
   合法显式 `undefined` 路径。
3. **Regenerate 状态清理不完整**：hard reset 新增清空 Connect
   `launchToken`、Cipher decrypt 的 `nonce` / `cipherbytes`，以及 FeePool
   commit 的 `operationId` / `counterpartyPublicKeyHex`。浏览器 E2E 先写入
   sentinel，再切换各工作台逐项确认清空。

首轮实施后，主代理独立 `typecheck` 发现 endpoint helper 缺少 TypeScript
字符串收窄（`TS2345`），当即退回同一 `luna_worker` 修正；最终核查未遗留
阻断问题或错误。最终复验结果：

```text
npm test          -> 11 test files passed, 156 tests passed
npm run typecheck -> passed, 0 TypeScript errors
npm run build     -> passed（仅既有 chunk size warning）
npm run test:e2e  -> production preview + Chromium, 1 passed
git diff --check  -> passed
```
