# KeymasterConnectDemo 新版 Connect 协议全面测试 Demo 硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `/home/david/Workspaces/keymaster.cc/packages/contracts/src/protocol.ts`
- `/home/david/Workspaces/keymaster.cc/packages/plugin-protocol/src/protocolValidation.ts`
- `/home/david/Workspaces/keymaster.cc/docs/keymaster-protocol-common-v1-draft.md`
- `/home/david/Workspaces/keymaster.cc/docs/keymaster-connect-v1-draft.md`
- `/home/david/Workspaces/keymaster.cc/docs/keymaster-storage-v1-draft.md`
- `/home/david/Workspaces/KeymasterConnectDemo/src/lib/protocol.ts`
- `/home/david/Workspaces/KeymasterConnectDemo/src/lib/connectClient.ts`
- `/home/david/Workspaces/KeymasterConnectDemo/src/lib/popupSessionClient.ts`
- `/home/david/Workspaces/KeymasterConnectDemo/src/App.tsx`
- `/home/david/Workspaces/KeymasterConnectDemo/README.md`
- `/home/david/Workspaces/KeymasterConnectDemo/docs/KeymasterConnectDemo-首版设计.md`

发生冲突时：

1. 本单关于 demo 协议外表面、session-first 调用方式、测试范围的定义优先。
2. 本单未覆盖的协议字段真值，以 `keymaster.cc` 当前 contract 与 docs 为准。
3. 后续若再改协议方法集或 session 语义，必须先改本单与 demo 文档，再改代码，不允许只改实现。

---

## 1. 本单定位

本单不是“在旧 7 方法 demo 上补几个字段”的小修。

本单定义的是一次**硬切换**：

- demo 从“7 方法、单请求时代的外部调用方”切到“新版 connect session 协议的外部调用方”；
- 协议方法集从 7 个扩到当前完整真值：
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
  - `storage.put`
  - `storage.get`
  - `storage.list`
  - `storage.listAll`
  - `storage.delete`
- transport 顶层消息从 `ready/request/result/closing` 扩到 `ready/request/result/closing/cancel`；
- demo 的业务真值从“直接调用单个业务方法”切到“先拿 `connectSessionId`，再测试会话内业务方法”；
- 页面组织从“7 个协议按钮 + 工具区”切到“Connect / Identity / Cipher / Transfer / Storage / Test Wallet”六类工作台；
- 不保留旧 7 方法 contract，不做双轨，不做兼容壳。

本单目标不是“尽量少改页面”，而是让这个 demo 重新变成**真实、独立、覆盖完整的外部调用方测试台**。

---

## 2. 简述缘由

### 2.1 当前 demo 的协议真值已经落后

当前 demo 的 [src/lib/protocol.ts](/home/david/Workspaces/KeymasterConnectDemo/src/lib/protocol.ts) 仍然只有旧 7 方法，且旧业务方法没有统一挂 `connectSessionId`。

而 `keymaster.cc` 当前真实协议已经明确：

- `connect.login` 才是登录入口；
- `connect.resume` / `connect.logout` 是正式 session 生命周期方法；
- `identity.get` / `intent.sign` / `cipher.*` / `p2pkh.transfer` / `feepool.*` 都属于某个 `connectSessionId`；
- 新增 `storage.*` 方法族；
- 顶层新增 `cancel` 控制消息；
- 新增 `not_found` 错误码；
- `connect.launch` 与 appView 启动链路已经成为正式协议面。

如果 demo 继续停在旧 contract，它测出来的不是“当前协议是否成立”，而只是“旧 demo 还能不能凑合点几个按钮”。

### 2.2 这是协议模型变化，不是字段补丁

这次变化的本质不是“某个方法多一个可选字段”，而是：

- 身份真值从“全局 active key 幻觉”切到“显式 connect session”；
- 调用顺序从“直接跑业务方法”切到“先登录/恢复，再跑业务方法”；
- transport 从“只发 request 等 result”切到“还要支持 cancel”；
- 方法面从“签名/加解密/转账”扩到“session + storage + appView 登录”。

如果做成渐进兼容：

