# KeymasterConnectDemo Connect Runtime Config 硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下文档与代码为准：

- 本仓库现状代码
  - `src/App.tsx`
  - `src/styles.css`
  - `README.md`
  - `docs/KeymasterConnectDemo-首版设计.md`
- 本仓库既有施工单
  - `施工单/2026-06-29/002-新版-connect-协议-全面测试-demo-硬切换施工单.md`
  - `施工单/2026-06-30/001-KeymasterConnectDemo-appview-child-ready-and-opener-launch-硬切换施工单.md`
  - `施工单/2026-06-30/002-KeymasterConnectDemo-launch-session-window-origin-显式注入-硬切换施工单.md`

发生冲突时：

1. 本单关于 Demo 页面测试面的定义优先。
2. `connect` / `launch` transport 真值仍以既有 launch 施工单定义为准。
3. 历史施工单允许保留历史叙述，不作为本次必须回写对象；README、设计文档、现行代码必须与本单一致。

---

## 1. 本单定位

本单不是做一个“先把字段折叠起来，底层继续给用户调”的软收口。

本单定义的是一次**硬切换**：

- 页面顶部不再保留全局 `Runtime config` 区块；
- `Runtime config` 不再作为 Demo 的一级概念暴露；
- `Keymaster Target Origin` 移入 `Connect` 工作台，并明确归属 `Popup / Direct 登录`；
- `Popup Width`
- `Popup Height`
- `Ready Timeout(ms)`
- `Result Timeout(ms)`

以上 4 个字段从 UI 中彻底删除，代码固定使用缺省值：

- `520`
- `760`
- `10000`
- `60000`

这次目标不是“让高级用户还能偷偷调参数”，而是让 Demo 的页面测试面重新收敛到**connect 协议本身**，而不是 transport 调参台。

---

## 2. 简述缘由

### 2.1 现在的 `Runtime config` 混淆了“协议测试面”和“transport 实现细节”

当前顶部全局区块把下面 5 个字段并列展示：

- `Keymaster Target Origin`
- `Popup Width`
- `Popup Height`
- `Ready Timeout(ms)`
- `Result Timeout(ms)`

但它们并不处于同一层级：

- `Keymaster Target Origin` 是 direct / popup 登录链路的真实输入；
- 其余 4 个字段只是 transport 行为参数。

把它们并列展示，会让页面看起来像是在测试：

- 协议是否正确
- 与
- popup 尺寸/超时是否可调

这两件事。

而本 Demo 现在的定位不是 transport 参数实验台，而是外部调用方协议验证台。

### 2.2 这 4 个字段不是当前 Demo 真正关心的测试对象

根据当前使用事实：

- `Popup Width = 520`
- `Popup Height = 760`
- `Ready Timeout = 10000`
- `Result Timeout = 60000`

已经是稳定缺省值。

继续开放这几个输入框，带来的收益很小，但副作用很明确：

1. 抢占顶部版面，挤压真正有业务意义的内容。
2. 增加“改了参数导致行为变化”的噪音路径。
3. 让用户误以为这些 transport 旋钮也是本 Demo 的正式测试承诺。

这与项目“优先简单、允许边缘失败、不要为少量调试场景加系统复杂度”的原则冲突。

### 2.3 `Keymaster Target Origin` 应该归属 `Connect`，而不是全局 Header 下

`targetOrigin` 的使用边界已经很清楚：

- 只服务 popup / direct 路径；
- 不服务 `connect.launch` 的 appView 链路；
- 改变时只影响 popup/direct transport 复用与开窗。

因此它应该待在 `Connect` 工作台里，和：

- `connect.login`
- `connect.resume`
- `connect.logout`

放在同一个语义组下面。

把它摆在 header 下的全局配置区，会制造错误心智模型：

- 好像它对所有工作台、所有 transport、所有模式都同等生效。

这与实际行为不一致。

### 2.4 这次应当硬切，而不是留下“高级设置入口”

最容易滑向复杂化的做法，是删掉 4 个字段后再补一个：

- `Advanced runtime config`
- 或 query 参数开关
- 或本地 debug 折叠面板

本单明确不这么做。

原因很简单：

