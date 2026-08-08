// Tests for the panel state machine — specifically the `busy` lock that gates
// whether navigation re-renders the panel. This is the area of the "stuck
// during verification" bug.
//
// Two layers:
//  1. REAL-code test of the gating mechanism: flowActive() must report busy.
//  2. An executable CONTRACT for the attach → verify → navigate sequence, which
//     mirrors content.js's #or-attach onclick + watchVerification + the SPA-nav
//     guard. It documents the current bug and defines the target behavior the
//     fix must satisfy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./harness.mjs";

const contentMocks = {
  chrome: { runtime: { id: "test", getURL: (p) => p, onMessage: { addListener: () => {} } } },
  document: { body: {}, addEventListener: () => {}, activeElement: null },
  location: { pathname: "/" },
  history: {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
};

// Expose flowActive plus closures over the real `busy` binding (defined inline
// in the export epilogue, so they capture the module's actual variable).
const C = loadModule(
  "content.js",
  ["flowActive", "getBusy: () => busy", "setBusy: (v) => { busy = v; }", "setVerifying: (v) => { verifying = v; }"],
  contentMocks
);

test("REAL: flowActive() reports true while busy — this is what gates navigation", () => {
  C.setBusy(true);
  assert.equal(C.flowActive(), true, "busy must make flowActive() true (nav/tick re-render is skipped)");
  C.setBusy(false);
  assert.equal(!!C.flowActive(), false, "idle with no panel → not active");
});

test("REAL: flowActive() reports true while verifying — protects the post-attach watch", () => {
  // The fix releases busy before the passive verify watch, so `verifying` is what
  // now stops a same-page background scan from clobbering the "verifying…" toast.
  C.setVerifying(true);
  assert.equal(C.flowActive(), true, "the verifying guard keeps same-page scans from overwriting the watch's narration");
  C.setVerifying(false);
  assert.equal(!!C.flowActive(), false, "idle again once verification ends");
});

// --- Contract model of the attach → verify → navigate sequence -------------
// Mirrors content.js:
//   onclick:  busy = true; ...attach...; await watchVerification(); finally busy=false
//   nav-guard: if (!busy) render()          (SPA-nav interval)
// `holdBusyDuringVerify` = true reproduces the SHIPPING code; false is the fix.
async function attachSequence({ holdBusyDuringVerify }) {
  let busy = false;
  let renderedDuringVerify = false;
  let verifyResolve;
  const verificationDone = new Promise((r) => (verifyResolve = r));

  // The SPA-nav guard: navigation only re-renders when not busy.
  const navigate = () => {
    if (!busy) renderedDuringVerify = true;
  };

  // The onclick flow.
  const flow = (async () => {
    busy = true; // attach begins
    // ...attachReceipt + writeMemo happen here (synchronous for the model)...
    if (!holdBusyDuringVerify) busy = false; // FIX: release before passive watch
    try {
      await verificationDone; // stand-in for watchVerification()'s long poll
    } finally {
      busy = false;
    }
  })();

  // While "verification" is in flight, the user navigates away.
  await Promise.resolve();
  navigate();
  verifyResolve();
  await flow;
  return renderedDuringVerify;
}

test("CONTRACT: shipping code holds busy during verification → navigation is ignored (the bug)", async () => {
  const rendered = await attachSequence({ holdBusyDuringVerify: true });
  assert.equal(rendered, false, "documents the bug: nav during verify does nothing while busy is held");
});

test("CONTRACT: the fix releases busy for the passive watch → navigation re-renders", async () => {
  const rendered = await attachSequence({ holdBusyDuringVerify: false });
  assert.equal(rendered, true, "target: user can navigate away while Ramp verifies");
});
