# KeymasterConnectDemo 首版设计（session-first + 16 方法 + transport cancel）

> 这是首版设计文档的 **2026-06-29 002 硬切换**更新版。当前 demo
> 已经按 `新版 connect 协议全面测试 demo 硬切换施工单` 把协议 contract
> 一次切到新版（16 个方法 + connect.* session 生命周期 + storage.*）、
> transport 顶层支持 `cancel`、业务方法统一带 `connectSessionId`、
> 页面工作台重组为 6 类（Connect / Identity / Cipher / Transfer /
> Storage / Test Wallet），并把当前 session 摘要作为共享上下文。
> 文档里凡是只描述 4 / 7 个能力、或还在描述旧 hero+tab 顶栏的旧措辞，
> 都已经在各自施工中按真值改写。

## 1. 目标

本项目不是 `keymaster.cc`(/home/david/Workspaces/keymaster.cc/) 的内部调试页，而是一个**独立的外部调用方 demo**，用来验证 Keymaster Connect V1 协议当前真实可用的 **16 个方法**：

- `identity.get` / `intent.sign`
- `cipher.encrypt` / `cipher.decrypt`
- `p2pkh.transfer`
- `feepool.prepare` / `feepool.commit`
- `connect.login` / `connect.resume` / `connect.logout` / `connect.launch`
- `storage.put` / `storage.get` / `storage.list` / `storage.listAll` / `storage.delete`

并附带一个**测试钱包 + 手动回款工具区**：

- 持有一把 demo 自己的测试私钥（只服务于 demo，不接触 Keymaster 私钥）；
- 生成主网 P2PKH 地址 + 压缩公钥 hex；
- 提供 WOC（WhatsOnChain）UTXO 查询；
- 提供本地主网 P2PKH 转账构造 / 签名 / 广播，用于手动把测试钱包里的 satoshis 转回 Keymaster 当前地址。

demo 是 **session-first 外部调用方**：先 `connect.login` / `connect.resume` / `connect.launch` 拿到 `connectSessionId`，再以该 sessionId 调用任何业务方法。本 demo 的首要目标不是"做一个好看的网站"，而是：

- 真实走通 `window.open + postMessage + ready/request/result/closing/cancel`
- 真实验证 `aud` / `event.origin` / `BinaryField` / 签名 / 站点绑定加解密
- 真实驱动 `p2pkh.transfer` / `feepool.*` / `storage.*`
- 把调用方最容易犯错的地方直接暴露出来
- 让协议验证结果可观察、可复现、可复核
- 验证 **popup 常驻 + 同窗复用 + session-first + transport cancel** 的 2026-06-29 002 硬切换行为

## 2. 设计结论

### 2.1 硬切换

本项目采用**硬切换**，不分阶段，不保留双轨，不做兼容壳。

也就是说当前直接钉死：

- 只支持 Keymaster Connect V1
- 只支持 popup + `postMessage`
- 支持 `ready -> request -> result / closing / cancel` 五种顶层消息
- 支持当前 **16** 个方法（4 个签名 / 加解密 + p2pkh.transfer + feepool.* + connect.* + storage.*）
- 只支持真实 Keymaster 站点，不做本地 mock 协议分支
- **session-first 调用方式**：业务方法（除 `connect.login`）都必须挂 `connectSessionId`
- **popup 一次打开常驻复用**：单条 request 完成后不关窗；同一页面
  对同一 `targetOrigin` 共享一个 popup session client
- **同时只允许一条在途 request**：第二条并发会被直接拒绝
- **transport cancel**：对当前在途 request 发顶层 `cancel`，由原 request 自己收尾
- **popup 内的命令流历史归 Keymaster 自有的 IndexedDB 保管**：
  demo 不缓存历史真值
- **demo 自己的最小 sessionId 缓存走 localStorage**：仅缓存最近一次 sessionId + ownerPublicKeyHex + targetOrigin，用于刷新后手动 `connect.resume`

### 2.2 这样做的缘由

这是一个协议验证 demo，不是生产业务入口，也不是"demo + 钱包产品"。

如果这里再做：

- 旧协议兼容
- 本地 mock / fake provider
- iframe / redirect 双通道
- 自动重试 / 自动补救 / 自动归一化
- 多阶段发布开关
- 同窗并发多 request 队列
- demo 端历史真值缓存
- demo 端持久化 unlock runtime / Keymaster 敏感材料
- 测试钱包自动回款 / 自动补偿 / 多 provider fallback
- demo 持有 Keymaster 主私钥
- 把 `connect.launch` 做成假成功路径

那么验证出来的就不是"协议是否成立"，而是"demo 自己做了多少兜底后还能不能凑合跑"。这会直接污染验证结果，也会把系统复杂度无意义地抬高。

