import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const DEMO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const KEYMASTER_ROOT = fileURLToPath(new URL("../../../keymaster.cc/", import.meta.url));

/**
 * real-Keymaster e2e 执行档（施工单 2026-09-18 001）。
 *
 * 同时启动：
 *   - keymaster.cc 生产构建 preview（4173）；
 *   - Demo 生产构建 preview（4174）。
 *
 * 该组会使用仓库外 `~/.config/keymaster-e2e/seed-key.hex` 的 testnet 余额，
 * 涉及真实广播与资金回收；不保留 trace/video，避免一次性 key 材料进入附件。
 * `KEYMASTER_E2E_SEED_KEY_PATH` 可覆盖 seed 路径。
 */
export default defineConfig({
  testDir: ".",
  testMatch: /real-connect\.spec\.ts/,
  timeout: 1_800_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [["line"]],
  outputDir: "test-results/real-connect",
  use: {
    baseURL: "http://127.0.0.1:4173",
    ...devices["Desktop Chrome"],
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command:
        "pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
      cwd: KEYMASTER_ROOT,
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 900_000,
    },
    {
      command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4174",
      cwd: DEMO_ROOT,
      url: "http://127.0.0.1:4174",
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