- 页面上会出现两套请求真值；
- 一部分方法走旧构包，一部分走新构包；
- sessionId 是否必填会在 UI 上变得不清楚；
- 测出来的问题会混着“demo 兼容层问题”和“协议问题”。

这违背本项目“简单粗暴、失败直接暴露、不要为了业务完整引入额外复杂度”的原则。

### 2.3 demo 必须继续保持独立调用方身份

本 demo 的价值就在于它**不是** `keymaster.cc` 自己的页面。

因此这次虽然要镜像新版 contract，但仍然不能：

- 直接把 `keymaster.cc` 的 runtime / protocol service 当 SDK 跑；
- 直接把 `plugin-protocol` UI 搬进 demo；
- 让 demo 与被测系统共享同一份协议实现真值。

正确做法是：

- contract 形状对齐；
- transport 语义对齐；
- demo 自己独立构包、发包、展示结果、做本地复核。

这样测出来的结果才有价值。

---

## 3. 最终目标

本次完成后，demo 必须达到以下状态：

1. 协议 contract 与 `keymaster.cc` 当前新版 Connect 协议外表面对齐。
2. 页面上可以显式执行 `connect.login`、`connect.resume`、`connect.logout`、`connect.launch`。
3. 页面持有“当前 session 摘要”，并把 `connectSessionId` 作为后续业务方法默认真值。
4. `identity.get`、`intent.sign`、`cipher.*`、`p2pkh.transfer`、`feepool.*`、`storage.*` 都能按当前 session 发起。
5. transport 支持顶层 `cancel`，并保持“cancel 不单独回 result，原 request 收口”的语义。
6. 继续只维护一个 popup session client，继续只允许一条在途 request。
7. demo 端可以持久化最近一次 `connectSessionId`，供刷新后手动 `resume`。
8. `connect.launch` 至少具备完整构包与手工测试能力；若外部 launcher 链路打通，则可做端到端验证。
9. `storage.*` 可以作为完整测试区独立操作，而不是仅留在类型层。
10. README、设计文档、测试用例都同步到新真值。

---

## 4. 单真值定义

### 4.1 demo 的调用模型

本次固定：

```txt
session-first caller
  = 先 connect.login / connect.resume / connect.launch
  = 再跑会话内业务方法
```

关键约束：

1. `connect.login` 是普通站点首次登录入口。
2. `connect.launch` 只用于 appView 场景，不冒充普通登录。
3. 其它业务方法默认都属于一个明确的 `connectSessionId`。

### 4.2 协议方法集

本次固定：

```txt
PROTOCOL_METHODS
  = 与 keymaster.cc 当前 contract 对齐的 16 个方法
```

关键约束：

1. demo 不再保留旧“只支持 7 个方法”的说法。
2. 除 `connect.login` / `connect.launch` 外，不得把“缺 sessionId 也能跑”作为 demo 行为。

### 4.3 transport 顶层消息

本次固定：

```txt
ProtocolMessage
  = ready | request | result | closing | cancel
```

关键约束：

1. `cancel` 是顶层控制消息，不是伪造的 `method: "cancel"` request。
2. `cancel` 不单独产出第二条 result。
3. 原 request 仍然是最终收 result 的唯一主体。

### 4.4 当前 session 真值

本次固定：

```txt
current session
  = connectSessionId + ownerPublicKeyHex + resolvedClaims 摘要
```

关键约束：

1. demo 页面上必须把当前 session 显示出来。
2. 后续业务方法表单默认引用当前 sessionId。
3. 用户仍可手改 sessionId，用于故障路径测试。

### 4.5 sessionId 的本地持久化

本次固定：

```txt
demo local session cache
  = localStorage 中最近一次成功得到的 connectSessionId
```

关键约束：

1. 只存 demo 自己需要的最小字段，不存 unlock runtime，不存任何 Keymaster 敏感材料。
2. demo 刷新后可以拿这个 sessionId 去点 `connect.resume`。
3. `connect.resume` 失败时，demo 只提示失败，不自动清库重登。

### 4.6 appView / connect.launch 的边界

本次固定：

```txt
connect.launch
  = 协议级支持 + demo 侧可构包测试
```

关键约束：

