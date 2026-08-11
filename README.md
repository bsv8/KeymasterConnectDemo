# Keymaster Connect Demo

独立的外部调用方测试项目，用来验证 Keymaster Connect V1 当前公开协议：**27 个方法 + 2 种顶层 event**。

本项目不依赖 Keymaster 内部 contracts 包；协议类型和 request builders 在 Demo 内显式镜像，便于发现外部调用方与 Keymaster 真值之间的偏差。

## 当前能力

页面按 8 个工作台组织：

1. Connect
2. Identity
3. Cipher
4. Transfer
5. AppMsg
6. Broadcast
7. Storage
8. Test Wallet

27 个协议方法：

```text
identity.get
intent.sign
cipher.encrypt
cipher.decrypt
p2pkh.transfer
feepool.prepare
feepool.commit
connect.login
connect.resume
connect.logout
connect.launch
appmsg.send
appmsg.list
appmsg.get
broadcast.publish
broadcast.subscription_set
broadcast.subscription_list
storage.list
storage.directory.create
storage.directory.delete
storage.put
storage.get
storage.delete
storage.upload.begin
storage.upload.part
storage.upload.complete
storage.upload.abort
```

两种 server-pushed event：

- `appmsg.message_received`：携带完整公开 AppMsg message。
- `broadcast.message_received`：携带完整公开 Broadcast message，正文为 base64。

event 不回 result、不占用 in-flight 槽位、不改变连接状态。Demo 只接收当前 popup/opener source、exact target origin、已知 event 名和完整合法 data；其它消息 fail closed。

## 启动

```bash
npm install
npm run dev
```

默认 Keymaster target origin 是 `https://keymaster.cc`，可在 Connect 工作台修改。浏览器必须允许打开 popup。

自动验证命令：

```bash
npm run test
npm run typecheck
npm run build
npm run test:e2e
npm run test:broadcast:smoke
```

`test:e2e` 会构建 production bundle，并用 Chromium 经过真实
`window.open` / popup / `postMessage` 和生产 UI handler 覆盖 Connect、
Broadcast、Storage、multipart 与 Regenerate。`test:broadcast:smoke`
连接真实 HubCast WSS；两者都不会输出测试私钥。

## Publisher App Identity

页面首次启动时会：

1. 从 localStorage 读取 `keymaster-connect-demo.publisher-private-key.v1`；
2. 不存在或损坏时生成随机 32-byte secp256k1 私钥并持久化；
3. 从该私钥派生固定 Demo App Identity；
4. 在 `connect.login` 中自动携带签名 proof。

固定 App 信息：

```json
{
  "id": "keymaster-connect-demo",
  "name": "Keymaster Connect Demo"
}
```

Shared context 只展示本地 appId、publisher public key、identity digest，以及 Keymaster session 返回的 verified snapshot 和四字段匹配结果。私钥和 proof signature 不进入 UI、协议日志或操作历史。

> 这把私钥只用于 Demo publisher identity 和 Storage namespace 隔离。不要在生产应用中复制这种测试密钥管理方式，也不要把它当作 Keymaster 钱包或 Test Wallet 私钥。

如果 localStorage 不可写，页面会明确显示错误并阻止 `connect.login` 使用一个无法持久化的身份。

### Regenerate publisher key

页首按钮用于开始一轮全新的 publisher 测试：

- 有 current session 时，先真实执行 `connect.logout`。
- logout 被拒绝、失败或 transport 异常时，不换 key，也不清业务状态。
- logout 成功或原本没有 session 时，才生成并原子覆盖新 key。
- 新 key 成功持久化后，关闭当前 transport，清 session cache，并硬重置全部 session-bound 状态。
- 不自动重新 login。
- 保留 target origin、Test Wallet、UTXO 和退款工具状态。
- appView 模式禁用此按钮；必须从 Keymaster 重新拉起应用。

点击前应先删除本轮 Storage 测试对象，并对未完成 multipart 执行 `storage.upload.abort`。

## Transport 与 session

- Direct 模式使用常驻 popup，同一 target origin 复用窗口。
- appView 模式只收养 `window.opener`，不会偷偷退回 `window.open`。
- 页面同时只允许一条 in-flight request。
- `Cancel in-flight` 发送顶层 `cancel`，原 request 仍拥有最终 result。
- target origin 改变会关闭旧 popup。
- `connect.login`、`connect.resume`、`connect.launch` 成功后，当前 sessionId 会同步到所有业务工作台，同时仍允许测试人员手动改写单个工作台的 sessionId。

## AppMsg

### `appmsg.send`

公开目标字段是：

```text
recipientPublicKeyHex
recipientOrigin?   # exact origin，必须包含 scheme + host + port
recipientAppId?    # plugin/app id
```

