import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** 使用两个不同 origin 的生产页面验证真实 Connect，不读取资金资源。 */
export default defineConfig({
  testDir: ".", testMatch: /local-connect\.spec\.ts/, workers: 1, retries: 0,
  timeout: 180_000, reporter: "list", outputDir: "test-results/local-connect",
  use: { baseURL: "http://127.0.0.1:4201", ...devices["Desktop Chrome"], trace: "off", video: "off", screenshot: "off" },
  webServer: [
    { command: "pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4201", cwd: fileURLToPath(new URL("../../../keymaster.cc/", import.meta.url)), url: "http://127.0.0.1:4201", reuseExistingServer: true, timeout: 120_000 },
    { command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4184", cwd: fileURLToPath(new URL("../../", import.meta.url)), url: "http://127.0.0.1:4184", reuseExistingServer: true, timeout: 120_000 },
  ],
});
