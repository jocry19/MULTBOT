import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests share one Postgres test database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
