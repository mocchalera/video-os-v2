import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 10000,
    exclude: [...configDefaults.exclude, "**/.project-loop/**"],
  },
});
