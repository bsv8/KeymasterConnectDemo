# KeymasterConnectDemo `p2pkh.transfer` / `feepool.prepare` / `feepool.commit` 硬切换施工单

## 1. 结论先行

本次必须做**硬切换**，不分阶段实施，不保留旧范围定义，不做“双轨 demo”。

原因如下：

- 这个项目的定位是**独立外部调用方协议验证 demo**，不是线上业务入口。
- `p2pkh.transfer` 与 `feepool.*` 一旦接入，demo 的能力边界、状态模型、测试输入与结果展示都会明显扩大。
- 如果保留“只支持原来四个能力”的旧文档、旧页面心智、旧验证口径，会把新协议能力伪装成“旁路功能”，最后既不简单，也不准确。
- `feepool.commit` 需要消费 `prepare` 产出的签名任务，天然要求 demo 拥有**本地测试钱包私钥**。这已经不是“补几个输入框”的小改动，继续按旧首版结构打补丁，只会把边界搞乱。

所以这次要一次性把下面几件事一起收口：

- 协议类型从 4 个方法扩到 7 个方法；
- 页面从“纯签名/加解密验证 demo”升级为“包含受控转账、费用池协商、测试钱包与手动回款工具”的协议验证 demo；
- 文档、测试、页面交互、异常口径一次性同步，不保留过期描述。

## 2. 这次到底要改成什么

改完后，本项目验证的 Keymaster Connect V1 能力应当明确变成：

- `identity.get`
- `intent.sign`
- `cipher.encrypt`
- `cipher.decrypt`
- `p2pkh.transfer`
- `feepool.prepare`
- `feepool.commit`

同时新增一个**本地测试钱包工具区**，职责固定为：

- 持有一把**测试钱包私钥**，只服务于 demo 自己；
- 生成测试收款地址，供 `p2pkh.transfer` 使用；
- 生成 `counterpartyPublicKeyHex`，供 `feepool.prepare` / `commit` 使用；
- 本地对 `draftClientSignBytes` / `closeClientSignBytes` 做回签；
- 在用户显式点击时，把测试钱包里收到的金额转回 Keymaster 当前地址。

## 3. 为什么只能这么做

### 3.1 为什么要引入“测试钱包私钥”

`feepool.prepare` / `feepool.commit` 的协议模型不是单请求结果回显，而是：

- `prepare` 产出签名任务；
- site 拿着 sign bytes 交给对手方签名；
- `commit` 再把回签提交回去。

如果 demo 没有本地测试钱包私钥，就只能：

- 手工复制 sign bytes 到外部脚本签名；
- 再手工把签名贴回页面；
- 或者把“费用池验证”降级成只看 `prepare`。

这两种都不合理：

- 前者太脆弱，操作成本高，且不利于稳定复测；
- 后者不构成闭环，验不出 `commit` 的真实行为。

所以本次必须内建一个**只属于 demo 的测试钱包**。

### 3.2 为什么不能碰 Keymaster 私钥

这个 demo 是外部调用方，不是 Keymaster 内部钱包页面。

如果让 demo 读取、导入或复用 Keymaster 的主私钥，会直接打穿边界：

- 验证结果不再是“外部调用方如何使用协议”，而变成“内部钱包如何自调自己”；
- 还会把真实主网资产安全暴露到一个本来只应做协议验证的页面里。

因此必须明确：

- **只引入 demo 自己的测试钱包私钥；**
- **绝不接触 Keymaster 私钥；**
- **回款也只从测试钱包发起，不从 Keymaster 侧发起。**

### 3.3 为什么回款工具必须是“手动一键回款”，不能自动回款

自动回款表面上省事，实际上会把系统复杂度抬高：

- `p2pkh.transfer` 成功后，链上交易是否已被观察到，和测试钱包何时可花费，是两个时序；
- 自动回款会让“协议调用成功”和“链上二次转账成功”搅在一起；
- 一旦第二步失败，用户很难分清是协议问题、WOC 问题、UTXO 未确认问题还是 fee 不足问题。

按你的系统设计原则，这类边缘流程不应该为了“看起来完整”去做隐式自动化。

所以本次只做：

