import { defineConfig, devices } from "@playwright/test";

const external = process.env.PLAYWRIGHT_BASE_URL;
const port = 3100;
// Placeholder host mapped to 127.0.0.1 inside Chromium: a non-localhost plain-http origin, i.e. a
// non-secure context like http://<NAIS_EXTERNAL_HOST>:21051 (secure-context-only APIs are undefined there).
const insecureHost = "nais.test";
const externalPort = process.env.PLAYWRIGHT_EXTERNAL_PORT ?? (external ? new URL(external).port || "80" : String(port));

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: external ?? `http://localhost:${port}`,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium-insecure-origin",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://${insecureHost}:${externalPort}`,
        launchOptions: { args: [`--host-resolver-rules=MAP ${insecureHost} 127.0.0.1`] },
      },
    },
  ],
  webServer: external
    ? undefined
    : {
        command: `corepack pnpm build && corepack pnpm exec next start --port ${port}`,
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        env: {
          NEXT_PUBLIC_API_MOCKING: "enabled",
          AUTH_SECRET: "e2e-only-secret-0123456789abcdef",
          AUTH_URL: `http://localhost:${port}/web-auth`,
          AUTH_TRUST_HOST: "true",
          AUTH_ALLOWED_HOSTS: `${insecureHost}:${port}`,
        },
      },
});