- 当前没有明确持续性的调参需求；
- 这些参数也不是业务侧验收对象；
- 为极少数临时调试保留正式 UI，会把偶发需要固化成长期复杂度。

如果未来真出现 transport 调参的长期刚需，应另开单，按“开发态专用能力”单独设计，而不是继续污染现行 Demo 主界面。

---

## 3. 最终目标

本次完成后，Demo 必须达到以下状态：

1. 页面顶部不再出现全局 `Runtime config` 区块。
2. `Keymaster Target Origin` 移入 `Connect` 工作台。
3. `Keymaster Target Origin` 明确只归属 `Popup / Direct 登录` 分组。
4. 页面 UI 中不再出现 `Popup Width`、`Popup Height`、`Ready Timeout(ms)`、`Result Timeout(ms)` 输入框。
5. 代码继续保留对应默认常量，但不再暴露用户编辑入口。
6. direct / popup 路径继续使用 `targetOrigin` 作为 transport 真值。
7. appView / launch 路径继续只使用 `sessionWindowOrigin`，不受本次 UI 收口影响。
8. README 与设计文档不再把“5 个全局 Runtime config 字段”描述为现行能力。
9. 页面文案不再出现“下方 Runtime config”这类已失效引用。

---

## 4. 单真值定义

### 4.1 页面级配置真值

本次固定：

```txt
页面对用户暴露的 connect transport 配置
  = 仅暴露 Keymaster Target Origin
```

关键约束：

1. 这是 direct / popup 登录链路参数。
2. 这不是全局 transport 面板。
3. 这不是 appView launch 参数。

### 4.2 transport 缺省参数真值

本次固定：

```txt
popupWidth      = 520
popupHeight     = 760
readyTimeoutMs  = 10000
resultTimeoutMs = 60000
```

关键约束：

1. 以上 4 个值继续保留在代码常量中。
2. 不再给用户提供输入框。
3. 不额外引入 localStorage、URL 参数、环境变量去改这 4 个值。

### 4.3 Connect 工作台归属真值

本次固定：

```txt
Connect / Popup / Direct 登录分组
  负责展示并编辑 targetOrigin
```

关键约束：

1. `targetOrigin` 与 `connect.login` / `connect.resume` / `connect.logout` 同组展示。
2. `connect.launch` 分组不展示也不消费这个字段作为自身真值。

### 4.4 launch/appView 行为真值

本次固定：

```txt
launch/appView transport origin
  = sessionWindowOrigin
```

关键约束：

1. 继续不回退 `targetOrigin`。
2. 本次只是收口 UI，不改 launch 链路协议语义。

---

## 5. 怎么做

### 一、删除顶部全局 `Runtime config` 区块

在 `App.tsx` 里删除 header 下方的整块全局配置面板：

- 删除标题 `Runtime config`
- 删除 `config-grid`
- 删除 5 个配置输入项的渲染

但状态层不做过度重构：

- `targetOrigin` state 继续保留；
- 4 个默认常量继续保留；
- `PopupSessionClient` 初始化时仍继续吃这 4 个固定值。

设计缘由：

- 目标是删除错误的 UI 暴露面，不是为了“形式上干净”把内部常量和初始化路径一起折腾坏。

### 二、把 `Keymaster Target Origin` 挪进 `Connect` 工作台

在 `renderConnectMain()` 的 `Popup / Direct 登录` 分组内新增一个明确字段：

- `Keymaster Target Origin`

建议放置位置：

1. 放在分组头说明之后；
2. 放在 `connect.login` 表单之前；
3. 与 direct/popup 说明文案贴近；
4. 不放进 `connect.launch` 分组。

设计缘由：

- 这个字段影响的是 direct/popup transport 真值，不是某一个单方法 payload；
- 它应该属于登录方式分组级配置，而不是某个单独 request 的字段。

### 三、把 direct/popup 文案改成“组内参数”，不再引用已删除区块

修正文案，避免继续出现：

- “取自下方 Runtime config 的 targetOrigin”

应改成：

- 当前分组内配置的 `Keymaster Target Origin`
- 或当前 popup/direct transport origin

设计缘由：

- 文案必须和页面结构一致；
- 否则用户会继续去找一个已经不存在的全局配置区。

