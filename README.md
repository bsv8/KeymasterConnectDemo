# Keymaster Connect Demo

独立的外部调用方 demo，用来验证 Keymaster Connect V1 的 **16 个方法**：

- `identity.get` / `intent.sign`
- `cipher.encrypt` / `cipher.decrypt`
- `p2pkh.transfer`
- `feepool.prepare` / `feepool.commit`
- `connect.login` / `connect.resume` / `connect.logout` / `connect.launch`
- `storage.put` / `storage.get` / `storage.list` / `storage.listAll` / `storage.delete`

并附带一个**测试钱包 + 手动一键回款工具**：

- 持有一把 demo 自己的测试私钥（内存态，不接触 Keymaster 私钥）；
- 生成主网 P2PKH 地址 + 压缩公钥 hex；
- 提供 WOC（WhatsOnChain）UTXO 查询；
- 提供本地主网 P2PKH 转账构造 / 签名 / 广播，用于手动把测试钱包里的 satoshis 转回 Keymaster 当前地址。

demo 是 **session-first** 外部调用方：先 `connect.login` / `connect.resume` / `connect.launch` 拿到 `connectSessionId`，再以该 sessionId 调用 `identity.get` / `intent.sign` / `cipher.*` / `p2pkh.transfer` / `feepool.*` / `storage.*` 等业务方法。transport 层支持顶层 `cancel`，业务方法错误码新增 `not_found`。

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

demo 把 16 个方法组织成六类工作台：

- **Connect**：`connect.login` / `connect.resume` / `connect.logout` / `connect.launch`，以及当前 session 摘要。
- **Identity**：`identity.get` / `intent.sign`，会话内身份断言与签名。
- **Cipher**：`cipher.encrypt` / `cipher.decrypt`，会话内加解密。
- **Transfer**：`p2pkh.transfer` / `feepool.prepare` / `feepool.commit`。
- **Storage**：`storage.put` / `storage.get` / `storage.list` / `storage.listAll` / `storage.delete`。
- **Test Wallet**：测试钱包生成 / 导入 / WOC UTXO / 手动回款（不参与 connect session）。

业务方法表单统一带 **当前 sessionId + 可手改** 策略：缺 sessionId 时按表单校验失败处理；不自动登录；不自动 fallback 到 active key。

## 关键概念

- `Keymaster Target Origin` 是 popup 打开的目标站点 origin，默认是 `https://keymaster.cc`
- `aud` 是调用方自己声明的 origin，demo 会自动使用当前页面的 `window.location.origin`
- `identity.get` 和 `intent.sign` 会把 `aud` 写成当前页面 origin
- `cipher.encrypt` / `cipher.decrypt` 不接收 `aud`
- `p2pkh.transfer` / `feepool.*` 由 popup 端按 `event.origin` 自动绑定 origin，site 不传
- 所有业务方法（除 `connect.login`）都强制要求 `connectSessionId` 输入字段；缺时直接 `invalid_request` 拒绝，不允许 fallback 到 active key

这两个值不能混淆。把 `aud` 写成 target origin 会直接触发 origin 校验失败。

## session-first 调用方式

- 第一次跑任何业务方法前，先在 **Connect** 工作台跑一次 `connect.login` 拿到 `connectSessionId`。
- demo 把最近一次成功 sessionId 写入 `localStorage`（仅 demo 自己的最小字段），刷新后可在 `connect.resume` 处手动触发恢复。
- session 摘要显示在 Connect 工作台顶部；任何业务方法的 `connectSessionId` 表单字段都会自动同步当前 sessionId，用户仍可手改做故障路径测试。
- `connect.logout` 成功后清空 demo 的本地缓存，**不**主动重连。
- `connect.launch` 只在 appView 场景下使用：launchToken 由 launcher 写入启动 URL 的 `?launchToken=<id>`，demo 不伪造 launcher；没有真实 launchToken 时失败是预期行为，不是 demo bug。

## popup 复用

本 demo **不是**"一次点击 → 一次 request → 等 result → 会话结束"的一次性模型。**popup 是常驻复用**的：

- 整个 demo 页面只有一个 popup session client 实例；所有方法走同一个 client。
- 第一次点击任一方法时打开 popup，等待 `ready`。
- 后续点击其它方法**不再**调用 `window.open`，直接复用现有 popup 句柄。
- popup 关闭（用户手工 / 浏览器回收）后，下次点击会重新开新窗。
- 同时只允许**一条在途** request；并发会被直接拒绝（按钮置灰）。
- `targetOrigin` 改变后，demo 主动关闭旧 popup，用新 origin 重新开窗。
- popup 内的命令流历史归 Keymaster 的 IndexedDB 保管，本 demo 不做历史真值存储，只发请求、维护 session、展示结果与日志。

## transport 层 cancel

demo 在 header 提供 **Cancel in-flight** 按钮，对当前在途 request 发顶层 `cancel` 报文：

