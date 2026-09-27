import { defineConfig } from "vitest/config";

const conditions = ["source", "node", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/api/src/**/*.test.ts", "apps/worker/src/**/*.test.ts", "tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
