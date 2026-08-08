// Tests for background.js scoring + verdict validation + amount parsing (real
// functions, loaded via the harness).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, makeChrome, gmsg } from "./harness.mjs";

const B = loadModule(
  "background.js",
  ["scoreMessage", "validVerdict", "amountsIn", "toCents"],
  { chrome: makeChrome({}), fetch: async () => ({ ok: false }) }
);

const T = (h, m) => Date.UTC(2026, 7, 4, h, m);

test("amountsIn: collects distinct dollar amounts, comma and comma-less", () => {
  // $0.00 legitimately parses to 0 cents — harmless (a charge is never $0.00).
  const s = B.amountsIn("Subtotal $6.45, tax $0.00, grand total $1,234.56 and again $6.45");
  assert.deepEqual([...s].sort((a, b) => a - b), [0, 645, 123456]);
});

test("toCents: strips $ and commas", () => {
  assert.equal(B.toCents("$1,234.56"), 123456);
  assert.equal(B.toCents("6.45"), 645);
});

test("scoreMessage: exact amount + known vendor + close date scores high", () => {
  const msg = gmsg({
    id: "m",
    subject: "Your receipt from OpenRouter, Inc #1",
    from: "invoice+statements@openrouter.ai",
    internalDate: T(22, 54),
    bodyText: "Total $6.45",
  });
  const ctx = { amountCents: 645, chargeDate: new Date(T(22, 52)), vendorRule: { match: /openrouter/i }, dateHasTime: true };
  const { score, reasons } = B.scoreMessage(ctx, msg, "Total $6.45");
  assert.ok(score >= 0.9, `expected high score, got ${score}`);
  assert.ok(reasons.includes("exact amount match"));
  assert.ok(reasons.includes("known vendor sender"));
});

test("scoreMessage: wrong amount gets no amount bonus", () => {
  const msg = gmsg({ id: "m", subject: "Receipt", from: "x@y.com", internalDate: T(22, 54), bodyText: "Total $9.99" });
  const ctx = { amountCents: 645, chargeDate: new Date(T(22, 52)), vendorRule: null, dateHasTime: true };
  const { score, reasons } = B.scoreMessage(ctx, msg, "Total $9.99");
  assert.ok(!reasons.includes("exact amount match"));
  assert.ok(score < 0.6);
});

test("validVerdict: normalizes a good verdict and clamps confidence", () => {
  const v = B.validVerdict({ match_index: 1, confidence: 1.7, rationale: "x", memo: "y" }, 3);
  assert.equal(v.match_index, 1);
  assert.equal(v.confidence, 1); // clamped to [0,1]
});

test("validVerdict: rejects out-of-range or non-integer index", () => {
  assert.equal(B.validVerdict({ match_index: 5 }, 3), null);
  assert.equal(B.validVerdict({ match_index: 1.5 }, 3), null);
  assert.equal(B.validVerdict("not an object", 3), null);
});

test("validVerdict: null index (no match) is allowed", () => {
  const v = B.validVerdict({ match_index: null, rationale: "none fit" }, 3);
  assert.equal(v.match_index, null);
});