1. demo 不伪造 launcher bootstrap。
2. demo 不自己发明 appView mode。
3. 若没有真实 launchToken，`connect.launch` 的失败是预期行为，不是 demo bug。

### 4.7 外部调用方独立性

本次固定：

```txt
demo contract mirror
  = 镜像协议外表面
  != 直接依赖 keymaster.cc runtime 实现
```

关键约束：

1. demo 可以参考 `keymaster.cc` 的 contract 与 docs。
2. demo 不能直接 import `packages/plugin-protocol` 作为运行时库。
3. 测试钱包、验签、观察区仍然由 demo 自己维护。

---

## 5. 怎么做

## 5.1 协议 contract 一次性硬切到新版

直接修改 [src/lib/protocol.ts](/home/david/Workspaces/KeymasterConnectDemo/src/lib/protocol.ts)：

- 扩 `PROTOCOL_METHODS` 到 16 个方法；
- 增加 `ProtocolCancelMessage`；
- 增加 `not_found` 错误码；
- 给旧业务方法补 `connectSessionId`；
- 增加 `connect.*` 与 `storage.*` 的 params/result 类型；
- 更新 `MethodParamsMap` 与 `MethodResultMap`。

要求：

- 类型命名与字段形状尽量与 `keymaster.cc` contract 对齐；
- demo 只维护最小必要的镜像，不在这里加入 UI 状态字段；
- 所有错误信息继续走英文。

## 5.2 PopupSessionClient 补 `cancel`，但不引入请求队列

修改 [src/lib/connectClient.ts](/home/david/Workspaces/KeymasterConnectDemo/src/lib/connectClient.ts) 与 [src/lib/popupSessionClient.ts](/home/david/Workspaces/KeymasterConnectDemo/src/lib/popupSessionClient.ts)：

- 增加构造并发送顶层 `cancel` 报文的能力；
- 为当前 in-flight request 暴露 `cancelCurrentRequest()` 或等价接口；
- 日志里增加 cancel 相关 stage；
- 保持 `ready` / `closing` / `result` 的原有边界不变。

要求：

1. 同时只允许一条在途 request，这条规则不变。
2. 不做本地请求队列。
3. 不做自动 cancel + 自动重发。
4. `cancel` 发完后，仍由原 request 自己收最终结果或失败。

## 5.3 页面结构切到“按协议职责分区”的工作台

修改 [src/App.tsx](/home/david/Workspaces/KeymasterConnectDemo/src/App.tsx) 与 [src/styles.css](/home/david/Workspaces/KeymasterConnectDemo/src/styles.css)：

- 保留现有三栏工作台总体结构；
- 把方法入口重组为六类：
  - `Connect`
  - `Identity`
  - `Cipher`
  - `Transfer`
  - `Storage`
  - `Test Wallet`
- `Connect` 区单独承载：
  - `connect.login`
  - `connect.resume`
  - `connect.logout`
  - `connect.launch`
  - 当前 session 摘要
- `Storage` 区单独承载：
  - `storage.put`
  - `storage.get`
  - `storage.list`
  - `storage.listAll`
  - `storage.delete`

要求：

1. 不把 16 个方法做成平铺 16 个一级 tab。
2. 业务方法默认读取当前 sessionId。
3. 观察区继续展示 request / response / inspection / protocol log。

## 5.4 session 状态作为 demo 自己的共享上下文

在 demo 内新增一个最小 session 状态层，职责只包括：

- 保存当前 sessionId；
- 保存当前 ownerPublicKeyHex；
- 保存最近一次 resolvedClaims；
- 保存最近一次 resume/login/launch 的返回；
- 从 localStorage 恢复最近一次 sessionId。

要求：

1. 只做页面级共享，不抽象成复杂状态管理系统。
2. 不做多 session 管理。
3. 不做 session 历史列表。
4. 不做自动 resume。

## 5.5 各业务方法统一走“当前 sessionId + 可手改”策略

`identity.get`、`intent.sign`、`cipher.*`、`p2pkh.transfer`、`feepool.*`、`storage.*` 的表单全部改成：

- 默认带入当前 sessionId；
- 允许手工覆盖；
- request 预览里明确展示最终带出去的 sessionId。

