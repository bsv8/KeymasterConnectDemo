# KeymasterConnectDemo 26 方法 / Channel / MSFile 硬切换施工单

## 1. 文档信息

- 日期：2026-09-18
- 涉及仓库：`KeymasterConnectDemo`、`keymaster.cc`（只读对照）
- 改造方式：硬切换，不保留 `appmsg.*` / `broadcast.*` 兼容壳，不保留已废弃事件。
- 核心目标：让 Demo 镜像的公开协议与 keymaster.cc 当前契约完全一致
  （26 方法 + 1 事件），并补齐 Channel / MSFile 工作台与测试。

## 2. 对照基准

- `packages/contracts/src/protocol.ts`（`PROTOCOL_METHODS`、错误码、feepool 结果）
- `packages/contracts/src/channel.ts`
- `packages/contracts/src/msfile.ts`
- `packages/contracts/src/appIdentity.ts`
- `packages/contracts/src/connectStorage.ts`
- `packages/connect/src/client.ts`（SDK 方法名与 transport 语义）

Demo 的立场不变：**不**依赖 keymaster.cc 内部包；类型与 builder 在
`src/lib/protocol.ts` / `src/lib/requestBuilders.ts` 显式镜像，用对照
keymaster 真值的方式暴露外部调用方偏差。

## 3. API 增删（相对上一版 27 方法 + 2 事件）

### 3.1 删除

- 方法：`appmsg.send`、`appmsg.list`、`appmsg.get`；
  `broadcast.publish`、`broadcast.subscription_set`、`broadcast.subscription_list`。
- 事件：`appmsg.message_received`、`broadcast.message_received`。
- 类型/错误：`AppMsg*`、`BroadcastMessagePublicView`、
  `isValidExactOriginShape`、`isValidPluginEndpointIdShape`。
- 工具链：HubCast 真实 smoke（`hubcast-real-smoke.ts`、
  `hubcast-vitest.config.ts`、`test:broadcast:smoke`）——上游已移除 HubCast。

### 3.2 新增

- 方法：`channel.publish`、`channel.subscription_set`；
  `msfile.stat`、`msfile.seed.read`、`msfile.block.read`。
- 事件：`channel.message_received`，data 为
  `{ channel, publisherPublicKeyHex, messageId, content: JSONValue }`。
- 错误码：13 个 `msfile_*` 稳定公开码。
- 类型：`ChannelSubscriptionStatus` / `ChannelSubscriptionPhase` /
  `JSONValue`、`MsFileSupplierStat` 家族、`MSFILE_*` 常量、
  `ProtocolFeePoolRecord`、`VerifiedAppIdentity`、`AppRequirement`。
- 命名对齐：`AppIdentityProof` → `AppIdentityProofV1`、
  `AppIdentityRequirement` → `AppRequirement`；
  `storage.upload.complete` 结果映射回 `StoragePutResult`。

### 3.3 同名 API 的语义变化

- `channel.*` 的 connect session 来自 Session Window transport context，
  **不**在 params 里携带 `connectSessionId`；必须先在同一窗口
  `connect.login` / `connect.resume`，且 Vault 锁定态直接失败。
- Channel 约束：精确频道、≤256 UTF-8 字节、禁控制字符与 `*`、
  禁 `bsv8.inbox.*`；订阅 ≤64 且去重；content 为 ≤16 层 JSON；
  发布配额 32 次/10s、512 KiB/10s、4 in-flight（服务端执行）。
- `msfile.*` 与 `storage.*` 同为 session-bound、要求已验证 App 身份，
  自动执行（无确认卡）；金额策略由 Keymaster 管理，caller 不能传价格。
- `feepool.prepare.priorPoolRecord` 收紧为具体可空类型；
  `feepool.commit` 结果新增 `poolRecord`。
- `connect.login.appIdentity` 在契约中可选；Demo 仍固定提交 HTML meta
  proof（需要 storage / msfile 身份）。

