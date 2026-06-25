# Keymaster Connect Demo

独立的外部调用方 demo，用来验证 Keymaster Connect V1 的四个能力：

- `identity.get`
- `intent.sign`
- `cipher.encrypt`
- `cipher.decrypt`

这个项目只做前端，不做后端、不做 mock、不做兼容壳。

## 启动

```bash
npm install
npm run dev
```

构建与测试：

```bash
npm run build
npm run test
```

## 关键概念

- `Keymaster Target Origin` 是 popup 打开的目标站点 origin，默认是 `https://keymaster.cc`
- `aud` 是调用方自己声明的 origin，demo 会自动使用当前页面的 `window.location.origin`
- `identity.get` 和 `intent.sign` 会把 `aud` 写成当前页面 origin
- `cipher.encrypt` 和 `cipher.decrypt` 不接收 `aud`

这两个值不能混淆。把 `aud` 写成 target origin 会直接触发 origin 校验失败。

## popup 复用（施工单 002 硬切换）

本 demo **不再**是"一次点击 → 一次 request → 等 result → 会话结束"的一次性
模型。**popup 是常驻复用**的：

- 整个 demo 页面只有一个 popup session client 实例；四个测试按钮走同一个
  client。
- 第一次点击任一测试时打开 popup，等待 `ready`。
- 后续点击其它测试**不再**调用 `window.open`，直接复用现有 popup 句柄。
- popup 关闭（用户手工 / 浏览器回收）后，下次点击会重新开新窗。
- 同时只允许**一条在途** request；并发会被直接拒绝（按钮置灰）。
- `targetOrigin` 改变后，demo 主动关闭旧 popup，用新 origin 重新开窗。
- popup 内的命令流历史归 Keymaster 的 IndexedDB 保管，本 demo 不做
  历史真值存储，只发请求、维护 session、展示结果与日志。

## 手工验证

### 1. `identity.get`

1. 保持浏览器允许弹窗。
2. 在 `identity.get` 区点击 `Run identity.get`。
3. popup 第一次打开；完成后 popup **不会**自动关闭。
4. 切换到 `intent.sign` 区点击 `Run intent.sign`：popup **不会**重新打开；
   同一 popup 串行处理第二条 request。
5. 在 popup 内可以看到按 origin 归档的命令流历史。
6. 成功 / 失败后页面会显示：
   - 原始 result
   - `identityEnvelope` 的 CBOR 解码结果
   - `subject.publicKey`
   - `signature`
   - 本地验签结果
   - `resolvedClaims`

### 2. `intent.sign`

1. 在 `intent.sign` 区填写 `contentType` 和 `contentText`。
2. 点击 `Run intent.sign`。
3. 成功后页面会显示：
   - 原始 result
   - `signedEnvelope` 的 CBOR 解码结果
   - 本地计算的 `contentSha256`
   - envelope 里的 `contentSha256`
   - 本地验签结果

### 3. `cipher.encrypt`

1. 在 `cipher.encrypt` 区填写明文。
2. 点击 `Run cipher.encrypt`。
3. 成功后会拿到：
   - `nonce`
   - `cipherbytes`
4. 页面会自动把这一轮结果回填到 `cipher.decrypt`。

### 4. `cipher.decrypt`

1. 使用上一轮 `cipher.encrypt` 的 `nonce + cipherbytes`。
2. 点击 `Run cipher.decrypt`。
3. 成功后会显示：
   - `contentType`
   - 明文字节十六进制
   - 明文文本预览

如果把 `nonce` 或 `cipherbytes` 改坏，或者换到不同 origin 下去解密，应该稳定得到 `decrypt_failed`。

## 事件日志

底部的 `Protocol log` 会记录：

- popup 打开
- 等待 `ready`
- 收到 `ready`
- request 已发送
- 等待 result
- 收到 result
- popup 关闭
- `closing` 收到
- busy 被拒
- 超时

这部分用于排查协议时序和跨 origin 问题。

## 与 Keymaster 端的协议语义保持一致

- `result` 只表示**单条** request 的业务结果。
- `closing` 只在 popup **窗口**生命周期结束时才发（用户手工关闭 / 页面卸载
  / demo 主动要求）。
- popup 一次只面向一个当前 origin；切换 origin 时按新 origin 重新载入
  命令流历史。
- 单条 request 完成后 popup **不**自动关闭；它回到"等待下一条请求"的
  可继续复用状态。
