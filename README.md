# Keymaster Connect Demo

独立的外部调用方测试项目，用来验证 Keymaster Connect V1 当前公开协议：**23 个 SDK 公开方法 + 2 种顶层 event**。

本项目不依赖 Keymaster 内部 contracts 包；协议类型和 request builders 在 Demo 内显式镜像，便于发现外部调用方与 Keymaster 真值之间的偏差。

## 当前能力

页面按 9 个工作台组织：

1. Connect
2. Identity
3. Cipher
4. Transfer
5. Channel
6. Price
7. Storage
8. MSFile
9. Test Wallet

23 个 SDK 公开方法：

```text
identity.get
intent.sign
cipher.encrypt
cipher.decrypt
p2pkh.transfer
connect.login
connect.resume
connect.logout
connect.launch
channel.publish
channel.subscription_set
price.get
price.subscribe
price.unsubscribe
storage.list
storage.directory.create
storage.directory.delete
storage.put
storage.get
storage.delete
msfile.stat
msfile.seed.read
msfile.block.read
```

server-pushed events：

- `price.changed`：当前展示价格变化，仅供显示。
- `channel.message_received`：携带已验签的频道、发布者公钥、消息编号和 JSON 内容。

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
```

`test:e2e` 会构建 production bundle，并用 Chromium 经过真实
`window.open` / popup / `postMessage` 和生产 UI handler 覆盖 Connect、
Channel、Storage、MSFile 与 Price。

## App metadata 与 Publisher

发行信息只在 [`index.html`](index.html) 的 `keymaster-app:*` meta 中维护：

- `keymaster-app:id`
- `keymaster-app:publisher-public-key`
- `keymaster-app:name`
- `keymaster-app:description`
- 可重复的 `keymaster-app:requirement`
- `keymaster-app:identity-signature`

当前能力要求固定为 `private-key` 和 `storage`。`storage` 表示 Keymaster
抽象存储能力，不绑定 S3 或其它具体 provider。

`publisher-public-key` 使用发行人的固定压缩 secp256k1 公钥，并且必须与
Keymaster 本地 catalog 中手工导入的数据完全一致。

发布采用两条明确的数据流：AppPackCore 负责生成签名，Demo 运行时只读取 HTML。

1. 在 Core 中创建 Publisher，确认公钥后手工写入 `index.html` 的
   `keymaster-app:publisher-public-key`；App sign 只输出固定
   `keymaster-app:identity-signature`，发行人再手工写回 HTML。
2. 运行 `app create` 从已签名的 HTML 派生项目 `keymaster.app.json`，手工复制到
   Keymaster catalog。该 JSON 不是浏览器运行时输入，Demo 不 fetch/import 它。

签名写入前入口会 fail closed，不伪造生产 signature。`keymaster.app.json` 不写入
`dist`，也不进入部署包。

```sh
export KEYMASTER_PUBLISHER_KEY_DIR=/secure/keymaster-publishers
export KEYMASTER_PUBLISHER_KEY_PASSWORD='...'
# 仅首次创建；已有同名 Publisher 时用 publisher list 确认公钥，不要重建
node ../KeymasterAppPackCore/packages/cli/dist/main.js publisher create keymaster-connect-demo
node ../KeymasterAppPackCore/packages/cli/dist/main.js publisher list
# 手工把公钥写入 index.html
node ../KeymasterAppPackCore/packages/cli/dist/main.js app sign --publisher keymaster-connect-demo
# 手工把输出的 identity-signature 写入 index.html
node ../KeymasterAppPackCore/packages/cli/dist/main.js app create
```

Demo 不生成、不保存 publisher 私钥；运行时从当前 `index.html` meta 构造完整固定
AppIdentityProof，并在 `connect.login` / `connect.launch` 中提交同一份 proof。
缺少签名或任何 meta shape 错误时请求直接失败。Direct login 由 Keymaster 直接
验签；Keymaster 拉起模式还会要求 proof 与本地 catalog/token 中的预期值完全一致。
Shared context 只展示 Keymaster 返回的 verified snapshot；其中 digest 是签名 payload
的稳定指纹，日志会遮蔽完整 signature。

AppPackCore 的 `.keymaster.json` 保存同一 proof 的 `identitySignature`，并可使用发行
私钥生成独立的 `bundleSignature`，保护具体构建的 proof、入口和文件哈希。项目文件
`keymaster.app.json` 不进入部署包，也不参与部署包校验。

## Transport 与 session

- Direct 模式使用常驻 popup，同一 target origin 复用窗口。
- appView 模式只收养 `window.opener`，不会偷偷退回 `window.open`。
- 页面同时只允许一条 in-flight request。
- `Cancel in-flight` 发送顶层 `cancel`，原 request 仍拥有最终 result。
- target origin 改变会关闭旧 popup。
- `connect.login`、`connect.resume`、`connect.launch` 成功后，当前 sessionId 会同步到所有 session-bound 工作台，同时仍允许测试人员手动改写单个工作台的 sessionId。
- `channel.*` 是例外：它的 connect session 属于 Session Window transport context，params 不带 `connectSessionId`，工作台也不提供 sessionId 输入框；必须先在同一窗口完成 login / resume。

## Channel

Channel 是当前唯一公开消息抽象；旧的 `appmsg.*` 与 `broadcast.*` 已从协议移除。

- `channel.publish`：输入 JSON 正文，Demo 解析后作为 `content` 构包；owner、签名和 messageId 由 Keymaster 生成。
- `channel.subscription_set`：替换当前 caller 的完整精确频道集合；空行表示清空。
- 最近 60 条 `channel.message_received` 保留已验签的 channel / 发布者公钥 / messageId / JSON content。
- 协议没有 `subscription_list`；订阅回读只依靠 `subscription_set` 返回值与 `statuses` 物理状态快照。

channel 是 exact string；不支持 wildcard 或 prefix，≤256 UTF-8 字节，`bsv8.inbox.*` 为保留私有 inbox。订阅最多 64 个且不得重复；publisher 公钥由 Keymaster 根据 session owner 补齐，caller 不能自报。

## MSFile

- `msfile.stat`：只提交 seed hash，返回各 Supplier 的 available / absent / discovering / quoted / network-error 状态与报价。
- `msfile.seed.read`：按 supplier + seed hash 读取并校验，上限 16 MiB。
- `msfile.block.read`：按 supplier + block hash 读取并校验，上限 256 KiB。
- Demo 不接受金额参数；全局价格和 App 单独额度由 Keymaster 管理，超额时由 Keymaster 内部确认。
- 完整二进制只存在于当前 result 与 Download 动作；展示层统一为 256 字节预览。

## Storage (S3-backed)

Storage 工作台只暴露 App namespace 内的相对路径。Demo 不接触或展示 S3 provider、bucket、endpoint、物理 key、credential 或 presigned URL。

使用 Storage 前必须满足：

- Keymaster 已配置并启用 Storage provider；
- 当前 connect session 带 Keymaster 本地 catalog metadata 快照；
- 工作台 sessionId 与目标 session 一致。

### Browse

`storage.list` 支持 `prefix`、opaque `cursor`、`limit`。成功后 `nextCursor` 自动回填；`Load next` 只在有 cursor 时启用，末页会清空已消费 cursor。

### Directory

- `storage.directory.create`
- `storage.directory.delete`

目录是 marker；删除 marker 不递归删除子对象。

### Small object

- `storage.put`：支持文本或 File、contentType、overwrite；File 在读取前检查 16 MiB 上限，超限时拒绝读取。
- `storage.get`：支持 offset、length、ifMatch；结果只渲染有限预览，并可显式 Download。
- `storage.delete`：删除单个对象。

单次 put/get 最大 16 MiB。完整二进制只保存在当前 get 下载 runtime；不会复制到 ResultPanel 或最多 30 条的 Storage history。

路径限制包括：相对路径、禁止 leading slash/反斜线/控制字符/Unicode slash lookalike/空 segment/`.`/`..`，object path 禁止尾 slash；list limit 为 1..1000。

## Test Wallet

Test Wallet 与 app publisher 完全独立，只服务 P2PKH 辅助测试：

- 生成或导入主网或 testnet WIF；
- 从 WhatsOnChain 查询 UTXO；
- 手工把测试余额退回 Keymaster 地址。

Test Wallet 私钥默认只在内存中，刷新即丢失。

## 端到端验收

当前验证入口：

- `npm run typecheck` 与 `npm test`：公开协议、构包、事件来源校验、二进制与签名验证。
- `npm run test:e2e`：生产 Demo 与明确的 popup fixture，覆盖 Connect、Channel、Price、Storage 与 MSFile；这项测试不代表真实钱包联调。
- `npm run test:e2e:local-connect`：相邻 `keymaster.cc` 与 Demo 的两个本地 origin，使用真实生产页面、新生成的无资金钱包，验证登录、身份、签名、密码学、App 文件读写、价格、恢复和注销。

当前 Storage 为钱包的本地 IndexedDB；不提供旧 `storage.upload.*` multipart 方法。历史远程 Provider 的记录保留在旧施工文档中，不作为本版验收证据。MSFile 返回 `sources`；读取使用 `sourceId`，block 读取还需 `seedHashHex`，本地来源为 `local-bitfs`，远程来源为 `remote-proxy:<公钥>`。

本地真实联调不读取资金配置，也不广播交易；资金转账、远程 MSFile 与线上部署交接需各自真实环境的证据。

## 设计与施工记录

- 本次 26 方法 / Channel / MSFile 对齐施工单：[`施工单/2026-09-18/001-KeymasterConnectDemo-26方法-Channel-MSFile-硬切换施工单.md`](施工单/2026-09-18/001-KeymasterConnectDemo-26方法-Channel-MSFile-硬切换施工单.md)
- 当前 App metadata 设计、三仓硬切换范围与验收门槛：[`施工单/2026-08-11/001-Keymaster-App-Meta与能力门禁-三仓硬切换施工单.md`](施工单/2026-08-11/001-Keymaster-App-Meta与能力门禁-三仓硬切换施工单.md)
- 27 方法与 Storage/Broadcast 历史施工记录：[`施工单/2026-08-10/001-KeymasterConnectDemo-27方法-Storage-Broadcast-AppIdentity-硬切换施工单.md`](施工单/2026-08-10/001-KeymasterConnectDemo-27方法-Storage-Broadcast-AppIdentity-硬切换施工单.md)
- 首版历史设计：[`docs/KeymasterConnectDemo-首版设计.md`](docs/KeymasterConnectDemo-首版设计.md)
