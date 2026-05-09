import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
  },
});
