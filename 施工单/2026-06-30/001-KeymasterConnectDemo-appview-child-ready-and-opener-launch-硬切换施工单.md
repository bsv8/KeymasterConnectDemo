# 001 KeymasterConnectDemo appView child ready + opener launch 硬切换施工单

## 参考文档与依赖项目

本次施工、联调、验收以下文档与代码为准：

- 本仓库：
  - `src/App.tsx`
  - `src/lib/protocol.ts`
  - `src/lib/connectClient.ts`
  - `src/lib/popupSessionClient.ts`
  - `src/lib/requestBuilders.ts`
  - `src/lib/connectClient.test.ts`
- 依赖项目 `keymaster.cc`：
  - `施工单/2026-06-30/003-appview-child-ready-showapp-popup-two-stage-hard-switch.md`
  - `packages/contracts/src/protocol.ts`
- 依赖项目 `KeymasterConnectNotesDemo`：
  - `施工单/2026-06-30/001-KeymasterConnectNotesDemo-appview-child-ready-and-opener-launch-硬切换施工单.md`

发生冲突时：

1. 本单关于 demo 作为 appView child client 的行为定义优先。
2. 依赖项目里关于顶层 `ready` 对称语义、Session Window 两段 UI、`connect.launch` 真值继续有效。
3. 后续若再改 demo 的 appView 行为，必须先改本单，再改代码。

---

## 1. 本单定位

本单不是把 demo 的 `connect.launch` 表单文案改一改。

本单定义的是：

- 这个 demo 除了手工测试 `connect.launch` 外，还应能作为一个真的 appView child client 接到 Session Window 上；
- 因此它也要承担 child `ready` 发送职责；
- 继续复用顶层 `ready`，不新增新消息；
- appView child 模式下优先复用 `window.opener`；
- direct 模式下原有测试工作台继续保留。

本单目标不是把 demo 做成另一个 JustNote，而是让这个 demo 既能手工测协议，也能真正接一次 appView 端到端启动。

---

## 2. 简述缘由

### 2.1 现在 demo 只有手工 `connect.launch`，还不是完整 child client

当前 demo 已经有：

- `connect.launch` 类型与表单
- 从 URL 读 `launchToken`
- 手工点按钮发 `connect.launch`

但它还没有承担 appView child app 在窗口层的职责：

- 被 Session Window 打开后，自己向 opener 发 `ready`

因此它更像“手工协议面板”，还不是完整 child client。

### 2.2 这个 demo 的价值不只是点按钮，还要能覆盖真实窗口方向

如果它只能手工填 `launchToken`，却不能走真实窗口方向，那么很多问题测不到：

1. child listener 就绪信号
2. opener 复用
3. appView 启动顺序
4. `ready -> connect.launch` 时序

所以本单要求它补齐 child app 角色，而不是只保留表单测试。

---

## 3. 最终目标

本次完成后，demo 必须达到以下状态：

1. direct 模式下，现有测试台继续可用。
2. appView child 模式下，demo 能识别 URL `launchToken`。
3. appView child 模式下，demo 在自身 listener / transport 就绪后，向 opener 发顶层 `ready`。
4. 之后 demo 可自动复用 opener transport 发 `connect.launch`。
5. `connect.launch` 成功后，session 摘要区继续按现有方式收口。
6. 现有手工 `connect.launch` 面板继续保留，用于协议调试。
7. appView child 启动失败时不自动 fallback 到 direct login。

---

## 4. 单真值定义

### 4.1 demo 的两种 `connect.launch` 用法

本次固定：

```txt
connect.launch
  = 真实 appView child 启动
  + 手工协议调试入口
```

定义：

1. 真实 child 启动：
   - URL 带 `launchToken`
   - opener 存在
   - 自动发 `ready`
   - 自动发 `connect.launch`
2. 手工调试：
   - 用户手工填 token
   - 用户手工点击按钮

关键约束：

1. 这两条入口共享同一份协议类型与 request builder。
2. 不维护两套 `connect.launch` contract。

### 4.2 child `ready`

本次固定：

```txt
demo 被 Session Window 打开时
也要向 opener 发顶层 ready
```

关键约束：

1. 继续复用顶层 `ready`。
2. 不发新消息。
3. direct 模式不受影响。

---

## 5. 怎么做

### 一、给 demo 增加 appView child 启动路径

当 URL 存在 `launchToken` 且 opener 可用时：

1. 进入 appView child 模式
2. 建立 / 复用 popup session client
3. 发送顶层 `ready` 给 opener
4. 自动发 `connect.launch`
5. 成功后把 session 摘要写进当前 UI

### 二、手工 `connect.launch` 面板继续保留

本单不删掉 demo 的手工面板。

原因：

1. 这是测试台，不是纯业务 app；
2. 真实 appView child 启动与手工协议调试都需要；
3. 但真实 child 启动成功路径应以自动路径为准，不要求用户每次手工再点一次按钮。

### 三、opener 复用优先

appView child 模式下：

1. 优先复用 `window.opener`
2. 不主动新开 popup
3. opener 不可用则 fail-closed

### 四、appView child 失败不自动降级

若：

- opener 不可用
- `ready` 发送失败
- `connect.launch` 失败

则：

1. 明确提示失败
2. 不自动改走 direct 登录

---

## 6. 不能怎么做

1. 不能为 demo 再发明第二种 ready 消息。

2. 不能把真实 child 启动和手工调试拆成两套 `connect.launch` 类型。

3. 不能在 appView child 模式下忽略 opener、自行开 popup。

4. 不能因为 demo 是测试台，就继续不实现 child `ready`。

5. 不能在 child 模式失败后自动伪装成 direct 模式成功。

---

## 7. 验收标准

1. URL 含 `launchToken` 且 opener 可用时，demo 会自动向 opener 发顶层 `ready`。
2. 之后 demo 能自动复用 opener 发 `connect.launch`。
3. 手工 `connect.launch` 面板仍然存在。
4. appView child 失败不会自动降级成 direct 登录。
5. 现有 direct 模式测试工作台不被破坏。