按当前项目处境，最合理的做法是：**demo 保持单一协议、单一通道、单一状态机；session 摘要只存最小字段；测试钱包保持内存态 + 工具区，不进入协议层；失败就暴露失败，修协议或修调用方，而不是在 demo 里补业务胶水。**

## 3. 范围

当前 demo 只做一个前端页面，不引入后端。

页面整体是**协议工作台**结构，硬切到三段：

- 上：顶部轻量 `header`
  - 页面名称与用途
  - popup 连接状态指示
  - 当前 `targetOrigin`
  - 当前激活工作台
  - **Cancel in-flight** 按钮（对当前在途 request 发顶层 cancel）
- 中：全局公共配置 + 共享上下文 (`app-mainbody`)
  - 5 个全局字段（`targetOrigin` / `popupWidth` / `popupHeight` /
    `readyTimeoutMs` / `resultTimeoutMs`）
  - 共享上下文（当前 connectSessionId / ownerPublicKeyHex / 测试钱包摘要 /
    最近一次 keymaster 主网地址 / 当前页面 origin）
- 下：三栏工作台 (`workbench-layout`)
  - 左栏：6 类工作台菜单（**Connect** / **Identity** / **Cipher** /
    **Transfer** / **Storage** / **Test Wallet**）
  - 中栏：当前激活工作台的主工作区（输入 + 主操作 + 关键结果摘要）
  - 右栏：当前工作台的观察区 + 全局协议日志
    - 观察区按 `activeWorkbench` 切换：每个工作台展示该工作台相关的
      request / raw result / decoded envelope / resolvedClaims / 关键回填字段
    - 全局协议日志保持最近 60 条，**不**按方法拆分

页面被组织成 **6 类工作台**而不是 16 个平铺一级 tab。每类工作台
内部继续细分：

- **Connect**：`connect.login` / `connect.resume` / `connect.logout` /
  `connect.launch`，外加一个 **Current session** 摘要卡片。
- **Identity**：`identity.get` / `intent.sign`。
- **Cipher**：`cipher.encrypt` / `cipher.decrypt`。
- **Transfer**：`p2pkh.transfer` / `feepool.prepare` / `feepool.commit`。
- **Storage**：`storage.put` / `storage.get` / `storage.list` /
  `storage.listAll` / `storage.delete`。
- **Test Wallet**：测试钱包生成 / 导入 / WOC UTXO / 手动回款工具区。

业务方法表单统一带"**当前 sessionId + 可手改**"策略：缺 sessionId
时表单校验失败；不自动登录；不自动 fallback 到 active key。

页面级 popup session client 由 16 个方法共用，按钮之间串行复用 popup。
手动回款工具**不**走 popup，**不**调用 Keymaster。

## 4. 核心边界

### 4.1 `target domain` 的真实含义

这里的"目标 domain"指的是 **Keymaster popup 打开的站点 origin**，默认值为：

- `https://keymaster.cc`

但它必须是可修改的，例如后续可切到：

- `http://localhost:5173`
- `https://staging.keymaster.cc`
- 其它测试域名

`targetOrigin` 改变时，demo 主动关闭旧 popup，再用新 origin 重新开窗。
旧 session 内的历史由 Keymaster 端的 IndexedDB 持久化保留，**不**做 demo
端缓存。

### 4.2 不能混淆 `target domain` 和 `aud`

这是设计里必须明确钉死的一条：

- `target domain` 是 `window.open()` 打开的 Keymaster 站点
- `aud` 是调用方声明的**自己**的 origin

因此：

- `identity.get` / `intent.sign` 里的 `params.aud` 必须默认取 `window.location.origin`
- 不能把 `params.aud` 写成 `https://keymaster.cc`
- `cipher.encrypt` / `cipher.decrypt` 本来就**不接收** `aud`
- `p2pkh.transfer` / `feepool.prepare` / `feepool.commit` **也不接收** `aud`：
  origin 等价检查由 popup 端按 `event.origin` 自动执行
- `connect.*` / `storage.*` 不需要 `aud`：origin 由 service 在 execute
  阶段自动绑定

如果把这两个概念混了，`identity.get` 和 `intent.sign` 会直接因 `aud !== event.origin` 失败，这不是 Keymaster 出错，而是调用方构包错了。

### 4.3 popup 路径

Keymaster popup 协议入口固定为：

- `/protocol/v1/popup`

因此 demo 的连接目标必须按下面方式拼接：

- `${targetOrigin}/protocol/v1/popup`

这里不做协议发现，不做路径协商，不做版本探测。

### 4.4 session-first 与 `connectSessionId`

业务方法（除 `connect.login`）都属于某个 `connectSessionId`：

- `identity.get` / `intent.sign` / `cipher.encrypt` / `cipher.decrypt` /
  `p2pkh.transfer` / `feepool.prepare` / `feepool.commit` /
  `storage.put` / `storage.get` / `storage.list` / `storage.listAll` /
  `storage.delete` / `connect.resume` / `connect.logout` 都强制要求
  `connectSessionId`。
