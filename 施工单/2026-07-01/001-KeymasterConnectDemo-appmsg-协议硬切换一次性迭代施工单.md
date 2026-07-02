# KeymasterConnectDemo appmsg 协议硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下文档与代码为准：

- 依赖项目 `keymaster.cc`
  - `/home/david/Workspaces/keymaster.cc/packages/contracts/src/protocol.ts`
  - `/home/david/Workspaces/keymaster.cc/packages/contracts/src/appmsg.ts`
  - `/home/david/Workspaces/keymaster.cc/packages/plugin-protocol/src/protocolService.ts`
  - `/home/david/Workspaces/keymaster.cc/docs/keymaster-connect-v1-draft.md`
  - `/home/david/Workspaces/keymaster.cc/施工单/2026-07-01/001-remove-s3-storage-and-protocol-storage-hard-switch.md`
  - `/home/david/Workspaces/keymaster.cc/施工单/2026-07-01/002-protocol-appmsg-bus-hard-switch.md`
  - `/home/david/Workspaces/keymaster.cc/施工单/2026-07-01/003-appmsg-v1-frozen-protocol-alignment.md`
- 本仓库现状代码
  - `src/lib/protocol.ts`
  - `src/lib/requestBuilders.ts`
  - `src/lib/connectClient.ts`
  - `src/lib/popupSessionClient.ts`
  - `src/App.tsx`
  - `src/lib/connectClient.test.ts`
  - `README.md`
  - `docs/KeymasterConnectDemo-首版设计.md`
- 本仓库既有施工单
  - `施工单/2026-06-29/002-新版-connect-协议-全面测试-demo-硬切换施工单.md`
  - `施工单/2026-06-30/001-KeymasterConnectDemo-appview-child-ready-and-opener-launch-硬切换施工单.md`
  - `施工单/2026-06-30/002-KeymasterConnectDemo-launch-session-window-origin-显式注入-硬切换施工单.md`

发生冲突时：

1. 本单关于 Demo 现行能力面的定义优先。
2. 本单未覆盖的协议字段真值，以 `keymaster.cc` 当前 contract 与施工单为准。
3. 后续若再改 Demo 的现行协议方法集，必须先改本单和 Demo 文档，再改代码，不允许只改实现。

---

## 1. 本单定位

本单不是给旧 Demo 打一个“storage 先隐藏、底层先留着”的软补丁。

本单定义的是一次**硬切换**：

- Demo 彻底删除现行 `storage.*` 测试能力；
- Demo 协议镜像从旧 16 方法切到现行 14 方法：
  - `identity.get`
  - `intent.sign`
  - `cipher.encrypt`
  - `cipher.decrypt`
  - `p2pkh.transfer`
  - `feepool.prepare`
  - `feepool.commit`
  - `connect.login`
  - `connect.resume`
  - `connect.logout`
  - `connect.launch`
  - `appmsg.send`
  - `appmsg.list`
  - `appmsg.get`
- transport 顶层消息从
  - `ready / request / result / closing / cancel`
  扩成
  - `ready / request / result / closing / cancel / event`
- 页面一级工作台从
  - `Connect / Identity / Cipher / Transfer / Storage / Test Wallet`
  改成
  - `Connect / Identity / Cipher / Transfer / AppMsg / Test Wallet`
- Demo 新增 `appmsg.inbox_dirty` 的被动事件观察能力。

这次目标不是“尽量少改页面”，而是让这个 Demo 再次成为**和当前 Keymaster 现行协议一致的外部调用方测试台**。

---

## 2. 简述缘由

### 2.1 Demo 当前真值已经明显落后于 server

当前 Demo 仍然把 `storage.*` 当作现行能力，并且 `src/lib/protocol.ts` 里没有 `appmsg.*`，也没有顶层 `event`。

但 `keymaster.cc` 当前现行真值已经明确：

- `storage.*` / S3 provider 被硬删除；
- `appmsg.send` / `appmsg.list` / `appmsg.get` 成为正式对外方法；
- transport 新增 server-pushed `event`，当前只定义 `appmsg.inbox_dirty`。

如果 Demo 不跟着切，它测出来的将不再是“当前协议是否成立”，而只是“旧 Demo 还能不能点通旧按钮”。