## 4. Demo 侧改动

| 文件 | 改动 |
| --- | --- |
| `src/lib/protocol.ts` | 26 方法表；Channel / MSFile / JSONValue 类型；13 个错误码；feepool 结果补 `poolRecord`、收紧 `priorPoolRecord`；删除 appmsg/broadcast 类型与校验 helper；命名对齐 |
| `src/lib/requestBuilders.ts` | 删除 6 个 builder；新增 `buildChannelPublishRequest` / `buildChannelSubscriptionSetRequest` / `buildMsFileStatRequest` / `buildMsFileSeedReadRequest` / `buildMsFileBlockReadRequest`；channel 频道 / JSON 深度校验；msfile 小写 hex 校验；channel builder 不带 sessionId |
| `src/lib/popupSessionClient.ts` | 事件白名单改为 `channel.message_received`；`isChannelMessageReceivedData` 递归校验 JSON content（≤16 层、plain object、key ≤256）；删除 appmsg/broadcast 校验器 |
| `src/lib/appIdentityProof.ts` | 类型更名到 `AppIdentityProofV1` / `AppRequirement` |
| `src/App.tsx` | AppMsg + Broadcast 合并为 Channel 工作台（publish / subscription_set / event queue / statuses），新增 MSFile 工作台（stat / seed.read / block.read + 256 字节预览与下载）；8 个工作台顺序为 Connect / Identity / Cipher / Transfer / Channel / Storage / MSFile / Test Wallet |
| `src/lib/channel.test.ts` | 新增 Channel / MSFile builder fail-closed 测试；删除 `broadcast.test.ts` |
| `src/lib/connectClient.test.ts` | 方法表断言 26；事件测试改为 channel；appView 跟随请求改用 `channel.subscription_set` |
| `scripts/e2e/*` | popup harness 增加 channel / msfile fixture；e2e 覆盖 Channel 订阅 / 发布 / 事件与 MSFile stat/read；删除 HubCast smoke |
| `README.md` | 26 方法 + 1 事件、8 工作台、Channel / MSFile 说明；移除 AppMsg / Broadcast / HubCast 章节 |

## 5. 不变量与边界

1. Channel params **不**出现 `connectSessionId`；工作台不提供 sessionId 输入框，
   只用提示文案说明会话来自当前 Session Window。
2. MSFile builder **不**接受金额字段；`msfile.*` 仍要求 sessionId 与
   已验证 App 身份快照。
3. 事件路径与请求路径同档严格：source + exact origin + 已知事件名 + 完整
   合法 data，任一不满足即丢弃且不改变连接状态。
4. MSFile 读取结果展示统一走 256 字节预览，完整字节只在 Download 动作使用，
   避免 16 MiB 内容进入 DOM。
5. SDK 包本身（`KeymasterConnectClient`、并发请求、`request_timeout` 等
   transport 语义）本轮**不**引入；Demo 继续保留自有的常驻 popup +
   单 in-flight + 顶层 cancel 模型。

## 6. 验证

- `npm test`：10 个测试文件 / 139 个用例通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run test:e2e`：Playwright production Chromium 通过，覆盖 Connect、
  Channel、Storage、MSFile 与 multipart，并核对 harness 收到的全部方法。

## 7. 顺带修复的历史遗留

- `src/lib/appMetadata.test.ts` 断言“生产入口没有 identity-signature”，
  与当前 `index.html` 以及 README 的“手工写回签名”流程矛盾，属于上一版
  遗留；已改为断言恰好一份签名 meta。
- `scripts/e2e/demo.spec.ts` 旧断言假设“业务完成后 popup 自动关闭、session
  被清空”，与 session-first 常驻 Session Window 语义不符；已改为
  “常驻窗口不关闭、第二次 login 复用同一窗口”，并删除从未发出的
  `connect.logout` 期望。