- 缺该字段直接 `invalid_request` 拒绝，**不**允许 fallback 到 active key。
- demo 只在 `localStorage` 缓存最近一次成功的 `connectSessionId` +
  `targetOrigin` + `ownerPublicKeyHex`，用于刷新后手动 `connect.resume`。
- demo **不**持久化 unlock runtime、**不**持久化 claims 完整快照、
  **不**持久化任何 Keymaster 敏感材料。
- `connect.logout` 成功后 demo **不**主动 reconnect / **不**自动清库。

### 4.5 测试钱包私钥的范围

测试钱包私钥**只属于 demo 自己**，不接触 Keymaster 私钥：

- 不读 Keymaster 主私钥；
- 不导入 Keymaster 主私钥；
- 不复用 Keymaster 主私钥；
- 不把测试钱包私钥落到 localStorage（默认内存态，刷新即丢）。

回款只能从测试钱包发起；Keymaster 侧不参与回款。

### 4.6 手动回款的边界

手动回款**不是** Connect 协议方法。它是 demo 自己工具区的链上辅助：

- 不调用 Keymaster popup；
- 不复用 `p2pkh.transfer` 协议；
- 不做自动重试 / 不做自动降 fee / 不做多 provider fallback；
- 失败就暴露失败。

`p2pkh.transfer` 成功 ≠ 自动回款。链上观察时序与测试钱包何时可花费是两个独立问题。

### 4.7 `feepool.commit` 的边界

demo 侧只做"对端本地签名辅助"：

- 从 `feepool.prepare` 结果里取 `operationId` + `draftSpendTxHex` + `draftClientSignBytes`；
- 用测试钱包私钥对 `draftSpendTxHex`（以及 `close_and_recreate` 的 `closeDraftTxHex`）做
  BIP143 sighash + DER 签名，组装成 `counterpartySignatures` 发给 Keymaster；
- `operationId` 失效就直接失败，**不**自动重新跑 `prepare`；
- `feepool.commit` 强制要求 `connectSessionId`；缺时 demo 表单校验拒绝。

demo 侧**不**：

- 自己发明新的会话协议；
- 在 demo 里缓存多组 pending operation 队列；
- 自动扫描所有历史 `prepare` 猜测 commit 哪一条；
- 对未知 `operationId` 自动回退重做 `prepare`。

### 4.8 `connect.launch` 的边界

- `connect.launch` 是 appView mode 首登入口，**不**冒充普通登录。
- `launchToken` 由 launcher 写入 client app 启动 URL 的 `?launchToken=<id>`；
  demo 自动从 URL 回填，缺省时用户手填。
- demo **不**伪造 launcher bootstrap；**不**模拟 appView mode；
- 没有真实 launchToken 时 `connect.launch` 失败是预期行为，不是 demo bug。

## 5. 实现形态

### 5.1 技术形态

建议使用：

- `Vite`
- `TypeScript`
- `React`

理由不是"为了前端时髦"，而是：

- 这个 demo 有 7 组表单 + 1 个工具区 + 共享结果区 + 共享日志区，状态切换比静态页面多
- 用 React 可以把页面状态收住，但仍然保持单页、无路由、无全局状态库
- 相比引入更重的框架，这已经是足够简单的落法

同时明确约束：

- 不引入服务端
- 不引入 UI 组件库
- 不引入状态管理库
- 不引入路由库
- 不做插件化结构

### 5.2 依赖边界

本 demo **不能直接依赖 `keymaster.cc` 项目里的 runtime/protocol 实现代码**作为运行时库。

可以参考它的文档与行为（参考 `/home/david/Workspaces/keymaster.cc`），但不能把它直接当 SDK 拉进来跑。缘由很直接：

- 如果 demo 和被验证系统共享同一份协议实现，验证就失去独立性
- 一旦协议实现里有同一类 bug，demo 也会"正确地错"，你看不出来

因此应当：

- 自己定义最小的协议消息类型
- 自己实现 popup session client（transport + 消息派发 + 关闭轮询）
- 自己实现 `BinaryField` 检查
- 自己做签名验签与 envelope 解码
- **测试钱包与 feepool 本地签名都走 `@bsv/sdk` + 自实现 BIP143 sighash**，
  不依赖 `keymaster-multisig-pool` 私包

这是"外部调用方验证"的必要条件。

## 6. 页面设计

页面整体是三段式（顶部 header / 中部 app-mainbody / 下部三栏工作台）。
各协议方法内部的输入与结果分布逻辑详见第 3 节"范围"。

### 6.1 顶部 header (`app-header`)

职责：

- 显示页面名称与用途
- 显示 popup 连接状态
- 显示当前 `targetOrigin`
- 显示当前激活测试项

要求：

- 轻量、稳定、可扫读
- 不再保留旧 hero 双栏那种偏展示型态

### 6.2 中部 `app-mainbody`（全局配置 + 共享上下文）

