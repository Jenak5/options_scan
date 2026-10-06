/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Same loss cap on the server and in the browser. Unset keeps 875 in risk.ts.
  env: {
    MAX_LOSS_DOLLARS: process.env.MAX_LOSS_DOLLARS ?? "",
  },
};

module.exports = nextConfig;
