# KeymasterConnectDemo / keymaster.cc popup 复用与命令流硬切换施工单

## 1. 结论先行

本次必须做**硬切换**，不能分阶段挂双轨。

原因很直接：

- `KeymasterConnectDemo` 现在是“一次点击 -> `window.open` -> 一次 request -> 等 result -> 会话结束”的一次性模型。
- `keymaster.cc` 现在的 `ProtocolService` 与 `ProtocolPopupPage` 也是“单 request、无持久化、结果后准备关窗”的一次性模型。
- 你要的是“popup 常驻 + 第二个测试复用同一个 popup + popup 内有按 domain 归档的命令流历史”。

这三件事不是补几行 UI 就能拼起来的，必须把 popup 的职责从“瞬时确认页”改成“域名协议面板”。

所以本单不做：

- 先保留旧 auto-close，再额外补一个“查看历史”页
- 先在 demo 端缓存 popup 句柄，但 Keymaster 端仍按旧逻辑每次结束就关窗
- 先把历史写到 demo 本地 `localStorage`
- 先做一套临时内存消息流，后面再补 DB

以上做法都会制造两套真值，最后只会把协议行为搞得更难收敛。

## 2. 这次到底要改成什么

### 2.1 popup 生命周期

改完后，popup 不再是“每个 request 的一次性确认窗”，而是：

- 同一个 demo 页面，对同一个 `targetOrigin`，只维护一个 popup 会话
- popup 第一次打开后保持驻留
- 后续点击其它测试，不重新 `window.open`，而是复用现有 popup 句柄
- popup 真正关闭时，才算这次 popup 会话结束

### 2.2 popup 里的展示模型

popup 主界面改成**单列时间流**，不是 Pinterest 式多列 Masonry。

这里“像瀑布流”我理解成：

- 新命令永远插到最上面
- 旧命令往下推
- 历史默认折叠
- 用户可以向下滚动看旧记录
- 用户可以随时回到顶部看最新命令

不做多列 Masonry 的原因：

- 协议命令有严格时间顺序
- 多列会破坏阅读顺序
- 确认、拒绝、失败这些状态本来就是时间流，不是内容画廊

所以最终 UI 形态应接近：

- 顶部 sticky 的当前 domain / 当前状态 / 关闭按钮 / 回到最新
- 下方单列 command feed
- 最新命令展开显示
- 历史命令默认折叠，只显示摘要

### 2.3 历史归档真值

所有协议命令的历史真值放在 **keymaster 自己的 IndexedDB**，而不是 demo。

索引维度按“domain”走，但实现上必须落 **exact origin**：

- 存 `event.origin`
- 例如 `https://demo.example.com`
- 不是只取裸 `host`

原因：

- 协议校验本来就绑定 `event.origin`
- 只按 `host` 分桶会把 `http/https/port` 串历史
- 历史归档必须和协议安全边界一致

UI 文案可以显示“站点 / 域名”，但 DB 真值必须存 exact origin。

## 3. 怎么做

## 3.1 Demo 端：从“一次性请求函数”改成“可复用 popup session client”

`KeymasterConnectDemo` 侧不能再每次点击都直接调用一次性 `runPopupProtocolRequest()`。

要改成：

- 页面级只保留一个 popup session client 实例
- 首次点击时：
  - 若没有 popup 句柄，打开 popup
  - 等一次 `ready`
  - 建立长期消息监听
- 后续点击时：
  - 若 popup 句柄仍存活且 `targetOrigin` 未变，直接复用
  - 不重新 `window.open`
  - 直接发新 request

同一时刻仍然只允许**一条在途 request**。

也就是说：

- 支持“同窗复用”
- 不支持“同窗并发多条 request”
- 不做请求队列
- 不做自动重试

这是刻意保持简单。

如果用户在上一条还没完时强点第二个测试：

- demo UI 直接禁用其它运行按钮，或明确报错：
  - `Popup session is busy with another request`

不要做客户端排队器。排队会把简单协议窗做成任务系统，复杂度不值。

## 3.2 Keymaster 端：popup 从“确认页”改成“域名命令面板”

