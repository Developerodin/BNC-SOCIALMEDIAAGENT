import { asc, and, eq } from "drizzle-orm";
import { forStore } from "@/db/client";
import { faqs } from "@/db/schema";

// D32 / D7: one product's FAQ for the storefront block and the chat's suggested questions. Read through RLS (forStore).

export const FAQ_LIMIT = 20;

/** The product's FAQ in `position` order, at most 20 (served by faqs_store_product_position_idx). */
export function productFaqs(storeId: string, productGid: string): Promise<{ question: string; answer: string }[]> {
  return forStore(storeId, (tx) =>
    tx
      .select({ question: faqs.question, answer: faqs.answer })
      .from(faqs)
      .where(and(eq(faqs.storeId, storeId), eq(faqs.productId, productGid)))
      .orderBy(asc(faqs.position), asc(faqs.id))
      .limit(FAQ_LIMIT),
  );
}
