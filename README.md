# Keymaster Connect Demo

跟随 **最新官方 `keymaster-connect` SDK** 的外部网页 App，演示 Connect v1。产品尚未上线，接口和 wire 版本都保持 v1，不维护已删除字段的兼容分支。

## 安装与运行

安装和开发不需要相邻钱包或 SDK 源码；生产构建需要已安装的 `keymaster-app-publisher` 精确版本和本机发布私钥：

```sh
npm ci
npm run dev
npm run build
npm run preview
```

lockfile 记录公共 npm 的 `keymaster-connect@0.2.0`。统一 MSFile 工作台使用 Connect SDK 工作树的候选包。开发时先从 SDK 工作树把 npm 包打到仓库外，再在 Demo 运行 `npm install --no-save --package-lock=false /absolute/path/keymaster-connect-0.2.0.tgz`，随后运行 `npm run build`。公开发布后再更新精确依赖和 lockfile。

App 主动连接显式打开完整钱包根页面 `/`；登录与操作审批在钱包应用连接中心处理。关闭传输、错误或超时只结束 Demo 侧传输，不关闭钱包窗口。

开发和生产构建不构建 SDK。`npm run build` 通过已安装的 Publisher Vite 插件生成 URL 来源证明与 Files 整包签名（`both`）。开发环境发布入口固定为 `https://mimi.degu-danio.ts.net:8089/`，产物位于 `dist/`。私钥仅从 `~/.config/keymaster-connect-demo/app.key.json` 读取，文件权限应为 `600`，不入 Git；缺失时构建失败，不自动生成或更换身份。`npm run dev` 不执行发布签名。维护者更新官方包时，先确认新版本已发布，再执行 `npm install --save-exact keymaster-connect@版本号`、提交 lockfile 并复跑测试。Demo 不复制或维护 SDK 源码、内部 contracts、协议类型、request builders 或 postMessage 实现。

直开页面默认选中**线上钱包**预设（`https://keymaster.cc`）；登录界面提供三选一：线上钱包、本地钱包（`http://127.0.0.1:2100`）、自定义。选中或改动自定义输入即更新目标并重建连接，点“使用 Keymaster 登录”直接登录当前选中地址，不再设“应用地址”。两个预设可用环境变量覆盖（`.env.local` 本地填写，不入 Git）：`VITE_CONNECT_WALLET_PRIMARY` 覆盖线上预设，`VITE_CONNECT_WALLET_SECONDARY` 覆盖本地预设；为空或非法时回退内置默认。自定义地址必须是精确 http(s) origin（首尾空白与末尾单个 `/` 自动归一化）。登录参数由代码生成，不提供登录 JSON 编辑。更改目标会关闭旧连接。连接成功必须同时满足 SDK `connected` 且 `networkIdentity` 非空；连接后只读展示 SDK 返回的 `networkIdentity`，不提供钱包公钥、网络或 session 选择输入。

## 工作台

| 工作台 | 演示方法 |
| --- | --- |
| Identity | `identity.get`、`intent.sign`，附本地 CBOR / secp256k1 验签 |
| Cipher | `cipher.encrypt`、`cipher.decrypt` |
| Payment | `payment.pay`、`payment.status`（outputs 模型） |
| Channel | `channel.publish`、`channel.subscription_set` |
| MSFile | `msfile.read`、`msfile.stat`、`msfile.readSeed`、`msfile.readBlock`、`msfile.import`、`msfile.sellerStatus` |

连接方法（`connect.login` / `logout` / `launch`）由专用登录界面控制，不占用业务导航：未登录只显示登录界面、连接诊断及错误；登录成功后进入功能页，退出后返回登录页。

登录成功进入 Identity，开放其余业务工作台。未登录只显示登录界面、连接诊断及错误；登录中显示进度和取消入口，禁止重复发起；连接断开后关闭业务入口，需重新登录或从钱包重新打开；退出或授权撤销返回登录界面。业务执行入口检查当前登录状态。顶部的「退出登录」执行 `connect.logout`；用户直接关闭页签无需 SDK 调用或等待回复；退出失败必须显示失败。

每个方法提供官方 SDK 类型约束的业务样例，可在 JSON 编辑器修改后手动执行。最终业务参数校验由钱包负责；Demo 不再独立镜像协议 schema。

- 同时只执行一条操作，不自动重试。
- “取消请求”使用 SDK 的 `AbortSignal`：发送尽力取消并结束本地等待，不代表钱包一定未签名或未广播。
- `connect.logout` 明确撤销本连接授权，长期应用操作许可独立保存。
- 收到的事件保留最近 60 条，来源、窗口、绑定和身份检查交给官方 SDK。
- 观察区只展示业务参数、结果与二进制摘要，不展示 transport binding、完整 proof 签名或启动令牌。

### App 身份与 appView

发行身份由 Publisher 在构建时生成：`index.html` 提供 `keymaster-app-name` 和 `keymaster-app-icon`，最终入口包含 URL 来源证明和 Files 签名。私钥只由构建进程读取，不进入浏览器代码或产物；Demo 不 fetch 运行时 manifest，连接证明由官方 SDK 读取和传递。

钱包主动启动（独立窗口 `mode=appView` 或页内 `mode=iframe`）时，Demo 按启动参数自动执行一次 `launch`，成功后移除 URL 一次性令牌、保留 appView 标记并进入功能页；失败不自动重试、不回退成 popup。刷新或断开后提示从钱包重新打开，不恢复旧连接、不重放 launch。React StrictMode 重复 effect 不得重复消费令牌。

### Payment

1. 注册渠道，把返回的 `channelId` 填入 `payment.pay`。
2. 使用稳定 `clientRequestId`；发送前必须成功持久化完整原申请、钱包身份和目标 origin。
3. 只以返回的 `status` 判断业务状态，Promise resolve 不等于付款成功。只有 `accepted` / `already_known` 表示已接收；`unknown` 等状态应查询，不自动换 ID 重付。
4. “查询原付款”“重交原付款（原 ID）”使用最近一笔持久原申请，不消费当前编辑器；恢复时核对 origin、公钥和网络。同 ID 不接受不同参数。
5. 每个原 ID 的记录独立保留，开始新付款不覆盖旧 unknown 的原申请。可手填历史 ID 查询，或填完整原申请显式重交。清理浏览器站点数据会丢失这些恢复信息。

### 二进制与文件

编辑器用 `{ "$type": "binary", "base64": "...", "mime": "..." }` 展示业务二进制，执行前转成官方 `BinaryField`，不是 wire 的自定义编码。

`intent.sign`、`cipher.encrypt` 可读取文件到 `content`；选择文件不会发送请求。文件输入上限为 16 MiB。观察区最多预览 256 字节，下载仍使用完整返回字节及返回的文件名/MIME。加密成功后可点“用此结果填入解密参数”，将完整 `nonce` / `cipherbytes` 放入解密编辑器，再手动执行；不从摘要重建密文。

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
