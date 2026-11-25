import { sql } from "drizzle-orm";
import { db } from "@/db/client";

// Liveness for a monitor or load balancer: 200 {ok:true} when the process answers and the database does a `select 1`
// within 3 s, else 503. No auth, and nothing about the setup in the answer. pm2 alone only restarts a crashed process;
// point an uptime check (or a cron + curl) at this to notice a hung one.

export const dynamic = "force-dynamic";
const PING_MS = 3000;

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), PING_MS);
  });
  try {
    const ping = db.execute(sql`select 1`);
    ping.catch(() => {}); // a late rejection after the timeout must not go unhandled
    await Promise.race([ping, limit]);
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers });
  } finally {
    clearTimeout(timer!);
  }
}
