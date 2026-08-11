import { expect, test } from "@playwright/test";

test("production Demo transport smoke: identity, connect, Broadcast, Storage, multipart, regenerate", async ({
  page,
}) => {
  await page.goto("/");
  const storageKey = "keymaster-connect-demo.publisher-private-key.v1";
  const initialKey = await page.evaluate(
    (key) => localStorage.getItem(key),
    storageKey,
  );
  expect(initialKey).toMatch(/^[0-9a-f]{64}$/);
  await page.reload();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBe(initialKey);

  await page
    .locator("nav .nav-item")
    .filter({ hasText: /^Connect/ })
    .click();
  await page
    .getByLabel("Keymaster Target Origin")
    .fill("http://127.0.0.1:4174");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Run connect.login" }).click();
  const popup = await popupPromise;
  await expect(
    page.getByText("demo-e2e-session", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("matched", { exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(async () =>
      popup.evaluate(
        () =>
          (window as Window & { __demoHarnessRequests?: unknown[] })
            .__demoHarnessRequests?.length ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await page.locator("nav .nav-item").filter({ hasText: "Broadcast" }).click();
  await page.getByLabel("channelId", { exact: true }).fill("demo-e2e.channel");
  await page.getByLabel("protocolId", { exact: true }).fill("demo.e2e.v1");
  await page
    .getByLabel("clientMessageId", { exact: true })
    .fill("demo-e2e-message");
  await page
    .getByLabel("body text (UTF-8; builder encodes base64)")
    .fill("hello from browser");
  await page
    .getByLabel("subscriptions (one channelId per line)")
    .fill("demo-e2e.channel");
  await page
    .getByRole("button", { name: "Run broadcast.subscription_set" })
    .click();
  await expect(
    page.getByText('"demo-e2e.channel"', { exact: false }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Run broadcast.subscription_list" })
    .click();
  await page.getByRole("button", { name: "Run broadcast.publish" }).click();
  await expect(
    page.getByText("hello from browser", { exact: false }).last(),
  ).toBeVisible({ timeout: 15_000 });

  await page.locator("nav .nav-item").filter({ hasText: "Storage" }).click();
  await page.getByLabel("path", { exact: true }).first().fill("demo-e2e.txt");
  await page.getByLabel("content text").fill("storage browser body");
  await page.getByRole("button", { name: "Put", exact: true }).click();
  await page.getByRole("button", { name: "Run list", exact: true }).click();
  await expect(
    page.getByText("demo-e2e.txt", { exact: false }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Get", exact: true }).click();
  await page.getByLabel("offset", { exact: true }).fill("1");
  await page.getByLabel("length", { exact: true }).fill("7");
  await page.getByRole("button", { name: "Get", exact: true }).click();
  await expect(
    page.getByText("storage browser body", { exact: false }).last(),
  ).toBeVisible();
  await expect(
    page.getByText('"offset": 1', { exact: false }).last(),
  ).toBeVisible();
  await expect(
    page.getByText('"previewText": "torage "', { exact: false }).last(),
  ).toBeVisible();
  await expect(
    page.getByText('"totalSize": 20', { exact: false }).last(),
  ).toBeVisible();
  await expect(
    page.getByText('"eof": false', { exact: false }).last(),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect((await downloadPromise).suggestedFilename()).toBe(
    "demo-e2e.txt",
  );
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Run create", exact: true }).click();
  await page.getByRole("button", { name: "Run delete", exact: true }).click();

  const file = {
    name: "multipart.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("multipart browser body"),
  };
  await page.getByLabel("File selection").setInputFiles(file);
  await page
    .getByLabel("path", { exact: true })
    .last()
    .fill("demo-e2e-multipart.bin");
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  await expect(page.getByLabel("uploadId")).not.toHaveValue("");
  await page.getByRole("button", { name: "Part", exact: true }).click();
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  await page.getByRole("button", { name: "Abort", exact: true }).click();

  // 这些值代表 session 运行时产物；regenerate 后必须清空，表单配置则保留。
  await page.locator("nav .nav-item").filter({ hasText: /^Connect/ }).click();
  await page.getByLabel("launchToken", { exact: true }).fill("sentinel-launch");
  await page.locator("nav .nav-item").filter({ hasText: /^Cipher/ }).click();
  await page.getByLabel("nonce", { exact: true }).fill("sentinel-nonce");
  await page
    .getByLabel("cipherbytes", { exact: true })
    .fill("sentinel-cipherbytes");
  await page.locator("nav .nav-item").filter({ hasText: /^Transfer/ }).click();
  await page
    .getByRole("textbox", { name: "operationId (auto from prepare)", exact: true })
    .fill("sentinel-operation");
  await page
    .getByRole("textbox", { name: "counterpartyPublicKeyHex", exact: true })
    .nth(1)
    .fill("sentinel-counterparty");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Regenerate publisher key" }).click();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .not.toBe(initialKey);
  await page.locator("nav .nav-item").filter({ hasText: /^Connect/ }).click();
  await expect(page.getByLabel("launchToken", { exact: true })).toHaveValue("");
  await page.locator("nav .nav-item").filter({ hasText: /^Cipher/ }).click();
  await expect(page.getByLabel("nonce", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("cipherbytes", { exact: true })).toHaveValue("");
  await page.locator("nav .nav-item").filter({ hasText: /^Transfer/ }).click();
  await expect(
    page.getByRole("textbox", {
      name: "operationId (auto from prepare)",
      exact: true,
    }),
  ).toHaveValue("");
  await expect(
    page
      .getByRole("textbox", { name: "counterpartyPublicKeyHex", exact: true })
      .nth(1),
  ).toHaveValue("");
  await page.locator("nav .nav-item").filter({ hasText: /^Storage/ }).click();

  const auditPage = await page.context().newPage();
  await auditPage.goto("http://127.0.0.1:4174/protocol/v1/popup");
  const requests = await auditPage.evaluate(
    () =>
      JSON.parse(localStorage.getItem("demo-e2e-audit") || "[]") as Array<{
        method: string;
        appIdentity?: { signature?: string; publisherPublicKey?: string };
      }>,
  );
  expect(requests.map((request) => request.method)).toEqual(
    expect.arrayContaining([
      "connect.login",
      "broadcast.subscription_set",
      "broadcast.subscription_list",
      "broadcast.publish",
      "storage.list",
      "storage.put",
      "storage.get",
      "storage.delete",
      "storage.directory.create",
      "storage.directory.delete",
      "storage.upload.begin",
      "storage.upload.part",
      "storage.upload.complete",
      "storage.upload.abort",
      "connect.logout",
    ]),
  );
  const proofRequest = requests.find(
    (request) => request.method === "connect.login",
  );
  expect(proofRequest?.appIdentity?.signature).toMatch(/^[0-9a-f]{128}$/);
  expect(proofRequest?.appIdentity?.publisherPublicKey).toMatch(
    /^0[23][0-9a-f]{64}$/,
  );
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByText("n/a", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("uploadId")).toHaveValue("");
  await expect(page.getByLabel("partSize")).toHaveValue("");
  await expect(page.getByLabel("maxParts")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toBeDisabled();
  const storage = page.locator(".protocol-section").filter({
    has: page.getByRole("heading", { name: "Storage (S3-backed)" }),
  });
  await expect(storage.getByLabel("connectSessionId")).toHaveValue("");
  await expect(storage.locator("pre").allTextContents()).resolves.toEqual(
    expect.arrayContaining(["null", "[]"]),
  );

  const broadcast = page
    .locator(".protocol-section")
    .filter({ has: page.getByRole("heading", { name: "Broadcast" }) });
  await page.locator("nav .nav-item").filter({ hasText: "Broadcast" }).click();
  await expect(broadcast.getByLabel("connectSessionId")).toHaveValue("");
  await expect(
    broadcast.getByLabel("subscriptions (one channelId per line)"),
  ).toHaveValue("");
  const broadcastPanels = await broadcast.locator("pre").allTextContents();
  expect(broadcastPanels.slice(0, 3)).toEqual(["null", "null", "null"]);
  expect(broadcastPanels[3]).toBe("[]");
  expect(
    (await requests.filter((request) => request.method === "connect.login"))
      .length,
  ).toBe(1);
  await page
    .locator("nav .nav-item")
    .filter({ hasText: /^Connect/ })
    .click();
  await expect(page.getByLabel("Keymaster Target Origin")).toHaveValue(
    "http://127.0.0.1:4174",
  );
  const secondPopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Run connect.login" }).click();
  const secondPopup = await secondPopupPromise;
  await expect(
    page.getByText("demo-e2e-session", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("matched", { exact: true }).first(),
  ).toBeVisible();
  await expect.poll(() => secondPopup.isClosed()).not.toBe(true);
  await auditPage.reload();
  const finalRequests = await auditPage.evaluate(
    () =>
      JSON.parse(localStorage.getItem("demo-e2e-audit") || "[]") as Array<{
        method: string;
        appIdentity?: { signature?: string; publisherPublicKey?: string };
      }>,
  );
  const loginProofs = finalRequests.filter(
    (request) => request.method === "connect.login",
  );
  expect(loginProofs).toHaveLength(2);
  expect(loginProofs[0]?.appIdentity?.publisherPublicKey).not.toBe(
    loginProofs[1]?.appIdentity?.publisherPublicKey,
  );
  expect(loginProofs[1]?.appIdentity?.signature).toMatch(/^[0-9a-f]{128}$/);
  await auditPage.close();
});