`keymaster.cc` 的协议 popup 要从下面这个模型切走：

- 等第一条 request
- 显示确认页
- 回 result
- 发 `closing`
- 自动 `window.close()`

改成：

- popup 启动后常驻
- 先显示“等待请求 / 最近命令流”
- 收到第一条合法 request 后：
  - 绑定当前 request
  - 取该 `event.origin` 的历史
  - 把当前命令卡插到列表顶部
- 用户确认 / 取消 / 执行完后：
  - 更新同一张命令卡状态
  - popup 不自动关闭
  - 回到“等待下一条请求”的可继续复用状态

只有下面几种情况才发送 `closing` 并结束 popup 会话：

- 用户显式关闭窗口
- 页面卸载 / 刷新
- demo 主动要求关闭旧 popup（例如 `targetOrigin` 改变）

**不能**再把“单条 request 完成”当作 popup 生命周期结束。

## 3.3 历史数据模型：一条命令一条记录，不做 event-sourcing

这次不要把一条命令拆成很多 event row。

最小稳定模型应该是：

- 一条 request = 一条 `ProtocolCommandRecord`
- 这条记录随着流程推进被更新状态
- 卡片在 `updatedAt` 变化时重新排到最上面

建议字段：

- `id`
- `origin`
- `requestId`
- `method`
- `phase`
- `decision`
- `status`
- `textSummary`
- `claimsSummary`
- `contentType`
- `payloadSize`
- `activePublicKeyHex`
- `createdAt`
- `updatedAt`
- `finishedAt`
- `errorCode`
- `errorMessage`

状态建议收口为：

- `waiting_unlock`
- `waiting_confirm`
- `executing`
- `approved`
- `rejected`
- `failed`

这里的“许可”不要单独再造第二种对象类型。

更简单的做法是：

- 同一条命令卡里带出最终许可结果
- `approved / rejected / failed` 就是用户关心的许可结论

## 3.4 历史持久化范围：存命令摘要，不存完整敏感原文

“所有命令都存 DB”不等于“把所有原始二进制和明文都灌进去”。

应该持久化的是**命令摘要与决策记录**，不是完整敏感 payload。

建议规则：

- `identity.get`
  - 存 `aud(origin)`、`text`、请求的 `claims`
- `intent.sign`
  - 存 `text`、`contentType`、`content bytes length`
- `cipher.encrypt`
  - 存 `text`、`contentType`、`content bytes length`
- `cipher.decrypt`
  - 存 `text`、`nonce bytes length`、`cipherbytes bytes length`
- 成功/失败
  - 存结果状态、错误码、错误英文消息

不持久化：

- 私钥材料
- 解密后的明文完整内容
- 完整密文字节
- 完整签名结果字节
- 大体积二进制正文

原因不是“绝对不能存”，而是这次需求只是命令流与许可历史，不是审计冷库。
为了一个 feed 去把大字节内容永久落盘，只会让 DB、隐私和 UI 都变复杂。

## 3.5 DB 位置：用协议插件专属全局 DB，不用 key-scoped DB

本次历史库不建议挂到 `keyspace.openKeyStorage()` 的 per-key namespace。

建议新建协议插件自己的全局 DB，例如：

- DB 名：`keymaster.protocol`

理由：

- 你要的是按 domain 看命令历史，不是按 active key 看资产类真值
- key 切换后，站点协议历史仍然应该能看
- 删除某把 key 不是删除整个站点历史的同义词
- 这类数据更像协议审计轨迹，不像某把 key 的业务账本

但记录里要保留：

- `activePublicKeyHex`

这样既能按 domain 看历史，也不会丢掉“当时是谁签的”这层上下文。

## 3.6 首次打开 popup 时如何恢复历史

不要在 popup 还没拿到合法 request 前，就靠 URL 参数猜历史 domain。

正确做法是：

- popup 初始只显示“等待请求”
- 收到第一条合法 request 时，拿 `event.origin`
- 用这个 exact origin 去 DB 里查历史
- 把历史列表渲染出来
- 再把当前请求卡顶到最上面

这样做的好处是：

