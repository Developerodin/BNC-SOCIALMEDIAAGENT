export async function register() {
  // Workers run in the app's own Node.js process (§6); pg-boss cannot load in the edge runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorkers } = await import("@/lib/jobs");
    await startWorkers();
  }
}
