# KeymasterConnectDemo 一次性迭代施工单

## 1. 施工原则

本次不是分步骤灰度，不是兼容切换，不是先做一半再补。

本次直接按**硬切换**施工，原因如下：


- 这是协议验证 demo，不是线上业务系统
- 双轨实现只会把协议问题藏起来
- mock、fallback、自动修复会污染验证结果
- 当前最有价值的是尽快得到一份**真实外部调用方**的可运行样本

因此本次施工要求：

- 一次性做完首版最小闭环
- 不保留旧接口壳
- 不引入多协议并行
- 不做自动重试和自动纠错
- 出错就暴露，靠日志和结果定位

## 2. 实施目标

交付一套独立的前端 demo，满足：

- 可以配置 Keymaster target origin，默认 `https://keymaster.cc`
- 可以真实调用 `identity.get`
- 可以真实调用 `intent.sign`
- 可以真实调用 `cipher.encrypt`
- 可以真实调用 `cipher.decrypt`
- 可以本地验签并解码 envelope
- 可以把协议时序和错误展示出来

## 3. 文件级施工清单

### 3.1 项目基础文件

#### `package.json`

内容：

- 定义 `dev`、`build`、`preview`、`test` 脚本
- 依赖保持最小：
  - `react`
  - `react-dom`
  - `typescript`
  - `vite`
  - `vitest`
  - 一个轻量 CBOR 解码库
  - `@noble/curves`
  - `@noble/hashes`
- 不引入 UI 框架
- 不引入状态管理库
- 不引入路由库

验收：

- `npm install` 或等价包管理命令可成功
- `npm run dev` 可启动
- `npm run build` 可构建

#### `tsconfig.json`

内容：

- 浏览器前端 TypeScript 基础配置
- 严格模式打开
- JSX 配置到 React

验收：

- 本地 TS 检查不报类型错误

#### `vite.config.ts`

内容：

- 最小 Vite 配置
- 不添加无关插件

验收：

- dev/build 行为正常

#### `index.html`

内容：

- 根节点
- 页面标题

验收：

- 页面可挂载 React 应用

### 3.2 文档文件

#### `README.md`

内容：

- 项目定位
- 本地启动方式
- `target origin` 与 `aud` 的区别
- 四个能力如何手工验证
- `decrypt_failed` 跨 origin 验证方法

验收：

- 新同事不看源码，只看 README 就能把 demo 跑起来并做基本验证

### 3.3 源码文件

#### `src/main.tsx`

内容：

- React 入口
- 挂载 `App`

验收：

- 页面正常渲染

#### `src/App.tsx`

内容：

- 顶部配置区
- 四个能力表单区
- 结果展示区
- 事件日志区
- 页面所有状态收口在这里

约束：

- 不拆成过多组件
- 不引入全局 store
- 不引入路由

验收：

- 四个功能都能从页面直接操作
- 日志和结果能稳定更新

#### `src/styles.css`

内容：

- 最小但清晰的布局与状态样式
- 保证桌面和移动端都能正常读写表单

约束：

- 不追求重设计
- 不上复杂动效
- 以可读性优先

验收：

- 页面布局不乱
- 表单、结果、日志都可读

#### `src/lib/protocol.ts`

内容：

- 本 demo 自己的最小协议类型定义
- `BinaryField`
- `ready/request/result`
- 四个方法的请求/结果类型
- 协议错误码字面量

约束：

- 只定义本 demo 真正要用到的内容
- 不直接依赖 `keymaster.cc` monorepo 的 runtime 类型

验收：

- 页面和连接层可共享同一套最小类型

#### `src/lib/connectClient.ts`

内容：

- 打开 popup
- 等待 `ready`
- 发送 request
- 等待 result
- 超时控制
- popup 关闭检测
- 单次会话封装

必须遵守：

- 先 `ready`，后 `request`
- 不自动重试
- 不吞掉超时
- 不支持一个 popup 会话连续发多条 request

验收：

- 四个能力都通过这个统一连接层跑通
- popup 被拦截、超时、用户关闭等异常能暴露给 UI

#### `src/lib/binary.ts`

内容：

- `ArrayBuffer` / `Uint8Array` 互转
- `BinaryField` 组装与校验

验收：

- 协议层二进制输入输出统一

#### `src/lib/encoding.ts`

内容：

- UTF-8 文本与字节互转
- hex 编解码
- base64 编解码

验收：

- `cipher.decrypt` 可手工粘贴数据
- 结果区可展示多种编码格式

#### `src/lib/cbor.ts`

内容：

- 只做 envelope 结果解码
- 把 `identityEnvelope.bytes` / `signedEnvelope.bytes` 解成可展示结构

约束：

- 不自己手写一整套 CBOR 编码器
- 只保留 demo 所需最小能力

验收：

- `identity.get` / `intent.sign` 返回的 CBOR 可成功展示

#### `src/lib/verify.ts`

内容：

- SHA-256 计算
- secp256k1 compact 64-byte 验签
- `identity.get` 本地验签 helper
- `intent.sign` 本地验签 helper

约束：

- 直接对返回的 envelope 真值字节验签
- 不做“解码后重编码再验签”

验收：

- `identity.get` 和 `intent.sign` 都能在 demo 内给出本地复核结果

### 3.4 测试文件

#### `src/lib/connectClient.test.ts`

内容：

- `ready` 先于 `request` 的时序测试
- 超时测试
- popup 缺失 / 被关掉测试

验收：

- 关键时序不靠手点回归

#### `src/lib/verify.test.ts`

内容：

- compact 签名验签测试
- envelope 原样验签测试
- 篡改后验签失败测试

