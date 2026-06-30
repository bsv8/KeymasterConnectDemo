# 002 KeymasterConnectDemo launch sessionWindowOrigin 显式注入硬切换施工单

## 参考文档与依赖项目

本次施工、联调、验收以下文档与代码为准：

- 本仓库：
  - `src/App.tsx`
  - `src/lib/connectClient.ts`
  - `src/lib/popupSessionClient.ts`
- 本仓库既有施工单：
  - `施工单/2026-06-30/001-KeymasterConnectDemo-appview-child-ready-and-opener-launch-硬切换施工单.md`
- 依赖项目：
  - `/home/david/Workspaces/keymaster.cc/施工单/2026-06-30/004-appview-launch-session-window-origin-explicit-injection-hard-switch.md`

发生冲突时：

1. 本单关于 Demo launch mode origin 真值来源的定义优先。
2. `001-...child-ready-and-opener-launch...` 里关于 child `ready`、自动 `connect.launch` 的定义继续有效。

---

## 1. 本单定位

本单不是改一个默认输入框初始值。

本单定义的是：

- `targetOrigin` 在本 Demo 里只保留给 popup / direct 模式
- `launch` 模式从此不再使用它
- `launch` 模式统一改读：
  - `sessionWindowOrigin`

---

## 2. 简述缘由

当前 Demo 的 `performAppViewLaunch()` 链路里：

1. 先取 `normalizedTargetOrigin`
2. 用它 `adoptOpener()`
3. 用它 `postReadyToOpener()`
4. 再用同一 transport 发 `connect.launch`

而 `normalizedTargetOrigin` 本身却来自：

- 历史缓存
- 或默认 `"https://keymaster.cc"`

这在设计上是错的：

- popup 的 `targetOrigin`
  不等于
- launch 打开我的那扇 Session Window 的 origin

---

## 3. 最终目标

本次完成后，Demo 必须达到以下状态：

1. popup / direct 模式继续使用 `targetOrigin`。
2. launch 模式不再读取默认 `https://keymaster.cc`。
3. launch 模式改读 URL 中显式注入的 `sessionWindowOrigin`。
4. `adoptOpener()` 只使用 `sessionWindowOrigin`。
5. `postReadyToOpener()` 只使用 `sessionWindowOrigin`。
6. launch 模式下首条 `connect.launch` request 也只使用 `sessionWindowOrigin`。
7. launch 模式缺少合法 `sessionWindowOrigin` 时直接失败。
8. 现有 direct 测试工作台与手工 `targetOrigin` 编辑能力不被破坏。

---

## 4. 单真值定义

### 4.1 Demo 的两种 origin 真值

本次固定：

```txt
popup/direct
  -> targetOrigin

launch/appView
  -> sessionWindowOrigin
```

### 4.2 launch 模式 origin 来源

本次固定：

```txt
sessionWindowOrigin
  = 父窗口在打开 child app 时显式写入 URL 的完整 origin
```

关键约束：

1. 必须是完整 origin，不是 `domain:port`
2. launch 模式下不能回退到本地 state 的 `targetOrigin`

---

## 5. 怎么做

### 一、把 `performAppViewLaunch()` 从 `normalizedTargetOrigin` 解耦

launch 模式里以下步骤统一改成只读 `sessionWindowOrigin`：

1. `adoptOpener()`
2. `postReadyToOpener()`
3. `connect.launch`

### 二、保留 `targetOrigin` 给 direct / popup 工作台

Demo 仍然是测试台，所以这些能力不删：

1. 手工输入 `targetOrigin`
2. 手工登录 / resume / launch 面板
3. direct popup 路径

只是 appView launch 自动路径不能再吃这些值。

### 三、失败策略

launch 模式下若：

- `launchToken` 存在
- 但 `sessionWindowOrigin` 缺失或非法

则：

1. 直接 appView failed
2. 停在失败态
3. 不自动回 direct

---

## 6. 不能怎么做

1. 不能继续让 launch 模式复用 `targetOrigin`。

2. 不能把默认 `https://keymaster.cc` 当 launch transport 真值。

3. 不能靠 child 自己读取 `window.opener.location.origin` 猜测。

4. 不能把 launch 模式的 `postMessage` 全部降级成 `"*"`。

---

## 7. 验收标准

1. Demo launch 模式不再依赖默认 `https://keymaster.cc`。
2. launch 模式的 `ready`、`connect.launch`、opener 复用都统一使用 `sessionWindowOrigin`。
3. direct 模式的 `targetOrigin` 输入与 popup 流保持原状。
4. launch URL 缺少合法 `sessionWindowOrigin` 时会明确失败。

