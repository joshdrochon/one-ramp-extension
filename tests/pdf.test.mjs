// Tests for the dependency-free receipt-PDF generator and the getReceiptFile
// fallback that uses it — the REAL background.js code. This locks in the "inline
// HTML receipt with no attachment still yields a file" behavior (Google Play, etc.).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, makeChrome, gmsg } from "./harness.mjs";

const B = loadModule(
  "background.js",
  ["buildReceiptPdf", "pdfSanitize", "pdfWrap", "getReceiptFile"],
  { chrome: makeChrome({}), fetch: async () => ({ ok: false }) }
);

const decode = (b64) => Buffer.from(b64, "base64").toString("latin1");

test("buildReceiptPdf: emits a valid single-font PDF containing the text", () => {
  const pdf = decode(B.buildReceiptPdf("Hello receipt\nTotal: $5.51"));
  assert.ok(pdf.startsWith("%PDF-1.4"), "has a PDF header");
  assert.ok(pdf.trimEnd().endsWith("%%EOF"), "has an EOF marker");
  assert.match(pdf, /\/Type \/Catalog/);
  assert.match(pdf, /BaseFont \/Courier/);
  assert.match(pdf, /\(Hello receipt\) Tj/);
  assert.match(pdf, /\(Total: \$5\.51\) Tj/);
  assert.match(pdf, /startxref\n\d+\n%%EOF/, "has an xref pointer");
});

test("buildReceiptPdf: escapes PDF-special characters ( ) and backslash", () => {
  const pdf = decode(B.buildReceiptPdf("a (b) c \\ d"));
  assert.match(pdf, /\(a \\\(b\\\) c \\\\ d\) Tj/);
});

test("pdfSanitize: output is printable ASCII only (drops control + non-ASCII)", () => {
  const out = B.pdfSanitize("AB—CéD\tE\r");
  assert.ok(!/[^\x20-\x7E\n]/.test(out), "only printable ASCII + newlines survive");
  for (const ch of ["A", "B", "C", "D", "E"]) assert.ok(out.includes(ch), `keeps ${ch}`);
});

test("pdfWrap: wraps long lines to the width, keeps short ones intact", () => {
  const lines = B.pdfWrap("short\n" + "x".repeat(200), 84);
  assert.equal(lines[0], "short");
  assert.ok(lines.slice(1).every((l) => l.length <= 84), "no wrapped line exceeds width");
  assert.ok(lines.length >= 3, "the 200-char line wrapped onto multiple lines");
});

test("getReceiptFile: an inline receipt with no attachment generates a PDF", async () => {
  const msg = gmsg({
    id: "R",
    subject: "Your Google Play Order Receipt from Aug 6, 2026",
    from: "googleplay-noreply@google.com",
    internalDate: Date.UTC(2026, 7, 6, 20, 26),
    bodyText: "Google AI Pro (Google One). Total: $5.51. Order number: SOP.3375-1860.",
  });
  const file = await B.getReceiptFile("tok", msg, ""); // no attachment, no Stripe link
  assert.equal(file.source, "generated");
  assert.equal(file.mime, "application/pdf");
  assert.ok(file.dataB64 && file.dataB64.length > 100, "carries PDF bytes");
  const pdf = decode(file.dataB64);
  assert.ok(pdf.startsWith("%PDF"), "is a real PDF");
  assert.match(pdf, /Total: \$5\.51/, "includes the receipt total");
  assert.match(pdf, /Google Play Order Receipt/, "includes the subject header");
});