`recipientOrigin` 与 `recipientAppId` 必须恰好填写一个。旧的 generic `recipientEndpoint` 形状不再接受。

### `appmsg.list`

只支持 `limit` 和 `afterMessageId` 正向增量读取。旧 `box` / `beforeMessageId` 不再存在。

### event

最近 60 条 `appmsg.message_received` 作为完整 message 队列展示，包括正文；event 不伪装成某条 request 的 response。

## Broadcast

- `broadcast.publish`：输入文本正文，Demo 以 UTF-8 编码后转 base64 构包。
- `broadcast.subscription_set`：替换当前 caller 的完整订阅集合；空数组表示清空。
- `broadcast.subscription_list`：读取当前 caller 自己贡献的订阅集合。
- 最近 60 条 `broadcast.message_received` 保留完整公开 message，并提供有限 UTF-8 正文预览。

channel 是 exact string；不支持 wildcard 或 prefix。publisher 公钥由 Keymaster 根据 session owner 补齐，caller 不能自报。

## Storage (S3-backed)

Storage 工作台只暴露 App namespace 内的相对路径。Demo 不接触或展示 S3 provider、bucket、endpoint、物理 key、credential 或 presigned URL。

使用 Storage 前必须满足：

- Keymaster 已配置并启用 Storage provider；
- 当前 connect session 带 verified App Identity；
- 工作台 sessionId 与目标 session 一致。

### Browse

`storage.list` 支持 `prefix`、opaque `cursor`、`limit`。成功后 `nextCursor` 自动回填；`Load next` 只在有 cursor 时启用，末页会清空已消费 cursor。

### Directory

- `storage.directory.create`
- `storage.directory.delete`

目录是 marker；删除 marker 不递归删除子对象。

### Small object

- `storage.put`：支持文本或 File、contentType、overwrite；File 在读取前检查 16 MiB 上限，超限时提示改用 multipart。
- `storage.get`：支持 offset、length、ifMatch；结果只渲染有限预览，并可显式 Download。
- `storage.delete`：删除单个对象。

单次 put/get 最大 16 MiB。完整二进制只保存在当前 get 下载 runtime；不会复制到 ResultPanel 或最多 30 条的 Storage history。

### Multipart

1. 选择 File，执行 `storage.upload.begin`。
2. Demo 回填 `uploadId`、`partSize`、`maxParts`。
3. 手动选择 `partNumber`，执行 `storage.upload.part`；Demo 按服务端 partSize 使用 `File.slice`。
4. 手动执行 `storage.upload.complete` 或 `storage.upload.abort`。

Demo 不自动重试、不自动 complete，也不在 provider/session generation 改变后偷偷重新 begin。

路径限制包括：相对路径、禁止 leading slash/反斜线/控制字符/Unicode slash lookalike/空 segment/`.`/`..`，object path 禁止尾 slash；list limit 为 1..1000，partNumber 为 1..10000。

## Test Wallet

Test Wallet 与 publisher identity 完全独立，只服务 P2PKH/FeePool 辅助测试：

- 生成或导入主网 WIF；
- 从 WhatsOnChain 查询 UTXO；
- 对 FeePool draft 做本地 counter-sign；
- 手工把测试余额退回 Keymaster 主网地址。

Test Wallet 私钥默认只在内存中，刷新即丢失。

## 端到端验收

本项目已完成以下分层实测：

- Demo production preview + Chromium：identity 刷新持久化、matched login、
  Broadcast 3 方法与 event、Storage 10 方法、range download、multipart、
  Regenerate/logout/reset、第二次新 publisher login。
- Keymaster production Chromium 基础环境及 App Identity/Broadcast/Storage
  protocol service 定向测试。
- 默认 HubCast 公网 WSS 双连接真实 publish/receive smoke。
- AWS S3、Cloudflare R2、S3-compatible 三家真实 Provider smoke，包括
  目录/list、条件写入、range、16 MiB multipart complete、abort、cancel 和
  隔离子树清理。

真实 S3 smoke 位于相邻 `keymaster.cc` 仓库，使用已配置且被 Git ignore 的
`.storage-smoke/.env`：

```bash
cd ../keymaster.cc
KEYMASTER_STORAGE_SMOKE_PROVIDER=all pnpm test:storage:smoke
```

## 设计与施工记录

- 当前设计、硬切换范围与验收门槛：[`施工单/2026-08-10/001-KeymasterConnectDemo-27方法-Storage-Broadcast-AppIdentity-硬切换施工单.md`](施工单/2026-08-10/001-KeymasterConnectDemo-27方法-Storage-Broadcast-AppIdentity-硬切换施工单.md)
- 首版历史设计：[`docs/KeymasterConnectDemo-首版设计.md`](docs/KeymasterConnectDemo-首版设计.md)
