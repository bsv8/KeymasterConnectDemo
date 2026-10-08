import { expect, test, type Page } from "@playwright/test";
import { confirmProtocolCard, createTestAppIdentity, grantPersistentStorage, installTestAppIdentityProof, submitConnectLogin } from "./realKeymaster";

const WALLET = "http://127.0.0.1:4201", DEMO = "http://127.0.0.1:4184";
const PASSWORD = "local-connect-test-password";
/** 定位当前工作台的方法区，响应则从独立 Observer 面板核验。 */
function section(page: Page, name: string) { return page.locator(".section-block").filter({ has: page.getByRole("heading", { name, exact: true }) }); }

/** 独立 Demo 与真实钱包完成认证、签名/密码学和 App 文件隔离入口。 */
test("真实本地 Connect：login、identity、cipher、Storage、price、resume 和 logout", async ({ context }) => {
  const wallet = await context.newPage();
  await wallet.goto(WALLET);
  await grantPersistentStorage(wallet);
  await wallet.locator('button[data-intent="new"]').click();
  await wallet.getByLabel(/^新密码$|^New password$/u).fill(PASSWORD);
  await wallet.getByLabel(/^确认密码$|^Confirm password$/u).fill(PASSWORD);
  await wallet.getByRole("button", { name: /^创建$|^Create$/u }).click();
  await expect(wallet.getByRole("navigation", { name: /主导航|Primary navigation/ })).toBeVisible({ timeout: 60_000 });

  const demo = await context.newPage();
  await installTestAppIdentityProof(demo, DEMO, createTestAppIdentity(DEMO, ["private-key", "storage"]));
  await demo.goto(DEMO);
  await demo.getByLabel("Keymaster Target Origin").fill(WALLET);
  const popupReady = demo.waitForEvent("popup");
  await demo.getByRole("button", { name: "Run connect.login" }).click();
  const popup = await popupReady;
  await submitConnectLogin(popup, PASSWORD);
  await expect.poll(() => demo.evaluate(() => localStorage.getItem("keymaster-connect-demo.sessionId"))).toBeTruthy();

  await demo.locator("nav .nav-item").filter({ hasText: /^Identity/ }).click();
  for (const method of ["identity.get", "intent.sign"]) {
    const panel = section(demo, method);
    await panel.getByRole("button", { name: `Run ${method}`, exact: true }).click();
    await confirmProtocolCard(popup);
    await expect(demo.locator(".result-panel").filter({ has: demo.getByText(`${method} raw result`, { exact: true }) }).locator("pre")).toContainText('"ok": true', { timeout: 30_000 });
    await expect(panel.locator(".result-stat").filter({ has: demo.getByText("local verify", { exact: true }) }).locator("strong")).toHaveText("pass");
  }
  await demo.locator("nav .nav-item").filter({ hasText: /^Cipher/ }).click();
  for (const method of ["cipher.encrypt", "cipher.decrypt"]) {
    const panel = section(demo, method);
    await panel.getByRole("button", { name: `Run ${method}`, exact: true }).click();
    await confirmProtocolCard(popup);
    await expect(demo.locator(".result-panel").filter({ has: demo.getByText(`${method} raw result`, { exact: true }) }).locator("pre")).toContainText('"ok": true', { timeout: 30_000 });
  }
  await demo.locator("nav .nav-item").filter({ hasText: /^Storage/ }).click();
  await demo.getByLabel("path", { exact: true }).last().fill("local-connect.txt");
  await demo.getByLabel("content text", { exact: true }).fill("connect file body");
  for (const action of ["put", "get", "list", "delete"]) {
    await demo.getByRole("button", { name: action === "list" ? "Run list" : action[0].toUpperCase() + action.slice(1), exact: true }).click();
    await expect(demo.locator(".error-text")).toHaveCount(0);
    await expect(demo.getByRole("button", { name: action === "list" ? "Run list" : action[0].toUpperCase() + action.slice(1), exact: true })).toBeEnabled({ timeout: 30_000 });
    await expect(demo.locator(".error-text")).toHaveCount(0);
    if (action === "get") await expect(demo.locator(".result-panel").filter({ has: demo.getByText("result preview", { exact: true }) }).locator("pre")).toContainText("connect file body");
    if (action === "list") await expect(demo.locator(".result-panel").filter({ has: demo.getByText("result preview", { exact: true }) }).locator("pre")).toContainText("local-connect.txt");
  }
  await demo.locator("nav .nav-item").filter({ hasText: /^Price/ }).click();
  for (const method of ["price.get", "price.subscribe", "price.unsubscribe"] as const) {
    await demo.getByRole("button", { name: `Run ${method}`, exact: true }).click();
    await expect(demo.getByRole("button", { name: `Run ${method}`, exact: true })).toBeEnabled({ timeout: 30_000 });
    await expect(demo.locator(".result-panel").filter({ has: demo.getByText("price response", { exact: true }) }).locator("pre").first()).toContainText('"ok": true');
  }
  await demo.locator("nav .nav-item").filter({ hasText: /^Connect/ }).click();
  await demo.getByRole("button", { name: "Run connect.resume", exact: true }).click();
  await expect(demo.locator(".result-panel").filter({ has: demo.getByText("connect.resume raw result", { exact: true }) }).locator("pre")).toContainText('"ok": true');
  await demo.getByRole("button", { name: "Run connect.logout", exact: true }).click();
  await expect(demo.locator(".result-panel").filter({ has: demo.getByText("connect.logout raw result", { exact: true }) }).locator("pre")).toContainText('"ok": true', { timeout: 60_000 });
  await expect.poll(() => demo.evaluate(() => localStorage.getItem("keymaster-connect-demo.sessionId"))).toBeNull();
});