### 2.2 这是能力面硬变化，不是字段级小补丁

这次变化不是“给某个旧方法多加一个字段”，而是：

- 删除一整族方法；
- 增加一整族新方法；
- 增加一种新的顶层消息方向；
- 增加一块新的页面工作台与观察模型。

如果做兼容层：

- 现行代码里会同时存在“已删除能力”和“新增能力”；
- UI 会把历史能力继续包装成“像是还支持”；
- transport 会继续假设只有 `result` 和 `closing` 两类异步收包；
- 测试结果会掺杂“兼容层行为”和“真实协议行为”。

这与项目“简单优先、失败直接暴露、不留半死兼容层”的原则冲突。

### 2.3 Demo 必须保持独立调用方身份

这个 Demo 的价值在于它是**独立外部调用方**，不是 `keymaster.cc` 站内页面。

所以这次即使要对齐最新协议，也不能：

- 直接把 `keymaster.cc` runtime 当 SDK 用；
- 直接把 `plugin-protocol` 的 UI 搬过来；
- 直接依赖 `keymaster.cc` 内部 service 真值。

正确做法仍然是：

- 镜像外表面 contract；
- 独立构包；
- 独立发包；
- 独立展示 raw result / event；
- 独立做测试与观察。

### 2.4 appmsg 需要独立工作台，而不是塞进现有角落

`appmsg.*` 不是 storage 的轻量替代品，也不是“再加三个按钮”就够了。

它至少有三类明显不同的测试需求：

1. 主动发消息 `send`
2. 主动拉消息 `list/get`
3. 被动看 server 推来的 `inbox_dirty`

因此最合理的做法是把 `Storage` 工作台整体替换为 `AppMsg` 工作台，而不是把 `appmsg.*` 零散塞进 Connect 或 Observer 边角。

---

## 3. 最终目标

本次完成后，Demo 必须达到以下状态：

1. `src/lib/protocol.ts` 与 `keymaster.cc` 当前现行协议外表面对齐。
2. Demo 中不再存在现行 `storage.*` 能力、状态、构包器、文案、测试断言。
3. Demo 中存在 `appmsg.send` / `appmsg.list` / `appmsg.get` 的完整测试入口。
4. Demo transport 能接收并展示顶层 `event` 报文。
5. Demo 页面能看到最近收到的 `appmsg.inbox_dirty` 队列。
6. `appmsg.*` 继续遵守 session-first 模型，强制要求 `connectSessionId`。
7. Demo 不允许外部表单自报 sender owner / sender endpoint。
8. Demo 中 `recipientEndpoint` 显式可配，支持：
   - `kind = "origin"`
   - `kind = "plugin"`
9. README、设计文档、测试用例都同步到新真值。
10. 除历史施工单外，仓库中不应继续把 `storage.*` 当成现行能力描述。

---

## 4. 单真值定义

### 4.1 现行协议方法集

本次固定：

```txt
PROTOCOL_METHODS
  = 14 个现行方法
  = connect.* + identity / intent / cipher / p2pkh / feepool + appmsg.*
```

关键约束：

1. Demo 不再承诺 `storage.put/get/list/listAll/delete`。
2. Demo 不做“旧方法保留但点击时报错”的伪兼容。

### 4.2 AppMsg 对外命名

本次固定：

```txt
UI / contract / request builder / observer
  一律使用 appmsg.*
```

关键约束：

1. 对外协议名是 `appmsg.*`，不是 `hubmsg.*`。
2. `HubMsg` 只作为底层承载背景存在，不作为 Demo 对外方法命名。

### 4.3 顶层事件报文

本次固定：

```txt
ProtocolEventMessage
  = { v, type: "event", event: "appmsg.inbox_dirty", data }
```

关键约束：

1. `event` 是 server-pushed 单向消息，不回 result。
2. `event` 不占用当前 in-flight request 槽位。
3. `event` 不改变连接状态。
4. `event` 当前只支持 `appmsg.inbox_dirty` 一种事件名。

### 4.4 AppMsg sender 真值

本次固定：

```txt
sender
  = connectSessionId 绑定 owner
  + 当前 event.origin 对应的 origin endpoint
```

关键约束：