包含两个区：

1. **Runtime config**（5 个全局输入字段）
   - `Keymaster Target Origin`（默认 `https://keymaster.cc`，可编辑）
   - `Popup Width`（默认固定值，例如 `520`）
   - `Popup Height`（默认固定值，例如 `760`）
   - `Ready Timeout(ms)`（默认固定值，例如 `10000`）
   - `Result Timeout(ms)`（默认固定值，例如 `60000`）
2. **Shared context**（共享上下文摘要）
   - `test wallet address`
   - `test wallet publicKeyHex`
   - `last keymaster main address`
   - `current origin`

设计原则：

- 这些字段是页面级公共真值，**不**进具体方法表单
- 可以改，但不搞配置中心
- 不做持久化也可以接受；即使刷新后丢失，也符合 demo 定位
- **targetOrigin / 尺寸 / 超时变化时，重置 session client**：旧 popup
  句柄被主动关闭，下次 submit 重新开新窗
- 重置 session 时**不**清空用户已填的表单（页面表单状态与会话句柄解耦）

### 6.3 下部三栏工作台 (`workbench-layout`)

- 左栏 `workbench-nav`：竖向菜单，菜单项 = 原 `tabItems`，每项显示
  方法名 / 中文说明 / 当前状态（status pill）；当前激活高亮；可切换
- 中栏 `workbench-main`：当前激活方法的完整表单 + 主操作 + 关键结果摘要
  （不放 raw request / decoded envelope / 完整 result，那些去右栏）
- 右栏 `workbench-observer`：观察区，按 `activeTab` 重挂载
  - 上半部：当前方法观察（request / raw result / decoded envelope /
    resolvedClaims / 关键回填字段 / 工具区摘要 等）
  - 下半部：全局协议日志（最近 60 条）
- 右栏是观察区，不是第二个完整测试页：中栏负责输入与主操作，右栏负责
  观察与复核
- 当前方法尚无结果时，右栏显示空态，不复用上一个方法的旧数据
- `anyBusy === true` 时左栏菜单仍可切换查看，但当前在途 request 之外的
  方法提交按钮保持禁用（不制造并行执行）

### 6.4 `identity.get` 区

输入项（中栏主工作区表单内）：

- `text`
- `claims`
- `ttlSeconds`

行为：

- `iat` 由 demo 在发送前现算
- `exp = iat + ttlSeconds`
- `aud = window.location.origin`
- claims 用简单文本输入，例如一行一个 claim 或逗号分隔

结果展示分布：

- 中栏（关键摘要）：`subject.publicKey` / `signature` / `local verify` /
  `claims projection` / `last keymaster main address`
- 右栏观察区：Request preview / Raw result / Decoded envelope /
  `resolvedClaims` / `lastKeymasterAddress`（用于回款工具自动带出）

### 6.5 `intent.sign` 区

输入项（中栏主工作区表单内）：

- `text`
- `contentType`
- `contentText`
- `ttlSeconds`

行为：

- 用 `TextEncoder` 把 `contentText` 转成 `ArrayBuffer`
- `aud = window.location.origin`
- `iat/exp` 发送前现算

结果展示分布：

- 中栏：`contentSha256 (local)` / `contentSha256 (envelope)` /
  `local verify` / `subject.publicKey`
- 右栏观察区：Request preview / Raw result / Decoded envelope

### 6.6 `cipher.encrypt` 区

输入项（中栏主工作区表单内）：

- `text`
- `contentType`
- `contentText`

行为：

- 用 `TextEncoder` 转字节
- 发起 `cipher.encrypt`
- 成功后把 `nonce + cipherbytes` 存在当前页面内存里，供解密区一键回填

结果展示分布：

- 中栏：`nonce hex / base64` / `cipherbytes hex / base64`，并提供
  "Fill decrypt inputs" 一键回填到 decrypt 区
- 右栏观察区：Request preview / Raw result

### 6.7 `cipher.decrypt` 区

输入项（中栏主工作区表单内）：

- `text`
- `nonce`
- `cipherbytes`

支持两种来源：

- 使用上一次 `cipher.encrypt` 的输出直接回填
- 用户手工粘贴十六进制或 base64 数据

结果展示分布：

- 中栏：`contentType` / `content hex` / `content text`（可按 UTF-8 解码则展示文本预览）
- 右栏观察区：Request preview / Raw result

### 6.8 `p2pkh.transfer` 区

输入项（中栏主工作区表单内）：

- `recipientAddress`（默认填入测试钱包地址；如果已生成/导入）
- `amountSatoshis`（正整数）
- `feeRateSatoshisPerKb`（正整数，可选；缺省 100）

行为：

- popup 端按 `event.origin` 自动绑定 origin
- `aud` 不传

结果展示分布：

- 中栏：`txid` / `rawTxHex (head)` / `feeSatoshis`
- 右栏观察区：Request preview / Raw result

