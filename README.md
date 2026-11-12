# Keymaster Connect Demo

跟随 **最新官方 `keymaster-connect` SDK** 的外部网页 App，演示 Connect v1。产品尚未上线，接口和 wire 版本都保持 v1，不维护已删除字段的兼容分支。

## 安装与运行

只克隆此仓库即可安装和构建，不需要相邻 `keymaster.cc`、`KeymasterConnect` 或工程测试仓：

```sh
npm ci
npm run dev
npm run build
npm run preview
```

依赖固定为公共 npm 的 `keymaster-connect@0.1.4`，lockfile 锁定注册表地址及完整性；不使用 vendor 安装包、本地 file/link/workspace SDK 或自建 SDK。

App 主动连接显式打开完整钱包根页面 `/`；登录与操作审批在钱包应用连接中心处理。关闭传输、错误或超时只结束 Demo 侧传输，不关闭钱包窗口。

开发和生产构建不再构建 SDK，也不访问本机相邻源码目录。维护者更新官方包时，先确认新版本已发布，再执行 `npm install --save-exact keymaster-connect@版本号`、提交 lockfile 并复跑测试。Demo 不复制或维护 SDK 源码、内部 contracts、协议类型、request builders 或 postMessage 实现。

直开页面默认目标是 `https://keymaster.cc`，在登录界面高级设置中填写可信的**精确 origin**，点“应用地址”后点“使用 Keymaster 登录”执行 `connect.login`。登录参数由代码生成，不提供登录 JSON 编辑。更改目标会关闭旧连接。连接成功必须同时满足 SDK `connected` 且 `networkIdentity` 非空；连接后只读展示 SDK 返回的 `networkIdentity`，不提供钱包公钥、网络或 session 选择输入。

## 工作台

| 工作台 | 演示方法 |
| --- | --- |
| Identity | `identity.get`、`intent.sign`，附本地 CBOR / secp256k1 验签 |
| Cipher | `cipher.encrypt`、`cipher.decrypt` |
| Payment | `payment.pay`、`payment.status`（outputs 模型） |
| Channel | `channel.publish`、`channel.subscription_set` |
| Storage | `storage.list`、`storage.directory.create/delete`、`storage.put/get/delete`（含可选加密读写） |
| MSFile | `msfile.stat`、`msfile.seed.read`、`msfile.block.read` |

连接方法（`connect.login` / `resume` / `logout` / `launch`）由专用登录界面控制，不占用业务导航：未登录只显示登录界面、连接诊断及错误；登录/恢复/退出成功后进入功能页。

登录成功进入 Identity，开放其余业务工作台。未登录只显示登录界面、连接诊断及错误；登录中显示进度和取消入口，禁止重复发起；连接暂停关闭业务操作并显示恢复入口；退出或授权撤销返回登录界面。业务执行入口检查当前登录状态。顶部的「退出登录」执行 `connect.logout`；`close()` 只关闭传输，不能当作退出；退出失败必须显示失败。

每个方法提供官方 SDK 类型约束的业务样例，可在 JSON 编辑器修改后手动执行。最终业务参数校验由钱包负责；Demo 不再独立镜像协议 schema。

- 同时只执行一条操作，不自动重试。
- “取消请求”使用 SDK 的 `AbortSignal`：发送尽力取消并结束本地等待，不代表钱包一定未签名或未广播。
- “关闭传输”只关闭 SDK 连接；`connect.logout` 才撤销授权连接。
- 收到的事件保留最近 60 条，来源、窗口、绑定和身份检查交给官方 SDK。
- 观察区只展示业务参数、结果与二进制摘要，不展示 transport binding、完整 proof 签名或启动令牌。

### App 身份与 appView

发行身份来自 `index.html` 的 `keymaster-app:*` meta：id、publisher-public-key、name、description、requirement、identity-signature。Proof 由发行工具签署；Demo 不生成或保存 Publisher 私钥，不 fetch 运行时 manifest。缺失或非法 meta 会阻止连接身份提交；编辑器不能覆盖固定 proof。

`login`、`resume`、`launch` 都提交入口 proof。钱包主动启动（独立窗口 `mode=appView` 或页内 `mode=iframe`）时，Demo 按启动参数自动执行一次 `launch`，成功后移除 URL 一次性令牌、保留 appView 标记并进入功能页；失败不自动重试、不回退成 popup。刷新后没有令牌时提供显式 `connect.resume`，不重放 launch；启动方丢失时提示从钱包重新打开。React StrictMode 重复 effect 不得重复消费令牌。

### Payment

1. 注册渠道，把返回的 `channelId` 填入 `payment.pay`。
2. 使用稳定 `clientRequestId`；发送前必须成功持久化完整原申请、钱包身份和目标 origin。
3. 只以返回的 `status` 判断业务状态，Promise resolve 不等于付款成功。只有 `accepted` / `already_known` 表示已接收；`unknown` 等状态应查询，不自动换 ID 重付。
4. “查询原付款”“重交原付款（原 ID）”使用最近一笔持久原申请，不消费当前编辑器；恢复时核对 origin、公钥和网络。同 ID 不接受不同参数。
5. 每个原 ID 的记录独立保留，开始新付款不覆盖旧 unknown 的原申请。可手填历史 ID 查询，或填完整原申请显式重交。清理浏览器站点数据会丢失这些恢复信息。

### 二进制与文件

编辑器用 `{ "$type": "binary", "base64": "...", "mime": "..." }` 展示业务二进制，执行前转成官方 `BinaryField`，不是 wire 的自定义编码。

`intent.sign`、`cipher.encrypt`、`storage.put`、`storage.encrypted.put` 可读取文件到 `content`；选择文件不会发送请求。上传受官方小对象大小上限约束。观察区最多预览 256 字节，下载仍使用完整返回字节及返回的文件名/MIME。加密成功后可点“用此结果填入解密参数”，将完整 `nonce` / `cipherbytes` 放入解密编辑器，再手动执行；不从摘要重建密文。

## 验证与文档

测试工具依赖安装在相邻 `BSV8_Engineering`；浏览器回归需要 Playwright Chromium。

```sh
npm run typecheck
npm test
npm run test:e2e
```

Connect 浏览器回归只使用**真实 Keymaster 钱包 + 真实 Demo + 官方 SDK**，通过生产 UI 完成钱包 → Demo 和 Demo → 钱包的认证、逐操作授权、验签与连接生命周期；不再维护模拟 Connect 钱包或测试 HTML。

`npm run test:e2e` 使用 Demo 已安装的公共精确 SDK；`npm run test:e2e -- --candidate` 在临时独立 Demo 中安装真实候选包。两类结果明确区分，候选通过不代表 npm 已发布。正常生产构建不依赖相邻钱包源码。

- Connect 双产品浏览器回归：`../BSV8_Engineering/e2e/KeymasterConnectWallet/`
- CLI Web 真实链路回归：`../BSV8_Engineering/e2e/KeymasterConnectCli/`
- 当前设计事实：`../BSV8_Engineering/docs/KeymasterConnectDemo/architecture.md`
- 旧设计与施工单归档：`../BSV8_Engineering/todo/KeymasterConnectDemo/history/`，不代表当前实现。