- 用户显式点击“手动一键回款”；
- 失败就直接暴露失败；
- 不排队，不自动补偿，不自动重试。

## 4. 怎么做

## 4.1 协议层：把方法集合一次性扩到 7 个

`src/lib/protocol.ts` 直接扩充以下内容：

- `PROTOCOL_METHODS` 增加：
  - `p2pkh.transfer`
  - `feepool.prepare`
  - `feepool.commit`
- 新增请求/结果类型：
  - `P2pkhTransferParams`
  - `P2pkhTransferResult`
  - `FeepoolPrepareParams`
  - `FeepoolPrepareResult`
  - `FeepoolCommitParams`
  - `FeepoolCommitResult`
- 新增 `ProtocolFeePoolAction`

这里的要求是：

- 只抄协议最小真值；
- 不把 `keymaster.cc` 的整套 contracts 包直接搬进来当运行时依赖；
- 但字段语义、字段名、可选性必须与文档对齐。

## 4.2 页面结构：从 4 个 tab 扩成 7 个协议 tab + 1 个工具区

`src/App.tsx` 直接切到新的页面结构：

- `identity.get`
- `intent.sign`
- `cipher.encrypt`
- `cipher.decrypt`
- `p2pkh.transfer`
- `feepool.prepare`
- `feepool.commit`
- 测试钱包 / 手动回款工具区

行为要求：

- 仍然只允许**一条在途 request**；
- 保持现有 popup session client 串行模型；
- `prepare` 成功后，把 `operationId`、`counterpartyPublicKeyHex`、`draft*` 结果自动回填到 `commit` 区；
- `identity.get` 成功后，如果返回了 `wallet.bsv.address.main`，自动记为“最近一次 Keymaster 地址”，供回款工具默认使用；
- `p2pkh.transfer` 默认收款地址优先使用测试钱包地址，减少手填错误；
- `feepool.prepare` 默认 `counterpartyPublicKeyHex` 优先使用测试钱包公钥，减少手填错误。

## 4.3 本地测试钱包：内存优先，不默认持久化

新增一个本地测试钱包模块，职责固定为：

- 接收或生成一把测试 WIF；
- 推导：
  - 主网 P2PKH 地址
  - 压缩公钥 hex
  - 需要的签名能力

落地原则：

- 默认只放在页面内存里；
- 不默认写 `localStorage`；
- 不做多钱包管理；
- 不做地址簿；
- 不做导出/导入体系。

如果用户刷新页面导致测试钱包消失，这是可以接受的。

这是 demo，不是钱包产品。

## 4.4 `feepool.commit`：只做本地回签辅助，不做额外会话模型

`feepool.commit` 的本质是把对手方签名结果交回 Keymaster。

demo 侧应该做的是：

- 从上一轮 `prepare` 结果里拿 `draftClientSignBytes`；
- 用测试钱包私钥对 sign bytes 做签名；
- 组装成 `counterpartySignatures`；
- 如果 `action === close_and_recreate` 且有 `closeClientSignBytes`，则同步签出 `closeCounterpartySignatures`；
- 发送 `feepool.commit` request。

这里**不能**做成：

- 自己发明新的中间会话协议；
- 在 demo 里缓存多组 pending operation 队列；
- 自动扫描所有历史 `prepare` 并猜测该 commit 哪一条；
- 对未知 `operationId` 自动回退重做 `prepare`。

正确模型是最简单的：

- 当前页面只辅助当前用户完成一条 `prepare -> commit` 闭环；
- 如果 `operationId` 失效，就明确失败，让用户重新从 `prepare` 开始。

## 4.5 手动一键回款：只服务测试钱包，不改协议层

手动回款工具不是 Connect 协议方法，它只是 demo 自己的测试辅助工具。

工具行为固定为：

- 输入或默认带出：
  - 目标地址（优先最近一次 `wallet.bsv.address.main`）
  - 回款金额
  - 可选 fee rate
- 查询测试钱包地址的 UTXO；
- 构造一笔普通主网 P2PKH 交易；
- 签名；
- 广播；
- 展示 `txid` / `rawTxHex` / `feeSatoshis`。

这里要明确：