1. Demo 表单里不允许出现 sender owner 字段。
2. Demo 表单里不允许出现 sender endpoint 字段。
3. 任何 `fromOrigin` / `fromAppId` / `senderEndpoint` 风格字段都视为伪造输入，不进入对外请求构包。

### 4.5 AppMsg recipient 真值

本次固定：

```txt
recipient
  = recipientOwnerPublicKeyHex + recipientEndpoint
```

其中：

```txt
recipientEndpoint
  = { kind: "origin", id: exactOrigin }
  | { kind: "plugin", id: pluginEndpointId }
```

关键约束：

1. `origin` 类型必须是完整 exact origin。
2. `plugin` 类型必须符合稳定 shape。
3. Demo 不做 host-only 归一化，不自行省略端口。

### 4.6 AppMsg 内容边界

本次固定：

```txt
contentType
  = "text/plain" | "text/markdown"
```

关键约束：

1. v1 不支持附件。
2. v1 不支持二进制正文。
3. v1 不支持未读计数、已读回执、撤回、群聊。

### 4.7 Dirty event 的定位

本次固定：

```txt
appmsg.inbox_dirty
  = 脏提示
  != 正文真值
```

关键约束：

1. 收到 dirty event 后，正文仍然要靠 `appmsg.list` / `appmsg.get` 拉。
2. Demo observer 可以展示 dirty event 历史，但不能把 dirty event 当成消息正文缓存真值。

---

## 5. 怎么做

### 一、协议镜像层一次性切到现行 appmsg 真值

修改 `src/lib/protocol.ts`：

- 删除 `storage.*` 方法名、参数、结果、辅助类型；
- 删除 `not_found` 协议错误码；
- 新增 `ProtocolEventMessage`；
- 扩 `ProtocolMessage` 联合类型，让它包含 `event`；
- 新增 `appmsg.*` 所需的最小协议类型：
  - `AppMsgEndpoint`
  - `AppMsgAddress`
  - `AppMsgContentType`
  - `AppMsgListBox`
  - `AppMsgMessage`
  - `AppMsgInboxDirtyEventData`
  - `AppMsgSendParams`
  - `AppMsgListParams`
  - `AppMsgGetParams`
  - `AppMsgSendResult`
  - `AppMsgListResult`
  - `AppMsgGetResult`
- 更新 `PROTOCOL_METHODS`、`MethodParamsMap`、`MethodResultMap`。

要求：

1. 字段形状以 `keymaster.cc/packages/contracts/src/protocol.ts` 与 `appmsg.ts` 为准。
2. Demo 只镜像协议外表面，不复制 `keymaster.cc` 内部平台能力接口。
3. 所有注释、文档说明改成中文；错误信息字面量继续英文。

### 二、构包层从 storage builder 切到 appmsg builder

修改 `src/lib/requestBuilders.ts`：

- 删除：
  - `buildStoragePutRequest`
  - `buildStorageGetRequest`
  - `buildStorageListRequest`
  - `buildStorageListAllRequest`
  - `buildStorageDeleteRequest`
- 新增：
  - `buildAppMsgSendRequest`
  - `buildAppMsgListRequest`
  - `buildAppMsgGetRequest`
- 统一校验：
  - `connectSessionId` 必填
  - `contentType` 只允许 `text/plain` / `text/markdown`
  - `recipientEndpoint.kind = "origin"` 时必须是完整 origin
  - `recipientEndpoint.kind = "plugin"` 时必须匹配插件端点 shape
  - `messageId` / `clientMessageId` / `body` 非空

要求：

1. 不在 builder 里偷偷补 sender 字段。
2. 不保留 storage builder 的 deprecated 壳。
3. endpoint 校验规则与 `keymaster.cc` 当前 shape 对齐。

### 三、transport 保持最小增量，不重写会话模型

修改 `src/lib/connectClient.ts`：

- 保留现有 `result` dispatcher 核心职责；
- 在类型层引入 `ProtocolEventMessage`；
- 若现有 dispatcher 只处理 result，就保持它只做 result，不把 event 也硬塞进去；
- 由上层 `PopupSessionClient` 直接处理 `event` 更简单。

要求：

1. 不因为加 `event` 就把现有 result 派发逻辑整段推倒重来。
2. 不引入第二套 transport 状态机。
3. 不把 `event` 做成“伪 request + 伪 result”。

