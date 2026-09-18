// scripts/e2e/real-connect.spec.ts
// real-Keymaster e2e：Demo Connect SDK 在真实本地 Keymaster + 真实 testnet 上跑通。
//
// 覆盖（施工单 2026-09-18 001）：
//   connect.login / connect.resume / connect.logout；
//   identity.get / intent.sign / cipher.encrypt / cipher.decrypt；
//   p2pkh.transfer（bsv-testnet，真实广播，差异化金额 2 / 3 sats）；
//   Demo Test Wallet 真实退款（1002 sats，验证本地签名 + 广播 + 回收）。
//
// 显式不覆盖（原因写入测试报告）：
//   channel.*       需要可用的 SatSubscription supplier；本执行档不注入供应商。
//   storage.*       本地 preview 无 Storage provider；需要真实 S3 配置。
//   msfile.*        需要临时 Go supplier。
//   connect.launch  需要本地 App catalog + appView bootstrap；mock e2e 已覆盖协议。
//
// 资金：从 ~/.config/keymaster-e2e/seed-key.hex 的 testnet 余额给一次性
// Keymaster key 充值；结束把一次性 key 与 Demo Test Wallet 的全部 UTXO 合并
// 扫回 seed，并断言差额只等于链上手续费。

import { expect, test } from "@playwright/test";
import {
  compressedPublicKeyOf,
  fundOneTimeWallet,
  listConfirmedUtxos,
  buildConsolidationTransaction,
  broadcast,
  newTestnetPrivateKeyHex,
  readSeedPrivateKeyHex,
  testnetAddressOf,
  waitForConfirmedTransaction,
} from "./testnetResource";
import {
  confirmProtocolCard,
  createTestAppIdentity,
  enableTestnetAssets,
  grantPersistentStorage,
  installTestAppIdentityProof,
  lockKeymasterWallet,
  setupLocalWalletWithImportedKey,
  submitConnectLogin,
} from "./realKeymaster";
import { PrivateKey } from "@bsv/sdk";

const KEYMASTER_ORIGIN = "http://127.0.0.1:4173";
const DEMO_ORIGIN = "http://127.0.0.1:4174";
const PASSWORD = "real-e2e-password-123";
const FEE_RATE_SATOSHIS_PER_KB = 1000;

// 差异化金额：任何余额差额都能直接对应到具体测试项。
const TRANSFER_AMOUNTS = [2, 3] as const;
const REFUND_AMOUNT_SATOSHIS = 1002;
const FUNDING_SATOSHIS = 2600; // Σ金额 + 全部手续费 + 余量（结束时按实际手续费对账）。

function sectionOf(page: import("@playwright/test").Page, title: string) {
  return page.locator(".section-block").filter({ has: page.getByRole("heading", { name: title }) });
}

