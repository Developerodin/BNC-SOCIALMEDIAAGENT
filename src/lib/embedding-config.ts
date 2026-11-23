// Constants only: imports nothing so schema.ts can use them without pulling in the SDK.
export const EMBEDDING_MODEL = "text-embedding-3-small";
// D33: moving to 1536 changes this plus the chunks.embedding column, and that migration must DELETE FROM chunks.
export const EMBEDDING_DIMS = 512;
// Bump when chunking changes so products re-embed.
export const CHUNKER_VERSION = 1;
