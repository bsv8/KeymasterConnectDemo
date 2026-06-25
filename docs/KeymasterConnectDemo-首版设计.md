# KeymasterConnectDemo 首版设计

## 1. 目标

本项目不是 `keymaster.cc`(/home/david/Workspaces/keymaster.cc/) 的内部调试页，而是一个**独立的外部调用方 demo**，用来验证 Keymaster Connect V1 协议当前真实可用的四个能力：

- `identity.get`
- `intent.sign`
- `cipher.encrypt`
- `cipher.decrypt`

本 demo 的首要目标不是“做一个好看的网站”，而是：

- 真实走通 `window.open + postMessage + ready/request/result/closing`
- 真实验证 `aud` / `event.origin` / `BinaryField` / 签名 / 站点绑定加解密
- 把调用方最容易犯错的地方直接暴露出来
- 让协议验证结果可观察、可复现、可复核
- 验证 **popup 常驻 + 同窗复用 + 按 origin 归档命令流历史**的施工单 002 行为

## 2. 设计结论

### 2.1 硬切换

本项目采用**硬切换**，不分阶段，不保留双轨，不做兼容壳。

也就是说当前直接钉死：

- 只支持 Keymaster Connect V1
- 只支持 popup + `postMessage`
- 只支持 `ready -> request -> result` 与窗口结束时的 `closing`
- 只支持当前四个方法
- 只支持真实 Keymaster 站点，不做本地 mock 协议分支
- **popup 一次打开常驻复用**：单条 request 完成后不关窗；同一页面
  对同一 `targetOrigin` 共享一个 popup session client
- **同时只允许一条在途 request**：第二条并发会被直接拒绝
- **popup 内的命令流历史归 Keymaster 自有的 IndexedDB 保管**：
  demo 不缓存历史真值

### 2.2 这样做的缘由

这是一个协议验证 demo，不是生产业务入口。

如果这里再做：

- 旧协议兼容
- 本地 mock / fake provider
- iframe / redirect 双通道
- 自动重试 / 自动补救 / 自动归一化
- 多阶段发布开关
- 同窗并发多 request 队列
- demo 端历史真值缓存

那么验证出来的就不是“协议是否成立”，而是“demo 自己做了多少兜底后还能不能凑合跑”。这会直接污染验证结果，也会把系统复杂度无意义地抬高。

按当前项目处境，最合理的做法是：**demo 保持单一协议、单一通道、单一状态机，失败就暴露失败，修协议或修调用方，而不是在 demo 里补业务胶水。**

## 3. 范围

当前 demo 只做一个前端页面，不引入后端。

页面包含四块能力区和一个公共结果区：

- `identity.get` 请求与结果查看
- `intent.sign` 请求与结果查看
- `cipher.encrypt` 请求与结果查看
- `cipher.decrypt` 请求与结果查看
- 协议事件日志与原始报文查看

页面级 popup session client 由四个测试按钮共用，按钮之间串行复用 popup。

## 4. 核心边界

### 4.1 `target domain` 的真实含义

这里的“目标 domain”指的是 **Keymaster popup 打开的站点 origin**，默认值为：

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

如果把这两个概念混了，`identity.get` 和 `intent.sign` 会直接因 `aud !== event.origin` 失败，这不是 Keymaster 出错，而是调用方构包错了。

### 4.3 popup 路径

Keymaster popup 协议入口固定为：

- `/protocol/v1/popup`

因此 demo 的连接目标必须按下面方式拼接：

- `${targetOrigin}/protocol/v1/popup`

这里不做协议发现，不做路径协商，不做版本探测。

## 5. 实现形态

### 5.1 技术形态

建议使用：

- `Vite`
- `TypeScript`
- `React`

理由不是“为了前端时髦”，而是：

- 这个 demo 有四组表单、共享结果区、共享日志区，状态切换比静态页面多
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

可以参考它的文档与行为，但不能把它直接当 SDK 拉进来跑。缘由很直接：

- 如果 demo 和被验证系统共享同一份协议实现，验证就失去独立性
- 一旦协议实现里有同一类 bug，demo 也会“正确地错”，你看不出来

因此应当：

- 自己定义最小的协议消息类型
- 自己实现 popup session client（transport + 消息派发 + 关闭轮询）
- 自己实现 `BinaryField` 检查
- 自己做签名验签与 envelope 解码

这是“外部调用方验证”的必要条件。

## 6. 页面设计

### 6.1 顶部配置区

放在页面顶部，字段如下：

- `Keymaster Target Origin`
  - 默认 `https://keymaster.cc`
  - 可编辑
- `Popup Width`
  - 默认固定值，例如 `520`
- `Popup Height`
  - 默认固定值，例如 `760`
- `Ready Timeout(ms)`
  - 默认固定值，例如 `10000`
- `Result Timeout(ms)`
  - 默认固定值，例如 `60000`

设计原则：

- 可以改
- 但不搞配置中心
- 不做持久化也可以接受；即使刷新后丢失，也符合 demo 定位
- **targetOrigin / 尺寸 / 超时变化时，重置 session client**：旧 popup
  句柄被主动关闭，下次 submit 重新开新窗

### 6.2 `identity.get` 区

输入项：

- `text`
- `claims`
- `ttlSeconds`

行为：

- `iat` 由 demo 在发送前现算
- `exp = iat + ttlSeconds`
- `aud = window.location.origin`
- claims 用简单文本输入，例如一行一个 claim 或逗号分隔

结果区展示：

- 原始 `result`
- `identityEnvelope.bytes` 的十六进制 / base64
- CBOR 解码后的 envelope 数组
- `subject.publicKey`
- `signature`
- 本地验签结果
- `resolvedClaims`

