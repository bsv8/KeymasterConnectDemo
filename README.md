# Keymaster Connect Demo

独立的外部调用方 demo，用来验证 Keymaster Connect V1 的 **14 个方法 + 1 种顶层 event**：

- `identity.get` / `intent.sign`
- `cipher.encrypt` / `cipher.decrypt`
- `p2pkh.transfer`
- `feepool.prepare` / `feepool.commit`
- `connect.login` / `connect.resume` / `connect.logout` / `connect.launch`
- `appmsg.send` / `appmsg.list` / `appmsg.get`
- 顶层 server-pushed `event`（V1 仅 `appmsg.inbox_dirty`）

并附带一个**测试钱包 + 手动一键回款工具**：

- 持有一把 demo 自己的测试私钥（内存态，不接触 Keymaster 私钥）；
- 生成主网 P2PKH 地址 + 压缩公钥 hex；
- 提供 WOC（WhatsOnChain）UTXO 查询；
- 提供本地主网 P2PKH 转账构造 / 签名 / 广播，用于手动把测试钱包里的 satoshis 转回 Keymaster 当前地址。

demo 是 **session-first** 外部调用方：先 `connect.login` / `connect.resume` / `connect.launch` 拿到 `connectSessionId`，再以该 sessionId 调用 `identity.get` / `intent.sign` / `cipher.*` / `p2pkh.transfer` / `feepool.*` / `appmsg.*` 等业务方法。transport 层支持顶层 `cancel` 与 server-pushed 顶层 `event`。

> 自 `2026-07-01` 起，旧的 `storage.*`（`storage.put` / `storage.get` / `storage.list` / `storage.listAll` / `storage.delete`）**不再是现行能力**——Demo 不再提供 storage 工作台，**不**保留"点击报 unsupported"的伪兼容工作台，也不翻译 `not_found` 这种旧 storage 错误码。

这个项目只做前端，不做后端、不做 mock、不做兼容壳。

## 启动

```bash
npm install
npm run dev
```

构建与测试：

```bash
npm run build
npm run test
npm run typecheck
```

## 工作台结构

demo 把 14 个方法 + 顶层 event 观察组织成六类工作台：

- **Connect**：`connect.login` / `connect.resume` / `connect.logout` / `connect.launch`，以及当前 session 摘要。
- **Identity**：`identity.get` / `intent.sign`，会话内身份断言与签名。
- **Cipher**：`cipher.encrypt` / `cipher.decrypt`，会话内加解密。
- **Transfer**：`p2pkh.transfer` / `feepool.prepare` / `feepool.commit`。
- **AppMsg**：`appmsg.send` / `appmsg.list` / `appmsg.get` + 顶层 `appmsg.inbox_dirty` event 观察面板。
- **Test Wallet**：测试钱包生成 / 导入 / WOC UTXO / 手动回款（不参与 connect session）。

业务方法表单统一带 **当前 sessionId + 可手改** 策略：缺 sessionId 时按表单校验失败处理；不自动登录；不自动 fallback 到 active key。

## 关键概念

- `Keymaster Target Origin` 是 popup 打开的目标站点 origin，默认是 `https://keymaster.cc`。**它只服务 direct / popup 登录链路**（`connect.login` / `connect.resume` / `connect.logout`），由 Connect 工作台里的 Popup / Direct 登录分组配置；`connect.launch` / appView 路径不读该字段，只读 URL 注入的 `sessionWindowOrigin`。
- popup 尺寸（`popupWidth = 520` / `popupHeight = 760`）与超时（`readyTimeoutMs = 10000` / `resultTimeoutMs = 60000`）是页面固定缺省值，**不在页面 UI 暴露编辑入口**；它们不是当前 Demo 的测试对象。
- `aud` 是调用方自己声明的 origin，demo 会自动使用当前页面的 `window.location.origin`
- `identity.get` 和 `intent.sign` 会把 `aud` 写成当前页面 origin
- `cipher.encrypt` / `cipher.decrypt` 不接收 `aud`
- `p2pkh.transfer` / `feepool.*` 由 popup 端按 `event.origin` 自动绑定 origin，site 不传
- 所有业务方法（除 `connect.login`）都强制要求 `connectSessionId` 输入字段；缺时直接 `invalid_request` 拒绝，不允许 fallback 到 active key
- `appmsg.*` 也强制 `connectSessionId`；sender owner / sender endpoint 由 service 从 `connectSession.ownerPublicKeyHex` + `event.origin` 投影，**不**接受 caller 自报

