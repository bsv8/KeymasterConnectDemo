// scripts/e2e/realKeymaster.ts
// real-Keymaster e2e 的页面操作 helper（只在本执行档使用）。
//
// 设计缘由（施工单 2026-09-18 001 real e2e）：
//   - 选择器集中在 helper；spec 只表达业务步骤；
//   - e2e 使用 **测试专用 publisher key** 生成 requirements=["private-key"] 的
//     签名 proof，替换 Demo 入口 HTML 的 meta：本地 preview 没有 Storage
//     provider，生产 proof 的 storage requirement 会让 connect.login 直接
//     fail-fast；生产 index.html 的 proof 不参与本组测试；
//   - 真实交互：先在 Keymaster 主页面初始化导入一次性 key，锁定后再走
//     connect.login，让 Session Window 能拿到 ready key 候选。

import { expect, type Page } from "@playwright/test";
import { PrivateKey } from "@bsv/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const APP_IDENTITY_DOMAIN = "keymaster-app-identity:v1";

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface TestAppIdentity {
  proof: {
    version: 1;
    publisherPublicKey: string;
    app: { id: string; name: string; description: string };
    requirements: ["private-key"];
    signature: string;
  };
}

/**
 * 生成测试 publisher proof（不触碰生产 publisher 私钥）。
 *
 * 签名算法与 Keymaster `verifyAppIdentityProof` 一致：
 * `sha256(domain || 0x00 || canonicalJson(payload))` 的 compact secp256k1 签名。
 */
export function createTestAppIdentity(origin: string): TestAppIdentity {
  const publisher = PrivateKey.fromRandom();
  const publisherPublicKey = String(publisher.toPublicKey().encode(true, "hex"));
  const app = {
    id: "keymaster-connect-demo",
    name: "Keymaster Connect Demo (e2e)",
    description: `Real Keymaster e2e app identity for ${origin}`,
  };
  const payload = { version: 1 as const, publisherPublicKey, app, requirements: ["private-key"] as ["private-key"] };
  const encoded = new TextEncoder().encode(canonicalize(payload));
  const domain = new TextEncoder().encode(APP_IDENTITY_DOMAIN);
  const signed = new Uint8Array(domain.length + 1 + encoded.length);
  signed.set(domain);
  signed[domain.length] = 0;
  signed.set(encoded, domain.length + 1);
  const digest = sha256(signed);
  const signature = bytesToHex(secp256k1.sign(digest, hexToBytes(publisher.toHex()), { lowS: true }));
  return { proof: { ...payload, signature } };
}

/**
 * 拦截 Demo 入口 HTML 并把 `keymaster-app:*` meta 换成测试 proof。
 *
 * Demo 运行时只读取这份 meta；替换发生在文档加载前，页面本身不改代码。
 */
export async function installTestAppIdentityProof(
  page: Page,
  demoOrigin: string,
  identity: TestAppIdentity,
): Promise<void> {
  const { proof } = identity;
  await page.route(`${demoOrigin}/`, async (route) => {
    const response = await route.fetch();
    let html = await response.text();
    html = html.replace(
      /<meta name="keymaster-app:publisher-public-key" content="[^"]*"\s*\/?>/u,
      `<meta name="keymaster-app:publisher-public-key" content="${proof.publisherPublicKey}" />`,
    );
    html = html.replace(
      /<meta name="keymaster-app:identity-signature" content="[^"]*"\s*\/?>/u,
      `<meta name="keymaster-app:identity-signature" content="${proof.signature}" />`,
    );
    html = html.replace(/\s*<meta name="keymaster-app:requirement" content="[^"]*"\s*\/?>/gu, "");
    html = html.replace(
      "</head>",
      `    <meta name="keymaster-app:requirement" content="private-key" />\n  </head>`,
    );
    await route.fulfill({ response, body: html });
  });
}

/**
 * 授予 Chromium durableStorage 权限。
 *
 * 设计缘由（keymaster.cc `Local 桶改用 IndexedDB`）：Local 桶落在 IndexedDB；
 * 未授权时页面顶部会出现"允许持久化存储"提示条，e2e 必须先授权，避免测试被
 * 提示条或存储淘汰语义干扰。
 */
export async function grantPersistentStorage(page: Page): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error("real e2e requires Chromium");
  if (typeof page.url() !== "string" || page.url() === "about:blank") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  const pageCdp = await page.context().newCDPSession(page);
  const target = await pageCdp.send("Target.getTargetInfo");
  await pageCdp.detach();
  const browserContextId = target.targetInfo.browserContextId;
  if (!browserContextId) throw new Error("cannot resolve browser context id");
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.grantPermissions", {
    origin: new URL(page.url()).origin,
    browserContextId,
    permissions: ["durableStorage"],
  });
  await cdp.detach();
  await page.reload({ waitUntil: "domcontentloaded" });
}

