import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
  output: "standalone",
  // pnpm monorepo: trace files from the repo root so the standalone bundle contains workspace packages.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  transpilePackages: ["@nais/ui"],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true }, // lint runs as its own step (pnpm lint)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default withNextIntl(config);
