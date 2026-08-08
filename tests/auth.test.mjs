// Tests for the launchWebAuthFlow-based Gmail auth — the REAL background.js
// functions: OAuth URL construction, redirect parsing, and the token cache
// (fresh / expired / cleared). This locks in the account-picker + sign-out
// behavior so a future change can't silently break "switch to a different inbox."

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, makeChrome } from "./harness.mjs";

function loadAuth(chrome) {
  return loadModule(
    "background.js",
    ["authUrl", "parseTokenFromRedirect", "storedToken", "saveToken", "clearToken", "getToken"],
    { chrome, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }
  );
}

test("authUrl: implicit flow to the WEB client, gmail scope, picker + login hint", () => {
  const A = loadAuth(makeChrome({}));
  const url = A.authUrl({ prompt: "select_account", loginHint: "koby@gmail.com" });
  assert.match(url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(url, /response_type=token/, "implicit flow → no client secret ships");
  assert.match(url, /client_id=607338298511-ia1oed8i2m28v1g9ensg73shlc9bs0ed/, "the NEW web client, not the extension client");
  assert.match(url, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fgmail\.readonly/);
  assert.match(url, /redirect_uri=https%3A%2F%2Ftest-ext\.chromiumapp\.org%2F/);
  assert.match(url, /prompt=select_account/, "explicit connect forces the account chooser");
  assert.match(url, /login_hint=koby%40gmail\.com/);
});

test("authUrl: no prompt / login_hint params when omitted (a silent re-mint)", () => {
  const A = loadAuth(makeChrome({}));
  const url = A.authUrl();
  assert.ok(!/[?&]prompt=/.test(url), "a silent mint must not force a UI prompt");
  assert.ok(!/login_hint=/.test(url));
});

test("parseTokenFromRedirect: reads token + ~1h expiry from the URL fragment", () => {
  const A = loadAuth(makeChrome({}));
  const before = Date.now();
  const { token, expiresAt } = A.parseTokenFromRedirect(
    "https://x.chromiumapp.org/#access_token=abc123&expires_in=3600&token_type=Bearer"
  );
  assert.equal(token, "abc123");
  assert.ok(expiresAt > before + 3599 * 1000, "expiry is ~1h in the future");
  assert.ok(expiresAt <= Date.now() + 3600 * 1000 + 5);
});

test("parseTokenFromRedirect: throws on a denied / error redirect", () => {
  const A = loadAuth(makeChrome({}));
  assert.throws(
    () => A.parseTokenFromRedirect("https://x.chromiumapp.org/#error=access_denied"),
    /access_denied/,
    "a user who cancels the picker must surface as an error, not a silent success"
  );
});

test("token cache: fresh returned, expired ignored, disconnect wipes identity", async () => {
  const chrome = makeChrome({});
  const A = loadAuth(chrome);
  assert.equal(await A.storedToken(), "test-token", "seeded fresh token is usable");

  await A.saveToken("stale", Date.now() - 1000);
  assert.equal(await A.storedToken(), null, "an expired token must never be handed out");

  await A.saveToken("good", Date.now() + 3600 * 1000, "koby@gmail.com");
  assert.equal(await A.storedToken(), "good");
  assert.equal(chrome.__store.gmailEmail, "koby@gmail.com", "the account persists alongside the token");

  await A.clearToken();
  assert.equal(await A.storedToken(), null);
  assert.equal(chrome.__store.gmailEmail, undefined, "disconnect forgets the account (full sign-out)");
});

test("getToken: silently re-mints via launchWebAuthFlow when the cache is empty", async () => {
  const chrome = makeChrome({});
  const A = loadAuth(chrome);
  await A.clearToken(); // force a cold cache
  const tok = await A.getToken(false);
  assert.equal(tok, "flow-token", "returns the token minted by the (mocked) web auth flow");
  assert.equal(await A.storedToken(), "flow-token", "and caches it for next time");
});
