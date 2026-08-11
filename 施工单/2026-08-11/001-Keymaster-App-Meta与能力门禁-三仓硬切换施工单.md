# Keymaster App Meta 与能力门禁三仓硬切换施工单

## 1. 文档信息

- 日期：2026-08-11
- 涉及仓库：`KeymasterAppPackCore`、`KeymasterConnectDemo`、`keymaster.cc`
- 改造方式：硬切换，不保留浏览器随机 Publisher Identity；运行时使用固定签名
  `AppIdentityProof`。
- 核心目标：以源码 `index.html` meta 为应用描述与 proof 唯一手写真值

## 2. 问题与取舍

旧 Demo 在浏览器 localStorage 中随机生成 Publisher 私钥，并在
`connect.login` 时提交签名 Identity Proof。浏览器、站点入口或 localStorage
变化都会改变身份；从 Keymaster Apps 打开时，launcher 又无法事先取得这份随机
proof，预建 session 因而缺少 Storage namespace，最终报
`storage_identity_required`。

新方案取消浏览器随机 Identity。Publisher proof 由 Core `app sign` 生成并由发行人
手工写回 HTML，Demo 只读取和提交公开 proof；必须保留以下安全边界：

1. `keymaster.app.json` 包含同一份 `AppIdentityProof`，但没有额外的文件外层签名；
2. `keymaster.app.json` 只供 Keymaster catalog 人工导入，不是浏览器运行时输入；
3. Demo 只从 HTML meta 构造 exact proof，不读取私钥或 JSON；
4. proof signature 覆盖 Publisher 公钥、App 三字段和 requirements；
5. 构建包另有 `bundleSignature`，覆盖 proof、入口和所有文件；
6. Identity 与 Bundle signer 公钥都必须等于 HTML meta 声明的 Publisher 公钥。

proof 是公开可复制的数据：它能阻止第三方修改 App id、Publisher 或 requirements，
但不能阻止第三方完整复制同一 proof。这与“不把部署 origin 写入 proof、允许同一 App
多处部署”的设计一致；它证明的是 Publisher/App namespace，不单独证明当前网页代码。
具体构建代码的真实性由 Bundle 签名负责。

## 3. 唯一真值：index.html meta

源 `index.html` 必须声明：

```html
<meta name="keymaster-app:id" content="keymaster-connect-demo">
<meta name="keymaster-app:publisher-public-key" content="03...">
<meta name="keymaster-app:name" content="Keymaster Connect Demo">
<meta name="keymaster-app:description" content="Keymaster Connect 协议测试应用">
<meta name="keymaster-app:requirement" content="private-key">
<meta name="keymaster-app:requirement" content="storage">
<meta name="keymaster-app:identity-signature" content="<Core app sign 输出的 64-byte lower compact hex>">
```

规则：

- `id`、`publisher-public-key`、`name`、`description` 各恰好出现一次；
- `id` 是稳定 Storage namespace 的必要组成，不能用部署域名代替；
- Publisher 公钥是 33-byte compressed secp256k1 小写 hex；
- requirement 可重复声明，但值不得重复；V1 仅允许 `private-key` 和 `storage`；
- requirements 按字典序输出，未知值 fail closed；
- Vite 插件只读取构建后的 HTML，不从配置或 JSON 反向注入 meta。

源码 `index.html` 是唯一手写真值。项目文件 `keymaster.app.json` 和构建清单
`.keymaster.json` 都只能从 HTML 派生，禁止手工维护后再反向覆盖 HTML。

## 4. 派生 keymaster.app.json

发行流程严格拆成三个显式步骤，命令不自动修改 HTML：

```sh
# 1. 创建 Publisher，手工把输出公钥写入 index.html
node ../KeymasterAppPackCore/packages/cli/dist/main.js publisher create <publisher-name>

# 2. 只生成 proof signature，手工把输出 meta 写入 index.html
node ../KeymasterAppPackCore/packages/cli/dist/main.js app sign --publisher <publisher-name>

# 3. 验证 HTML proof，在项目根生成 keymaster.app.json
node ../KeymasterAppPackCore/packages/cli/dist/main.js app create
```

`app sign` 默认读取项目 `index.html`，只向 stdout 输出 Publisher、公钥、signature 和
可直接复制的 meta，不修改任何文件。`app create` 不读取私钥或 signer 环境；它要求
HTML 已含唯一且有效的 `identity-signature`。

```json
{
  "version": 1,
  "publisherPublicKey": "03...",
  "app": {
    "id": "keymaster-connect-demo",
    "name": "Keymaster Connect Demo",
    "description": "Keymaster Connect 协议测试应用"
  },
  "requirements": ["private-key", "storage"],
  "signature": "<64-byte lowercase compact secp256k1 signature>"
}
```

该文件：

- 包含与 HTML 完全相同的 proof signature，但没有额外的 JSON 外层签名；
- 不包含 origin、URL、icon 或 launch 配置；
- 是可随时重新生成、可提交版本库的项目文件，不依赖 build；
- 不写入 `dist`，也不进入部署包；
- 供发行人查看并人工复制到 Keymaster 仓库；
- 不由 Keymaster 从部署网站抓取；
- 不允许 Keymaster 自动访问 App 源码仓库；
- 导入 Keymaster 后可在拉起前验签并建立可信 Storage namespace。

## 5. 构建包 Manifest

