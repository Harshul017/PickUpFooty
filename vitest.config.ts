import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/helpers/global-setup.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
