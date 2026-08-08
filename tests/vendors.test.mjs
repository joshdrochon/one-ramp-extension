// Tests for vendor-rule resolution, the merchant cleaner, and memo selection —
// the REAL background.js constants/helpers. These lock in the fix for the
// "Ramp says 'Google One' but the receipt is from Google Play" class of misses,
// and guard against a rule accidentally hijacking a different-billing vendor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, makeChrome } from "./harness.mjs";

const B = loadModule(
  "background.js",
  ["VENDORS", "cleanMerchant", "GENERIC_QUERY", "memoFor"],
  { chrome: makeChrome({}), fetch: async () => ({ ok: false }) }
);
const ruleFor = (merchant) => B.VENDORS.find((v) => v.match.test(merchant)) || null;

test("Google One resolves to the Google Play sender, not the merchant name", () => {
  const rule = ruleFor("Google One");
  assert.ok(rule, "a rule should match 'Google One'");
  assert.match(rule.query, /googleplay-noreply@google\.com/);
});

test("Google Play card descriptor (with g.co/helppay) also resolves to the Play rule", () => {
  const rule = ruleFor("GOOGLE *Google One g.co/helppay# CA");
  assert.ok(rule);
  assert.match(rule.query, /googleplay/);
});

test("Google Cloud / Ads / Workspace must NOT hijack the Play rule (they bill separately)", () => {
  assert.equal(ruleFor("Google Cloud"), null);
  assert.equal(ruleFor("Google Ads"), null);
  assert.equal(ruleFor("Google Workspace"), null);
});

test("Apple App Store bill (APPLE.COM/BILL) resolves to the Apple sender", () => {
  const rule = ruleFor("APPLE.COM/BILL");
  assert.ok(rule);
  assert.match(rule.query, /apple\.com/);
});

test("Figma resolves to figma.com", () => {
  assert.match(ruleFor("Figma").query, /figma\.com/);
});

test("cleanMerchant strips card-statement cruft", () => {
  assert.equal(B.cleanMerchant("GOOGLE *Google One g.co/helppay# CA"), "GOOGLE Google One CA");
  assert.equal(B.cleanMerchant("OpenRouter, Inc"), "OpenRouter");
  assert.equal(B.cleanMerchant("Figma"), "Figma");
});

test("GENERIC_QUERY uses the cleaned merchant and broadened terms (no strict quoting)", () => {
  const q = B.GENERIC_QUERY("GOOGLE *SomeSaaS g.co/helppay#");
  assert.match(q, /GOOGLE SomeSaaS/);
  assert.match(q, /subscription/);
  assert.ok(!/"/.test(q), "generic query should not exact-phrase the messy descriptor");
});

test("memoFor: function memo uses the cleaned merchant; string memo passes through", () => {
  assert.equal(B.memoFor(ruleFor("Google One"), "GOOGLE *Google One g.co/helppay#"), "GOOGLE Google One subscription");
  assert.equal(B.memoFor(ruleFor("Figma"), "Figma"), "Figma subscription");
  assert.equal(B.memoFor(ruleFor("Anthropic"), "Anthropic"), "Claude subscription / API credits");
  assert.equal(B.memoFor(null, "Whatever"), null);
});
