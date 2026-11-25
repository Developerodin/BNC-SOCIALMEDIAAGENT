import postgres from "postgres";
import { beforeAll } from "vitest";

// Clean slate for each test file.
beforeAll(async () => {
  const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  await admin`truncate accounts, stores, store_tokens, webhook_events cascade`;
  await admin.end();
});
