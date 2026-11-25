import { configDefaults, defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

// Tests run against the test database: point the runtime URLs at the TEST_* ones.
const env = loadEnv("test", process.cwd(), "");
process.env.DATABASE_URL = env.TEST_DATABASE_URL;
process.env.DATABASE_ADMIN_URL = env.TEST_DATABASE_ADMIN_URL;

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    // Test-only dummy values; never real secrets.
    env: {
      SHOPIFY_API_KEY: "test-api-key",
      SHOPIFY_API_SECRET: "test-api-secret",
      SHOPIFY_APP_URL: "https://test.example.com",
      TOKEN_KEY: "2n3r8krbA8HE+VcP4RyQl6noUkyRd26boJxKNyhAfH8=",
      // Real key from .env, only for tests/live (skipped when unset); other tests mock embed.
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
    },
    // Agent worktrees under .claude/ hold full copies of the repo and their tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
    fileParallelism: false, // DB files share one database and truncate per file
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-truncate.ts"],
  },
});