`aud` 与 `targetOrigin` / `sessionWindowOrigin` 是两个概念，不能混淆。把 `aud` 写成 target origin 会直接触发 origin 校验失败。

## session-first 调用方式

- 第一次跑任何业务方法前，先在 **Connect** 工作台跑一次 `connect.login` 拿到 `connectSessionId`。
- demo 把最近一次成功 sessionId 写入 `localStorage`（仅 demo 自己的最小字段），刷新后可在 `connect.resume` 处手动触发恢复。
- session 摘要显示在 Connect 工作台顶部；任何业务方法的 `connectSessionId` 表单字段都会自动同步当前 sessionId，用户仍可手改做故障路径测试。
- `connect.logout` 成功后清空 demo 的本地缓存，**不**主动重连。
- `connect.launch` 只在 appView 场景下使用：launchToken 由 launcher 写入启动 URL 的 `?launchToken=<id>`，demo 不伪造 launcher；没有真实 launchToken 时失败是预期行为，不是 demo bug。
- appView 模式下，**自动** `connect.launch`（启动期由 mount effect 触发）与**手工** `connect.launch`（用户从 Connect 工作台表单里点击）共用同一条 opener transport：
  - 两者都先 `adoptOpener()` 接管 Session Window，向它发顶层 `ready`，再发 `connect.launch`；
  - 手工 launch **不**会为 `connect.launch` 新开一扇 `/protocol/v1/popup`——那条链路上只有已打开的 Session Window 自己；
  - launch 成功后，业务方法（`identity.get` / `cipher.*` / `p2pkh.*` / `feepool.*` / `appmsg.*` / `connect.resume` / `connect.logout` 等）继续复用当前 opener session client，不再 `window.open`；
  - opener 不可用（`window.opener` 不存在 / 已关 / 非法 `sessionWindowOrigin`）→ 直接 fail-closed，**不**降级 direct / popup 登录，要求从 Keymaster 重新拉起。

## popup 复用

本 demo **不是**"一次点击 → 一次 request → 等 result → 会话结束"的一次性模型。**popup 是常驻复用**的：

- 整个 demo 页面只有一个 popup session client 实例；所有方法走同一个 client。
- 第一次点击任一方法时打开 popup，等待 `ready`。
- 后续点击其它方法**不再**调用 `window.open`，直接复用现有 popup 句柄。
- popup 关闭（用户手工 / 浏览器回收）后，下次点击会重新开新窗。
- 同时只允许**一条在途** request；并发会被直接拒绝（按钮置灰）。
- `targetOrigin`（在 Connect / Popup / Direct 登录分组里配置）改变后，demo 主动关闭旧 popup，用新 origin 重新开窗。
- popup 内的命令流历史归 Keymaster 的 IndexedDB 保管，本 demo 不做历史真值存储，只发请求、维护 session、展示结果与日志。

### appView transport（与 popup 复用并列的复用语义）

appView 模式下 demo 是被 Session Window 打开的 child app，transport **不**走 popup：

- transport 真值 = `window.opener` 指向的 Session Window；URL 注入的 `sessionWindowOrigin` = `targetOrigin`。
- 启动期：mount effect 自动 `connect.launch`，先 `adoptOpener()` + 发顶层 `ready` 再发 launch request。
- 手工 `connect.launch`：表单仍保留，但**不**因手工点击而新开 `/protocol/v1/popup`；同样先 `adoptOpener()` + `postReadyToOpener()` 再发 launch request。
- launch 成功后，业务方法（`identity.get` / `cipher.*` / `p2pkh.*` / `feepool.*` / `appmsg.*` / `connect.resume` / `connect.logout`）继续复用当前 session client，全部沿用同一条 opener transport，**不**切换 popup。
- opener 不可用 / `sessionWindowOrigin` 非法 → 任何 `connect.launch` 路径（自动 / 手工）直接 fail-closed，**不**自动回退 direct / popup 登录。