- 历史归属只信浏览器给的 `event.origin`
- 不信 query 参数
- 不信 demo 本地缓存
- 不会出现 A 站点伪造一个 URL 让 popup 提前展示 B 站点历史

## 4. 不能怎么做

以下方案本次明确禁止：

### 4.1 不能继续每次点击都 `window.open`

如果 demo 每次还在 `window.open(url, sameName, ...)`：

- 浏览器很可能会把现有 popup 重新导航一次
- popup 内历史和当前状态会被重置
- 表面看像“复用了窗口名”，实际上没有复用会话

这不算满足需求。

### 4.2 不能让 popup 每条 request 后自动关闭

只要还有 auto-close：

- 第二个测试就不可能是真复用
- 历史流也留不住上下文

所以 `DoneView -> setTimeout(window.close)` 这条逻辑必须删。

### 4.3 不能把 `closing` 当作“每条 request 的尾包”

`closing` 现在应该回到它本来的职责：

- popup 生命周期结束信号

不是：

- 单条 request 完成信号

单条 request 完成只靠 `result`。

### 4.4 不能把历史真值放 demo 本地

历史必须以 Keymaster DB 为准。

demo 只负责：

- 发请求
- 维护 popup session
- 展示本地结果与调试日志

不能再额外存一套“命令历史真值”，否则两边一定漂移。

### 4.5 不能按裸 host 存历史

禁止：

- `example.com`

必须：

- `https://example.com`
- `https://example.com:8443`

否则 origin 安全边界会被 UI 设计偷掉。

### 4.6 不能把并发、多站点切换、恢复旧会话一次做满

本次只做最小闭环：

- 单 popup 会话
- 单在途 request
- exact origin 历史流
- popup 常驻

不做：

- 多 request 并发队列
- 多 opener 争抢同一 popup 的会话编排
- popup 刷新后恢复未完成 request
- 离线补写历史

## 5. 特殊情况怎么处理

### 5.1 popup 被用户手工关掉

处理：

- demo 侧清空缓存句柄
- 连接状态回 `disconnected`
- 下次点击重新打开新 popup

不做：

- 自动偷偷重开
- 自动重发上一条命令

### 5.2 `targetOrigin` 被改了

处理：

- 旧 popup 会话直接作废
- demo 主动关闭旧句柄
- 清空 session client
- 用新 `targetOrigin` 重新开窗

不做：

- 试图把旧窗口里的协议状态迁移到新 origin

### 5.3 popup 还活着，但 request 正在处理中

处理：

- 第二个按钮直接禁止
- 或显式提示当前 popup 正忙

不做：

- 客户端排队
- 背景 silently queue

### 5.4 popup 刷新

处理：

- 视为旧 popup 会话结束
- demo 发现旧监听失效后，等待新 `ready` 或重新开窗
- Keymaster popup 重载后只恢复 DB 历史，不恢复未完成 request

这点要故意保守。

未完成 request 不做恢复，避免引入半完成事务复杂度。

### 5.5 历史 DB 打不开 / 写失败

处理：

- 当前 request 继续走协议主流程
- popup 顶部显示“历史不可用”状态
- 当前命令至少保留在内存列表
- 打英文错误日志

不做：

- 自动重试风暴
- 事务补偿系统
- 为了写历史失败而阻塞签名/解密主流程

这符合“系统简单优先，边缘失败就让它失败”的原则。

### 5.6 收到不同 origin 的下一条 request

处理：

- 合法 request 来了，就把当前 feed 视图切到新 origin
- 重新从 DB 载入该 origin 历史
- 新请求卡插到最上面

不做：

- 一页同时拼多 origin 混合流

协议窗一次只面向一个当前 origin，看起来更清楚。

## 6. 文件级一次性施工清单

下面按两个项目分别列。

## 6.1 KeymasterConnectDemo

### `src/lib/connectClient.ts`

处理方式：

- 取消“每次调用都自己开窗并绑定一次性监听”的 owner 身份
- 改成底层 transport helper，或拆出复用所需公共逻辑

核心变化：

- 监听器不再跟单次 Promise 同生共死
- 支持已有 popup 句柄复用
- 区分“session ready”与“request result”