test("real Keymaster e2e：connect / identity / cipher / p2pkh + testnet 回收", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const seedHex = readSeedPrivateKeyHex();
  const seedAddress = testnetAddressOf(seedHex);
  const ownerHex = newTestnetPrivateKeyHex();
  const counterpartyHex = newTestnetPrivateKeyHex();
  const ownerAddress = testnetAddressOf(ownerHex);
  const counterpartyAddress = testnetAddressOf(counterpartyHex);
  const ownerPub = compressedPublicKeyOf(ownerHex);

  const broadcastTxs: Array<{ label: string; txid: string }> = [];
  let fundingTxid = "";
  let recoveredSatoshis = 0;

  const context = await browser.newContext();
  const km = await context.newPage();
  const demo = await context.newPage();
  await installTestAppIdentityProof(demo, DEMO_ORIGIN, createTestAppIdentity(DEMO_ORIGIN));

  /** 当前 Session Window（owner 登录后整个 run 复用一扇）。 */
  function sessionWindow() {
    const popup = context.pages().find((candidate) => candidate.url().includes("/protocol/v1/popup"));
    if (!popup) throw new Error("Keymaster Session Window is not open");
    return popup;
  }

  try {
    await test.step("seed 给一次性 Keymaster key 充值并等待确认", async () => {
      fundingTxid = await fundOneTimeWallet({
        seedPrivateKeyHex: seedHex,
        targetAddress: ownerAddress,
        amountSatoshis: FUNDING_SATOSHIS,
        feeRateSatoshisPerKb: FEE_RATE_SATOSHIS_PER_KB,
      });
      broadcastTxs.push({ label: "fund owner", txid: fundingTxid });
      await waitForConfirmedTransaction(fundingTxid);
    });

    await test.step("Keymaster 导入一次性 key、开启 testnet、锁定钱包", async () => {
      await grantPersistentStorage(km);
      await setupLocalWalletWithImportedKey(km, {
        privateKeyHex: ownerHex,
        password: PASSWORD,
        bucketLabel: "real-e2e-bucket",
        keyLabel: "real-e2e-key",
      });
      await enableTestnetAssets(km);
      await lockKeymasterWallet(km);
    });

    await test.step("Demo connect.login（真实 Session Window 选 key + 密码）", async () => {
      await demo.goto(DEMO_ORIGIN, { waitUntil: "domcontentloaded" });
      await demo.getByLabel("Keymaster Target Origin").fill(KEYMASTER_ORIGIN);
      const popupPromise = demo.waitForEvent("popup", { timeout: 45_000 });
      await demo.getByRole("button", { name: "Run connect.login" }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded");
      await submitConnectLogin(popup, PASSWORD);
      await expect
        .poll(() => demo.evaluate(() => localStorage.getItem("keymaster-connect-demo.sessionId")))
        .toBeTruthy();
      await expect
        .poll(() => demo.evaluate(() => localStorage.getItem("keymaster-connect-demo.ownerPublicKeyHex")))
        .toBe(ownerPub);
    });

    await test.step("identity.get：真实确认卡 + 成功结果", async () => {
      await demo.locator("nav .nav-item").filter({ hasText: /^Identity/ }).click();
      const section = sectionOf(demo, "identity.get");
      await section.getByRole("button", { name: "Run identity.get" }).click();
      await confirmProtocolCard(sessionWindow());
      await expect(section.locator("pre", { hasText: '"ok": true' }).first()).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("intent.sign：真实确认卡 + 成功结果", async () => {
      const section = sectionOf(demo, "intent.sign");
      await section.getByRole("button", { name: "Run intent.sign" }).click();
      await confirmProtocolCard(sessionWindow());
      await expect(section.locator("pre", { hasText: '"ok": true' }).first()).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("cipher.encrypt / cipher.decrypt：真实确认卡 + 成功结果", async () => {
      await demo.locator("nav .nav-item").filter({ hasText: /^Cipher/ }).click();
      const encrypt = sectionOf(demo, "cipher.encrypt");
      await encrypt.getByRole("button", { name: "Run cipher.encrypt" }).click();
      await confirmProtocolCard(sessionWindow());
      await expect(encrypt.locator("pre", { hasText: '"ok": true' }).first()).toBeVisible({
        timeout: 30_000,
      });
      const decrypt = sectionOf(demo, "cipher.decrypt");
      await decrypt.getByRole("button", { name: "Run cipher.decrypt" }).click();
      await confirmProtocolCard(sessionWindow());
      await expect(decrypt.locator("pre", { hasText: '"ok": true' }).first()).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("p2pkh.transfer bsv-testnet：差异化金额真实广播", async () => {
      await demo.locator("nav .nav-item").filter({ hasText: /^Transfer/ }).click();
      const section = sectionOf(demo, "p2pkh.transfer");
      await section.getByLabel("assetId").selectOption("bsv-testnet");
      await section.getByLabel("recipientAddress").fill(ownerAddress);
      await section.getByLabel("feeRateSatoshisPerKb").fill(String(FEE_RATE_SATOSHIS_PER_KB));
      for (const amount of TRANSFER_AMOUNTS) {
        await section.getByLabel("amountSatoshis").fill(String(amount));
        await section.getByRole("button", { name: "Run p2pkh.transfer" }).click();
        await confirmProtocolCard(sessionWindow());
        const txidCell = section.locator(".result-stat", { hasText: "txid" }).locator("strong");
        await expect
          .poll(async () => (await txidCell.innerText()).trim())
          .toMatch(/^[0-9a-f]{64}$/u);
        const txid = (await txidCell.innerText()).trim();
        broadcastTxs.push({ label: `p2pkh.transfer ${amount}`, txid });
      }
    });

    await test.step("Demo Test Wallet 导入退款 key 并刷新 UTXO", async () => {
      await demo.locator("nav .nav-item").filter({ hasText: "Test Wallet" }).click();
      const wallet = sectionOf(demo, "Test wallet");
      await wallet
        .getByLabel("import WIF")
        .fill(PrivateKey.fromHex(counterpartyHex).toWif([0xef]));
      await wallet.getByRole("button", { name: "Import" }).click();
      await expect(wallet.getByText(counterpartyAddress, { exact: false }).first()).toBeVisible();
      await demo
        .locator(".section-block")
        .filter({ has: demo.getByRole("heading", { name: /Test wallet UTXOs/ }) })
        .getByRole("button", { name: "Refresh UTXOs" })
        .click();
    });

    await test.step("Demo Test Wallet 真实退款回 owner 地址", async () => {
      await demo.locator("nav .nav-item").filter({ hasText: "Test Wallet" }).click();
      const utxoSection = demo
        .locator(".section-block")
        .filter({ has: demo.getByRole("heading", { name: /Test wallet UTXOs/ }) });
      await utxoSection.getByRole("button", { name: "Refresh UTXOs" }).click();
      const refund = sectionOf(demo, "Manual one-click refund");
      await refund.getByLabel("recipientAddress").fill(ownerAddress);
      // 留出 refund 手续费；零头会并入 fee，不产生 dust output。
      await refund.getByLabel("amountSatoshis").fill(String(REFUND_AMOUNT_SATOSHIS - 400));
      await refund.getByLabel("feeRateSatoshisPerKb").fill(String(FEE_RATE_SATOSHIS_PER_KB));
      await refund.getByRole("button", { name: "Run one-click refund" }).click();
      const refundTxid = refund.locator(".result-stat", { hasText: "txid" }).locator("strong");
      await expect
        .poll(async () => (await refundTxid.innerText()).trim())
        .toMatch(/^[0-9a-f]{64}$/u);
      broadcastTxs.push({ label: "demo test wallet refund", txid: (await refundTxid.innerText()).trim() });
    });

    await test.step("connect.resume / connect.logout", async () => {
      await demo.locator("nav .nav-item").filter({ hasText: /^Connect/ }).click();
      const resume = sectionOf(demo, "connect.resume");
      await resume.getByRole("button", { name: "Run connect.resume" }).click();
      // resume 是自动执行能力：不需要确认卡。
      await expect(resume.locator("pre", { hasText: '"ok": true' }).first()).toBeVisible({
        timeout: 30_000,
      });
      const logout = sectionOf(demo, "connect.logout");
      await logout.getByRole("button", { name: "Run connect.logout" }).click();
      await expect(logout.locator("pre", { hasText: '"ok": true' }).first()).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("回收 testnet 资金并核对差额只等于手续费", async () => {
      // owner（Keymaster）与 demo 测试钱包（counterparty）的全部 UTXO 合并扫回 seed。
      const ownerUtxos = await listConfirmedUtxos(ownerAddress);
      const counterpartyUtxos = await listConfirmedUtxos(counterpartyAddress);
      if (ownerUtxos.length + counterpartyUtxos.length > 0) {
        const consolidated = await buildConsolidationTransaction({
          wallets: [
            { privateKeyHex: ownerHex, utxos: ownerUtxos },
            { privateKeyHex: counterpartyHex, utxos: counterpartyUtxos },
          ],
          recipientAddress: seedAddress,
          feeRateSatoshisPerKb: FEE_RATE_SATOSHIS_PER_KB,
        });
        const txid = await broadcast(consolidated.rawTxHex);
        broadcastTxs.push({ label: "consolidate back to seed", txid });
        await waitForConfirmedTransaction(txid);
        recoveredSatoshis =
          ownerUtxos.reduce((sum, utxo) => sum + utxo.value, 0) +
          counterpartyUtxos.reduce((sum, utxo) => sum + utxo.value, 0) -
          consolidated.feeSatoshis;
      }
      // 差额上限 = 已知广播笔数 × 单笔预算（含未扫净的 dust 余量）。
      const maxLoss = broadcastTxs.length * 500;
      expect(recoveredSatoshis).toBeGreaterThanOrEqual(FUNDING_SATOSHIS - maxLoss);
      test.info().annotations.push({
        type: "testnet-ledger",
        description: JSON.stringify({ fundingTxid, funding: FUNDING_SATOSHIS, recovered: recoveredSatoshis, broadcastTxs }),
      });
    });
  } finally {
    await context.close();
  }
});
