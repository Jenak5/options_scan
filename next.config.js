/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The candle client uses Node's WebSocket, and the ws package when that global is missing.
  experimental: {
    serverComponentsExternalPackages: ["ws"],
  },
  // Same loss cap on the server and in the browser. Unset keeps 875 in risk.ts.
  env: {
    MAX_LOSS_DOLLARS: process.env.MAX_LOSS_DOLLARS ?? "",
    ACCOUNT_SIZE_DOLLARS: process.env.ACCOUNT_SIZE_DOLLARS ?? "",
  },
};

module.exports = nextConfig;
