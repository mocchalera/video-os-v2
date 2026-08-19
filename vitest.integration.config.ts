import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/final-render-review-pack.real.test.ts"],
    testTimeout: 120_000,
  },
});