### 6.9 `feepool.prepare` 区

输入项（中栏主工作区表单内）：

- `counterpartyPublicKeyHex`（默认填入测试钱包压缩公钥 hex）
- `amountSatoshis`（正整数）

行为：

- popup 端按 `event.origin` 自动绑定 origin
- `aud` 不传
- `action`（`create` / `spend` / `close_and_recreate`）由 Keymaster 单边决定

结果展示分布：

- 中栏：`operationId` / `action` / `draftSpendTxHex (head)` / `baseTxHex` /
  `priorPool.totalAmount`，并提供 "Fill commit inputs" 一键回填
- 右栏观察区：Request preview / Raw result / prepare result (full)

### 6.10 `feepool.commit` 区

输入项（中栏主工作区表单内）：

- `operationId`（自动从 `feepool.prepare` 回填）
- `counterpartyPublicKeyHex`（自动从 `feepool.prepare` 回填）
- `action`（read-only）
- `serverPublicKeyHex`（Keymaster multisig 公钥 hex，**必须手填**）
- `draftTotalAmount`（pool 大小；自动从 `priorPoolRecord.totalAmount` 回填或手填）
- `counterpartySignatures`（read-only；自动由本地测试钱包私钥计算）
- `closeCounterpartySignatures`（read-only；`close_and_recreate` 时自动计算）

行为：

- 点击 "Run feepool.commit" 时，demo 用本地测试钱包私钥对
  `draftSpendTxHex`（以及 `close_and_recreate` 的 `closeDraftTxHex`）做
  BIP143 sighash + DER 签名，组装成 `counterpartySignatures` 发给 Keymaster。
- 测试钱包未生成时，本地签名辅助不可用；UI 明确报错。
- `operationId` 失效时，直接展示失败；不自动重新跑 `prepare`。

结果展示分布：

- 中栏：`result.operationId` / `result.action` / `result.draftTxid` / `result.draftTxHex (head)`
- 右栏观察区：Request preview / Raw result

### 6.11 测试钱包 / 手动回款工具区

工具区与协议方法平级，作为左栏菜单的一项 `test wallet`。三段全部在
中栏主工作区内（`tool-grid`）：

1. **Test wallet**：
   - 生成 / 导入 WIF；
   - 显示地址、公钥 hex、WIF；
   - 私钥默认只在内存里；不持久化。
2. **Test wallet UTXOs (WOC)**：
   - 通过 WOC `/address/.../confirmed/unspent` 拉 UTXO；
   - 失败就报错，不重试。
3. **Manual one-click refund**：
   - 回款目标地址默认填入最近一次 `identity.get` 返回的 `wallet.bsv.address.main`；
   - 重新查 UTXO → 构造 + 签名 P2PKH tx → 走 WOC `/tx/raw` 广播；
   - 成功展示 `txid` / `rawTxHex` 摘要 / `feeSatoshis`；
   - 失败只影响工具区，不污染协议区。

右栏观察区对应展示：钱包摘要（address / publicKeyHex）/ UTXO 状态与列表 /
回款结果原始报文（`refund tx`）。

工具区信息和协议区信息共享上下文（test wallet 地址 / 公钥）由
`shared-context` 摘要统一出口；不允许把工具区再做"特殊大杂烩角落"。

### 6.12 全局协议日志（右栏观察区下半部）

必须有一个轻量日志区，按时间顺序记录：

- popup opened
- popup reused（命中已有 session 时）
- 等待 `ready`
- 收到 `ready`
- request 已发送
- 等待 result
- 收到 result
- 收到 `closing`
- popup 关闭
- busy 被拒（第二条在途并发时）
- 超时

这不是为了"做日志系统"，而是为了在 `invalid_request` 被静默忽略时，能看出流程卡在什么阶段。

- 这份日志保持全局口径，**不**按方法分别存一份
- 保留最近 60 条；不分方法、不搜索、不分页、不导出
- 日志 UI 跟在中栏一样用 `<aside class="workbench-observer">` 内的
  `observer-log` 子卡片，**不**再单独成页面级 rail

## 7. 协议层规则

### 7.1 怎么做

按下面方式做：

1. `window.open()` 打开 `${targetOrigin}/protocol/v1/popup`（仅在**没有**
   已有 popup 句柄 / `targetOrigin` 改变 / popup 已关闭时）
2. 只在收到 `ready` 之后发送正式 `request`
3. `postMessage` 发送 JS 对象，不做 `JSON.stringify`
4. 二进制字段统一走：

```ts
{
  $type: "binary",
  bytes: ArrayBuffer,
  mime?: string
}
```

5. `identity.get` / `intent.sign` 的 `aud` 直接用 `window.location.origin`
6. `cipher.encrypt` / `cipher.decrypt` 不传 `aud`
7. `p2pkh.transfer` / `feepool.*` / `connect.*` / `storage.*` 不传 `aud`：
   popup 端按 `event.origin` 自动绑定
