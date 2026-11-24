// D41: mask contact details in shopper text before it is stored, rewritten, embedded or sent to OpenAI.
// ponytail: regex masking misses spelled-out numbers ("zero six...") and obfuscated emails
// ("jo at shop dot fr"). That residual risk is accepted.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Phone candidate: optional "+", then digits joined by at most two of space . - ( ).
// isPhone() then requires 9+ digits and at most one balanced pair of parentheses,
// so sizes, SKUs, dates, prices and order numbers stay untouched.
// ponytail: a run of 9+ digits such as two dates in a row ("2026-11-24 2026-12-01") is masked too.
const PHONE_CANDIDATE = /(?<![\w@])\+?\(?\d(?:[ .()-]{0,2}\d)*(?!\w)/g;

function isPhone(s: string): boolean {
  if ((s.match(/\d/g) ?? []).length < 9) return false;
  const open = s.split("(").length - 1;
  const close = s.split(")").length - 1;
  if (open > 1 || close > 1 || open !== close) return false;
  return open === 0 || s.indexOf("(") < s.indexOf(")");
}

export function maskPII(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE_CANDIDATE, (m) => (isPhone(m) ? "[phone]" : m));
}
