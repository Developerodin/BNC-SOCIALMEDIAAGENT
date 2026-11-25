// Seeds a product's FAQ for a dev store (C24: until the M7 FAQ editor exists, FAQs come only from this script).
//   node --env-file=.env scripts/seed-faq.mjs [shop] [product title]
// Defaults: the dev store and "The Complete Snowboard". The product is looked up by title in our synced `products`
// table, so the store must be installed and synced. Re-running replaces that product's FAQ (delete + insert in one
// transaction), so it is safe to run twice. Uses DATABASE_ADMIN_URL because it writes across RLS as a developer tool;
// never run it against production.
import postgres from "postgres";

const shop = process.argv[2] ?? "ask-cart-hv7ufqqy.myshopify.com";
const title = process.argv[3] ?? "The Complete Snowboard";

// D49 drafts: sample content for the dev store only. Lengths stay under the 300 / 2,000 character checks.
const FAQS = [
  {
    question: "What riding style is this board made for?",
    answer: "It's an all-mountain board: stable at speed on groomers, with enough flex for park laps and powder days.",
  },
  {
    question: "How do I choose the right length?",
    answer: "Stand the board up next to you: for all-mountain riding it should reach between your chin and your nose. Go shorter for park, longer for powder.",
  },
  {
    question: "Are bindings included?",
    answer: "No, the board ships without bindings. It uses the standard 4x4 insert pattern, so most bindings fit.",
  },
];

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (run with node --env-file=.env).");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });
try {
  const [store] = await sql`select id from stores where shop_domain = ${shop}`;
  if (!store) throw new Error(`No store ${shop} in this database.`);
  const found = await sql`select shopify_id from products where store_id = ${store.id} and title = ${title}`;
  if (found.length !== 1) throw new Error(`Expected one product titled "${title}" in ${shop}, found ${found.length}.`);
  const productId = found[0].shopify_id;

  await sql.begin(async (tx) => {
    await tx`delete from faqs where store_id = ${store.id} and product_id = ${productId}`;
    for (const [position, f] of FAQS.entries()) {
      await tx`insert into faqs (store_id, product_id, question, answer, position)
               values (${store.id}, ${productId}, ${f.question}, ${f.answer}, ${position})`;
    }
  });
  console.log(`Seeded ${FAQS.length} FAQs for "${title}" (${productId}) in ${shop}.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