### 四、保留既有行为，不引入新的配置来源

本次 UI 删除后，以下行为保持不变：

1. `targetOrigin` 改变后，direct/popup 旧 session client 仍会关闭并在下次请求时按新 origin 开窗。
2. `appView` 模式下，改 `targetOrigin` 不影响当前 launch 会话。
3. 当前 session 摘要仍按登录方式显示：
   - popup/direct => `targetOrigin`
   - launch/appView => `sessionWindowOrigin`

### 五、同步 README 与设计文档

README 要从“全局 runtime config”叙事改成：

- direct/popup 只暴露 `Keymaster Target Origin`
- 其余 popup 尺寸与超时使用固定缺省值

设计文档要把“5 个全局字段”改成新的现行真值：

- `targetOrigin` 是 Connect 工作台内的 direct/popup 参数
- 4 个 transport 参数是固定缺省值，不在 UI 调整

---

## 6. 不能怎么做

1. 不能保留顶部 `Runtime config`，只把 4 个字段 visually hidden。

原因：

- 这是假删除；结构和心智模型都没收口。

2. 不能把 4 个 transport 参数挪到 `Connect` 工作台继续展示。

原因：

- 这样只是“从 header 挪到 connect”，并没有解决它们不是测试对象的问题。

3. 不能给这 4 个参数再补一个“高级设置”折叠面板。

原因：

- 当前没有被证明的长期需求，只会把临时调试欲望固化为正式复杂度。

4. 不能把 `targetOrigin` 塞进 `connect.login` / `connect.resume` / `connect.logout` 的 request 表单字段。

原因：

- 它是 transport 组级真值，不是协议 payload 字段。

5. 不能借这次机会改 launch/appView 的 origin 语义。

原因：

- 那是另一条既有真值：`sessionWindowOrigin`；
- 本次只做 connect runtime UI 收口，不混入 launch 语义重构。

6. 不能新增一套 localStorage / URL query / 环境变量配置来替代被删掉的 4 个输入框。

原因：

- 这会把 UI 复杂度换成隐式复杂度，问题没有减少，只是藏起来。

---

## 7. 特殊情况怎么办

### 7.1 用户输入了非法 `targetOrigin`

处理原则：

- 保持当前 direct/popup fail-closed 行为；
- 不自动修正；
- 不回退默认值；
- 继续让 `normalizedTargetOrigin` 呈现 `invalid`。

这类错误本来就是 Demo 要显式暴露的测试路径，不需要为了“更顺手”加隐式兜底。

### 7.2 当前会话来自 `connect.launch`

处理原则：

- `SessionSummary` 继续显示 `sessionWindowOrigin`；
- `Connect` 工作台里的 `Keymaster Target Origin` 仅影响后续 direct/popup 路径；
- 不允许让用户误解为“改了 targetOrigin 就能改变当前 launch 会话”。

必要时在文案里继续强调：

- launch/appView 不读 `targetOrigin`。

### 7.3 用户在 direct/popup 已连通后修改 `targetOrigin`

处理原则：

- 保持现有逻辑：
  - 关闭旧 session client
  - 清理当前 popup transport 复用
  - 下次 direct/popup 请求按新 origin 重新建立

不新增：

- 自动重连
- 自动补发请求
- 自动 resume

### 7.4 本地缓存里保留了旧 `targetOrigin`

处理原则：

- 继续允许用缓存值预填 `targetOrigin`；
- 这是当前 demo 已有最小缓存设计的一部分；
- 本次不改缓存 contract。

注意：

- 缓存里保留 `targetOrigin` 不等于 UI 里必须暴露其它 4 个 transport 参数。

### 7.5 后续确实需要临时调 transport 参数

处理原则：

- 不在本单里预埋能力；
- 到时单开施工单，明确是：
  - 开发态专用能力
  - 还是正式测试面

如果只是一次性排障，优先直接改本地常量，不把偶发调试需求变成产品界面。

---

## 8. 文件级施工清单

### 8.1 `src/App.tsx`

必须修改：