### appView 锁定模式（运行期 transport 守门）

`appViewOnly: true` 选项锁住 `PopupSessionClient`：只要页面处于 appView 模式，client 任何运行期 `ensureSession()` 在 state !== `"connected"` 时**绝不**走 `window.open(...)` 回退，而是抛 `appview_session_lost`。这把"opener 关闭 / 还未 `adoptOpener()`"两条边界一起收口到 client 自身：

- 一旦 `adoptOpener()` 成功，client 只持有 opener；后续所有 request 走同一条 opener transport。
- Session Window 被用户手工关闭后，下一次业务 request（如 `appmsg.list`）会被 client **立即**抛 `appview_session_lost`，由 App.tsx 写"请从 Keymaster 重新拉起"的失败态；**不会**偷偷再开一扇 popup。
- 想恢复只能重新 `adoptOpener()`；也就是说用户必须从 Keymaster 重新打开 demo。
- 直接 / popup 登录模式下，`appViewOnly` 维持默认 `false`，旧 `ensureSession() → window.open(...)` 行为不变。

### appView 启动 helper（被 App.tsx 复用，被 lib 测试锁住）

页面级 `prepareAppViewTransportOrFail()`（[src/lib/appViewLaunch.ts](src/lib/appViewLaunch.ts)）从 App.tsx 抽出、独占一行：只做 `closeSession → adoptOpener → postReadyToOpener` 三步原子；返回三档失败真值：

- `missing_origin` ⇒ `sessionWindowOrigin` 缺 / 空 / 非法；
- `no_opener`     ⇒ `window.opener` 不可用 / `adoptOpener()` 失败；
- `ready_failed`  ⇒ `postReadyToOpener(...)` 返回 `false`，client 已被 `closeSession()` 收敛。

lib 化的目的是让 React App.tsx 只做调用方逻辑（组装 launch request / 处理 result / strip URL），由 [src/lib/appViewLaunch.test.ts](src/lib/appViewLaunch.test.ts) 把所有失败档位与"不调 runRequest"的契约一并锁住。

## transport 层 cancel

demo 在 header 提供 **Cancel in-flight** 按钮，对当前在途 request 发顶层 `cancel` 报文：

- `cancel` 是 transport 控制消息（type="cancel"），**不**是 `method: "cancel"` 的伪 request。
- 发出后**仍由原 request 自己收最终结果或失败**，demo 不为 cancel 单独新开第二条 result 面板。
- 无在途 request 时调用 cancel 会得到 `no_in_flight` 错误，作为 warn 日志推入面板。
- popup 已经死亡时 cancel 不可达；inFlight request 走 popup.closed / closing 收口即可。

## transport 层 event（server-pushed）

popup session client 在 listener 里直接消费顶层 `event` 报文，通过 `onEvent` 回调投到本页 dirty event 队列：

- `event` 是 server-pushed 单向消息，V1 仅 `appmsg.inbox_dirty`；**不**回 result。
- `event` **不**占用 in-flight request 槽位，与 `result` / `closing` 可交错。
- `event` **不**改变连接状态（`opening` / `connected` / `disconnected` 三态不变）。
- 非法 origin 的 `event` 直接忽略，写一条 `event_received` 日志。
- 未知事件名（如 server 未来推 `appmsg.message_received`）V1 不接受，仅记日志。
- dirty event **只是 hint**，正文真值仍由 `appmsg.list` / `appmsg.get` 拉；Demo 不把 dirty event 当成消息正文缓存。
- `closing` 与 `event` 同时出现时仍以 `closing` 收敛连接。

## AppMsg 工作台