构建后的 `.keymaster.json` 保存上述 proof payload，以 `identitySignature` 保存同一
proof signature，再增加 `index`、`files` 和 `bundleSignature`。Vite 插件和部署
写入器只输出 `.keymaster.json`，不输出项目文件 `keymaster.app.json`。

两种签名职责不同：

- `identitySignature` 认证稳定的 App identity 与 requirements；
- `bundleSignature` 认证一次具体构建的 proof、入口和文件表。

两者继续使用 AppPackCore 的 Publisher signer：

- `KEYMASTER_PUBLISHER_KEY_DIR`
- `KEYMASTER_PUBLISHER_KEY_PASSWORD`
- CLI `--key` signer alias

私钥不得进入 HTML、JSON、浏览器代码或命令行参数。签名时必须检查 signer 公钥
与 HTML meta 公钥完全一致。验包时必须检查：

1. 入口 HTML Hash 与 Manifest `index/files` 一致；
2. 构建后 HTML proof 与 `.keymaster.json` 的 proof 完全一致且验签有效；
3. `bundleSignature` 对完整 proof、`index` 和 `files` 有效；
4. `.keymaster.json` 是部署清单；`keymaster.app.json` 仍是保留名，不能意外进入
   内容寻址 `files`。

## 6. Keymaster 本地信任边界

Keymaster catalog 保存两类数据：

- 人工复制的 `keymaster.app.json` 完整内容；
- Keymaster 管理的 `appOrigin`、`appUrl`、icon 和 claims。

两类数据不得由部署站点运行时覆盖。两种入口分别处理：

- Direct：App 从 HTML 读取 proof，通过 `connect.login.appIdentity` 提交；Keymaster
  直接验签并按签名 requirements 门禁。未提交 proof 时只建立普通非 Storage session。
- appView：Keymaster 从 catalog proof 验签并在拉起前检查 requirements，预建 session
  和一次性 token；App 启动后再通过
  `connect.launch({ launchToken, appIdentity })` 提交 HTML proof。Keymaster 要求其
  digest 与 token/session 绑定的 catalog proof 完全一致，成功后才消费 token。

Keymaster 不从部署站点 fetch proof，也不允许运行时 proof 覆盖 catalog 拉起配置。

## 7. Requirements 门禁

Requirements 表示启动前置条件，不表示权限：

- `private-key`：本次选定的 owner key 已 ready；App 永远拿不到私钥；
- `storage`：抽象 Storage service 的状态为 ready；描述中不得出现 `s3`。

Direct login 的门禁顺序：

1. 接收并验签 App 从 HTML 提交的 proof；
2. 解析签名覆盖的 requirements；
3. 检查 owner key 和抽象 Storage 状态；
4. 全部满足后才能创建 session。

appView 必须保留浏览器 user activation：catalog 与 Storage 门禁在开窗前完成；
随后同步预开 `about:blank`，再异步确认所选 owner key。key 不可用时立即关闭空窗，
且不创建 session、launch token 或导航。不能把异步 key 查询移到预开之前，否则
iOS Safari 会把后续 `window.open` 当作脚本弹窗拦截。

失败立即返回明确错误，不重试、不降级、不创建半成品 session。App 启动后 Storage
临时降级不自动关闭已有 session；后续 Storage 请求按当时状态失败。

## 8. Demo 硬切换

Demo 需要：

- 在源 `index.html` 写固定 App meta；
- 删除 localStorage Publisher 私钥、随机 proof 和 Regenerate Publisher Key；
- Direct `connect.login` 必须发送 HTML 派生的 `appIdentity`；
- appView `connect.launch` 必须发送 `{ launchToken, appIdentity }`；
- Shared context 显示 Keymaster 返回的 verified proof snapshot；日志不可输出完整
  proof signature。

三步发布顺序固定为：Publisher create → 手工写公钥 → Core app sign 并手工写
`identity-signature` → `app create` 生成 JSON 并复制到 catalog。签名未写入前
Demo 明确 fail closed，禁止伪造生产签名。

生产 Publisher 公钥必须来自发行人已有私钥。测试可以使用明确标注的 fixture key，
但不得把 fixture、临时随机私钥或私钥 `1` 写成 Demo 生产身份。

## 9. 验收标准

- `app sign` 只输出签名/meta，不修改 HTML 或 JSON；
- `app create` 只接受已验签 HTML，且不读取 Publisher 私钥；
- AppPackCore 能从源码 HTML 生成项目根目录的完整 proof `keymaster.app.json`；
- build 不生成、部署包不包含 `keymaster.app.json`；
- `.keymaster.json` 同时绑定 `identitySignature` 与独立 `bundleSignature`；
- meta 缺失、重复、格式错误或未知 requirement 时构建失败；
- signer 公钥不匹配、部署 HTML 或 Manifest 被篡改时验包失败；
- Keymaster 不 fetch App proof；Direct login 和 appView launch 都验证 App 提交的 proof；
- appView launch proof 必须与 catalog/token/session 绑定 proof 一致；
- Direct 与 appView 都在 session/token/navigation 前执行 requirements 门禁；
- Storage 未 ready 时要求 Storage 的 App 不启动；
- Demo 不再生成或保存 Publisher 私钥；
- 三仓类型检查、单元测试和构建通过；
- 用户提供真实 Publisher 公钥并完成最终 Bundle 签名后，生产 Demo 才算可发布。
