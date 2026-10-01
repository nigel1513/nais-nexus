import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost:3000/" } },
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
    css: false,
    env: { NEXT_PUBLIC_API_MOCKING: "enabled" },
    testTimeout: 15000,
    // next-auth/react (pulled in via the shell) imports "next/server" without an extension; let Vite resolve it.
    server: { deps: { inline: [/next-auth/] } },
  },
});
