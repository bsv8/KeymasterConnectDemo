# Keymaster Connect Demo

独立的外部调用方 demo，用来验证 Keymaster Connect V1 的 **七个能力**：

- `identity.get`
- `intent.sign`
- `cipher.encrypt`
- `cipher.decrypt`
- `p2pkh.transfer`
- `feepool.prepare`
- `feepool.commit`

并附带一个**测试钱包 + 手动一键回款工具**：

- 持有一把 demo 自己的测试私钥（内存态，不接触 Keymaster 私钥）；
- 生成主网 P2PKH 地址 + 压缩公钥 hex；
- 提供 WOC（WhatsOnChain）UTXO 查询；
- 提供本地主网 P2PKH 转账构造 / 签名 / 广播，用于手动把测试钱包里的 satoshis 转回 Keymaster 当前地址。

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

## 关键概念

- `Keymaster Target Origin` 是 popup 打开的目标站点 origin，默认是 `https://keymaster.cc`
- `aud` 是调用方自己声明的 origin，demo 会自动使用当前页面的 `window.location.origin`
- `identity.get` 和 `intent.sign` 会把 `aud` 写成当前页面 origin
- `cipher.encrypt` 和 `cipher.decrypt` 不接收 `aud`
- `p2pkh.transfer` / `feepool.*` 由 popup 端按 `event.origin` 自动绑定 origin，site 不传

这两个值不能混淆。把 `aud` 写成 target origin 会直接触发 origin 校验失败。

## popup 复用（施工单 002 硬切换）

本 demo **不是**"一次点击 → 一次 request → 等 result → 会话结束"的一次性模型。**popup 是常驻复用**的：

- 整个 demo 页面只有一个 popup session client 实例；七个测试按钮走同一个 client。
- 第一次点击任一测试时打开 popup，等待 `ready`。
- 后续点击其它测试**不再**调用 `window.open`，直接复用现有 popup 句柄。
- popup 关闭（用户手工 / 浏览器回收）后，下次点击会重新开新窗。
- 同时只允许**一条在途** request；并发会被直接拒绝（按钮置灰）。
- `targetOrigin` 改变后，demo 主动关闭旧 popup，用新 origin 重新开窗。
- popup 内的命令流历史归 Keymaster 的 IndexedDB 保管，本 demo 不做历史真值存储，只发请求、维护 session、展示结果与日志。

## 测试钱包与手动回款工具（新增）

新增的"test wallet" tab 提供：

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

### 1. `identity.get`

1. 在 `identity.get` 区点击 `Run identity.get`。
2. popup 第一次打开；完成后 popup **不会**自动关闭。
3. 切换到任意其它协议区点击运行：popup **不会**重新打开；同一 popup 串行处理第二条 request。
4. 成功 / 失败后页面会显示：
   - 原始 result
   - `identityEnvelope` 的 CBOR 解码结果
   - `subject.publicKey`
   - `signature`
   - 本地验签结果
   - `resolvedClaims`
   - 最近一次拿到的 `wallet.bsv.address.main`（如果存在）

### 2. `intent.sign`

1. 在 `intent.sign` 区填写 `contentType` 和 `contentText`。
2. 点击 `Run intent.sign`。
3. 成功后页面会显示 contentSha256 与本地验签结果。

### 3. `cipher.encrypt` / `cipher.decrypt`

`cipher.encrypt` 成功后会自动回填 `nonce + cipherbytes` 到 `cipher.decrypt` 区。

### 4. `p2pkh.transfer`

1. 默认 `recipientAddress` 自动填入测试钱包地址（如果已生成/导入测试钱包）。
2. 填写 `amountSatoshis` 与 `feeRateSatoshisPerKb`。
3. 点击 `Run p2pkh.transfer`。
4. 成功后页面会显示 `txid`、`rawTxHex` 摘要、`feeSatoshis`。

### 5. `feepool.prepare` → `feepool.commit`

1. 先在 `test wallet` tab 生成或导入一把测试钱包。
2. 切换到 `feepool.prepare`，`counterpartyPublicKeyHex` 默认填入测试钱包公钥。
3. 填写 `amountSatoshis` 并点击 `Run feepool.prepare`。
4. 准备成功后：
   - `action`（`create` / `spend` / `close_and_recreate`）由 Keymaster 单边决定。
   - 如果有 `priorPoolRecord.totalAmount`，demo 自动把池大小回填到 `feepool.commit` 区。
   - 点击 `Fill commit inputs` 可手动把 `operationId` / `counterpartyPublicKeyHex` 回填到 commit 区。
5. 在 `feepool.commit` 区：
   - 填写 `serverPublicKeyHex`（Keymaster 服务端 multisig 公钥 hex）。demo 不知道，必须手填。
   - 确认 `draftTotalAmount`（pool 大小）正确。
   - 点击 `Run feepool.commit`：demo 用本地测试钱包私钥对 `draftSpendTxHex`（以及 `close_and_recreate` 时的 `closeDraftTxHex`）做 BIP143 sighash + DER 签名，组装成 `counterpartySignatures` 发给 Keymaster。

**重要不变量**：

- `operationId` 只在本 popup 会话内有效。popup 关闭 / 刷新后失效；demo **不**自动重新跑 `prepare`，**不**自动把旧 sign bytes 套到新 `operationId`。
- demo **不**发明新的会话协议 / pending operation 队列 / 多端点自动协商。

### 6. 手动回款

1. 在 `test wallet` tab 生成测试钱包并点击 `Refresh UTXOs` 拿到当前余额。
2. 回款目标地址默认填入最近一次 `identity.get` 拿到的 Keymaster 主网地址。
3. 点击 `Run one-click refund`：
   - 重新查 UTXO；
   - 构造并签名一笔主网 P2PKH 转账；
   - 走 WOC `/tx/raw` 广播；
   - 展示 `txid` / `rawTxHex` 摘要 / `feeSatoshis`。
4. 失败（UTXO 查不到 / 余额不足 / 广播失败）就展示原始英文错误；不影响协议区已有结果。

## 事件日志

底部的 `Protocol log` 会记录 popup 连接状态、request 发送、result 接收、busy_rejected、timeout 等。这部分用于排查协议时序和跨 origin 问题。

## 与 Keymaster 端的协议语义保持一致

- `result` 只表示**单条** request 的业务结果。
- `closing` 只在 popup **窗口**生命周期结束时才发。
- popup 一次只面向一个当前 origin；切换 origin 时按新 origin 重新载入命令流历史。
- 单条 request 完成后 popup **不**自动关闭；它回到"等待下一条请求"的可继续复用状态。

## 哪些能力需要主网资金

- `p2pkh.transfer` 需要 Keymaster 当前 active key 在主网上有可用 BSV。
- `feepool.prepare` 的 `create` 路径会要求 Keymaster 当前 active key 在主网上有足够余额建池。
- 测试钱包的回款工具需要测试钱包地址上有 satoshis（不会自动从别处转过来）。

## 哪些失败属于预期

- 测试钱包没生成：`p2pkh.transfer` 收款地址默认为空；`feepool.commit` 的本地签名辅助不可用。
- `identity.get` 没拿到 `wallet.bsv.address.main`：回款目标地址需要手填。
- WOC 查询 / 广播失败：工具区展示英文错误；协议区不受影响。
- 测试钱包暂时看不到新 UTXO：链上观察时序问题，不算协议失败；可以稍后点 `Refresh UTXOs`。
- `feepool.commit` 收到 `user_rejected`：可能是 `operationId` 失效 / 池状态变化 / 服务端验签失败——demo **不**自动重新跑 `prepare`。