import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /demo\.spec\.ts/,
  timeout: 90_000,
  fullyParallel: false,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    ...devices["Desktop Chrome"],
    headless: true,
  },
  webServer: [
    {
      command: "npm run preview -- --host 127.0.0.1 --port 4173",
      cwd: process.cwd(),
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "node scripts/e2e/popup-harness.mjs",
      cwd: process.cwd(),
      url: "http://127.0.0.1:4174/protocol/v1/popup",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