/** 在 Keymaster 主页面完成 Local 首次初始化（导入一次性 hex key）。 */
export async function setupLocalWalletWithImportedKey(
  page: Page,
  input: { privateKeyHex: string; password: string; bucketLabel: string; keyLabel: string },
): Promise<void> {
  console.log("[e2e] km: goto root");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const allowPersistent = page.getByRole("button", { name: /Allow persistent storage|允许持久化存储/iu });
  if (await allowPersistent.isVisible().catch(() => false)) {
    await allowPersistent.click();
  }
  console.log("[e2e] km: click Local");
  await page.getByRole("button", { name: /Local/ }).click();
  await page.getByLabel(/桶名称|Bucket name/).fill(input.bucketLabel);
  await page.getByRole("button", { name: /开始创建|Start creating/ }).click();
  await expect(
    page.getByRole("heading", { name: /设置第一把 Key|Set up your first Key/ }),
  ).toBeVisible({ timeout: 20_000 });
  console.log("[e2e] km: import key flow");
  await page.getByRole("button", { name: /Import a Key|导入 Key/ }).click();
  await page
    .getByLabel(/^Key 密码（至少 8 位）|Key password \(at least 8 characters\)/u)
    .fill(input.password);
  await page.getByLabel(/再输入一次 Key 密码|Repeat the Key password/iu).fill(input.password);
  await page.getByRole("button", { name: /继续确认|Continue to confirm/iu }).click();
  await page.getByRole("button", { name: /Hex/ }).click();
  await page.getByRole("button", { name: /Next|下一步/ }).click();
  await page.getByLabel(/Text|文本/).fill(input.privateKeyHex);
  await page.getByRole("button", { name: /Parse|解析/ }).click();
  await page.getByLabel(/Label|标签/).fill(input.keyLabel);
  await page
    .getByRole("button", { name: /Use this Key|使用这把 Key|Import this Key|导入这把 Key/ })
    .click();
  console.log("[e2e] km: create bucket");
  await page
    .getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/ })
    .click();
  console.log("[e2e] km: wait navigation");
  await expect(
    page.getByRole("navigation", { name: /Primary navigation|主导航/ }),
  ).toBeVisible({ timeout: 60_000 });
  console.log("[e2e] km: setup complete");
}

/** 锁定钱包（让 Session Window 走"选 key + 再输密码"的 login 视图）。 */
export async function lockKeymasterWallet(page: Page): Promise<void> {
  console.log("[e2e] km: locking wallet");
  await page.getByRole("button", { name: /^(锁定|Lock)$/u }).first().click();
  await expect(page.getByLabel(/密码|password/iu).first()).toBeVisible({ timeout: 20_000 });
  console.log("[e2e] km: wallet locked");
}

/** 在 Session Window 完成 connect.login：选 key + 密码 + 确认。 */
export async function submitConnectLogin(popup: Page, password: string): Promise<void> {
  console.log("[e2e] popup: waiting login candidates");
  await expect(popup.locator('input[type="radio"]').first()).toBeVisible({ timeout: 30_000 });
  await popup.locator('input[type="radio"]').first().check();
  await popup.locator('input[type="password"]').last().fill(password);
  await popup
    .getByRole("button", { name: /重新认证并建立会话|Re-authenticate and create session/ })
    .click();
  console.log("[e2e] popup: login submitted");
}

/** 在 Keymaster 设置里打开 testnet 资产开关。 */
export async function enableTestnetAssets(page: Page): Promise<void> {
  // 不能 page.goto：整页导航会撤销当前窗口运行态并回到锁定页；
  // 必须走正式侧栏 SPA 导航。
  const navigation = page.getByRole("navigation", { name: /Primary navigation|主导航/ });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: /^(设置|Settings)$/u }).click();
  await navigation.getByRole("button", { name: /^(系统|System)$/u }).click();
  await expect(page).toHaveURL(/\/settings\/system$/u);
  const p2pkhSettings = page.locator("#p2pkh");
  await expect(p2pkhSettings).toBeVisible({ timeout: 30_000 });
  const select = p2pkhSettings.getByRole("combobox").first();
  await expect(select).toBeVisible();
  await select.selectOption("yes");
  await expect.poll(() => select.inputValue(), { timeout: 20_000 }).toBe("yes");
  console.log("[e2e] km: testnet enabled");
}

/**
 * 等 Session Window 的确认卡并点确认。
 *
 * 设计缘由：identity.get / intent.sign / cipher.* / p2pkh.* 都是
 * manual confirm 路径；popup 的命令流会出现 Confirm 按钮。这里不解析英文
 * 文案，直接按按钮名称（中英）匹配。
 */
export async function confirmProtocolCard(popup: Page, timeoutMs = 30_000): Promise<void> {
  const confirm = popup.getByRole("button", { name: /^(确认|Confirm)$/u });
  await expect(confirm.first()).toBeVisible({ timeout: timeoutMs });
  await confirm.first().click();
}

/** 等 popup 上出现某个 method 的已批准卡片（自动执行能力用）。 */
export async function expectApprovedCard(popup: Page, method: string, timeoutMs = 60_000): Promise<void> {
  await expect(
    popup.getByRole("button", { name: new RegExp(`${method}.*(?:Approved|已批准)`, "u") }).last(),
  ).toBeVisible({ timeout: timeoutMs });
}
