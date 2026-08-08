// Tests for content.js parsing/util logic — the real functions, loaded via the
// harness. These are the functions that have caused the most subtle bugs
// (glued DOM text, month abbreviations, invisible narrow spaces, thousands
// separators), so they get the heaviest coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./harness.mjs";

const contentMocks = {
  chrome: { runtime: { id: "test", getURL: (p) => p, onMessage: { addListener: () => {} } } },
  document: { body: {}, addEventListener: () => {} },
  location: { pathname: "/" },
  history: {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
};

const C = loadModule(
  "content.js",
  ["parseDate", "parseDateTime", "monthIdx", "toCents", "normWS", "AMOUNT_RE", "DATE_RE", "DATETIME_RE"],
  contentMocks
);

test("toCents: dollars/commas/whitespace", () => {
  assert.equal(C.toCents("$5.33"), 533);
  assert.equal(C.toCents("$1,234.56"), 123456);
  assert.equal(C.toCents("$ 6.45"), 645);
  assert.equal(C.toCents("191.34"), 19134);
});

test("monthIdx: 3- and 4-letter month names", () => {
  assert.equal(C.monthIdx("Aug"), 7);
  assert.equal(C.monthIdx("Sept"), 8); // 4-letter → first 3
  assert.equal(C.monthIdx("July"), 6);
  assert.equal(C.monthIdx("Xyz"), undefined);
});

test("parseDate: plain and glued-both-directions", () => {
  assert.equal(+C.parseDate("Aug 3, 2026"), +new Date(2026, 7, 3));
  // Text nodes glue together in Ramp's DOM — must still match on both sides.
  assert.equal(+C.parseDate("Virtual CardJul 28, 2026"), +new Date(2026, 6, 28));
  assert.equal(+C.parseDate("Aug 3, 2026Virtual card"), +new Date(2026, 7, 3));
  assert.equal(C.parseDate("no date here"), null);
});

test("parseDateTime: real header string with time of day", () => {
  const d = C.parseDateTime("Josh Rochon·OpenRouter·Aug 4, 2026 at 5:52 PMOptions");
  assert.equal(+d, +new Date(2026, 7, 4, 17, 52));
});

test("parseDateTime: narrow no-break space before AM/PM still parses", () => {
  // Ramp renders a U+202F (narrow no-break space) before PM.
  const d = C.parseDateTime("Aug 4, 2026 at 5:52 PM");
  assert.equal(+d, +new Date(2026, 7, 4, 17, 52));
});

test("parseDateTime: AM/12-hour edge cases", () => {
  assert.equal(+C.parseDateTime("Jan 1, 2026 at 12:00 AM"), +new Date(2026, 0, 1, 0, 0));
  assert.equal(+C.parseDateTime("Jan 1, 2026 at 12:30 PM"), +new Date(2026, 0, 1, 12, 30));
  assert.equal(+C.parseDateTime("Jan 1, 2026 at 9:05 AM"), +new Date(2026, 0, 1, 9, 5));
});

test("AMOUNT_RE: matches comma and comma-less thousands, not bare integers", () => {
  const re = () => new RegExp(C.AMOUNT_RE.source, C.AMOUNT_RE.flags.replace("g", ""));
  assert.ok(re().test("$6.45"));
  assert.ok(re().test("$1,234.56"));
  assert.ok(re().test("$1234.56"));
  assert.ok(!re().test("$1234")); // needs cents
});

test("DATE_RE: no leading word-boundary so glued text matches", () => {
  const re = () => new RegExp(C.DATE_RE.source);
  assert.ok(re().test("CardJul 28, 2026"));
  assert.ok(re().test("Aug 3, 2026"));
});
