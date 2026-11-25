// Prints one customer's AskCart chats as JSON, for answering a Shopify customers/data_request (src/lib/shopify/webhooks.ts
// logs the request with the store id, the request id and how many conversations the customer owns; this is the manual step).
//   node --env-file=.env scripts/export-customer-chats.mjs <shop.myshopify.com> <customerId> > chats.json
// Only chats started while signed in are linked to a customer; guest chats carry no customer id and can't be matched.
// Message text is already masked (D41). conversations, messages and cart_events are FORCE RLS, so even the table owner
// sees nothing until app.store_id is set (as forStore does): the reads run in one transaction that sets it.
// Run it by hand against production from a trusted machine, and hand the file to the merchant, who answers the customer.
import postgres from "postgres";

const [shop, customerId] = process.argv.slice(2);
if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop ?? "") || !/^\d{1,20}$/.test(customerId ?? "")) {
  console.error("usage: node --env-file=.env scripts/export-customer-chats.mjs <shop.myshopify.com> <numeric customer id>");
  process.exit(1);
}
const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (run with node --env-file=.env).");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const [store] = await sql`select id from stores where shop_domain = ${shop}`;
  if (!store) {
    console.error(`no such store: ${shop}`);
    process.exit(1);
  }
  const owner = `gid://shopify/Customer/${customerId}`;
  const conversations = await sql.begin(async (tx) => {
    await tx`select set_config('app.store_id', ${store.id}, true)`;
    const conversations = await tx`
      select id, page_url, created_at from conversations
      where store_id = ${store.id} and owner_customer_id = ${owner} order by created_at`;
    for (const c of conversations) {
      c.messages = await tx`
        select role, content, product_ids, created_at from messages
        where store_id = ${store.id} and conversation_id = ${c.id} order by created_at, id`;
      c.cart_events = await tx`
        select product_id, variant_id, quantity, created_at from cart_events
        where store_id = ${store.id} and conversation_id = ${c.id} order by created_at, id`;
    }
    return conversations;
  });
  console.log(JSON.stringify({ shop, customer: owner, conversations }, null, 2));
} finally {
  await sql.end();
}
