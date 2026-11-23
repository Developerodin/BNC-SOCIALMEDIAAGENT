import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

// Tests run against the test database: point the runtime URLs at the TEST_* ones.
const env = loadEnv("test", process.cwd(), "");
process.env.DATABASE_URL = env.TEST_DATABASE_URL;
process.env.DATABASE_ADMIN_URL = env.TEST_DATABASE_ADMIN_URL;

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    fileParallelism: false, // DB files share one database and truncate per file
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-truncate.ts"],
  },
});
