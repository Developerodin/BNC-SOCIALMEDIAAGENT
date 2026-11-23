# Agent rules for this project

## Decisions belong to the user

- **Never make a product or technical decision yourself.** This covers "my call", "builder's call", and silently picking a default.
- For any open choice:
  - present the options with their trade-offs and your recommendation,
  - let the user pick,
  - until they do, list it as **PENDING** in `product.md` → §11 "Pending decisions".
- Only choices the user explicitly made are recorded as decided, with the date.
- Don't implement anything that depends on a pending decision.

## Project docs

- `product.md`: the design. Section §12 "User decisions log" holds what's settled, and §11 "Pending decisions" holds what isn't.
