# One Ramp — test suite

Regression tests that load the **real** `background.js` / `content.js` into a
sandboxed VM (via `harness.mjs`) and exercise their actual functions — so a
change that breaks matching, parsing, or the panel state machine fails here
before it ever reaches the cohort.

## Run

```bash
npm test
# or:
node --test tests/*.test.mjs
```

No dependencies — uses Node's built-in test runner (Node 18+).

## What's covered

- **matching.test.mjs** — the `findReceipt` engine end-to-end (Gmail mocked):
  nearest-time disambiguation of same-amount receipts, same-amount alternate
  filtering (known vs unknown vendor), the far-off-time "possible match"
  confidence rule, used-receipt exclusion, clean not-found, and the AI-judge
  fallback for non-exact (tip/tax/FX) amounts.
- **scoring.test.mjs** — `scoreMessage`, `validVerdict` (verdict hardening),
  `amountsIn`, `toCents`.
- **parsing.test.mjs** — `parseDate` / `parseDateTime` / `monthIdx` / the amount
  & date regexes against realistic glued DOM text, 3/4-letter months, narrow
  no-break spaces, and thousands separators.
- **state.test.mjs** — the `busy` lock that gates navigation: a real-code check
  that `flowActive()` reports busy, plus an executable contract for the
  attach → verify → navigate sequence (documents the "stuck during
  verification" behavior and the target once fixed).

## Notes

- Tests create a fresh VM realm per scenario, so they're isolated. When
  asserting on values returned from that realm, compare primitives (or spread
  into a local array) — `deepStrictEqual` rejects cross-realm arrays on their
  prototype even when contents match.
