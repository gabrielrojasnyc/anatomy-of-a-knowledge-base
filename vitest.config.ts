import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
    globalSetup: ["./vitest.setup.ts"],
    env: {
      // Isolate the suite from the live kb database, which holds real
      // distilled content. loadDotEnv() only fills in vars that are still
      // undefined, so this wins over any DATABASE_URL in .env.
      DATABASE_URL: "postgres://kb:kb@localhost:5433/kb_test",
    },
  },
});