### 新增 `src/lib/popupSessionClient.ts`

新增一个页面级 popup session client。

职责：

- 持有 popup 句柄
- 持有长期 `message` 监听
- 首次开窗等待 `ready`
- 后续复用同一 popup
- 序列化 request
- 暴露：
  - `ensureSession()`
  - `runRequest(request)`
  - `closeSession()`
  - `getConnectionState()`

### `src/lib/connectClient.test.ts`

测试改成覆盖：

- 首次点击开窗
- 第二次点击不再 `window.open`
- popup 关闭后会重新开窗
- 正在处理时第二次点击被拒绝
- `targetOrigin` 改变后强制新开窗

### `src/App.tsx`

处理方式：

- 页面只持有一个 popup session client
- 四个测试按钮统一走同一个 session client
- 运行中禁用其它测试按钮
- 连接状态显示改成“会话级状态”，而不是“单次请求生命周期状态”

### `README.md`

必须更新：

- popup 现在是常驻复用
- 第二个测试会复用现有 popup
- popup 关闭后下次会重开
- 同时只支持一条在途 request

### `docs/KeymasterConnectDemo-首版设计.md`

必须改掉旧语义：

- 不能再写“一次 request 对应一个 popup 会话”
- 不能再写“结果后 popup 结束”

如果不改文档，后面实现的人会被旧设计误导。

## 6.2 keymaster.cc

### `packages/contracts/src/protocol.ts`

处理方式：

- 保留外部协议 `ready/request/result/closing` 四种顶层报文
- 明确 `closing` 是 popup 生命周期结束，不是每条 request 的结束
- 新增 popup 命令流所需的内部契约类型

建议新增类型：

- `ProtocolCommandRecord`
- `ProtocolCommandStatus`
- `ProtocolCommandFeedState`

并新增 `ProtocolService` 能力接口：

- `currentOrigin()`
- `feedSnapshot()`
- `subscribeFeed(...)`

不要把命令流硬塞回现有 `ProtocolSessionSnapshot`。

`ProtocolSessionSnapshot` 继续只表达会话状态机。

### 新增 `packages/plugin-protocol/src/protocolCommandDb.ts`

职责：

- 打开 `keymaster.protocol`
- 创建 `commands` store
- 建 index：
  - `origin`
  - `updatedAt`
  - 建议再加 compound index：`origin+updatedAt`
- 提供：
  - `putCommand`
  - `getCommand`
  - `listCommandsByOrigin`

### 新增 `packages/plugin-protocol/src/protocolCommandDb.test.ts`

覆盖：

- 能按 exact origin 拉历史
- 新命令插入后能按 `updatedAt desc` 返回
- 不同 origin 不串历史
- 更新同一命令后仍只保留一条记录

### `packages/plugin-protocol/src/protocolService.ts`

这是本次改造核心。

必须改成：

- service 生命周期跟 popup 窗口走
- request 生命周期跟单条命令走
- 单条 request 完成后：
  - 更新命令卡
  - phase 回到 waiting
  - 不结束 popup 会话
  - 不自动发 `closing`

新增职责：

- 接收第一条合法 request 时按 `event.origin` 载入历史
- 创建当前命令卡
- 状态推进时更新 DB
- 向 UI 推送 feed snapshot

保留约束：

- 同时只处理一条 request
- 非当前 request / 非 opener 消息继续忽略
- 无复杂恢复逻辑

### `packages/plugin-protocol/src/protocolService.test.ts`

必须补的测试：

- 同一 popup 会话内连续处理两条 request
- 第一条成功后 popup 不 close，phase 回 waiting
- 第二条 request 复用同一 popup service
- 不同 origin 请求会切换 feed 历史
- `pageUnloading` 才发 `closing`
- DB 写失败不阻塞主协议结果

### `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

从“单确认页组件”改成“命令流面板”。

页面结构建议：

- 顶部：
  - 当前站点
  - 当前会话状态
  - 关闭按钮
  - 回到最新按钮
- 中间：
  - 当前进行中的命令卡
  - 历史命令列表
- 底部：
  - 空态 / 历史不可用提示

