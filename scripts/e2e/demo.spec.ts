import { expect, test } from "@playwright/test";

test("production Demo transport smoke: identity, connect, Channel, Storage, MSFile, multipart", async ({
  page,
}) => {
  // 生产签名由 Core app sign 生成后手工写入 HTML；e2e 使用明确 fixture，
  // 不把 fixture 写入生产入口，也不生成浏览器私钥。
  await page.addInitScript(() => {
    const meta = document.createElement("meta");
    meta.name = "keymaster-app:identity-signature";
    meta.content = "ab".repeat(64);
    document.head.append(meta);
  });
  await page.goto("/");
  expect(await page.evaluate(() => Object.keys(localStorage))).not.toContain(
    "keymaster-connect-demo.publisher-private-key.v1",
  );

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
  await expect
    .poll(async () =>
      popup.evaluate(
        () =>
          (window as Window & { __demoHarnessRequests?: unknown[] })
            .__demoHarnessRequests?.length ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await page.locator("nav .nav-item").filter({ hasText: "Channel" }).click();
  await page
    .getByLabel("channel (exact, ≤256 UTF-8 bytes)")
    .fill("demo-e2e.channel");
  await page
    .getByLabel("content (JSON, ≤16 levels)")
    .fill('{"text":"hello from browser"}');
  await page
    .getByLabel("channels (one exact channel per line)")
    .fill("demo-e2e.channel");
  await page
    .getByRole("button", { name: "Run channel.subscription_set" })
    .click();
  await expect(
    page.getByText('"demo-e2e.channel"', { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run channel.publish" }).click();
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

  await page.locator("nav .nav-item").filter({ hasText: "MSFile" }).click();
  await page
    .getByLabel("seedHashHex (64 lowercase hex)")
    .first()
    .fill("ab".repeat(32));
  await page.getByRole("button", { name: "Run msfile.stat" }).click();
  await expect(
    page.getByText("02" + "44".repeat(32), { exact: false }).first(),
  ).toBeVisible();
  await page
    .getByLabel("supplierPublicKeyHex (02/03 + 64 lowercase hex)")
    .first()
    .fill("02" + "44".repeat(32));
  await page
    .getByLabel("seedHashHex (64 lowercase hex)")
    .last()
    .fill("ab".repeat(32));
  await page.getByRole("button", { name: "Run msfile.seed.read" }).click();
  await expect(
    page.getByText("seed browser body", { exact: false }).last(),
  ).toBeVisible({ timeout: 15_000 });
  await page
    .getByLabel("supplierPublicKeyHex (02/03 + 64 lowercase hex)")
    .last()
    .fill("02" + "44".repeat(32));
  await page
    .getByLabel("blockHashHex (64 lowercase hex)")
    .fill("cd".repeat(32));
  await page.getByRole("button", { name: "Run msfile.block.read" }).click();
  await expect(
    page.getByText("block browser body", { exact: false }).last(),
  ).toBeVisible({ timeout: 15_000 });

  const auditPage = await page.context().newPage();
  await auditPage.goto("http://127.0.0.1:4174/protocol/v1/popup");
  const requests = await auditPage.evaluate(
    () =>
      JSON.parse(localStorage.getItem("demo-e2e-audit") || "[]") as Array<{
        method: string;
        params?: Record<string, unknown>;
      }>,
  );
  expect(requests.map((request) => request.method)).toEqual(
    expect.arrayContaining([
      "connect.login",
      "channel.subscription_set",
      "channel.publish",
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
      "msfile.stat",
      "msfile.seed.read",
      "msfile.block.read",
    ]),
  );
  const loginRequest = requests.find((request) => request.method === "connect.login");
  expect(loginRequest).toBeDefined();
  expect(Object.keys(loginRequest?.params ?? {}).sort()).toEqual(["appIdentity", "claims", "text"]);
  expect(loginRequest?.params?.appIdentity).toMatchObject({
    version: 1,
    publisherPublicKey: "032558368095eb0a4cb07d0dd59a8a5bffdfd19c495a79de280db63b746e228b30",
    app: { id: "keymaster-connect-demo", name: "Keymaster Connect Demo" },
    requirements: ["private-key", "storage"],
    signature: "[redacted]",
  });
  // session-first：常驻 Session Window 不随业务完成关闭，业务结果保留。
  expect(await popup.isClosed()).toBe(false);
  await page.locator("nav .nav-item").filter({ hasText: "Storage" }).click();
  const storage = page.locator(".protocol-section").filter({
    has: page.getByRole("heading", { name: "Storage (S3-backed)" }),
  });
  await expect(storage.locator("input").first()).toHaveValue(
    "demo-e2e-session",
  );

  const channel = page
    .locator(".protocol-section")
    .filter({ has: page.getByRole("heading", { name: "channel.publish" }) });
  await page.locator("nav .nav-item").filter({ hasText: "Channel" }).click();
  // Channel 工作台没有 sessionId 输入框：会话属于 Session Window。
  await expect(
    channel.getByPlaceholder("required for this method"),
  ).toHaveCount(0);
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
  // 第二次 connect.login 复用同一扇 Session Window，不新开 popup。
  let popupOpened = false;
  page.on("popup", () => {
    popupOpened = true;
  });
  await page.getByRole("button", { name: "Run connect.login" }).click();
  // 等到第二次 login 已落到 harness audit；页面上的 session 文案可能仍是上一次的。
  await expect
    .poll(async () =>
      auditPage.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("demo-e2e-audit") || "[]") as Array<{
              method: string;
            }>
          ).filter((request) => request.method === "connect.login").length,
      ),
    )
    .toBe(2);
  expect(popupOpened).toBe(false);
  const finalRequests = await auditPage.evaluate(
    () =>
      JSON.parse(localStorage.getItem("demo-e2e-audit") || "[]") as Array<{
        method: string;
        params?: Record<string, unknown>;
      }>,
  );
  const loginRequests = finalRequests.filter(
    (request) => request.method === "connect.login",
  );
  expect(loginRequests).toHaveLength(2);
  for (const request of loginRequests) {
    expect(Object.keys(request.params ?? {}).sort()).toEqual(["appIdentity", "claims", "text"]);
    expect(request.params?.appIdentity).toHaveProperty("signature", "[redacted]");
  }
  await auditPage.close();
});