8. 业务方法（除 `connect.login`）统一挂 `connectSessionId` 强制输入字段；
   缺时直接 `invalid_request` 拒绝，**不**做 fallback
9. 验签时直接对 `identityEnvelope.bytes` / `signedEnvelope.bytes` 验签
10. 结果展示中保留原始报文，不要只保留加工后的 UI 数据
11. 同一 popup session 内串行处理多条 request；不并发
12. popup 关闭 / 刷新 / `targetOrigin` 改变时，session 终止；下次 submit
    重新开新窗
13. `feepool.commit` 的本地签名走 `@bsv/sdk` 派生 + 自实现 BIP143 sighash；
    与 Keymaster 服务端验签用同一 sighash 公式
14. 顶层 `cancel` 报文：对当前在途 request 发 `{ v, type: "cancel", id }`；
    不替代 `result`；不单独产出第二条 result
15. demo 自己只在 `localStorage` 缓存最小 sessionId / targetOrigin /
    ownerPublicKeyHex；不缓存 unlock runtime / 不缓存 claims 完整快照

### 7.2 不能怎么做

明确禁止：

- 不能在 `ready` 之前先发 request
- 不能把 `cancel` 做成 `method: "cancel"` 的伪 request
- 不能把报文转成 JSON 字符串再传
- 不能把 `ArrayBuffer` 换成 base64 字符串塞进协议层
- 不能把 `aud` 写成 Keymaster 的 origin
- 不能自己归一化 `origin`，例如补默认端口、改小写、改 host
- 不能在同一个 popup 会话里**并发**连发多条 request
- 不能把 `identityEnvelope` / `signedEnvelope` 解码后重编码再验签
- 不能引入 mock 模式来"绕过 popup 验证"
- 不能加自动重试，把时序错误掩盖掉
- 不能在 demo 端做"命令流历史真值"持久化（历史归 Keymaster 端 IndexedDB）
- 不能在 demo 端持久化 unlock runtime 或任何 Keymaster 敏感材料
- 不能用"重新 `window.open` 同一 name"假装复用 popup —— 那只会触发
  popup 重新导航，把 session 状态清掉
- 不能让 demo 持有 / 导入 / 复用 Keymaster 主私钥
- 不能把测试钱包私钥默认写到 `localStorage`
- 不能把回款工具做成 `p2pkh.transfer` 成功后的自动副作用
- 不能把回款工具做成自动重试 / 自动降 fee / 多 provider fallback
- 不能在 `feepool.commit` 失败后自动重新跑 `feepool.prepare`
- 不能在 demo 里缓存多组 pending operation 队列
- 不能为了图省事直接依赖 `keymaster.cc` 的 runtime 内部实现充当 demo SDK
- 不能把链上工具失败包装成协议失败；协议区和工具区的日志、状态要分开
- 不能在 `connect.resume` 失败后自动 `connect.login`
- 不能在 `connect.logout` 后主动 reconnect
- 不能把 `connect.launch` 做成假成功（demo 不伪造 launchToken / 不伪造 appView mode）

## 8. 特殊情况处理

### 8.1 popup 被浏览器拦截

处理方式：

- 页面直接报错提示"浏览器拦截了 popup，请允许本站弹窗后重试"
- 不做自动降级
- 不改成 iframe

### 8.2 长时间收不到 `ready`

处理方式：

- 到 `Ready Timeout` 后直接报错
- 告诉用户检查：
  - `targetOrigin` 是否正确
  - popup 是否打开到了 `/protocol/v1/popup`
  - Keymaster 页面是否已完成加载
- 不自动重发

### 8.3 用户取消

处理方式：

- 结果区原样展示 `user_rejected`
- 日志明确记录是用户取消
- 不做二次确认包装
- popup **不**自动关闭；用户取消是单条 request 的终态，session 继续

### 8.4 Keymaster 未解锁

处理方式：

- 这是协议正常路径
- 用户会在 popup 内完成解锁
- demo 侧只等待结果，不额外插入自己的"解锁中间页"

### 8.5 Keymaster 尚未初始化或没有 active key

处理方式：

- 这不由 demo 兜底修复
- 若返回 `active_key_unavailable`，直接展示错误
- 文案提示用户先到 Keymaster 侧完成 Vault 初始化和 active key 准备

### 8.6 `decrypt_failed`

这类错误在 V1 下不细分成更多原因。demo 必须按协议现实展示：

- 可能是 origin 变了
- 可能是 `nonce` 错了
- 可能是 `cipherbytes` 被改了
- 可能是密文内层结构非法

不要在 demo 里假装自己能精确判断是哪一种。

### 8.7 需要验证"跨 origin 解不开"

这件事**不能**在同一个页面 origin 内自证。

正确做法是：

