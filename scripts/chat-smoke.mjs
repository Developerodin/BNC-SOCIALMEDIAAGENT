// Task 21 dev-store check: reads the /api/chat SSE stream from the running app (plain Node, no dependencies).
//   node scripts/chat-smoke.mjs <baseUrl> <shop> "<question>" [country] [--token <t>]
//   node scripts/chat-smoke.mjs <baseUrl> <shop> --history --token <t>
// Prints text as it arrives, one line per product event, then `done` with the token to pass as --token next time.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const token = flag("--token");
const history = args.includes("--history");
if (history) args.splice(args.indexOf("--history"), 1);
const [baseUrl, shop, question, country] = args;

if (!baseUrl || !shop || (!history && !question) || (history && !token)) {
  console.error('usage: node scripts/chat-smoke.mjs <baseUrl> <shop> "<question>" [country] [--token <t>]');
  console.error("       node scripts/chat-smoke.mjs <baseUrl> <shop> --history --token <t>");
  process.exit(2);
}
const origin = `https://${shop}`;
const base = baseUrl.replace(/\/+$/, "");

if (history) {
  const res = await fetch(`${base}/api/chat/history?shop=${encodeURIComponent(shop)}`, {
    headers: { Origin: origin, "X-Conversation-Token": token },
  });
  console.log(`HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.messages) {
    console.log(JSON.stringify(body));
    process.exit(1);
  }
  for (const m of body.messages) {
    console.log(`[${m.role}${m.status && m.status !== "ok" ? `, ${m.status}` : ""}] ${m.content}`);
    for (const c of m.cards ?? []) console.log(`   ${cardLine(c)}`);
  }
  process.exit(0);
}

function cardLine(c) {
  const price = c.price == null ? "no price" : `${c.price} ${c.currency ?? ""}`.trim();
  const stock = c.stock == null ? "no stock" : c.stock.kind === "count" ? `${c.stock.n} left` : c.stock.kind;
  return `product: ${c.title} | available=${c.available} | action=${c.action} | ${price} | ${stock} | ${c.url}`;
}

const started = Date.now();
const res = await fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ shop, message: question, ...(token ? { conversationToken: token } : {}), ...(country ? { country } : {}) }),
});
if (!res.ok || !res.body) {
  console.log(`HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}

let firstText = null;
let failed = false;
let buf = "";
const decoder = new TextDecoder();

// One SSE block: "event: <name>\ndata: <JSON>"; comment lines (": ping") are skipped.
function handle(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return;
  const payload = JSON.parse(data.join("\n"));
  if (event === "text") {
    firstText ??= Date.now() - started;
    process.stdout.write(payload.delta);
  } else if (event === "product") {
    process.stdout.write(`\n${cardLine(payload)}\n`);
  } else if (event === "done") {
    console.log(`\ndone token=${payload.conversationToken}`);
  } else if (event === "error") {
    failed = true;
    console.log(`\nerror: ${payload.message} token=${payload.conversationToken ?? ""}`);
  } else {
    console.log(`\n${event}: ${JSON.stringify(payload)}`);
  }
}

for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
  let i;
  while ((i = buf.indexOf("\n\n")) !== -1) {
    handle(buf.slice(0, i));
    buf = buf.slice(i + 2);
  }
}
if (buf.trim()) handle(buf);
console.log(`(first text after ${firstText ?? "-"} ms, total ${Date.now() - started} ms)`);
process.exit(failed ? 1 : 0);