- 回款工具**不**调用 Keymaster popup；
- 回款工具**不**复用 `p2pkh.transfer` 协议；
- 回款工具就是 demo 页面里的一段本地链上辅助逻辑。

## 4.6 链上查询与广播：直接走 WOC

本次最简单、最贴近 `keymaster.cc` 现状的路线是：

- 查询 UTXO：WOC
- 广播交易：WOC

不做：

- 自建后端代理；
- 自建 mempool 广播服务；
- 多 provider 兜底；
- provider 自动切换；
- provider 失败自动重试。

失败就报错，保持边界简单。

## 4.7 测试策略：自动化只测本地逻辑，真实主网仍靠手工验收

自动化测试应该覆盖：

- 协议类型与请求构包；
- 测试钱包 WIF / 地址 / 公钥推导；
- `prepare -> 本地签名 -> commit params` 组装逻辑；
- 回款工具的参数校验、UTXO 选择、交易构造辅助逻辑；
- `App` 里新 tab 的基础交互与回填逻辑。

不做：

- CI 里连真实 `keymaster.cc` 主网自动打钱；
- CI 里连真实 WOC 广播；
- 自动等待链确认。

这些都应留给手工验收。

## 5. 不能怎么做

本次明确禁止以下做法：

- 不能保留 README / 设计文档里“只支持四个能力”的旧说法。
- 不能让 demo 持有 Keymaster 私钥。
- 不能把测试钱包做成正式钱包系统。
- 不能把回款做成 `p2pkh.transfer` 成功后的自动副作用。
- 不能做自动重试、自动补偿、自动 provider fallback。
- 不能把 `feepool.commit` 做成“失败后自动偷偷重跑 `prepare`”。
- 不能为了图省事，直接依赖 `keymaster.cc` 运行时内部实现充当 demo SDK。
- 不能让工具区长期持久化大额敏感材料；默认内存态即可。
- 不能把链上工具失败包装成协议失败；协议区和工具区的日志、状态要分开。
- 不能引入“并发多请求”“多 pending operation 队列”“多钱包切换”这类未来想象功能。

## 6. 特殊情况应该怎么办

### 6.1 没有测试钱包私钥

行为：

- `p2pkh.transfer` 仍然可以发，但收款地址默认值为空或提示先生成测试钱包；
- `feepool.prepare` 可以允许手填 `counterpartyPublicKeyHex`；
- `feepool.commit` 不允许走“一键本地签名提交”，明确提示缺少测试钱包私钥。

不能做：

- 自动临时生成一把新私钥然后悄悄替换用户原先的 counterparty。

### 6.2 `identity.get` 没返回 `wallet.bsv.address.main`

行为：

- 回款工具不自动带出原地址；
- 用户手工填写回款地址；
- UI 明确说明“未从最近一次 identity 结果中拿到 Keymaster 主网地址”。

不能做：

- 猜地址；
- 从别的 claim 名里瞎兜底。

### 6.3 `feepool.commit` 的 `operationId` 失效

行为：

- 直接展示失败；
- 提示“当前 popup 会话已失效，请重新执行 `feepool.prepare`”。

不能做：

- 自动重新发 `prepare`；
- 自动把旧 sign bytes 套到新的 `operationId` 上。

### 6.4 WOC 查不到 UTXO 或广播失败

行为：

- 只让工具区失败；
- 显示原始英文错误；
- 不影响协议区现有结果。

不能做：

- 自动重试；
- 自动切换 provider；
- 自动降低 fee 重发。

### 6.5 测试钱包余额不足，无法回款

行为：

- 工具区明确失败；
- 保留当前已知余额/UTXO 查询结果，方便排查；
- 用户下次有资金后再手动点一次。

不能做：

- 自动拆多笔重试；
- 自动回最大全额；
- 自动忽略找零或 fee。

### 6.6 `p2pkh.transfer` 成功，但测试钱包暂时还看不到新 UTXO

行为：

- 视为链上观察时序问题，不把它误判成协议失败；
- 回款工具允许用户稍后再试；
- 可以提供一个手动“刷新测试钱包 UTXO”按钮。

不能做：

- 因为没立刻查到 UTXO，就自动认为协议结果是假成功。

## 7. 文件级施工清单

### 7.1 `package.json`