### 四、PopupSessionClient 增加 event 收包能力

修改 `src/lib/popupSessionClient.ts`：

- 继续维持现有：
  - 单 popup session
  - 单 in-flight request
  - `result` 与 `closing` 收口
- 新增页面级 `event` 分发能力，推荐做法：
  - 在 `PopupSessionClientOptions` 里新增 `onEvent?: (message: ProtocolEventMessage) => void`
  - 在现有 `combinedListener` 中处理 `event`
  - origin 校验通过后，直接回调给上层

关键要求：

1. `event` 到来时不能占用 `inFlight`。
2. `event` 到来时不能把连接状态切到 `connected` / `disconnected` 以外的新状态。
3. `event` 与 `result` 可以交错到达，不能互相覆盖。
4. `event` 监听必须在 popup session 生命周期内长期有效，而不是只在某次 request 期间有效。

### 五、App.tsx 用 AppMsg 工作台整体替换 Storage 工作台

修改 `src/App.tsx`：

- 一级工作台枚举从 `storage` 改为 `appmsg`
- 删除全部 storage 相关 state、submit、observer、section、状态聚合
- 新增 appmsg 相关 state，最少包括：
  - `appmsgSend`
  - `appmsgList`
  - `appmsgGet`
  - `appmsgDirtyEvents`
- 将 `Storage` 工作台完整替换为 `AppMsg` 工作台

建议工作台布局：

1. `appmsg.send`
   - `connectSessionId`
   - `recipientOwnerPublicKeyHex`
   - `recipientEndpoint.kind`
   - `recipientEndpoint.id`
   - `contentType`
   - `body`
   - `clientMessageId`
   - `createdAtMs`
2. `appmsg.list`
   - `connectSessionId`
   - `box`
   - `limit`
   - `afterMessageId`
   - `beforeMessageId`
3. `appmsg.get`
   - `connectSessionId`
   - `messageId`
4. `dirty event` 观察区
   - 最近事件列表
   - 最近一次事件详情

要求：

1. observer 区继续展示 request / raw result / inspection 风格，不改总模式。
2. `dirty event` 单独展示，不混入某个 request 的 raw result 面板。
3. `connectSessionId` 仍然沿用“当前 session 默认填充，但允许手改”的策略。

### 六、AppMsg 表单边界要显式 fail-closed

在 `src/App.tsx` 提交逻辑和表单约束里明确：

- `recipientEndpoint.kind = "origin"` 时
  - `recipientEndpoint.id` 必须是完整 origin
- `recipientEndpoint.kind = "plugin"` 时
  - `recipientEndpoint.id` 必须匹配 `^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$`
- `body` 不能为空
- `contentType` 非法直接表单报错
- `messageId` 不能为空

要求：

1. 不做“用户乱填也先发出去试试”的宽松模式。
2. 表单层先拦，server 侧再拦，保持双重 fail-closed。

### 七、observer 与日志区补充 event 观察

修改 `src/App.tsx` observer / log 相关逻辑：

- 继续保留 request / result / protocol log；
- 新增 `appmsg.inbox_dirty` 事件观察面板；
- protocol log 可增加一条简洁 event 记录，例如：
  - `stage = "event_received"`
  - `detail = { event: "appmsg.inbox_dirty", ... }`

要求：

1. event 观察必须是独立面板，不假装是某条 request 的 response。
2. 事件多次到达时按时间倒序或新到追加展示，行为固定即可，不做复杂分页。
3. 不做本地未读计数真值。

### 八、文档与说明同步硬切

修改：

- `README.md`
- `docs/KeymasterConnectDemo-首版设计.md`

需要同步：

- 删除所有“当前支持 `storage.*`”描述；
- 新增 `appmsg.*` 与 `appmsg.inbox_dirty` 的使用说明；
- 把一级工作台说明改成 `AppMsg`；
- 明确 `storage.*` 已在 `2026-07-01` 后不再是现行能力。

要求：

1. 现行文档不保留“storage 暂时不可用”这类过渡说法。
2. 历史施工单不改。

### 九、测试一起硬切

修改 `src/lib/connectClient.test.ts`：