AppMsg 工作台由 4 块组成：

- **`appmsg.send`**：发一条应用消息。
  - `recipientOwnerPublicKeyHex`：33-byte compressed secp256k1 hex；
  - `recipientEndpoint.kind`：`origin` 或 `plugin`；
  - `recipientEndpoint.id`：
    - `kind = "origin"` 时必须是完整 origin（scheme + host + port，例如 `https://example.com:443`）；
    - `kind = "plugin"` 时必须匹配 `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`，长度 ≤ 128；
  - `contentType`：仅允许 `text/plain` / `text/markdown`；
  - `body`：非空；
  - `clientMessageId`：调用方幂等键；
  - `createdAtMs`：unix milliseconds 正整数；
  - 表单里**不**会出现 sender owner / sender endpoint 字段；它们由 service 投影。
- **`appmsg.list`**：列 inbox / sent / all，支持 `limit` / `afterMessageId` / `beforeMessageId`。
- **`appmsg.get`**：单条取消息；`messageId` 非空。
- **dirty event 观察区**：最近 60 条 `appmsg.inbox_dirty` event + 最近一次事件详情。event 面板独立展示，**不**伪装成某条 request 的 response。

## 测试钱包与手动回款工具

新增的 **Test Wallet** 工作台提供：

- 生成 / 导入 demo 自己的测试 WIF（私钥只放在内存里；刷新页面就丢）。
- 显示测试钱包的主网 P2PKH 地址、压缩公钥 hex。
- 通过 WOC 查询测试钱包地址的 UTXO（`confirmed/unspent`）。
- 手动一键回款：把测试钱包里的 satoshis 转回**最近一次** `identity.get` 返回的 `wallet.bsv.address.main`（缺省时手填）。失败就报错，不重试。

**重要不变量**：

- demo **绝不**读取 / 导入 / 复用 Keymaster 的主私钥。
- 测试钱包私钥默认只在内存里；不写 localStorage、不做多钱包管理、不做导出导入。
- 手动回款工具**不**调用 Keymaster popup，**不**复用 `p2pkh.transfer` 协议；它就是 demo 自己的链上辅助。
- 失败直接暴露英文错误，不重试、不切换 provider、不降低 fee 重发。

## 手工验证

### 1. `connect.login`

1. 切到 **Connect** 工作台，点击 `Run connect.login`。
2. popup 第一次打开；完成后 popup **不会**自动关闭。
3. 成功后页面顶部出现 **Current session** 摘要：connectSessionId / ownerPublicKeyHex / source / refreshedAt。
4. 切换到任意其它工作台：业务方法的 `connectSessionId` 表单字段会自动同步到当前 sessionId。

### 2. `identity.get`

1. 在 **Identity** 工作台点击 `Run identity.get`。
2. popup 复用：不会重新打开。
3. 成功 / 失败后页面会显示：
   - 原始 result
   - `identityEnvelope` 的 CBOR 解码结果
   - `subject.publicKey`
   - `signature`
   - 本地验签结果
   - `resolvedClaims`
   - 最近一次拿到的 `wallet.bsv.address.main`（如果存在）

### 3. `intent.sign`

1. 在 **Identity** 工作台填写 `contentType` 和 `contentText`。
2. 点击 `Run intent.sign`。
3. 成功后页面会显示 contentSha256 与本地验签结果。

### 4. `cipher.encrypt` / `cipher.decrypt`

`cipher.encrypt` 成功后会自动回填 `nonce + cipherbytes` 到 `cipher.decrypt` 区。

### 5. `p2pkh.transfer`

1. 默认 `recipientAddress` 自动填入测试钱包地址（如果已生成/导入测试钱包）。
2. 填写 `amountSatoshis` 与 `feeRateSatoshisPerKb`。
3. 点击 `Run p2pkh.transfer`。
4. 成功后页面会显示 `txid`、`rawTxHex` 摘要、`feeSatoshis`。

### 6. `feepool.prepare` → `feepool.commit`

