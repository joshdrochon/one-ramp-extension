// Test harness: loads the REAL extension source (background.js / content.js) into
// a fresh VM realm with mocked browser globals, and returns the named top-level
// symbols so tests exercise the actual shipping code — not a copy.
//
// Why a VM + epilogue: the extension files are plain scripts using top-level
// `const`/`function` (browser globals), not ES modules. `const` at script top
// level doesn't attach to the global object, so we append an export epilogue in
// the same scope to capture the symbols we want.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Load a source file, exposing `exposeNames`, with `mocks` injected as globals. */
export function loadModule(relPath, exposeNames, mocks = {}) {
  const src = readFileSync(join(here, "..", relPath), "utf8");
  const epilogue = `\n;globalThis.__exports = { ${exposeNames.join(", ")} };`;

  const sandbox = {
    console,
    // Timers default to NO-OPS so top-level setInterval/observer/setTimeout in
    // content.js don't spin during load. Individual tests override as needed.
    setTimeout: (fn) => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    TextDecoder,
    atob,
    btoa,
    queueMicrotask,
    URL,
    URLSearchParams,
    ...mocks,
  };

  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox, { filename: relPath });
  return sandbox.__exports;
}

/** base64url-encode a UTF-8 string (Gmail body encoding). */
export const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

/** Build a Gmail "full" message object shaped like the API returns. */
export function gmsg({ id, subject, from, internalDate, bodyText = "" }) {
  return {
    id,
    internalDate: String(internalDate),
    snippet: bodyText.slice(0, 120),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
      ],
      body: { data: b64url(bodyText) },
    },
  };
}

/** A fetch() mock that routes Gmail list / message / judge calls from fixtures. */
export function makeFetch({ list = [], messages = {}, judge = null }) {
  return async (url) => {
    const ok = (data) => ({
      status: 200,
      ok: true,
      json: async () => data,
      text: async () => "",
      headers: { get: () => "application/json" },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    if (/\/messages\?q=/.test(url)) return ok({ messages: list });
    const m = url.match(/\/messages\/([^/?]+)\?format=full/);
    if (m) return ok(messages[m[1]] || {});
    if (/anthropic\.com|workers\.dev/.test(url))
      return ok({ content: [{ text: JSON.stringify(judge || {}) }] });
    return { status: 404, ok: false, text: async () => "", headers: { get: () => "" } };
  };
}

/** chrome mock sufficient for background.js load + findReceipt + the auth path.
 *  Seeds a "fresh" cached Gmail token so getToken() short-circuits without ever
 *  touching launchWebAuthFlow — matching tests don't care about auth. Pass
 *  `store` to override/extend the backing storage (used by the auth tests). */
export function makeChrome({ usedIds = [], store: extra = {} } = {}) {
  const badge = { text: "" };
  const store = {
    usedIds,
    gmailToken: "test-token",
    gmailTokenExp: 4102444800000, // ~year 2100 → always within skew, never "expired"
    gmailEmail: "tester@example.com",
    ...extra,
  };
  const pick = (keys) => {
    if (keys == null) return { ...store };
    const arr = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of arr) if (k in store) out[k] = store[k];
    return out;
  };
  const chrome = {
    runtime: { onMessage: { addListener: () => {} }, lastError: null, id: "test", getURL: (p) => p },
    identity: {
      getAuthToken: (_opts, cb) => cb("tok"),
      removeCachedAuthToken: (_o, cb) => cb && cb(),
      getRedirectURL: (path = "") => `https://test-ext.chromiumapp.org/${path}`,
      launchWebAuthFlow: (_opts, cb) =>
        cb("https://test-ext.chromiumapp.org/#access_token=flow-token&expires_in=3600&token_type=Bearer"),
    },
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (patch) => { Object.assign(store, patch); },
        remove: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete store[k];
        },
      },
    },
    action: {
      getBadgeText: async () => badge.text,
      setBadgeText: async ({ text }) => (badge.text = text),
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
    },
    __store: store, // exposed so auth tests can assert on stored identity
  };
  return chrome;
}