### 6.3 `intent.sign` 区

输入项：

- `text`
- `contentType`
- `contentText`
- `ttlSeconds`

行为：

- 用 `TextEncoder` 把 `contentText` 转成 `ArrayBuffer`
- `aud = window.location.origin`
- `iat/exp` 发送前现算

结果区展示：

- 原始 `result`
- `signedEnvelope.bytes` 的十六进制 / base64
- CBOR 解码后的 envelope 数组
- 本地计算的 `contentSha256`
- envelope 中的 `contentSha256`
- 本地验签结果

### 6.4 `cipher.encrypt` 区

输入项：

- `text`
- `contentType`
- `contentText`

行为：

- 用 `TextEncoder` 转字节
- 发起 `cipher.encrypt`
- 成功后把 `nonce + cipherbytes` 存在当前页面内存里，供解密区一键回填

结果区展示：

- 原始 `result`
- `nonce` 十六进制 / base64
- `cipherbytes` 十六进制 / base64
- 一键送入 `cipher.decrypt`

### 6.5 `cipher.decrypt` 区

输入项：

- `text`
- `nonce`
- `cipherbytes`

支持两种来源：

- 使用上一次 `cipher.encrypt` 的输出直接回填
- 用户手工粘贴十六进制或 base64 数据

结果区展示：

- 原始 `result`
- `contentType`
- 解密后的字节
- 若可按 UTF-8 解码，则展示文本预览

### 6.6 公共日志区

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

这不是为了“做日志系统”，而是为了在 `invalid_request` 被静默忽略时，能看出流程卡在什么阶段。

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
7. 验签时直接对 `identityEnvelope.bytes` / `signedEnvelope.bytes` 验签
8. 结果展示中保留原始报文，不要只保留加工后的 UI 数据
9. 同一 popup session 内串行处理多条 request；不并发
10. popup 关闭 / 刷新 / `targetOrigin` 改变时，session 终止；下次 submit
    重新开新窗

### 7.2 不能怎么做

明确禁止：

- 不能在 `ready` 之前先发 request
- 不能把报文转成 JSON 字符串再传
- 不能把 `ArrayBuffer` 换成 base64 字符串塞进协议层
- 不能把 `aud` 写成 Keymaster 的 origin
- 不能自己归一化 `origin`，例如补默认端口、改小写、改 host
- 不能在同一个 popup 会话里**并发**连发多条 request
- 不能把 `identityEnvelope` / `signedEnvelope` 解码后重编码再验签
- 不能引入 mock 模式来“绕过 popup 验证”
- 不能加自动重试，把时序错误掩盖掉
- 不能在 demo 端做"命令流历史真值"持久化（历史归 Keymaster 端 IndexedDB）
- 不能用"重新 `window.open` 同一 name"假装复用 popup —— 那只会触发
  popup 重新导航，把 session 状态清掉

## 8. 特殊情况处理

### 8.1 popup 被浏览器拦截

处理方式：

- 页面直接报错提示“浏览器拦截了 popup，请允许本站弹窗后重试”
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

注意：首包非法 request 在 Keymaster 当前实现里会被**静默忽略**，不是一定回错，所以 demo 必须靠超时和日志定位。

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
- demo 侧只等待结果，不额外插入自己的“解锁中间页”

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

### 8.7 需要验证“跨 origin 解不开”

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
- popup 顶部显示“历史不可用”状态
- 当前命令至少保留在内存列表
- demo 不感知 DB 异常

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
- `src/lib/binary.ts`
- `src/lib/encoding.ts`
- `src/lib/verify.ts`
- `src/lib/cbor.ts`
- `README.md`

其中：

- `protocol.ts` 只放最小类型与错误码字面量
- `connectClient.ts` 放 transport 底层 helper（URL / features / 消息派发 /
  关闭检测 / 一次性 ready 等待），**不**拥有"单 request 生命周期"
- `popupSessionClient.ts` 放页面级 popup session client：持有 popup
  句柄、长期 message 监听、关闭轮询、连接状态机；支持 `ensureSession` /
  `runRequest` / `closeSession` / `getConnectionState`
- `binary.ts` / `encoding.ts` 只做字节、hex、base64 转换
- `verify.ts` 只做 SHA-256 与 secp256k1 验签
- `cbor.ts` 只做 envelope 解码
- `App.tsx` 收住所有页面状态，**不**做协议层状态机

## 10. 不做的事

明确不做：

- 不做后端验签服务
- 不做账户系统
- 不做 demo 端命令流历史持久化
- 不做多页面路由
- 不做文件上传优先流
- 不做图片 claim 专门预览器
- 不做 SDK 发布
- 不做 NPM 包抽取
- 不做未完成 request 恢复
- 不做请求队列（并发时直接拒绝）
- 不做 demo 端历史全文搜索
- 不做多协议版本并存

## 11. 完成标准

当前 demo 完成后，应当能稳定证明下面几件事：

- demo 能对任意可配置的 Keymaster origin 发起 popup 连接
- 第一次点击开窗；后续点击复用同一 popup 句柄，**不**再 `window.open`
- popup 关闭后下次点击会重开新窗
- `targetOrigin` 改变后强制放弃旧 popup 并打开新窗
- 同时只允许一条在途 request；并发被直接拒绝
- demo 能按真实协议调用四个方法
- demo 能在本地复核 `identity.get` / `intent.sign` 的返回真值与签名
- demo 能展示 `cipher.encrypt` / `cipher.decrypt` 的站点绑定行为
- demo 能把常见接入错误直接暴露出来，而不是替调用方偷偷修正