- `cancel` 是 transport 控制消息（type="cancel"），**不**是 `method: "cancel"` 的伪 request。
- 发出后**仍由原 request 自己收最终结果或失败**，demo 不为 cancel 单独新开第二条 result 面板。
- 无在途 request 时调用 cancel 会得到 `no_in_flight` 错误，作为 warn 日志推入面板。
- popup 已经死亡时 cancel 不可达；inFlight request 走 popup.closed / closing 收口即可。

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

### 7. `storage.*`

- `storage.put` 写明文对象；Keymaster 在 Session Window 内透明加密。
- `storage.get` 读对象；对象不存在时返回 `not_found` 错误（属于协议错误，不是 transport 错误）。
- `storage.list` 按 prefix 列对象；`storage.listAll` 列当前 session 虚拟桶下所有对象。
- `storage.delete` 删除对象；对象不存在时同样返回 `not_found`。
- 所有 storage 方法都要求 `connectSessionId`，**不**参与 storage 真值的是 `appViewContext`。

### 8. `connect.resume` / `connect.logout` / `connect.launch`

- `connect.resume`：刷新页面后用本地缓存的 sessionId 手动触发；resume 失败时 demo 不自动清库重登。
- `connect.logout`：成功后清空 demo 本地缓存，但不主动重连。
- `connect.launch`：appView mode 首登入口。launchToken 优先从 URL `?launchToken=<id>` 自动回填，没有时用户手填；没有真实 launcher bootstrap 时失败是预期行为。

### 9. transport cancel

- 任意方法在途时点击 header 的 **Cancel in-flight**，demo 会发顶层 `cancel` 报文；
- 原 request 的最终结果（成功 / `user_rejected` / `popup_closed`）仍按正常路径展示；
- 不会出现第二条 cancel 专属 result。

### 10. 手动回款

1. 在 **Test Wallet** 工作台生成测试钱包并点击 `Refresh UTXOs` 拿到当前余额。
2. 回款目标地址默认填入最近一次 `identity.get` 拿到的 Keymaster 主网地址。
3. 点击 `Run one-click refund`：
   - 重新查 UTXO；
   - 构造并签名一笔主网 P2PKH 转账；
   - 走 WOC `/tx/raw` 广播；
   - 展示 `txid` / `rawTxHex` 摘要 / `feeSatoshis`。
4. 失败（UTXO 查不到 / 余额不足 / 广播失败）就展示原始英文错误；不影响协议区已有结果。

## 事件日志

底部的 `Protocol log` 会记录 popup 连接状态、request 发送、result 接收、cancel_sent、busy_rejected、timeout 等。这部分用于排查协议时序和跨 origin 问题。

## 与 Keymaster 端的协议语义保持一致

- `result` 只表示**单条** request 的业务结果。
- `closing` 只在 popup **窗口**生命周期结束时才发。
- `cancel` 是 transport 控制消息，**不**替代 `result`、**不**单独产出第二条 result。
- popup 一次只面向一个当前 origin；切换 origin 时按新 origin 重新载入命令流历史。
- 单条 request 完成后 popup **不**自动关闭；它回到"等待下一条请求"的可继续复用状态。
- 业务方法缺 `connectSessionId` 时服务端直接 `invalid_request`；demo 端在表单层也会拒绝空 sessionId。

## 哪些能力需要主网资金

- `p2pkh.transfer` 需要 Keymaster 当前 active key 在主网上有可用 BSV。
- `feepool.prepare` 的 `create` 路径会要求 Keymaster 当前 active key 在主网上有足够余额建池。
- 测试钱包的回款工具需要测试钱包地址上有 satoshis（不会自动从别处转过来）。

## 哪些失败属于预期

- 当前没有 sessionId：业务方法表单显式报错（"connectSessionId is required"）；demo 不自动登录。
- `connect.resume` 失败：session 已 revoke / origin 不匹配 / popup unlock runtime 已失效——demo 只展示原始错误，不自动清库重登。
- 测试钱包没生成：`p2pkh.transfer` 收款地址默认为空；`feepool.commit` 的本地签名辅助不可用。
- `identity.get` 没拿到 `wallet.bsv.address.main`：回款目标地址需要手填。
- `storage.get` / `storage.delete` 命中不存在对象：返回 `not_found` 错误，是有效的协议错误。
- WOC 查询 / 广播失败：工具区展示英文错误；协议区不受影响。
- 测试钱包暂时看不到新 UTXO：链上观察时序问题，不算协议失败；可以稍后点 `Refresh UTXOs`。
- `feepool.commit` 收到 `user_rejected`：可能是 `operationId` 失效 / 池状态变化 / 服务端验签失败——demo **不**自动重新跑 `prepare`。
- `connect.launch` 没有真实 launchToken：失败路径清晰可见；demo **不**伪造成功。