1. 先在 **Test Wallet** 工作台生成或导入一把测试钱包。
2. 切换到 **Transfer** 工作台，`counterpartyPublicKeyHex` 默认填入测试钱包公钥。
3. 填写 `amountSatoshis` 并点击 `Run feepool.prepare`。
4. 准备成功后：
   - `action`（`create` / `spend` / `close_and_recreate`）由 Keymaster 单边决定。
   - 如果有 `priorPoolRecord.totalAmount`，demo 自动把池大小回填到 `feepool.commit` 区。
   - 点击 `Fill commit inputs` 可手动把 `operationId` / `counterpartyPublicKeyHex` 回填到 commit 区。
5. 在 `feepool.commit` 区：
   - 填写 `keymasterPublicKeyHex`（Keymaster multisig 公钥 hex）。demo 不知道，必须手填。
   - 确认 `draftTotalAmount`（pool 大小）正确。
   - 点击 `Run feepool.commit`：demo 用本地测试钱包私钥对 `draftSpendTxHex`（以及 `close_and_recreate` 时的 `closeDraftTxHex`）做 BIP143 sighash + DER 签名，组装成 `counterpartySignatures` 发给 Keymaster。

**重要不变量**：

- `operationId` 只在本 popup 会话内有效。popup 关闭 / 刷新后失效；demo **不**自动重新跑 `prepare`，**不**自动把旧 sign bytes 套到新 `operationId`。
- demo **不**发明新的会话协议 / pending operation 队列 / 多端点自动协商。

### 7. `appmsg.*` + `appmsg.inbox_dirty`

- 切到 **AppMsg** 工作台，先填一个合法的 `recipientOwnerPublicKeyHex` 和 `recipientEndpoint`（`origin` 或 `plugin`），点击 `Run appmsg.send`。合法输入 ⇒ 进入 in-flight；缺 `sessionId` / 空 body / 非法 endpoint shape / 非法 `contentType` 全部在表单层先拦。
- `appmsg.list`：`box` = `inbox` / `sent` / `all`，可填 `limit` / `afterMessageId` / `beforeMessageId`。
- `appmsg.get`：`messageId` 来自 `appmsg.list` 或手动粘贴。
- 切到 **AppMsg** 工作台底部的 "appmsg.inbox_dirty (passive observer)" 观察区，可以看到：
  - 最近 60 条 dirty event 列表（按到达倒序）；
  - 最近一次事件的 `atMs` / `ownerPublicKeyHex` / `endpoint`。
- 如果当前不在 AppMsg 工作台，dirty event 仍然会通过 `onEvent` 投到队列；本 demo **不**自动切换工作台——是否去看 / 调 `appmsg.list` / `appmsg.get` 由用户自己决定。

### 8. `connect.resume` / `connect.logout` / `connect.launch`

- `connect.resume`：刷新页面后用本地缓存的 sessionId 手动触发；resume 失败时 demo 不自动清库重登。
- `connect.logout`：成功后清空 demo 本地缓存，但不主动重连。
- `connect.launch`：appView mode 首登入口。launchToken 优先从 URL `?launchToken=<id>` 自动回填，没有时用户手填。**自动** launch（启动期）与**手工** launch 都复用 `window.opener` 指向的 Session Window 作为 transport 对端——手工 launch **不**会新开 `/protocol/v1/popup`，没有真实 launcher bootstrap / opener 不可用时失败是预期行为；opener 关闭后需从 Keymaster 重新拉起。

### 9. transport cancel

- 任意方法在途时点击 header 的 **Cancel in-flight**，demo 会发顶层 `cancel` 报文；
- 原 request 的最终结果（成功 / `user_rejected` / `popup_closed`）仍按正常路径展示；
- 不会出现第二条 cancel 专属 result。

### 10. transport event

- 在另一端调用 `appmsg.send` 让当前 demo 收到推送，dirty event 队列自动追加。
- 验证 event 推送独立于 result / closing：
  - event 与 result 可交错到达，互不影响；
  - event 不占用 in-flight request 槽位；
  - event 不改变 connection state；
  - closing 仍能正常收敛到 disconnected。

