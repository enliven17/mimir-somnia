const createNextIntlPlugin = require("next-intl/plugin");
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // /council prerenders from on-chain logs, and 31 build workers share one public
  // Somnia RPC, so a cold build can sit well past Next's 60s default and fail the
  // whole export. The page is ISR (revalidate 30), so a slow build is cheap.
  staticPageGenerationTimeout: 300,
  // ...and cap how many render at once. The default spawns one worker per CPU
  // (31 on Railway's builder); each holding an open RPC scan for up to the
  // timeout above was enough to get the build container OOM-killed mid-export,
  // with no error in the log — just a build that stops at 12/25 pages.
  experimental: {
    cpus: 2,
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // frame-src is listed explicitly. Without it these fall back to default-src
        // 'self', which blocks the wallet iframes Privy opens — the
        // connect flow failed with a generic "could not connect" and nothing in the
        // network tab, because the frame never loaded. Named origins rather than
        // https:, so a compromised third-party script still cannot frame anything.
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss:; frame-src 'self' https://auth.privy.io https://*.privy.io https://keys.coinbase.com https://*.walletconnect.com https://*.walletconnect.org https://verify.walletconnect.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
      ],
    }];
  },
  // Pin Turbopack's workspace root. A stray ~/package-lock.json makes Next infer
  // the wrong root (C:\Users\enliven) and serve an empty app dir → every route
  // 404s. Anchoring to this file's dir fixes dev and prod builds alike.
  turbopack: {
    root: __dirname,
    resolveAlias: {
      // The browser bundle must not pull server-only x402 modules into the client.
      // scheme. Mimir is EVM-only, so that branch never runs — but Turbopack
      // resolves the dynamic import statically and fails the build. Stub it
      // instead of installing the whole Solana SDK for dead code.
      "@x402/svm/exact/client": { browser: "./lib/x402/svm-stub.ts", default: "./lib/x402/svm-stub.ts" },
      // @privy-io/react-auth imports Stripe for card funding, which Mimir does not
      // offer. Same reasoning as above: stub the dead path instead of installing a
      // payments SDK to satisfy it.
      "@stripe/stripe-js": { browser: "./lib/stripe-stub.ts", default: "./lib/stripe-stub.ts" },
    },
  },
};

module.exports = withNextIntl(nextConfig);