1. 先在 origin A 上执行 `cipher.encrypt`
2. 保存 `nonce + cipherbytes`
3. 再把同一份 demo 跑在 origin B
4. 在 origin B 上执行 `cipher.decrypt`
5. 预期得到 `decrypt_failed`

注意：这里的 origin 包含协议、主机名和端口。不同端口也算不同 origin。

### 8.8 popup 被用户手动关掉

处理方式：

- demo 侧清空缓存句柄
- 连接状态回到 `disconnected`
- 下次点击重新打开新 popup
- 不做：
  - 自动偷偷重开
  - 自动重发上一条命令

### 8.9 `targetOrigin` 被改

处理方式：

- 旧 popup 会话直接作废
- demo 主动关闭旧句柄
- 清空 session client
- 用新 `targetOrigin` 重新开窗
- 不做：
  - 试图把旧窗口里的协议状态迁移到新 origin

### 8.10 popup 还活着，但 request 正在处理中

处理方式：

- 第二个按钮直接禁止（按钮置灰）
- 或显式提示当前 popup 正忙
- 不做：
  - 客户端排队
  - 背景 silently queue

### 8.11 popup 刷新

处理方式：

- 视为旧 popup 会话结束
- demo 发现旧监听失效后，等待新 `ready` 或重新开窗
- Keymaster popup 重载后只恢复 DB 历史，不恢复未完成 request
- 不做未完成 request 恢复

### 8.12 历史 DB 打不开 / 写失败

处理方式（与 Keymaster 端约定一致）：

- 当前 request 继续走协议主流程
- popup 顶部显示"历史不可用"状态
- 当前命令至少保留在内存列表
- demo 不感知 DB 异常

### 8.13 没有测试钱包私钥

行为：

- `p2pkh.transfer` 仍可以发，但收款地址默认值为空（提示先生成测试钱包）；
- `feepool.prepare` 可以允许手填 `counterpartyPublicKeyHex`；
- `feepool.commit` 不允许走"一键本地签名提交"，明确提示缺少测试钱包私钥。

不能做：

- 自动临时生成一把新私钥然后悄悄替换用户原先的 counterparty。

### 8.14 `identity.get` 没返回 `wallet.bsv.address.main`

行为：

- 回款工具不自动带出原地址；
- 用户手工填写回款地址；
- UI 明确说明"未从最近一次 identity 结果中拿到 Keymaster 主网地址"。

不能做：

- 猜地址；
- 从别的 claim 名里瞎兜底。

### 8.15 `feepool.commit` 的 `operationId` 失效

行为：

- 直接展示失败；
- 提示"当前 popup 会话已失效，请重新执行 `feepool.prepare`"。

不能做：

- 自动重新发 `prepare`；
- 自动把旧 sign bytes 套到新的 `operationId` 上。

### 8.16 WOC 查不到 UTXO 或广播失败

行为：

- 只让工具区失败；
- 显示原始英文错误；
- 不影响协议区现有结果。

不能做：

- 自动重试；
- 自动切换 provider；
- 自动降低 fee 重发。

### 8.17 测试钱包余额不足，无法回款

行为：

- 工具区明确失败；
- 保留当前已知余额 / UTXO 查询结果，方便排查；
- 用户下次有资金后再手动点一次。

不能做：

- 自动拆多笔重试；
- 自动回最大全额；
- 自动忽略找零或 fee。

### 8.18 `p2pkh.transfer` 成功，但测试钱包暂时还看不到新 UTXO

行为：

- 视为链上观察时序问题，不把它误判成协议失败；
- 回款工具允许用户稍后再试；
- 提供手动"刷新测试钱包 UTXO"按钮。

不能做：

- 因为没立刻查到 UTXO，就自动认为协议结果是假成功。

## 9. 文件结构

保持极小结构：

- `index.html`
- `package.json`
- `tsconfig.json`
- `vite.config.ts`
- `src/main.tsx`
- `src/App.tsx`
- `src/styles.css`
- `src/lib/protocol.ts`
- `src/lib/connectClient.ts`
- `src/lib/popupSessionClient.ts`
- `src/lib/sessionCache.ts`（**新增**：demo 自己的最小 sessionId 缓存）
- `src/lib/requestBuilders.ts`（**新增**：16 方法的请求构包 helper）
- `src/lib/binary.ts`
- `src/lib/encoding.ts`
- `src/lib/verify.ts`
- `src/lib/cbor.ts`
- `src/lib/testWallet.ts`
- `src/lib/woc.ts`
- `src/lib/p2pkhTool.ts`
- `src/lib/feepool.ts`
- `README.md`
- `docs/KeymasterConnectDemo-首版设计.md`

其中：

- `protocol.ts` 只放最小类型与错误码字面量；16 个方法的请求 / 结果类型 +
  `ProtocolCancelMessage` + `not_found` 错误码都在这里
- `connectClient.ts` 放 transport 底层 helper（URL / features / 消息派发 /
  关闭检测 / `sendCancel`），**不**拥有"单 request 生命周期"
