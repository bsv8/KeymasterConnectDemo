# Keymaster Connect Demo

跟随 **最新官方 `@keymaster/connect` SDK** 的外部网页 App，演示 Connect v1。产品尚未上线，接口和 wire 版本都保持 v1，不维护已删除字段的兼容分支。

## 安装与运行

相邻目录布局：

```text
Workspaces/
├── keymaster.cc/          # 官方 SDK：packages/connect
├── KeymasterConnectDemo/  # 此项目
└── BSV8_Engineering/      # 测试、设计事实及过程文档
```

先按 `keymaster.cc` 的说明安装其 workspace 依赖，然后：

```sh
npm install
npm run dev
npm run build
npm run preview
```

依赖使用 `file:../keymaster.cc/packages/connect`。`dev`、`build`、`test` 会先构建官方 SDK，避免误用旧 dist；Demo 不复制 SDK 源码、contracts、协议类型、request builders 或 postMessage 实现。

直开页面默认目标是 `https://keymaster.cc`，可在 Connect 工作台填写可信的**精确 origin**，点“应用地址”后执行登录。更改目标会关闭旧连接。连接后只读展示 SDK 返回的 `networkIdentity`，不提供钱包公钥、网络或 session 选择输入。

## 工作台

| 工作台 | 演示方法 |
| --- | --- |
| Connect | `connect.login` / `resume` / `logout` / `launch` |
| Identity | `identity.get`、`intent.sign`，附本地 CBOR / secp256k1 验签 |
| Cipher | `cipher.encrypt`、`cipher.decrypt` |
| Payment | `payment.channel.register`、`payment.pay`、`payment.status` |
| Channel | `channel.publish`、`channel.subscription_set` |
| Price | `price.get`、`price.subscribe`、`price.unsubscribe` |
| Storage | `storage.list`、`storage.directory.create/delete`、`storage.put/get/delete` |
| MSFile | `msfile.stat`、`msfile.seed.read`、`msfile.block.read` |
| Test Wallet | 独立内存测试钱包，不属于 Connect 协议 |

共 25 个演示方法；不演示生产禁用的 `p2pkh.transfer`，不开放费用池。

每个方法提供官方 SDK 类型约束的业务样例，可在 JSON 编辑器修改后手动执行。最终业务参数校验由钱包负责；Demo 不再独立镜像协议 schema。

- 同时只执行一条操作，不自动重试。
- “取消请求”使用 SDK 的 `AbortSignal`：发送尽力取消并结束本地等待，不代表钱包一定未签名或未广播。
- “关闭传输”只关闭 SDK 连接；`connect.logout` 才撤销授权连接。
- 收到的事件保留最近 60 条，来源、窗口、绑定和身份检查交给官方 SDK。
- 观察区只展示业务参数、结果与二进制摘要，不展示 transport binding、完整 proof 签名或启动令牌。

### App 身份与 appView

发行身份来自 `index.html` 的 `keymaster-app:*` meta：id、publisher-public-key、name、description、requirement、identity-signature。Proof 由发行工具签署；Demo 不生成或保存 Publisher 私钥，不 fetch 运行时 manifest。缺失或非法 meta 会阻止连接身份提交；编辑器不能覆盖固定 proof。

`login`、`resume`、`launch` 都提交入口 proof。以 `launchToken` / `sessionWindowOrigin` / `mode=appView` 启动时，SDK 只采用 `window.opener`，不回退弹窗。页面预选 `connect.launch`，由用户点“执行请求”；成功后移除 URL 一次性令牌并保留 appView 标记。刷新不自动重放令牌或改为 popup 登录。

### Payment

1. 注册渠道，把返回的 `channelId` 填入 `payment.pay`。
2. 使用稳定 `clientRequestId`；发送前必须成功持久化完整原申请、钱包身份和目标 origin。
3. 只以返回的 `status` 判断业务状态，Promise resolve 不等于付款成功。只有 `accepted` / `already_known` 表示已接收；`unknown` 等状态应查询，不自动换 ID 重付。
4. “查询原付款”“重交原付款（原 ID）”使用最近一笔持久原申请，不消费当前编辑器；恢复时核对 origin、公钥和网络。同 ID 不接受不同参数。
5. 每个原 ID 的记录独立保留，开始新付款不覆盖旧 unknown 的原申请。可手填历史 ID 查询，或填完整原申请显式重交。清理浏览器站点数据会丢失这些恢复信息。

### 二进制与文件

编辑器用 `{ "$type": "binary", "base64": "...", "mime": "..." }` 展示业务二进制，执行前转成官方 `BinaryField`，不是 wire 的自定义编码。

`intent.sign`、`cipher.encrypt`、`storage.put` 可读取文件到 `content`；选择文件不会发送请求。上传受官方小对象大小上限约束。观察区最多预览 256 字节，下载仍使用完整返回字节及返回的文件名/MIME。加密成功后可点“用此结果填入解密参数”，将完整 `nonce` / `cipherbytes` 放入解密编辑器，再手动执行；不从摘要重建密文。

### Test Wallet

独立生成或导入 WIF，默认测试网；导入后清空 WIF 输入框。钱包只存页面内存，不写 localStorage 或观察日志，切换工作台保留，刷新清除。

UTXO 查询、构造签名与广播均需手动操作；广播另有明确确认。主网选择只影响此独立测试钱包，不影响 Keymaster。广播失败可能是结果未知，不应直接重新选币付款。

## 验证与文档

测试工具依赖安装在相邻 `BSV8_Engineering`；浏览器回归需要 Playwright Chromium。

```sh
npm run typecheck
npm test
npm run test:e2e
```

浏览器回归使用**真实生产 Demo + 官方 SDK + 模拟钱包**，不是 Keymaster 真钱包、实体设备或公网广播验收。

- 测试：`../BSV8_Engineering/test/KeymasterConnectDemo/`
- 浏览器回归：`../BSV8_Engineering/e2e/KeymasterConnectDemo/`
- 当前设计事实：`../BSV8_Engineering/docs/KeymasterConnectDemo/architecture.md`
- 本轮执行结果：`../BSV8_Engineering/todo/KeymasterConnectDemo/2026-10-25-official-sdk/STATUS.md`
- 旧设计与施工单归档：`../BSV8_Engineering/todo/KeymasterConnectDemo/history/`，不代表当前实现。
