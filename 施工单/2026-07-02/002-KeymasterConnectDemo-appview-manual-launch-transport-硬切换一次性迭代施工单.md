# KeymasterConnectDemo appView 手工 connect.launch transport 硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下文档与代码为准：

- 本仓库现状代码
  - `src/App.tsx`
  - `src/lib/popupSessionClient.ts`
  - `src/lib/connectClient.ts`
  - `src/lib/connectClient.test.ts`
  - `README.md`
  - `docs/KeymasterConnectDemo-首版设计.md`
- 本仓库既有施工单
  - `施工单/2026-06-30/001-KeymasterConnectDemo-appview-child-ready-and-opener-launch-硬切换施工单.md`
  - `施工单/2026-06-30/002-KeymasterConnectDemo-launch-session-window-origin-显式注入-硬切换施工单.md`
  - `施工单/2026-07-01/001-KeymasterConnectDemo-appmsg-协议硬切换一次性迭代施工单.md`
- 联调参考仓
  - `/home/david/Workspaces/keymaster.cc`
  - `packages/plugin-protocol/src/protocolService.ts`
  - `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

发生冲突时：

1. 本单对 demo 端 appView transport 真值与行为边界的定义优先。
2. keymaster.cc 当前协议实现是外部约束，demo 需要对齐它，而不是反过来假定 keymaster 会兼容 demo 的错误 transport。
3. 历史施工单可保留历史描述，但现行代码、README、设计文档、测试必须与本单一致。

---

## 1. 本单定位

本单不是补一个“如果 opener 不好用就再偷偷开一扇 popup”的兼容层。

本单定义的是一次硬切换：

- appView 模式下，手工 `connect.launch` 与自动 `connect.launch` 共用同一条 transport 语义；
- 这条语义固定为：
  - 复用 `window.opener` 指向的 Session Window；
  - child 自己向 opener 发顶层 `ready`；
  - 后续所有协议请求继续走这条已收养的 opener transport；
- appView 模式下不得再通过 `ensureSession() -> window.open(...)` 新开一扇 protocol popup；
- 无法复用 opener 时，直接失败并要求“从 Keymaster 重新拉起”，不做降级。

本单目标不是“提高兼容性”，而是把 demo 收口到与 keymaster 当前协议实现一致的单一路径，消除一半 appView 走 opener、一半 appView 走 popup 的双轨真值。

---

## 2. 简述缘由

### 2.1 现在的 bug 不是 appmsg 协议先坏了，而是 appView transport 先走错了

联调现象是：

- demo 页已经打印了 `connect.launch`、`appmsg.list`、`appmsg.send` request；
- Session Window 没有相应表现，像是“没有收到消息”；
- 这不是典型的业务执行失败，更像 transport 对端不对。

结合两边源码，当前真实问题是：

- demo 的自动 appView 启动链路会先 `adoptOpener()`，这是对的；
- 但手工 `connect.launch` 提交流程没有先收养 opener，而是直接走普通 `runProtocolRequest()`；
- `runProtocolRequest()` 在没有现成 session 时会落到 `ensureSession()`；
- `ensureSession()` 会触发 `window.open(...)` 打开 `/protocol/v1/popup`；
- 于是 appView child 页面在“本应连回 opener 那扇 Session Window”的情况下，又新开了一扇 protocol popup。

这会导致用户看到：

- 页面上 request 已发送；
- 但真正负责当前 appView 会话的 Session Window 没反应；
- 后续 `appmsg.*` 也继续走错 transport，看起来像“session window 没动静”。

### 2.2 keymaster.cc 当前实现明确要求 appView 运行期只认 child app 那个 source

keymaster.cc 当前 `plugin-protocol` 约束已经很清楚：

- appView 模式下，真正的运行期对端是 child app，不是 launcher；
- Session Window 只允许绑定一个稳定的 child source window；
- 首条合法 child 协议消息会把这个 source 绑定下来；
- 之后同一 appView 会话的 request 必须继续来自同一个 child source。

所以 demo 再去新开 protocol popup，本质上是在协议层面造出第二个 transport peer。

这不是“还能试试看能不能兼容”的场景，而是违反当前协议模型的行为。

### 2.3 继续保留“双轨 appView transport”只会让问题越来越难查

如果继续允许：

- 自动 launch 走 opener；
- 手工 launch 走 popup；
- 失败时再视情况猜测该连哪一扇窗；

那后面所有联调问题都会变脏：

- `connect.launch` 成功到底绑到哪扇窗；
- `appmsg.inbox_dirty` 事件该推给谁；
- `appmsg.list` 为什么有时能收结果、有时完全没有；
- `closing` / `popup_closed` 收敛的是哪条 transport；
- 用户刷新后当前页面复用的是旧 opener 还是新 popup。

这与项目“宁可失败得直接，也不要为了补边角成功路径引入系统复杂度”的原则相冲突。

### 2.4 正确做法不是“回退”，而是“fail-closed + 重新从 Keymaster 拉起”

appView 启动期本来就是一个强约束场景：

- 当前页面是被 Session Window 打开的 child；
- `launchToken` 是一次性凭证；
- `sessionWindowOrigin` 是显式注入的真值；
- `window.opener` 是唯一应复用的 transport 对端。

缺其中任何一项，都不应该自动回到普通 popup 登录语义。

正确收口是：

- 缺 opener / opener 已关 / origin 不匹配 / ready 发不出去；
- 直接报错，页面进入 appView 失败态；
- 用户回到 Keymaster 重新点 `Open App`。

---

## 3. 最终目标

本次完成后，demo 必须达到以下状态：

1. appView 模式下，自动 `connect.launch` 与手工 `connect.launch` 复用同一条 opener transport 语义。
2. appView 模式下，demo 不再因为手工点击 `connect.launch` 而新开一扇 `/protocol/v1/popup`。
3. appView 模式下，一旦当前页面已成功 `adoptOpener()`，后续 `appmsg.send`、`appmsg.list`、`appmsg.get`、`identity.get` 等业务请求继续复用这条 opener transport。
4. appView 模式下，若 opener 不可用，手工 `connect.launch` 直接失败，不回退普通 popup。
5. direct / popup 模式下，现有 `ensureSession() -> window.open(...) -> wait ready` 行为保持不变。
6. README 与设计文档明确说明：appView 手工调试面板仍然存在，但 transport 不再是“再开一扇 popup”，而是“复用已存在的 opener Session Window”。
7. 测试覆盖以下关键边界：
  - appView 手工 `connect.launch` 先收养 opener；
  - appView 手工 `connect.launch` 不触发 `window.open`；
  - appView 手工 launch 成功后业务请求继续发给 opener；
  - opener 缺失时 fail-closed。

---

## 4. 单真值定义

### 4.1 appView transport 真值

本次固定：

```txt
appView transport peer
  = window.opener 指向的 Session Window
