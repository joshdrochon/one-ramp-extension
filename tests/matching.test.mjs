// Tests for background.js matching engine — the REAL findReceipt() and its
// helpers, with Gmail/storage/AI mocked. This is the highest-value regression
// coverage: it locks in the nearest-time disambiguation, same-amount alternate
// filtering, confidence rules, the judge fallback, and used-receipt exclusion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, makeFetch, makeChrome, gmsg } from "./harness.mjs";

// Absolute epoch ms so timezone never enters into it.
const T = (h, m) => Date.UTC(2026, 7, 4, h, m); // Aug 4 2026, hh:mm UTC
const chargeISO = (h, m) => new Date(T(h, m)).toISOString();

function run(charge, { list, messages, usedIds = [], judge = null }) {
  const bg = loadModule("background.js", ["findReceipt"], {
    chrome: makeChrome({ usedIds }),
    fetch: makeFetch({ list, messages, judge }),
  });
  return bg.findReceipt(charge);
}

// ---- fixtures ------------------------------------------------------------
const openrouterFrom = "invoice+statements@openrouter.ai";
const orMsg = (id, num, h, m, dollars) =>
  gmsg({
    id,
    subject: `Your receipt from OpenRouter, Inc #${num}`,
    from: openrouterFrom,
    internalDate: T(h, m),
    bodyText: `Receipt total $${dollars} for OpenRouter credits`,
  });

// ==========================================================================
test("nearest-time: two same-amount receipts → picks the one closest to the charge", async () => {
  // Charge 5:52 PM. Receipts at 5:18 (34 min off) and 5:54 (2 min off).
  const res = await run(
    { merchant: "OpenRouter", amountCents: 645, dateISO: chargeISO(22, 52), dateHasTime: true },
    {
      list: [{ id: "A" }, { id: "B" }],
      messages: {
        A: orMsg("A", "2604-2949", 22, 18, "6.45"),
        B: orMsg("B", "2482-0960", 22, 54, "6.45"),
      },
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.match.receiptNo, "2482-0960", "should pick the 5:54 receipt, not 5:18");
  assert.equal(res.confident, true);
  assert.equal(res.alternates.length, 1);
  assert.equal(res.alternates[0].receiptNo, "2604-2949");
});

test("same-amount alternates: known vendor drops a different-amount receipt", async () => {
  const res = await run(
    { merchant: "OpenRouter", amountCents: 645, dateISO: chargeISO(22, 52), dateHasTime: true },
    {
      list: [{ id: "A" }, { id: "B" }, { id: "C" }],
      messages: {
        A: orMsg("A", "2604-2949", 22, 18, "6.45"),
        B: orMsg("B", "2482-0960", 22, 54, "6.45"),
        C: orMsg("C", "1111-2222", 14, 21, "2.91"), // different amount
      },
    }
  );
  assert.equal(res.match.receiptNo, "2482-0960");
  const amounts = res.alternates.map((a) => a.amtCents);
  assert.ok(!amounts.includes(291), "the $2.91 receipt must NOT be offered for a $6.45 charge");
  // (compare primitives, not the VM-realm array, to avoid a cross-realm prototype mismatch)
  assert.equal(amounts.length, 1, "only the same-amount twin should be an alternate");
  assert.equal(amounts[0], 645);
});

test("same-amount alternates: unknown vendor keeps a different-amount fallback (tip/FX)", async () => {
  const res = await run(
    { merchant: "SomeCafe", amountCents: 645, dateISO: chargeISO(22, 52), dateHasTime: true },
    {
      list: [{ id: "X" }, { id: "Y" }],
      messages: {
        X: gmsg({ id: "X", subject: "Receipt from SomeCafe", from: "billing@somecafe.com", internalDate: T(22, 50), bodyText: "Total $6.45" }),
        Y: gmsg({ id: "Y", subject: "Receipt from SomeCafe", from: "billing@somecafe.com", internalDate: T(20, 0), bodyText: "Total $2.91" }),
      },
    }
  );
  assert.equal(res.match.amtCents, 645);
  const amounts = res.alternates.map((a) => a.amtCents);
  assert.ok(amounts.includes(291), "unknown vendor should keep the different-amount fallback reachable");
});

test("confidence: a same-amount receipt far in time from the charge is only a POSSIBLE match", async () => {
  // Only receipt is 34 min off — the real one may not have arrived yet.
  const res = await run(
    { merchant: "OpenRouter", amountCents: 645, dateISO: chargeISO(22, 52), dateHasTime: true },
    { list: [{ id: "A" }], messages: { A: orMsg("A", "2604-2949", 22, 18, "6.45") } }
  );
  assert.equal(res.ok, true);
  assert.equal(res.match.receiptNo, "2604-2949");
  assert.equal(res.confident, false, "34 min off should not be a confident match");
});

test("used receipts: a receipt already attached elsewhere is never re-offered", async () => {
  const res = await run(
    { merchant: "OpenRouter", amountCents: 645, dateISO: chargeISO(22, 52), dateHasTime: true },
    {
      list: [{ id: "A" }, { id: "B" }],
      messages: {
        A: orMsg("A", "2604-2949", 22, 18, "6.45"),
        B: orMsg("B", "2482-0960", 22, 54, "6.45"),
      },
      usedIds: ["B"], // the nearer receipt is already spent
    }
  );
  assert.equal(res.match.receiptNo, "2604-2949", "should fall back to the un-used receipt");
});

test("no receipts: returns a clean not-found instead of a wrong match", async () => {
  const res = await run(
    { merchant: "OpenRouter", amountCents: 645, dateISO: chargeISO(22, 52), dateHasTime: true },
    { list: [], messages: {} }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /No receipt emails found/);
});

test("judge fallback: no exact-amount receipt (tip/tax) escalates and uses the verdict", async () => {
  // $54.20 charge, only a $45.00 receipt (tip added at settlement).
  const res = await run(
    { merchant: "DinerX", amountCents: 5420, dateISO: chargeISO(22, 52), dateHasTime: true },
    {
      list: [{ id: "R" }],
      messages: {
        R: gmsg({ id: "R", subject: "Receipt from DinerX", from: "no-reply@dinerx.com", internalDate: T(22, 40), bodyText: "Subtotal $45.00" }),
      },
      judge: { match_index: 0, confidence: 0.9, rationale: "tip added at settlement", memo: "Team dinner" },
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.match.memo, "Team dinner", "memo comes from the judge on non-exact matches");
  assert.match(res.match.aiRationale, /tip/);
  assert.equal(res.confident, true, "judge confidence ≥ 0.75 → confident");
});

test("vendor mismatch: a Google One charge matches the Google Play receipt (total incl. tax)", async () => {
  // The real bug Josh hit: Ramp labels the charge "Google One" but the receipt
  // arrives from Google Play. The vendor rule searches the Play sender, and the
  // charged total ($5.51 = $4.99 + $0.52 tax) is present in the body, so it matches.
  const res = await run(
    { merchant: "Google One", amountCents: 551, dateISO: chargeISO(20, 26), dateHasTime: true },
    {
      list: [{ id: "G" }],
      messages: {
        G: gmsg({
          id: "G",
          subject: "Your Google Play Order Receipt from Aug 6, 2026",
          from: "googleplay-noreply@google.com",
          internalDate: T(20, 26),
          bodyText:
            "Thank you. Google AI Pro (5 TB) (Google One) $4.99/month. State sales tax: $0.32 Local sales tax: $0.20 Total: $5.51/month",
        }),
      },
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.match.amtCents, 551, "matches the $5.51 total charged, not the $4.99 base price");
  assert.equal(res.match.memo, "Google One subscription");
});