- 更新 `PROTOCOL_METHODS` 断言：
  - 删除 5 个 `storage.*`
  - 增加 3 个 `appmsg.*`
- 新增 event 相关测试，至少覆盖：
  - `PopupSessionClient` 收到 `event` 时会调用 `onEvent`
  - `event` 不影响当前 in-flight request
  - 非法 origin 的 `event` 被忽略
  - `closing` 与 `event` 同时出现时仍以 `closing` 收敛连接

若有必要，可补充：

- endpoint 输入 shape 测试
- builder 对非法 contentType 的拒绝测试

要求：

1. 不把测试留在旧 `storage.*` 真值上。
2. 不用“测试先跳过”作为交付形态。

---

## 6. 文件级施工范围

### `src/lib/protocol.ts`

- 硬删除 `storage.*` contract
- 新增 `appmsg.*` contract
- 新增 `ProtocolEventMessage`
- 更新 `ProtocolMessage` 联合类型
- 更新错误码集合

### `src/lib/requestBuilders.ts`

- 删除 storage builders
- 新增 appmsg builders
- 增加 endpoint / contentType / 非空字段校验

### `src/lib/connectClient.ts`

- 补充 `ProtocolEventMessage` 类型引用
- 保持 result dispatcher 简单
- 如有需要，补充事件日志 stage 类型

### `src/lib/popupSessionClient.ts`

- 在现有 listener 中接收 `event`
- 向 `App.tsx` 暴露 `onEvent` 回调
- 保持单 in-flight 模型不变

### `src/App.tsx`

- 一级工作台 `storage -> appmsg`
- 全量删掉 storage 状态、表单、submit、observer
- 新增 appmsg 状态、表单、submit、observer、dirty event 队列
- 接上 `PopupSessionClient.onEvent`

### `src/lib/connectClient.test.ts`

- 更新方法集断言
- 增加 event 收包测试
- 删掉 storage 相关旧断言

### `README.md`

- 删除 storage 现行说明
- 增加 appmsg 使用说明
- 更新工作台清单与方法清单

### `docs/KeymasterConnectDemo-首版设计.md`

- 删除 storage 现行能力描述
- 增加 appmsg 工作台、事件观察、transport event 说明
- 让文档与当前实现目标一致

### `src/styles.css`

- 只做必要样式调整
- 把 `Storage` 区相关的现行样式命名和文案适配为 `AppMsg`
- 不趁机做无关重构

---

## 7. 不能怎么做

1. 不能保留一个“还叫 Storage，但按钮点了报 unsupported”的现行工作台。
2. 不能把 `appmsg.*` 命名成 `hubmsg.*` 暴露给 Demo 用户。
3. 不能让 Demo 表单自报 sender owner / sender endpoint。
4. 不能把 `appmsg.inbox_dirty` 当消息正文真值。
5. 不能为了 `event` 引入第二套 transport 状态机。
6. 不能让 `event` 占用 in-flight request 槽位。
7. 不能继续保留 `not_found` 当现行公开错误码，只因为旧 storage 用过它。
8. 不能修改历史施工单，把过去写成像现在就这样。
9. 不能顺手重构整个 `App.tsx` 状态组织，只改和本单直接相关的部分。
10. 不能为了将来想象中的附件、未读计数、聊天页，先发明一套超前抽象。

---

## 8. 特殊情况与处理

### 8.1 收到 `appmsg.inbox_dirty`，但当前不在 AppMsg 工作台

处理：

- 事件照收；
- 追加到页面级 dirty event 队列；
- 不强行切换工作台；
- 由用户自己决定何时切到 `AppMsg` 做 `list/get`。

原因：

- 这是被动提示，不是强制导航命令。

### 8.2 收到 `event` 时正有 request 在途

处理：

- `event` 正常收下；
- 当前 request 继续等待自己的 `result`；
- 两者互不抢占。

原因：

- `event` 是带外消息，不是 request 生命周期的一部分。

### 8.3 收到非法 origin 的 `event`

处理：

- 直接忽略；
- 如现有日志体系允许，可写一条本地错误日志；
- 不改变连接状态。

原因：

- transport 真值仍然以 exact origin 校验为准。

### 8.4 `appmsg.get` 请求的 `messageId` 不存在