交互规则：

- 最新命令默认展开
- 历史命令默认折叠
- 点击卡片可展开详情
- 新命令出现时自动滚回顶部

### 新增 `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`

建议单独拆出 feed 组件。

原因：

- `ProtocolPopupPage.tsx` 现在已经承担 session page 职责
- 再把 feed 渲染全堆进去会过重
- 但也不要拆太碎，保持“一页 + 一个 feed 组件”就够

### 新增 `packages/plugin-protocol/src/styles.css`

用于协议 popup 专属样式。

要点：

- 单列流布局
- sticky 顶栏
- 折叠卡片
- 长列表滚动
- 移动端可读

### `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`

必须补 UI 行为测试：

- waiting 状态显示空 feed / 等待文案
- 收到历史后按新到旧渲染
- 最新命令默认展开
- 历史命令可点击展开
- 完成一条后页面不自动关闭

### `packages/plugin-protocol/src/manifest.ts`

处理：

- 注入新的 command DB/repository 给 protocol service
- 补 i18n 文案

新增文案包括：

- 当前站点
- 最近命令
- 回到最新
- 历史不可用
- 已批准 / 已拒绝 / 执行失败

### `packages/plugin-protocol/src/index.ts`

如有新增 feed 组件 / DB helper，需要统一导出。

### `docs/keymaster-protocol-common-v1-draft.md`

必须修正文档真值：

- popup 生命周期不再默认一条 request 一次结束
- `result` 是单条请求结果
- `closing` 是窗口会话结束

### `docs/keymaster-protocol-v1-draft.md`

同步补上：

- popup 常驻复用语义
- 同窗串行多 request 语义
- 历史只按 `event.origin` 归档

### `apps/web/src/App.protocol.test.tsx`

大概率不用改路由行为，但建议补一条：

- 带 query 的 `/protocol/v1/popup?...` 仍正常命中 popup 页

虽然当前 `pathname` 已经天然满足，但最好显式锁住。

## 7. 最终验收清单

## 7.1 Demo 复用验收

- 第一次点击任一测试，会打开 popup
- popup 打开后不因单条 request 完成而自动关闭
- 第二次点击任一测试，不会再次调用新的 `window.open`
- popup 被手工关闭后，再点测试会重新开新窗
- `targetOrigin` 改变后，会强制放弃旧 popup 并打开新窗

## 7.2 Keymaster popup 命令流验收

- popup 顶部始终能看到当前 exact origin
- 新命令出现时，卡片出现在最上面
- 老命令被往下推
- 历史命令默认折叠
- 可以向下滚动查看历史
- 可以回到顶部看最新命令
- 单条命令完成后 popup 不自动关闭，而是回到等待下一条命令

## 7.3 DB 持久化验收

- 每条合法协议命令都会落到 Keymaster 的协议 DB
- 同一 origin 的历史能在 popup 内重新打开后恢复
- 不同 origin 的历史不会串
- 存储主键唯一，不会因状态更新写出重复命令卡
- DB 中保留命令摘要与结果状态，不保留私钥与大体积敏感正文

## 7.4 协议语义验收

- `result` 只表示单条 request 完成
- `closing` 只在 popup 会话真的结束时才发
- popup 会话存活期间，允许串行处理多条 request
- 同时仍然只允许一条在途 request

## 7.5 异常路径验收

- popup 手工关闭后 demo 能识别并重新开窗
- popup 刷新不会恢复旧的未完成 request
- 正在处理时再次点击测试，不会并发发出第二条 request
- 历史 DB 不可写时，当前协议主流程仍可继续，且 UI 有可见错误提示

## 8. 本单的落地边界

这次只做：

- popup 复用
- popup 常驻
- domain(exact origin) 维度历史
- popup 内命令流
- Keymaster DB 持久化

这次不做：

- 跨多个 opener 的复杂会话编排
- 并发 request 队列
- 未完成 request 恢复
- 历史全文搜索
- 历史删除/清理策略 UI
- 多列瀑布流视觉花活

先把“单 popup、单在途、可复用、可看历史”的最小闭环做硬、做稳，再谈后续扩展。