这样做的缘由：

- 正常路径测试快；
- 故障路径测试也方便；
- 不需要在 demo 里做“锁死当前 session 不让改”的复杂 UI。

## 5.6 `connect.launch` 只做协议支持，不做伪 launcher

`connect.launch` 区必须明确展示：

- `launchToken` 输入；
- 当前 URL 里若有 `launchToken`，可以自动回填；
- 若没有 token，用户可手填；
- 若调用失败，按真实错误展示。

要求：

1. 不在 demo 里模拟 Session Window bootstrap registry。
2. 不在 demo 里造假 appView mode。
3. 只要构包、发包、结果展示、错误展示完整，就算协议面支持完成。

## 5.7 `storage.*` 做成完整测试区

新增 storage 测试区时，不只做最小表单，还要满足真实测试需要：

- `put`：路径、可选 contentType、内容输入
- `get`：路径、结果内容展示
- `list`：prefix、entries 展示
- `listAll`：entries 展示
- `delete`：路径、删除结果展示

要求：

1. `BinaryField` 输入仍复用现有编码工具。
2. `not_found` 错误要单独显示得足够明确。
3. 不做本地对象缓存，不做目录树模型，不做批量删除。

## 5.8 文档与测试一次性同步

同步修改：

- [README.md](/home/david/Workspaces/KeymasterConnectDemo/README.md)
- [docs/KeymasterConnectDemo-首版设计.md](/home/david/Workspaces/KeymasterConnectDemo/docs/KeymasterConnectDemo-首版设计.md)
- 协议与 transport 相关测试文件

要求：

1. README 不再写“只验证 7 个能力”。
2. 设计文档里要把 demo 的定位更新为新版协议工作台。
3. 单测至少覆盖方法集、sessionId 要求、cancel、closing、storage 基础构包。

---

## 6. 不能怎么做

### 6.1 不能保留旧 7 方法 contract 作为兼容层

不允许出现：

- 旧 `PROTOCOL_METHODS_OLD`
- “如果没有 sessionId 就按旧协议发”
- “identity.get 仍然可兼作登录入口”的 demo 叙事

原因：

- 会制造两套调用真值；
- 会让测试结果失真；
- 只会让后续维护更乱。

### 6.2 不能把 `keymaster.cc` 实现直接搬进 demo

不允许：

- 直接 import `packages/plugin-protocol/src/*` 作为 demo 运行时逻辑；
- 直接复用 `ProtocolPopupPage`；
- 直接把 `protocolValidation.ts` 当本地运行时校验器使用。

原因：

- demo 会和被测系统共错；
- 外部调用方独立性消失；
- 出问题时分不清是协议错还是共享实现一起错。

### 6.3 不能为了“更顺手”发明本地队列或自动恢复

不允许：

- 本地 request 队列
- 自动 retry
- popup 断线后自动 reopen + 自动 replay
- `connect.resume` 失败后自动 `connect.login`

原因：

- 这会掩盖协议边界与真实失败；
- 违背项目“失败就暴露，不要增加系统复杂度”的原则。

### 6.4 不能把 `connect.launch` 做成假成功

不允许：

- demo 自己生成假 launchToken
- demo 自己伪装 appView mode
- 没有真实 launcher bootstrap 时返回“伪成功”

原因：

- 这会直接污染 appView 协议验证结果；
- `connect.launch` 本来就不是普通网页登录入口。

### 6.5 不能把 Storage 做成小型文件管理器

不允许：

- 本地目录树缓存
- 拖拽上传系统
- 对象预览器大而全
- 批量操作

本次只做协议测试面，不做产品化存储界面。

---

## 7. 特殊情况应该怎么办

### 7.1 当前没有 sessionId

处理规则：

1. 业务方法表单允许为空。
2. 发送前若用户没填 sessionId，按当前 contract 发包失败或本地表单校验失败即可。
3. demo 不自动帮用户登录。

### 7.2 `connect.resume` 失败

可能原因：

- session 已 revoke
- origin 不匹配
- popup unlock runtime 已失效且恢复失败
- owner key 不可用

处理规则：

