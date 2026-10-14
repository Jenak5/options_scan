import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    // Existing suites mock the Schwab client. Keep the router on Schwab there;
    // marketData tests pass their own env.
    env: { DATA_SOURCE: "schwab" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