修改内容：

- 增加链上与钱包所需依赖：
  - `@bsv/sdk`
- 如有必要，补充与 WIF / base58 / 地址推导直接相关的最小依赖；能用 `@bsv/sdk` 解决就不要再引第二套库。

要求：

- 不引入 UI 框架；
- 不引入状态管理库；
- 不引入后端 SDK；
- 不引入多 provider 适配库。

### 7.2 `README.md`

修改内容：

- 项目定位从“四个能力”更新为“七个能力 + 测试钱包工具”；
- 写清楚：
  - 测试钱包私钥只属于 demo；
  - 不接触 Keymaster 私钥；
  - `p2pkh.transfer` / `feepool.*` 的基本使用方式；
  - 手动回款工具如何使用；
  - 哪些能力需要主网资金；
  - 哪些失败属于预期。

### 7.3 `docs/KeymasterConnectDemo-首版设计.md`

修改内容：

- 把“首版四个能力”更新成当前真实范围；
- 明确新增测试钱包与手动回款工具；
- 删除或改写已经不成立的边界描述。

要求：

- 不保留过期设计文字。

### 7.4 `src/lib/protocol.ts`

修改内容：

- 增加三种新方法及其类型；
- 保持现有协议 transport 类型不乱；
- 必要时扩充 `ProtocolErrorCode` 的使用注释，但不发明新对外错误码。

### 7.5 `src/lib/connectClient.ts`

修改内容：

- 让日志类型、方法枚举兼容新方法；
- 不改变当前 popup transport 基本模型。

要求：

- 不在这里引入链上工具逻辑；
- 不在这里引入钱包逻辑。

### 7.6 `src/lib/popupSessionClient.ts`

修改内容：

- 主要是类型适配与日志兼容；
- 保持“同一时刻只允许一条在途 request”的现状。

要求：

- 不做请求队列；
- 不做自动重试；
- 不做 operation 管理器。

### 7.7 新增 `src/lib/testWallet.ts`

内容：

- 测试钱包私钥导入或生成；
- WIF 校验；
- 地址推导；
- 压缩公钥 hex 推导；
- `feepool` 所需签名 helper。

要求：

- 注释写清楚“只给 demo 自用，不是正式钱包”；
- 默认内存态；
- 错误信息用英文。

### 7.8 新增 `src/lib/feepool.ts`

内容：

- 从 `FeepoolPrepareResult` 提取本地签名任务；
- 生成 `FeepoolCommitParams` 所需签名数组；
- 处理 `close_and_recreate` 的双签名场景。

要求：

- 只做 demo 侧本地组装；
- 不做协议状态持久化。

### 7.9 新增 `src/lib/p2pkhTool.ts`

内容：

- 手动回款工具的本地交易构造；
- fee 估算；
- UTXO 选择；
- 原始交易签名。

要求：

- 只服务测试钱包；
- 不与 Keymaster 协议层耦合。

### 7.10 新增 `src/lib/woc.ts`

内容：

- 查询地址 UTXO；
- 广播原始交易；
- WOC 请求与响应的最小封装。

要求：

- 保持 API 最小；
- 不做复杂 rate limit 管理；
- 不做 provider fallback。

### 7.11 `src/App.tsx`

修改内容：

- 增加 `p2pkh.transfer` tab；
- 增加 `feepool.prepare` tab；
- 增加 `feepool.commit` tab；
- 增加测试钱包 / 手动回款工具区；
- 增加相关 state、回填、日志展示；
- `identity.get` 成功后提取 `wallet.bsv.address.main`；
- 保持所有业务状态集中在页面层。

要求：

- 不把页面拆成过度抽象的状态机框架；
- 不引入全局 store；
- 不引入路由。

### 7.12 `src/styles.css`

修改内容：

- 给新增 tab、工具区、状态提示、回款结果面板补样式；
- 保持桌面和移动端可读。

要求：

- 不做花哨 UI；
- 保持信息密度清晰。

### 7.13 `src/lib/connectClient.test.ts`

修改内容：

- 如果已有方法枚举断言，需要扩到新方法；
- transport 行为本身不需要被新能力重写。

### 7.14 新增 `src/lib/testWallet.test.ts`