1. 页面按原始错误展示。
2. 当前缓存 sessionId 不自动删除。
3. 用户自行决定是重试 `resume` 还是重新 `login`。

### 7.3 popup 被手工关闭或收到 `closing`

处理规则：

1. 会话状态收敛到 `disconnected`。
2. 当前在途 request reject。
3. demo 不自动重放上一条 request。
4. 用户下次点击时重新开窗。

### 7.4 用户点击 `cancel`

处理规则：

1. demo 只对当前在途 request 发顶层 `cancel`。
2. 发出后进入等待原 request 收尾状态。
3. 不新开第二条 cancel 结果面板。
4. 若请求已不可取消，按最终业务结果展示即可。

### 7.5 `connect.launch` 没有 launchToken

处理规则：

1. 允许表单为空。
2. 点击执行时按正常失败路径处理。
3. UI 明确提示：没有真实 launchToken 时失败是预期。

### 7.6 `storage.get` / `storage.delete` 返回 `not_found`

处理规则：

1. 这不是 transport 错误。
2. 这是有效的协议错误返回。
3. UI 需明确显示 `not_found`，不要混成“未知错误”。

### 7.7 旧测试钱包 / feepool 工具与 session 体系并存

处理规则：

1. 测试钱包仍然只属于 demo 自己。
2. 它不参与 session 真值。
3. `feepool.commit` 仍然只做本地对端签名辅助，不升级成复杂状态系统。

### 7.8 文档与代码暂时不一致

处理规则：

1. 一次性施工里必须同步改。
2. 不允许先改代码、留文档以后补。
3. 若时间不够，缩范围也要保持文档与代码一致。

---

## 8. 文件级施工

以下为本次允许且预期会改动的文件级范围。

### 8.1 必改文件

#### `src/lib/protocol.ts`

职责：

- 硬切到新版协议 contract 镜像；
- 补 `connect.*`、`storage.*`、`cancel`、`not_found`；
- 更新旧业务方法的 `connectSessionId`。

验收点：

- 类型定义完整；
- `PROTOCOL_METHODS` 与当前新版真值一致；
- `ProtocolMessage` 包含 `cancel`。

#### `src/lib/connectClient.ts`

职责：

- 补 transport 层 cancel 支撑；
- 更新日志 stage；
- 保持 origin 校验、ready/result/closing 语义稳定。

验收点：

- 发送 `cancel` 的底层能力存在；
- 不引入第二套 transport 状态机。

#### `src/lib/popupSessionClient.ts`

职责：

- 暴露当前请求 cancel 能力；
- 继续维护单 popup、单在途 request；
- 对 popup 关闭、closing、result、cancel 做稳定收口。

验收点：

- 只能取消当前在途 request；
- popup 关闭后可重新开窗；
- 不出现本地队列。

#### `src/App.tsx`

职责：

- 页面 UI 与状态模型硬切到 session-first；
- 新增 Connect 与 Storage 工作区；
- 统一业务方法对 sessionId 的使用；
- 维护当前 session 摘要与本地缓存。

验收点：

- 可以显式跑 `connect.login` / `resume` / `logout` / `launch`；
- 可以显式跑 `storage.*`；
- 旧业务方法都能带 sessionId 发包。

#### `src/styles.css`

职责：

- 为 Connect / Storage 区、新的状态摘要、取消按钮、结果面板补样式；
- 保持现有工作台结构稳定。

验收点：

- 桌面与移动端都能正常操作；
- 不因新增方法区导致布局失控。

#### `README.md`

职责：

- 把项目定位、能力范围、手工验证步骤更新到新版协议；
- 明确 session-first 调用方式。

验收点：

- 不再描述“只有 7 个能力”；
- 包含 connect.*、storage.*、cancel 的说明。

#### `docs/KeymasterConnectDemo-首版设计.md`

职责：

- 把设计真值同步到新版协议；
- 解释为什么 demo 要变成 session-first 工作台。

验收点：

- 文档与实现真值一致；
- 不保留旧协议叙事。

### 8.2 必改测试文件

#### `src/lib/connectClient.test.ts`

职责：

- 补 `cancel` 相关单测；
- 更新方法集断言；
- 保持 closing / popup reopen / busy 语义覆盖。

