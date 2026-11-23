import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

export default async function setup() {
  const testUrl = new URL(process.env.DATABASE_ADMIN_URL!);
  const dbName = testUrl.pathname.slice(1);
  const bootstrapUrl = new URL(testUrl);
  bootstrapUrl.pathname = "/shopassist";

  const boot = postgres(bootstrapUrl.href, { max: 1 });
  const exists = await boot`select 1 from pg_database where datname = ${dbName}`;
  if (exists.length === 0) await boot.unsafe(`create database "${dbName}"`);
  await boot.end();

  const admin = postgres(testUrl.href, { max: 1 });
  await migrate(drizzle(admin), { migrationsFolder: "./drizzle" });
  await admin.end();
}
