// D35 limits for one chat turn.
export const MAX_INPUT_CHARS = 2000; // longer messages get a 413
export const HISTORY_MESSAGES = 20; // messages of history sent with each turn
export const MAX_ANSWER_TOKENS = 1000; // max_output_tokens for the answer
// Safety net for mcp-mode stores (no install, no billing yet): at most this many shopper messages per store per UTC day,
// counted from the messages table. Over it the turn ends with a friendly error and makes no OpenAI call.
export const MCP_DAILY_MESSAGES = 100;
