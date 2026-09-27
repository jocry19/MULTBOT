import { defineConfig } from "vitest/config";

// "source" resolves workspace packages to their TypeScript sources (no build step needed in tests).
const conditions = ["source", "node", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests share one Postgres test database; run files sequentially.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