处理：

- Demo 只展示 server 返回的原始协议错误；
- 不自行把它翻译成“not_found”；
- 不做本地补偿猜测。

原因：

- 现行公开协议不再靠旧 storage 的 `not_found` 语义建模。

### 8.5 `recipientEndpoint.kind = "plugin"` 但用户填了非法 `endpointId`

处理：

- 表单层直接拒绝提交；
- 错误信息明确指出 shape 非法；
- 不发请求。

原因：

- 这是本地可确定的无效输入，不值得送到 server 再失败一次。

### 8.6 `recipientEndpoint.kind = "origin"` 但用户填了 host-only 或缺 scheme

处理：

- 表单层直接拒绝；
- 必须要求完整 origin。

原因：

- exact origin 是协议真值，不允许猜。

### 8.7 Popup 关闭后又来了新 event

处理：

- 由于 session 已断开，Demo 本地不会再收到 event；
- 不做本地重放；
- 用户下次重新建立 popup session 后继续测试。

原因：

- 本单不引入 replay / reconnect queue。

### 8.8 appView 启动路径下收到 dirty event

处理：

- 只要 transport 已 adopt 且 listener 已装好，就与 direct 模式同样处理；
- 不为 appView 再做第二套 event 逻辑。

原因：

- event 是 transport 层统一语义，不应按启动路径分叉。

### 8.9 历史本地缓存里残留旧 storage 观察数据

处理：

- Demo 不做迁移；
- 直接丢弃旧内存态 / 旧 local state；
- 只保留 session 缓存最小字段。

原因：

- 旧 storage 本身已不是现行能力，没有迁移价值。

---

## 9. 最终验收清单

### 一、协议镜像

- [ ] `src/lib/protocol.ts` 的方法集已从 `storage.*` 切到 `appmsg.*`。
- [ ] `ProtocolEventMessage` 已存在，且只定义 `appmsg.inbox_dirty`。
- [ ] Demo 侧错误码集合不再保留现行 `not_found`。

### 二、构包与校验

- [ ] `src/lib/requestBuilders.ts` 中已不存在 storage builder。
- [ ] `buildAppMsgSendRequest` / `buildAppMsgListRequest` / `buildAppMsgGetRequest` 已存在。
- [ ] appmsg builder 不允许 caller 自报 sender 字段。
- [ ] plugin endpoint 与 exact origin 的 shape 校验已落地。

### 三、transport 与会话

- [ ] `PopupSessionClient` 可以长期接收顶层 `event`。
- [ ] `event` 不影响当前 in-flight request。
- [ ] `closing` 仍然能正常把会话收敛到 `disconnected`。

### 四、页面工作台

- [ ] 一级工作台中已无 `Storage`，改为 `AppMsg`。
- [ ] `AppMsg` 工作台有 `send` / `list` / `get` 三个主动测试区。
- [ ] 页面能看到 `appmsg.inbox_dirty` 的最近事件列表。

### 五、observer 与日志

- [ ] observer 区能分别看到 `appmsg.send` / `appmsg.list` / `appmsg.get` 的 request 与 raw result。
- [ ] dirty event 独立展示，不伪装成某个 request 的 response。
- [ ] 非法 origin event 不会污染 observer 真值。

### 六、文档

- [ ] `README.md` 不再把 `storage.*` 当成现行能力。
- [ ] `README.md` 已新增 `appmsg.*` 与 dirty event 说明。
- [ ] `docs/KeymasterConnectDemo-首版设计.md` 已与现行能力面对齐。

### 七、测试

- [ ] `src/lib/connectClient.test.ts` 的方法集断言已更新为现行 14 方法。
- [ ] 已有 event 收包相关测试。
- [ ] 不再存在把 `storage.*` 当现行能力的测试断言。

### 八、整体行为

- [ ] Demo 作为独立外部调用方，能够继续：
  - `connect.login`
  - `connect.resume`
  - `connect.logout`
  - `connect.launch`
  - `identity.get`
  - `intent.sign`
  - `cipher.*`
  - `p2pkh.transfer`
  - `feepool.*`
  - `appmsg.*`
- [ ] 现行仓库中除历史施工单外，不再把 `storage.*` 描述为当前存在能力。