1. 删除顶部全局 `Runtime config` 渲染区块。
2. 在 `Connect` 工作台 `Popup / Direct 登录` 分组内新增 `Keymaster Target Origin` 输入区。
3. 修正文案中“取自下方 Runtime config”的旧说法。
4. 保留默认常量与现有 state / effect 行为：
   - `DEFAULT_POPUP_WIDTH`
   - `DEFAULT_POPUP_HEIGHT`
   - `DEFAULT_READY_TIMEOUT`
   - `DEFAULT_RESULT_TIMEOUT`
5. 不让 `connect.launch` 分组消费 `targetOrigin` 作为自身 transport 真值。

不应该修改：

1. `connect.launch` 的 `sessionWindowOrigin` 真值定义。
2. `performAppViewLaunch()` 的协议顺序。
3. 各业务方法 `connectSessionId` 同步逻辑。

### 8.2 `src/styles.css`

必须修改：

1. 删除只服务顶部全局 `Runtime config` 区块的无用样式。
2. 为 `Connect` 分组内的 `Keymaster Target Origin` 输入区补最小必要样式。
3. 保持现有分组视觉层级，不因为少一个全局区块导致页面节奏塌掉。

不应该修改：

1. 整体三栏布局。
2. 工作台主视觉方向。
3. 与本单无关的 section/block 样式。

### 8.3 `README.md`

必须修改：

1. 删除或改写“全局 runtime config / 5 个字段”的旧叙述。
2. 明确 direct/popup 只暴露 `Keymaster Target Origin`。
3. 明确 popup 尺寸与超时使用固定缺省值，不属于当前 Demo 主要测试面。

### 8.4 `docs/KeymasterConnectDemo-首版设计.md`

必须修改：

1. 把“5 个全局字段”改成新的现行页面真值。
2. 把 `Runtime config` 的位置描述从 header 全局区调整为 `Connect` 工作台内 direct/popup 分组参数。
3. 明确 4 个 transport 参数固定缺省，不再作为用户可调测试项。

允许不改：

1. 历史章节里的已完成施工背景叙述。

前提：

- 不能让读者再把它理解成“当前现行 UI 仍有 5 个全局字段”。

### 8.5 自动化测试

本次默认不新增 UI 自动化测试文件。

理由：

- 当前仓库没有围绕 `App.tsx` 的页面测试基建；
- 这次是页面结构与文案收口，不是协议 contract 改动；
- 自动化验收以现有类型检查 / 构建通过 + 手工验收为主。

如果施工中发现现有 lint / build / typecheck 依赖于已删除 DOM 结构，再按最小代价补对应修复，不扩散到新测试体系。

---

## 9. 最终验收清单

### 9.1 页面结构验收

1. 页面顶部不再出现 `Runtime config` 标题。
2. `Connect` 工作台内能看到 `Keymaster Target Origin`。
3. `Keymaster Target Origin` 明确位于 `Popup / Direct 登录` 分组。
4. 页面中看不到：
   - `Popup Width`
   - `Popup Height`
   - `Ready Timeout(ms)`
   - `Result Timeout(ms)`

### 9.2 行为验收

1. 修改 `Keymaster Target Origin` 后，direct/popup 请求按新 origin 生效。
2. direct/popup 改 origin 后，旧 popup transport 不会被偷偷复用。
3. appView / launch 会话不因这个字段变化而改变其 transport 真值。
4. launch/appView 仍继续只读 `sessionWindowOrigin`。
5. 非法 `targetOrigin` 仍明确表现为失败路径，不自动兜底。

### 9.3 文案与认知验收

1. 页面文案中不再引用“下方 Runtime config”。
2. README 不再把 5 个全局字段描述成现行能力。
3. 设计文档不再把 4 个 transport 参数描述成用户要重点测试的对象。

### 9.4 构建验收

1. `npm run build` 通过。
2. 若仓库有现行 typecheck / test 命令且成本可接受，应同步跑通。
3. 若某项未执行，施工结果里必须显式说明原因，不能假装已验。

---

## 10. 完成定义

本单完成的标志不是“字段挪了位置”。

而是下面三件事同时成立：

1. 页面测试面收口到真正要测的 connect 参数与协议行为。
2. transport 缺省参数不再冒充正式测试对象。
3. 文档、代码、UI 三者对“现在这个 Demo 到底让用户配什么”给出同一个答案。