验收：

- 本地复核逻辑可信

#### `src/lib/encoding.test.ts`

内容：

- UTF-8 / hex / base64 互转测试
- 非法输入测试

验收：

- 手工粘贴数据时不容易误判

## 4. 页面行为要求

### 4.1 `identity.get`

必须这样做：

- `aud = window.location.origin`
- `iat`/`exp` 发送前现算
- `claims` 按用户输入发送
- 结果返回后立刻做本地验签和 CBOR 解码

不能这样做：

- 不能把 `aud` 写成 target origin
- 不能假装 claim 不存在也是错误
- 不能只展示 `resolvedClaims`，不展示 envelope 真值

### 4.2 `intent.sign`

必须这样做：

- 业务文本先转 `ArrayBuffer`
- `contentType` 明确可见
- 本地计算 `contentSha256` 与 envelope 内容对照
- 本地验签

不能这样做：

- 不能直接把字符串塞进 `content`
- 不能跳过 envelope 解码
- 不能只显示“签名成功”这种空洞状态

### 4.3 `cipher.encrypt`

必须这样做：

- 明文文本先转字节
- 成功后保存 `nonce + cipherbytes` 到当前页面状态
- 允许一键带入解密区

不能这样做：

- 不能自行拼业务密文格式
- 不能假装返回里有 `contentType` 回显

### 4.4 `cipher.decrypt`

必须这样做：

- 支持用上一次加密结果回填
- 支持手工粘贴 `nonce` / `cipherbytes`
- 成功后展示 `contentType` 和明文字节

不能这样做：

- 不能要求用户额外再输入 `contentType`
- 不能把 `decrypt_failed` 细分成假精确错误

## 5. 特殊情况预案

### 5.1 popup 被拦截

处理：

- 立即在页面报错
- 提示用户允许弹窗后重试

### 5.2 收不到 `ready`

处理：

- 到超时直接失败
- 在日志里明确停在 `waiting ready`

### 5.3 首包构造错了

处理：

- 不指望 Keymaster 一定回错
- 靠 demo 的超时和日志暴露
- 必须在开发态保留原始 request 预览

### 5.4 用户在 Keymaster popup 内取消

处理：

- 原样展示 `user_rejected`
- 日志标清楚

### 5.5 Keymaster 无 active key

处理：

- 原样展示 `active_key_unavailable`
- 不在 demo 里补救

### 5.6 解密失败

处理：

- 原样展示 `decrypt_failed`
- 辅助提示常见原因：origin 不同、nonce 错、cipherbytes 错
- 不自作聪明给出“确定原因”

### 5.7 需要验证跨 origin 失败

处理：

- 在 README 写清楚两套 origin 的手工步骤
- 不在首版里做双窗口自动编排

## 6. 施工顺序

1. 建立项目基础骨架：`package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`
2. 建立最小协议与连接层：`protocol.ts`、`connectClient.ts`、`binary.ts`、`encoding.ts`
3. 建立本地解码与复核能力：`cbor.ts`、`verify.ts`
4. 完成单页 UI：`App.tsx`、`styles.css`
5. 补测试：连接时序、编码工具、验签工具
6. 更新 README，写清手工验证步骤
7. 做完整人工验收

这里虽然列了顺序，但它不是分阶段上线；它只是编码时的落笔顺序。交付时必须是一次性完整闭环。

## 7. 最终验收清单

### 7.1 基础运行

- 项目能安装依赖
- 项目能本地启动
- 项目能成功构建
- 页面打开后无明显白屏或初始化错误

### 7.2 协议连接

- 可配置 target origin，默认值是 `https://keymaster.cc`
- popup 能打开到 `/protocol/v1/popup`
- 能先收 `ready`，再发 `request`
- result 能按 `id` 正常回收

### 7.3 `identity.get`

- 能成功发起请求
- `aud` 默认是当前 demo 页面 origin
- 成功结果能展示原始 `identityEnvelope`
- 能对 `identityEnvelope.bytes` 做本地验签
- 能展示解码后的 claims 投影
- claim 缺失时表现为省略，不是前端报错

### 7.4 `intent.sign`

- 能成功发起请求
- 能展示原始 `signedEnvelope`
- 能本地计算 `contentSha256`
- 能校对 envelope 中的 `contentSha256`
- 能对 `signedEnvelope.bytes` 做本地验签

### 7.5 `cipher.encrypt`

- 能成功返回 `nonce`
- 能成功返回 `cipherbytes`
- 结果能一键回填到解密区

### 7.6 `cipher.decrypt`

- 用同一 origin 上的加密结果可成功解密
- 成功后能展示 `contentType`
- 成功后能展示明文内容或字节预览
- 篡改 `nonce` 或 `cipherbytes` 后可稳定得到 `decrypt_failed`

### 7.7 异常展示

- popup 被拦截时有明确提示
- `ready` 超时时有明确提示
- `user_rejected` 有明确提示
- `active_key_unavailable` 有明确提示
- `decrypt_failed` 有明确提示
- 日志能帮助定位失败停在哪个阶段

### 7.8 文档完整性

- README 写清启动方式
- README 写清 `target origin` 与 `aud` 的区别
- README 写清跨 origin 的解密失败验证方法
- `docs/` 与 `施工单/` 文档与实现一致

## 8. 本次明确不施工的内容

- 不做后端服务
- 不做账号体系
- 不做协议 mock server
- 不做 iframe 通道
- 不做历史记录持久化
- 不做多协议版本切换
- 不做 SDK 抽包
- 不做自动恢复会话

这些都不是这次验证任务的必要部分，做了只会让系统变复杂。