内容：

- WIF 校验；
- 地址推导；
- 公钥推导；
- 签名结果基本正确性。

### 7.15 新增 `src/lib/feepool.test.ts`

内容：

- `prepare` 结果到 `commit` 参数的组装；
- `create` / `spend` / `close_and_recreate` 三种 action 的本地签名路径。

### 7.16 新增 `src/lib/p2pkhTool.test.ts`

内容：

- 参数校验；
- UTXO 选择；
- fee 与找零的基础逻辑；
- 余额不足等失败路径。

### 7.17 如有必要新增 `src/App.test.tsx`

内容：

- 新 tab 回填与工具区基本交互；
- 测试钱包缺失时的禁用/报错行为；
- 最近一次 Keymaster 地址自动带出。

## 8. 最终验收清单

### 8.1 基础构建

- [ ] `npm install` 成功。
- [ ] `npm run typecheck` 成功。
- [ ] `npm run test` 成功。
- [ ] `npm run build` 成功。

### 8.2 文档真值

- [ ] `README.md` 已明确项目现在验证 7 个协议能力。
- [ ] `README.md` 已明确测试钱包私钥只属于 demo。
- [ ] `README.md` 已明确手动回款工具不是 Connect 协议方法。
- [ ] `docs/KeymasterConnectDemo-首版设计.md` 不再保留“只支持四个能力”的过期描述。

### 8.3 协议页面

- [ ] 页面可见 `p2pkh.transfer`、`feepool.prepare`、`feepool.commit` 三个新能力区。
- [ ] 任意时刻仍只允许一条在途 request。
- [ ] popup 复用行为不回归。

### 8.4 `p2pkh.transfer`

- [ ] 可以填写或默认带出测试钱包地址并成功发起 `p2pkh.transfer`。
- [ ] 成功结果能显示 `txid`、`rawTxHex`、`feeSatoshis`。
- [ ] 非法地址、非法金额、被拒绝等错误能稳定展示。

### 8.5 `feepool.prepare` / `commit`

- [ ] `feepool.prepare` 能成功发送并展示 `operationId`、`action`、`draftSpendTxHex` 等结果。
- [ ] `prepare` 成功后能自动回填到 `commit` 区。
- [ ] 测试钱包私钥存在时，可以本地回签并成功发起 `feepool.commit`。
- [ ] `close_and_recreate` 场景下，若返回 `closeClientSignBytes`，demo 能正确生成 `closeCounterpartySignatures`。
- [ ] `operationId` 失效时，页面明确提示需重新执行 `prepare`。

### 8.6 测试钱包与手动回款

- [ ] 页面能导入或生成测试钱包私钥。
- [ ] 页面能显示测试钱包地址与公钥 hex。
- [ ] 最近一次 `identity.get` 若返回 `wallet.bsv.address.main`，回款工具能自动带出该地址。
- [ ] 用户可显式点击“手动一键回款”发起普通 P2PKH 回款交易。
- [ ] 回款成功时能显示 `txid`、`rawTxHex`、`feeSatoshis`。
- [ ] 回款失败时只影响工具区，不污染协议区结果。

### 8.7 异常路径

- [ ] 没有测试钱包私钥时，`feepool.commit` 的本地签名辅助明确不可用。
- [ ] `identity.get` 没返回 `wallet.bsv.address.main` 时，回款工具要求手填地址。
- [ ] WOC UTXO 查询失败、广播失败、余额不足等情况都能直接暴露英文错误。
- [ ] `p2pkh.transfer` 成功但测试钱包暂时未观察到 UTXO 时，不会被误判成协议失败。

## 9. 完成标准

本次施工完成，不以“代码已经写进去”为准，而以以下事实同时成立为准：

- demo 的协议范围、页面结构、测试口径、文档描述已经全部收口到新真值；
- `p2pkh.transfer`、`feepool.prepare`、`feepool.commit` 三个新能力都能被这个外部调用方 demo 真实驱动；
- demo 具备最小但完整的测试钱包与手动回款闭环；
- 没有为了“更智能”额外引入请求队列、自动重试、自动回款、多 provider fallback 等复杂机制。

这才叫硬切换完成。