验收点：

- 覆盖 16 方法集；
- 覆盖 cancel 基本行为。

### 8.3 允许新增的辅助文件

若 `App.tsx` 体量失控，允许新增以下“最小辅助文件”，但必须保持简单：

#### `src/lib/sessionCache.ts`

职责：

- 只处理当前 sessionId 的 localStorage 读写；
- 不处理复杂业务逻辑。

#### `src/lib/requestBuilders.ts`

职责：

- 只收口 Connect / Storage / 旧业务方法的 request 构包；
- 不做隐式魔法。

#### `src/lib/protocol.test.ts`

职责：

- 对纯类型常量 / 构包规则 / 结果形状做独立断言。

关键约束：

1. 新增文件必须是“为了压住单文件复杂度”。
2. 不得借机抽象出大而全状态机框架。

---

## 9. 最终验收清单

### 9.1 类型与 contract

- `PROTOCOL_METHODS` 为 16 个方法，且名称与 `keymaster.cc` 当前 contract 对齐。
- `ProtocolMessage` 包含 `ready/request/result/closing/cancel`。
- `ProtocolErrorCode` 包含 `not_found`。
- `identity.get`、`intent.sign`、`cipher.*`、`p2pkh.transfer`、`feepool.*`、`storage.*` 的 params 形状包含 `connectSessionId`。

### 9.2 Connect 工作区

- 可以发送 `connect.login`。
- `connect.login` 成功后，页面可见当前 `connectSessionId`、`ownerPublicKeyHex`、`resolvedClaims` 摘要。
- 可以发送 `connect.resume`。
- 可以发送 `connect.logout`。
- 可以发送 `connect.launch`。
- 刷新页面后，最近一次 sessionId 能从本地恢复到表单默认值。

### 9.3 业务方法工作区

- `identity.get` 能带当前 sessionId 发起请求。
- `intent.sign` 能带当前 sessionId 发起请求。
- `cipher.encrypt` / `cipher.decrypt` 能带当前 sessionId 发起请求。
- `p2pkh.transfer` 能带当前 sessionId 发起请求。
- `feepool.prepare` / `feepool.commit` 能带当前 sessionId 发起请求。
- `storage.put` / `get` / `list` / `listAll` / `delete` 都有独立可操作表单与结果展示。

### 9.4 Transport 与 cancel

- popup 仍然只开一个会话窗口。
- 同时仍然只允许一条在途 request。
- 在途 request 可以点击取消，demo 会发顶层 `cancel`。
- `cancel` 不会生成第二条伪 result 展示。
- 收到 `closing` 或 popup 手工关闭后，连接状态会进入 `disconnected`。

### 9.5 文档

- README 已更新为新版协议工作台说明。
- 首版设计文档已更新为 session-first 叙事。
- 本施工单已纳入 `/施工单` 目录并可作为后续迭代真值。

### 9.6 测试与构建

- `npm run test` 通过。
- `npm run typecheck` 通过。
- `npm run build` 通过。

### 9.7 手工联调

- 普通网页登录场景：`connect.login` -> `identity.get` / `cipher.*` / `storage.*` 可走通。
- 刷新后恢复场景：页面刷新 -> `connect.resume` 可手动触发。
- 注销场景：`connect.logout` 后，旧 sessionId 再跑业务方法应按协议失败。
- popup 关闭场景：手工关 popup -> 下次点击重新开窗。
- `storage.get` / `storage.delete` 命中不存在对象时，`not_found` 可见。
- `connect.launch` 没有真实 launchToken 时，失败路径清晰可见，不出现假成功。

---

## 10. 收口原则

本次若遇到实现体量压力，收口顺序必须是：

1. 先保证 contract、Connect 工作区、旧业务方法 session 化、Storage 工作区真实可测。
2. 再保证 cancel 与单测补齐。
3. 最后再做观察区与交互细节优化。

不允许反过来：

- 先做漂亮 UI；
- 再做一半 storage；
- 最后留着 connect.launch / cancel / 文档不同步。

本单的核心不是“页面多几个区块”，而是让 demo 重新对齐当前协议真值，并且继续保持外部调用方的独立测试价值。