### 11. 手动回款

1. 在 **Test Wallet** 工作台生成测试钱包并点击 `Refresh UTXOs` 拿到当前余额。
2. 回款目标地址默认填入最近一次 `identity.get` 拿到的 Keymaster 主网地址。
3. 点击 `Run one-click refund`：
   - 重新查 UTXO；
   - 构造并签名一笔主网 P2PKH 转账；
   - 走 WOC `/tx/raw` 广播；
   - 展示 `txid` / `rawTxHex` 摘要 / `feeSatoshis`。
4. 失败（UTXO 查不到 / 余额不足 / 广播失败）就展示原始英文错误；不影响协议区已有结果。

## 事件日志

底部的 `Protocol log` 会记录 popup 连接状态、request 发送、result 接收、cancel_sent、busy_rejected、timeout、event_received 等。这部分用于排查协议时序和跨 origin 问题。

## 与 Keymaster 端的协议语义保持一致

- `result` 只表示**单条** request 的业务结果。
- `closing` 只在 popup **窗口**生命周期结束时才发。
- `cancel` 是 transport 控制消息，**不**替代 `result`、**不**单独产出第二条 result。
- `event` 是 server-pushed 单向消息，V1 仅 `appmsg.inbox_dirty`；**不**回 result、**不**占用 in-flight 槽位、**不**改变连接状态。
- popup 一次只面向一个当前 origin；切换 origin 时按新 origin 重新载入命令流历史。
- 单条 request 完成后 popup **不**自动关闭；它回到"等待下一条请求"的可继续复用状态。
- 业务方法缺 `connectSessionId` 时服务端直接 `invalid_request`；demo 端在表单层也会拒绝空 sessionId。
- `appmsg.send` / `list` / `get` 缺 sessionId / 缺 body / 非法 endpoint shape / 非法 contentType 时服务端直接 `invalid_request`；demo 表单层会先拦。
- demo 表单里**不**会出现 sender owner / sender endpoint 字段；它们由 service 投影，伪造输入不入对外请求。

## 哪些能力需要主网资金

- `p2pkh.transfer` 需要 Keymaster 当前 active key 在主网上有可用 BSV。
- `feepool.prepare` 的 `create` 路径会要求 Keymaster 当前 active key 在主网上有足够余额建池。
- 测试钱包的回款工具需要测试钱包地址上有 satoshis（不会自动从别处转过来）。

## 哪些失败属于预期

- 当前没有 sessionId：业务方法表单显式报错（"connectSessionId is required"）；demo 不自动登录。
- `connect.resume` 失败：session 已 revoke / origin 不匹配 / popup unlock runtime 已失效——demo 只展示原始错误，不自动清库重登。
- 测试钱包没生成：`p2pkh.transfer` 收款地址默认为空；`feepool.commit` 的本地签名辅助不可用。
- `identity.get` 没拿到 `wallet.bsv.address.main`：回款目标地址需要手填。
- `appmsg.send` 缺 recipientOwnerPublicKeyHex / 缺 body / endpoint 不合法 / contentType 非法：表单层先拦，错误信息明确指出。
- `appmsg.get` 找不到对应 message：服务端按 result(ok=false) 返回；demo **不**翻译成 `not_found`，**不**做本地补偿猜测。
- `appmsg.inbox_dirty` event 接收方收到 dirty 但还没拉 list / get：dirty event **不是**正文真值；正文由 `appmsg.list` / `appmsg.get` 拉。
- WOC 查询 / 广播失败：工具区展示英文错误；协议区不受影响。
- 测试钱包暂时看不到新 UTXO：链上观察时序问题，不算协议失败；可以稍后点 `Refresh UTXOs`。
- `feepool.commit` 收到 `user_rejected`：可能是 `operationId` 失效 / 池状态变化 / 服务端验签失败——demo **不**自动重新跑 `prepare`。
- `connect.launch` 没有真实 launchToken：失败路径清晰可见；demo **不**伪造成功。