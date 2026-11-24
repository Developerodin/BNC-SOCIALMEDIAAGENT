// Moved to src/lib/rate-limit.ts (it serves the chat routes too). Kept so src/app/api/app/website-check/route.ts, which
// was being edited elsewhere at the time, still resolves; point it at "@/lib/rate-limit" and delete this file.
export * from "@/lib/rate-limit";