- `popupSessionClient.ts` 放页面级 popup session client：持有 popup
  句柄、长期 message 监听、关闭轮询、连接状态机；支持 `ensureSession` /
  `runRequest` / `cancelCurrentRequest` / `closeSession` /
  `getConnectionState` / `getCurrentRequestId`
- `sessionCache.ts`（**新增**）只做 demo 自己最小 sessionId 缓存的
  localStorage 读写；**不**缓存 unlock runtime、**不**缓存敏感材料
- `requestBuilders.ts`（**新增**）只收口 16 个方法的请求构包；
  每个 builder 返回对应 `MethodParamsMap[M]`，**不**触发 popup
- `binary.ts` / `encoding.ts` 只做字节、hex、base64 转换
- `verify.ts` 只做 SHA-256 与 secp256k1 验签
- `cbor.ts` 只做 envelope 解码
- `testWallet.ts` 只放 demo 自己的测试钱包（WIF 派生 / 校验 / 公钥 / 地址）；
  默认内存态，不持久化
- `woc.ts` 只放 demo 工具区对 WOC 的最小封装（list UTXO / broadcast）；
  无 rate limit、无 fallback
- `p2pkhTool.ts` 只放 demo 工具区的本地 P2PKH 转账（构造 / 签名 / 序列化）；
  不走 Keymaster 协议
- `feepool.ts` 只放 demo 侧 `prepare -> commit` 的本地组装
  （对端签名）；不发明会话协议，不缓存 pending operation
- `App.tsx` 收住所有页面状态，**不**做协议层状态机

## 10. 不做的事

明确不做：

- 不做后端验签服务
- 不做账户系统
- 不做 demo 端命令流历史持久化
- 不做 demo 端 unlock runtime 持久化
- 不做多页面路由
- 不做文件上传优先流
- 不做图片 claim 专门预览器
- 不做 SDK 发布
- 不做 NPM 包抽取
- 不做未完成 request 恢复
- 不做请求队列（并发时直接拒绝）
- 不做 demo 端历史全文搜索
- 不做多协议版本并存
- 不做"测试钱包 → Keymaster"自动回款 / 自动重试
- 不做 `feepool.commit` 失败后自动重跑 `feepool.prepare`
- 不做多 provider 兜底 / 切换 / 自动降 fee
- 不做"connect.resume 失败后自动 connect.login"
- 不做"connect.logout 后自动 reconnect"
- 不做"connect.launch 假成功"
- 不做 popup 自动 cancel + 自动重发

## 11. 完成标准

当前 demo 完成后，应当能稳定证明下面几件事：

- demo 能对任意可配置的 Keymaster origin 发起 popup 连接
- 第一次点击开窗；后续点击复用同一 popup 句柄，**不**再 `window.open`
- popup 关闭后下次点击会重开新窗
- `targetOrigin` 改变后强制放弃旧 popup 并打开新窗
- 同时只允许一条在途 request；并发被直接拒绝
- demo 能按真实协议调用 **16 个方法**：
  - `identity.get` / `intent.sign`
  - `cipher.encrypt` / `cipher.decrypt`
  - `p2pkh.transfer` / `feepool.prepare` / `feepool.commit`
  - `connect.login` / `connect.resume` / `connect.logout` / `connect.launch`
  - `storage.put` / `storage.get` / `storage.list` / `storage.listAll` / `storage.delete`
- demo 能在本地复核 `identity.get` / `intent.sign` 的返回真值与签名
- demo 能展示 `cipher.encrypt` / `cipher.decrypt` 的站点绑定行为
- demo 能发起 `p2pkh.transfer` 并展示 `txid` / `rawTxHex` / `feeSatoshis`
- demo 能发起 `feepool.prepare` 并把结果回填到 `feepool.commit`；
  有测试钱包时 demo 能本地回签并发出 `feepool.commit`
- demo 能对 `storage.*` 完整测试 put / get / list / listAll / delete；
  命中不存在对象时 `not_found` 可见
- demo 能显式执行 `connect.launch`（launchToken 优先从 URL 回填）；
  没有真实 launchToken 时失败路径清晰可见
- demo 能对当前在途 request 发顶层 `cancel`；原 request 仍按正常
  `result` 收尾，不出现第二条 cancel 专属 result
- demo 持久化最近一次 sessionId 到 `localStorage`；刷新后可手动
  `connect.resume`；resume 失败时 demo 不自动清库重登
- demo 具备测试钱包（生成 / 导入 / WOC UTXO 查询）+ 手动回款工具；
  失败只影响工具区
- demo 能把常见接入错误直接暴露出来，而不是替调用方偷偷修正
- demo 不接触 Keymaster 主私钥；测试钱包私钥默认只在内存里
- `npm install` / `npm run typecheck` / `npm run test` / `npm run build` 全部成功