```

关键约束：

1. 这是 appView 启动期与运行期共同的 transport 真值。
2. 不是新开的 popup。
3. 不是用户输入框里的任意目标窗口。

### 4.2 appView transport origin 真值

本次固定：

```txt
appView targetOrigin
  = URL 注入的 sessionWindowOrigin
```

关键约束：

1. 不回退 `targetOrigin`。
2. 不猜 `window.opener.location.origin`。
3. 缺失 / 非法时直接 fail-closed。

### 4.3 appView 首次连回顺序真值

本次固定：

```txt
adoptOpener
  -> postReadyToOpener
  -> connect.launch
```

关键约束：

1. `ready` 在前，`connect.launch` 在后。
2. 手工 launch 与自动 launch 都必须满足这个顺序。
3. 不能跳过 `adoptOpener` 直接尝试 `runRequest()`。

### 4.4 appView 后续业务请求真值

本次固定：

```txt
appView launch 成功后所有业务 request
  = 继续走同一条已收养 opener transport
```

关键约束：

1. 不能“launch 走 opener，业务方法改走新 popup”。
2. 不能“launch 失败后业务方法偷偷开 popup 试一下”。
3. 不能为某个方法单独引入第二套 session client。

---

## 5. 怎么做

### 一、把手工 `connect.launch` 收口到与自动 launch 相同的 appView transport 链路

修改 `src/App.tsx` 中手工 `submitConnectLaunch()`：

1. 在 `startupMode === "appView"` 分支里，不再直接 `runProtocolRequest(request)`。
2. 改为显式获取当前 `PopupSessionClient`。
3. 先执行：
   - `adoptOpener()`
   - `postReadyToOpener(sessionWindowOrigin)`
4. 之后再发送 `connect.launch` request。
5. 成功后沿用现有 `adoptSessionFromResponse(...)` 收口 session。

这一步的本质不是“抽象复用”，而是消除手工 launch 与自动 launch 的 transport 分叉。

### 二、抽一个最小公共 helper，统一 appView 手工/自动 launch 的 transport 预备动作

建议在 `src/App.tsx` 内部抽一个页面级最小 helper，语义类似：

```txt
prepareAppViewTransportOrFail()
```

它只负责：

1. 校验 `sessionWindowOrigin` 存在；
2. `getSessionClient()`;
3. `adoptOpener()`;
4. `postReadyToOpener(...)`;
5. 失败时返回明确错误，由调用方写 UI 状态。

它不负责：

1. 组装 `connect.launch` request；
2. 写 session；
3. strip URL；
4. 发送业务 request。

这样做的原因是：

- 只抽 transport 原子，不再散落两套 appView 前置逻辑；
- 不扩成复杂状态机；
- 不引入“launch orchestrator”这类额外抽象。

### 三、确保 appView 成功后后续业务请求继续复用当前 opener session client

这部分原则上现有结构已经接近正确，因为：

- `getSessionClient()` 持有页面级单例；
- 一旦 `adoptOpener()` 成功，client 内部的 `popup` 就是 opener；
- 后续 `runRequest()` 会继续对这个 `popup` 发消息。

但需要补测试明确锁住这个行为：

1. appView 手工 `connect.launch` 成功后，执行 `appmsg.list`；
2. 断言请求发送目标仍是 opener；
3. 断言没有发生新的 `window.open(...)`。

### 四、补测试覆盖“不能重新开 popup”这一条硬约束

测试要覆盖的不只是“能成功”，而是“不会偷偷走错路”。

至少补以下测试：

1. appView 手工 `connect.launch`：
   - 有 opener；
   - 有合法 `sessionWindowOrigin`；
   - 调用后不触发 `window.open`。
2. appView 手工 `connect.launch`：
   - `adoptOpener()` 失败；
   - 页面进入错误态；
   - 不再尝试 `ensureSession()` / `window.open`。
3. appView 手工 `connect.launch`：
   - `postReadyToOpener()` 返回 `false`；
   - 页面进入错误态；
   - 不发送 `connect.launch` request。
4. appView launch 成功后首个 `appmsg.*`：
   - 继续发给 opener；
   - 不新开 popup。

### 五、更新 README 与设计文档

需要回写文档，明确以下事实：

1. appView 手工 `connect.launch` 面板仍然保留。
2. 该面板的作用是协议调试，不是另起一扇 popup。
3. appView 场景下：
   - transport 真值 = `sessionWindowOrigin + window.opener`
   - 失败时只能重启 appView，不会回退 direct/popup
4. `appmsg.*` 在 appView 下也走同一条已建立 transport。

---

## 6. 不能怎么做

### 6.1 不能在 appView 手工 `connect.launch` 里继续直接调 `runProtocolRequest()`

如果它前面没有先 `adoptOpener()`，那实际效果就是：

- 当前没有 session；
- `ensureSession()` 触发；
- `window.open(...)` 再开 protocol popup。

这正是本次要消灭的问题。

### 6.2 不能在 opener 失败时自动回退 direct / popup 登录

不能做：

- opener 不存在就偷偷按 `targetOrigin` 开 popup；
- `ready` 发不出去就继续尝试发 `connect.launch`；
- launch 失败后把页面切回 direct 模式。

因为这会把一次性 launchToken、当前 appView 语义和普通 popup 登录混成一锅。

### 6.3 不能给 appView 再做一套独立 session client

不能新增：

- `appViewSessionClient`
- `launchSessionClient`
- “手工 launch 专用 transport”

当前页面级 `PopupSessionClient` 已经有 `adoptOpener()` 能力，本次应该收口复用，而不是复制第二套状态。

### 6.4 不能把“如果 opener 不可用就新开 popup”包装成所谓兼容性增强

这不是增强，而是把错误路径变隐蔽。

代价是：

- 用户看到“有时能发，有时没反应”；
- Session Window 与新 popup 哪个是真正对端变得不可判断；
- 后续所有 `closing`、`event`、`result` 行为都变脏。

### 6.5 不能顺手改 keymaster.cc 协议来适配 demo 的错误行为

本次 bug 在 demo 端。

不能因为 demo 误开 popup，就去改 keymaster.cc：

- 放宽 appView source 绑定；
- 允许多个 child transport peer；
- 把 launcher / Session Window / child app 三者关系改模糊。

这会把协议层做脏，得不偿失。

---

## 7. 特殊情况与提前约定

### 7.1 当前页面带 `launchToken`，但不是从 Session Window 打开的

表现：

- URL 有 `launchToken`
- 但 `window.opener` 不存在，或已关闭

处理：

1. 直接进入 appView 失败态。
2. 手工 `connect.launch` 也继续失败。
3. 页面明确提示：请从 Keymaster 重新打开 app。

不做：

- 回退 direct 模式；
- 自己猜一个 popup target；
- 自行伪造 launch 成功。

### 7.2 opener 存在，但 `sessionWindowOrigin` 缺失或非法

处理：

1. 直接 fail-closed。
2. 不发 `ready`。
3. 不发 `connect.launch`。

原因：

- appView transport origin 真值就是 URL 注入值；
- 缺这项时继续发消息，只会把 transport 身份做脏。

### 7.3 手工 `connect.launch` 时 opener 可用，但之前页面已经错误地开过一扇 popup

处理原则：

1. 优先显式 `closeSession()` 清掉当前 client 旧状态；
2. 再重新 `adoptOpener()`；
3. 收口回 appView 正确路径。

原因：

- 不能继续带着“旧 popup 句柄 + 新 opener 意图”混跑。

### 7.4 opener 在 launch 成功后被用户手工关闭

处理：

1. 后续业务 request 失败；
2. demo 收到 `popup_closed` / `closing` 后收口当前 transport；
3. 用户重新从 Keymaster 打开 app，或走当前已设计好的后续恢复路径。

不做：

- 自动再开一扇 popup 顶上；
- 静默切 direct 模式；
- 偷偷改连别的窗口。

### 7.5 appmsg.core 未连接 HubMsg

这不是本单首要 bug，但需要提前说清：

- transport 修正后，若 `appmsg.core` 仍未连上 HubMsg，`appmsg.*` 会返回业务错误；
- 这属于“请求到了 Session Window，但执行失败”；
- 不应再表现为“Session Window 没反应”。

验收时要区分两类问题：

1. transport 根本没发到正确窗口；
2. transport 正确，但业务执行失败。

### 7.6 用户刷新了 child app 页面

刷新后：

- `launchToken` 可能已被 strip；
- opener 可能还在，也可能不在；
- 当前 transport runtime 可能已丢。

处理：

1. 不伪造旧 launch 自动恢复；
2. 继续遵守既有设计：
   - 有合法 session hint 时走 `connect.resume`；
   - 需要重新 appView 拉起时，由 Keymaster 再次打开。

本单不新增“刷新后自动重新握 launchToken”这类复杂逻辑。

---

## 8. 文件级施工范围

### 8.1 必改文件

- `src/App.tsx`
  - 收口手工 `connect.launch` 到 appView opener transport；
  - 视情况抽页面级最小 helper；
  - 统一错误文案与日志。
- `src/lib/connectClient.test.ts`
  - 补 appView transport 原子行为测试。
- `src/lib/popupSessionClient.ts`
  - 仅在确有必要时做最小修改；
  - 原则上不改整体状态机，只补当前硬切换所需的小接口/边界。
- `README.md`
  - 修正文档中对 appView 手工 launch 的 transport 说明。
- `docs/KeymasterConnectDemo-首版设计.md`
  - 对齐“手工 launch 面板保留，但 transport 仍复用 opener”。

### 8.2 能不改就不改的文件

- `src/lib/protocol.ts`
- `src/lib/requestBuilders.ts`
- 样式文件
- 其它业务工作台代码

原因：

- 本次不是协议字段变更；
- 不是 UI 改版；
- 不是 appmsg contract 变更；
- 只修 appView transport 分叉。

### 8.3 不应改动的外部仓文件

- `/home/david/Workspaces/keymaster.cc/packages/plugin-protocol/...`
- `/home/david/Workspaces/keymaster.cc/packages/plugin-appmsg/...`

除非联调时发现当前 keymaster.cc 与既有协议文档自相矛盾，否则本单不以“顺手改 keymaster”作为收口手段。

---

## 9. 实施顺序

1. 修改 `src/App.tsx`
   - 先把手工 `connect.launch` 接到 opener transport。
2. 跑前端单测
   - 至少覆盖 `connectClient` / `popupSessionClient` / 与 appView launch 相关测试。
3. 补 / 改测试
   - 锁住“appView 不再开新 popup”。
4. 更新 README 与设计文档
   - 对齐最终行为。
5. 做手工联调
   - 自动 launch
   - 手工 launch
   - launch 后 `appmsg.list`
   - launch 后 `appmsg.send`

---

## 10. 最终验收清单

### 10.1 代码行为验收

- [ ] appView 自动 `connect.launch` 仍然可用。
- [ ] appView 手工 `connect.launch` 不会触发新的 `window.open("/protocol/v1/popup")`。
- [ ] appView 手工 `connect.launch` 前会先复用 `window.opener`。
- [ ] appView 手工 `connect.launch` 前会先向 opener 发送顶层 `ready`。
- [ ] appView 手工 `connect.launch` 成功后，当前 session 摘要正确写入 `connectSessionId`。
- [ ] appView launch 成功后执行 `appmsg.list`，请求继续发给 opener，而不是新 popup。
- [ ] appView launch 成功后执行 `appmsg.send`，请求继续发给 opener，而不是新 popup。
- [ ] opener 不存在时，手工 `connect.launch` 直接失败，不发生 popup 回退。
- [ ] `sessionWindowOrigin` 缺失或非法时，手工 `connect.launch` 直接失败，不发 request。

### 10.2 测试验收

- [ ] 新增或更新单测，覆盖 appView 手工 launch 不开新 popup。
- [ ] 新增或更新单测，覆盖 opener 缺失时 fail-closed。
- [ ] 新增或更新单测，覆盖 launch 后业务请求继续复用 opener transport。
- [ ] 现有相关测试全部通过。

### 10.3 文档验收

- [ ] README 已明确 appView 手工 launch 仍复用 opener transport。
- [ ] 设计文档已删除或修正“手工 launch 可另开 popup”这类错误心智。
- [ ] 本施工单已能单独作为实现与回归依据，无需再依赖口头补充。

### 10.4 联调验收

- [ ] 在真实 appView 打开链路下，手工 `connect.launch` 后 Session Window 能看到并处理请求。
- [ ] 在同一会话下继续发 `appmsg.list`，Session Window 有响应，不再出现“demo 已打印 request，但 session window 没反应”的现象。
- [ ] transport 正确后，如 `appmsg.*` 失败，页面能看到明确错误，不再表现成无响应。

---

## 11. 完成定义

本单完成的定义不是“代码看起来更整洁”，而是：

1. demo 不再在 appView 手工 launch 路径上偷偷开第二扇 protocol popup。
2. appView 所有 request 的 transport 真值重新收口为同一条 opener 链路。
3. 联调时，`connect.launch -> appmsg.*` 的请求能稳定到达同一扇 Session Window。
4. 失败路径保持简单直接：不能复用 opener 就失败，不做复杂回退。

这四条同时满足，才算本次硬切换完成。
