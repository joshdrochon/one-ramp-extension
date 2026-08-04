/**
 * One Ramp — content script for app.ramp.com.
 * Detects unverified charges, shows the panel, and — only on the user's
 * click — attaches the receipt file and memo through the page itself.
 *
 * v1 reads the DOM (resilient text/semantics selectors, no hashed classes).
 * README documents the internal-API upgrade path for fully API-based reads.
 */

// ------------------------------------------------------------- utilities ----
const log = (...a) => console.log("[OneRamp]", ...a);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const AMOUNT_RE = /\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/;
// No trailing \b: body.textContent glues elements together ("2026Virtual card",
// "PMOptions"), and a word boundary can never exist between two word chars —
// it made these patterns structurally unmatchable on real pages.
const DATE_RE = /([A-Z][a-z]{2,3}) (\d{1,2}), (\d{4})/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const monthIdx = (s) => MONTHS[s.slice(0, 3)]; // "Sept"/"July" → first three letters

// Ramp renders times with narrow no-break spaces (U+202F etc.) that look like
// spaces but aren't — normalize before any date parsing or they silently miss.
const normWS = (t) => (t || "").replace(/[\u00A0\u202F\u2009]/g, " ");
const parseDate = (text) => {
  const m = normWS(text).match(DATE_RE);
  return m && monthIdx(m[1]) != null ? new Date(m[3], monthIdx(m[1]), m[2]) : null;
};
// "Aug 3, 2026 at 4:02 PM" — the time of day matters: same-amount receipts on
// consecutive days are ranked by proximity, and midnight-truncation can make
// yesterday evening look closer than this afternoon.
const DATETIME_RE = /([A-Z][a-z]{2,3}) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM)/;
const parseDateTime = (text) => {
  const m = normWS(text).match(DATETIME_RE);
  if (!m || monthIdx(m[1]) == null) return null;
  let h = parseInt(m[4], 10) % 12;
  if (m[6] === "PM") h += 12;
  return new Date(m[3], monthIdx(m[1]), m[2], h, parseInt(m[5], 10));
};
const toCents = (s) => Math.round(parseFloat(s.replace(/[$,\s]/g, "")) * 100);

function findByText(re, root = document, tag = "*") {
  return $$(tag, root).find(
    (el) => re.test(el.textContent || "") && el.children.length === 0
  );
}

// --------------------------------------------------------------- panel ------
let panel;
let busy = false; // true while a find/attach flow is mid-flight
let lastToast = "";
let checkingStreak = 0; // canary: consecutive scans that recognized nothing
function ensurePanel() {
  if (panel && document.contains(panel)) return panel;
  lastToast = ""; // fresh panel: don't let the de-dupe guard suppress the first write
  panel = document.createElement("div");
  panel.id = "one-ramp-panel";
  const logo = chrome.runtime.getURL("icons/icon-32.png");
  panel.innerHTML = `<button class="or-chipbtn" title="One Ramp"><img src="${logo}" alt="One Ramp"/></button><div class="or-head"><span class="or-title"><img src="${logo}" alt="" class="or-logo"/> One Ramp</span> <button class="or-min" title="minimize">–</button></div><div class="or-body"></div>`;
  document.body.appendChild(panel);
  $(".or-min", panel).onclick = () => setMode("chip");
  $(".or-chipbtn", panel).onclick = () => setMode("open");
  return panel;
}

// Presence = relevance: a tiny chip when idle, the full panel when there's
// work or an active flow, and auto-collapse shortly after a success.
let collapseTimer = null;
// Off the detail page (list/home) Ramp's own FOB owns the bottom-right corner,
// so we sit to its LEFT. On an expense detail page that FOB is gone, so we slide
// sideways into the corner. The .or-detail-pos class (added only on detail pages)
// + a CSS transition on `right` produce the horizontal slide. See ui.css.
const onDetailPage = () => /\/details\/my-expenses\//.test(location.pathname);
function positionPanel() {
  if (panel) panel.classList.toggle("or-detail-pos", onDetailPage());
}
function setMode(mode) {
  ensurePanel();
  panel.classList.toggle("or-chip", mode === "chip");
  positionPanel(); // apply left/corner placement on every mode change
}
function collapseSoon(ms = 8000) {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (!flowActive()) setMode("chip");
  }, ms);
}
const setBody = (html) => {
  ensurePanel();
  const body = $(".or-body", panel);
  if (html === lastToast) return body; // identical content: keep DOM + handlers
  lastToast = html;
  body.innerHTML = html;
  return body;
};
const toast = (msg, cls = "") => setBody(`<div class="or-note ${cls}">${msg}</div>`);
const bindBack = () => {
  const a = $("#or-back", panel);
  if (a && !a._bound) {
    a._bound = true;
    a.onclick = (e) => {
      e.preventDefault();
      history.back();
    };
  }
};

// ------------------------------------------------------------- detection ----
/**
 * On the expense detail page, read what's missing from what Ramp literally
 * says. The tab title is "Merchant — $X.XX — Ramp" and required items render
 * as the exact strings "Add a memo (required)" / "Upload a receipt (required)"
 * — plain text survives redesigns far better than tag structure does.
 */
function detailState() {
  if (!/\/details\/my-expenses\//.test(location.pathname)) return null;
  const t = document.title.match(/^(.+?) — \$([\d,.]+) — Ramp/);
  if (!t) return null;
  const body = document.body.textContent;
  const dt = parseDateTime(body);
  return {
    merchant: t[1].trim(),
    amountCents: toCents("$" + t[2]),
    date: dt || parseDate(body) || new Date(),
    dateHasTime: !!dt, // honest precision: day-only dates get treated as such downstream
    hasReceipt: !body.includes("Upload a receipt (required)"),
    hasMemo: !body.includes("Add a memo (required)"),
  };
}

/**
 * On the list page, find unverified charges by anchoring on Ramp's own
 * "Missing items" status text and climbing to the enclosing row — zero
 * assumptions about tags or table structure.
 */
function listUnverified() {
  if (!/personal-expenses\/all/.test(location.pathname)) return [];
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!/Missing items/.test(node.textContent)) continue;
    if (panel && panel.contains(node.parentElement)) continue; // never read our own panel
    const clickEl = node.parentElement; // the status cell — inside the clickable row area
    let el = clickEl;
    let row = null;
    for (let i = 0; el && el !== document.body && i < 8; i++) {
      if (AMOUNT_RE.test(el.textContent) && DATE_RE.test(el.textContent)) {
        row = el;
        break;
      }
      el = el.parentElement;
    }
    const anchor = row || clickEl;
    if (!out.some((o) => o.anchor === anchor || o.anchor.contains(anchor) || anchor.contains(o.anchor))) {
      const lines = row ? (row.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean) : [];
      const amt = row ? (row.textContent.match(AMOUNT_RE) || [])[0] : null;
      out.push({
        anchor,
        clickEl,
        merchant: row ? lines[0] || "expense" : null,
        amountCents: amt ? toCents(amt) : 0,
        date: row ? parseDate(row.textContent) || new Date() : null,
      });
    }
  }
  return out;
}

const fmtCents = (c) => `$${(c / 100).toFixed(2)}`;

/** Top-level flow: open the expense from the list, then run the hunt there. */
async function verifyFromList(u, idx = 0) {
  // Ramp may have re-rendered since this card was drawn; re-find the live
  // entry if ours went stale.
  if (!document.contains(u.clickEl)) {
    // Prefer matching by identity (merchant + amount) over list position —
    // rows can be reordered by a newly streamed-in charge between draw and click.
    const list = listUnverified();
    u = list.find((x) => x.merchant === u.merchant && x.amountCents === u.amountCents) || list[idx] || u;
  }
  busy = true;
  lastToast = ""; // force fresh panel writes
  setMode("open");
  clearTimeout(collapseTimer);
  toast(`Opening ${u.merchant ? `<b>${esc(u.merchant)}</b>` : "the expense"}…`);
  u.clickEl.click();
  let state = null;
  for (let i = 0; i < 20 && !state; i++) {
    await new Promise((r) => setTimeout(r, 500));
    state = detailState();
    if (!state && i === 4) u.clickEl.click(); // sometimes needs a second click
  }
  if (!state) {
    busy = false;
    toast("Couldn't open the expense. Click it manually and I'll take over.", "or-warn");
    return;
  }
  if (state.hasReceipt && state.hasMemo) {
    // The list flagged this charge but the detail reads complete — either
    // Ramp just caught up, or their UI changed and our anchors are stale.
    busy = false;
    toast(
      "The list flagged this charge but the detail looks complete. If this keeps happening, Ramp may have changed their UI and One Ramp needs an update 🛠",
      "or-warn"
    );
    return;
  }
  runFindFlow(state);
}

// ------------------------------------------------------------ page writes ---
/** Set a React-controlled input's value so the page's state actually updates. */
function setReactValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function attachReceipt(file) {
  const input = $('input[type="file"]');
  log("attachReceipt: file input", input ? "found" : "MISSING", "| uploading", file.filename, file.mime);
  if (!input) throw new Error("No file input found on this page. Open the expense first.");
  const bytes = Uint8Array.from(atob(file.dataB64), (c) => c.charCodeAt(0));
  const f = new File([bytes], file.filename, { type: file.mime });
  const dt = new DataTransfer();
  dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function writeMemo(memo) {
  // Open the memo editor by clicking Ramp's own "Add a memo (required)"
  // control — whatever tag it happens to be. Take the innermost small
  // element containing that text, and click its nearest clickable wrapper.
  const candidates = [...document.querySelectorAll("*")].filter(
    (el) =>
      el.childElementCount <= 2 &&
      /Add a memo/i.test(el.textContent || "") &&
      (el.textContent || "").trim().length < 40 &&
      !(panel && panel.contains(el))
  );
  const inner = candidates[candidates.length - 1];
  const opener =
    inner?.closest('a, button, [role="button"], [tabindex]') ||
    inner ||
    (() => {
      const lbl = findByText(/^Memo/, document, "*");
      const row = lbl?.closest("div")?.parentElement;
      return row?.querySelector('button, a, [role="button"]');
    })();
  log("writeMemo: opener", opener ? `<${opener.tagName.toLowerCase()}> "${(opener.textContent || "").trim().slice(0, 40)}"` : "MISSING");
  if (opener) opener.click();
  await new Promise((r) => setTimeout(r, 700));
  // The editor focuses its field on open — trust the focused element first.
  // Never write into a search box (Ramp's global "Search for anything" is a
  // text input too — typing the memo there + Enter would navigate away).
  const isSearch = (el) =>
    !el ||
    /search/i.test(
      (el.getAttribute && (el.getAttribute("placeholder") || "") + (el.getAttribute("aria-label") || "")) +
        (el.type || "")
    );
  const active = document.activeElement;
  const field =
    active && /^(TEXTAREA|INPUT)$/.test(active.tagName) && !(panel && panel.contains(active)) && !isSearch(active)
      ? active
      : $("textarea") ||
        $$('input[type="text"], input:not([type])').find(
          (i) => !isSearch(i) && i.closest("div")?.textContent.includes("Memo")
        ) ||
        $$('input[type="text"], input:not([type])').find((i) => !isSearch(i));
  log("writeMemo: field", field ? `<${field.tagName.toLowerCase()}>` : "MISSING", "| active was", document.activeElement?.tagName);
  if (!field) throw new Error("Couldn't find the memo field. Add it manually this time 🙏");
  setReactValue(field, memo);
  await new Promise((r) => setTimeout(r, 250));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  field.dispatchEvent(new FocusEvent("blur", { bubbles: true })); // commit on blur if Enter didn't
  // Only click a Save/Done control that lives INSIDE the memo editor's own
  // dialog/menu — a document-wide button search could submit an unrelated form.
  const scope = field.closest('[role="dialog"], [role="menu"], form');
  const save = scope && [...scope.querySelectorAll("button")].find((b) => /^(Save|Done)$/i.test(b.textContent.trim()));
  if (save) save.click();
}

/** Narrate Ramp's own verification pipeline after we attach. */
async function watchVerification() {
  toast("Attached ✓ Ramp is verifying your receipt ⏳ (takes ~a minute)", "or-ok");
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (/Auto-verified/i.test(document.body.textContent)) {
      toast('Auto-verified by Ramp 🎉<div class="or-linkrow"><a href="#" id="or-back">← Back to expenses</a></div>', "or-ok");
      bindBack();
      collapseSoon(10000);
      return;
    }
  }
  toast('Receipt attached ✓ Ramp is still verifying.<div class="or-linkrow"><a href="#" id="or-back">← Back to expenses</a></div>', "or-ok");
  bindBack();
  collapseSoon(10000);
}

// ----------------------------------------------------------------- flow -----
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function runFindFlow(state) {
  busy = true;
  // Contract check before anything leaves this page: no hunt on garbage.
  if (!state.merchant || !(state.amountCents > 0) || !(state.date instanceof Date) || isNaN(+state.date)) {
    busy = false;
    log("charge FAILED validation:", state);
    toast("Couldn't read this charge cleanly. Open the console (filter: OneRamp) and screenshot it 🛠", "or-warn");
    return;
  }
  log("find flow start:", state.merchant, state.amountCents, state.date, "hasTime:", state.dateHasTime);
  toast(`Hunting your <b>${esc(state.merchant)}</b> receipt 🔎`);
  const res = await chrome.runtime.sendMessage({
    type: "FIND_RECEIPT",
    merchant: state.merchant,
    amountCents: state.amountCents,
    dateISO: state.date.toISOString(),
    dateHasTime: !!state.dateHasTime,
  });
  if (!res?.ok) {
    busy = false;
    toast(
      `${esc(res?.error || "Search failed.")}<br><button class="or-btn" id="or-retry">Retry</button>`,
      "or-warn"
    );
    $("#or-retry").onclick = () => runFindFlow(state);
    return;
  }
  const { match, confident, alternates } = res;
  log("match:", match.subject, "score", match.score, "reasons", match.reasons, "file", match.file?.source || match.file?.manualLink || "none", "ai", match.aiRationale || "n/a");
  showMatchCard(state, match, confident, alternates || []);
}

function showMatchCard(state, match, confident, alternates) {
  const needs = [];
  if (!state.hasReceipt) needs.push("receipt");
  if (!state.hasMemo) needs.push("memo");
  // Keep the card in user language: amount, vendor, date and time. The
  // engineering detail (score, sender, reasons, file source) lives in the log.
  log("card:", match.subject, "| from", match.from, "| score", match.score, "| reasons", match.reasons, "| file", match.file?.source || match.file?.manualLink || "none");
  const fileWarn = match.file?.dataB64
    ? ""
    : match.file?.manualLink
    ? `<div class="or-dim">Couldn't auto-download the file. <a href="${esc(match.file.manualLink)}" target="_blank" rel="noopener noreferrer">Open the receipt</a>, save it, and drag it onto Ramp's upload box.</div>`
    : `<div class="or-dim">No receipt file found in that email.</div>`;
  const body = setBody(`
    <div class="or-card ${confident ? "" : "or-warn"}">
      <div><b>${confident ? "Match found" : "Possible match"}</b></div>
      <div class="or-big">${match.amtCents ? fmtCents(match.amtCents) + " · " : ""}${esc(state.merchant)} · ${esc(match.date)}</div>
      ${match.receiptNo ? `<div class="or-dim">Receipt #${esc(match.receiptNo)}</div>` : ""}
      ${match.aiRationale ? `<div class="or-dim">🧠 ${esc(match.aiRationale.slice(0, 140))}${match.aiRationale.length > 140 ? "…" : ""}</div>` : ""}
      ${fileWarn}
      <label>Memo</label><input id="or-memo" value="${esc(match.memo)}"/>
      <button class="or-btn or-primary" id="or-attach">Attach ${needs.join(" + ") || "receipt + memo"}</button>
      ${alternates?.length ? `<div class="or-dim" style="margin-top:6px">Not it? Pick the right one:</div>${alternates
        .map((a, j) => {
          // Every option should say what it IS: amount + time + receipt #
          // when we have them, otherwise fall back to the email's subject.
          const label =
            a.amtCents || a.receiptNo
              ? [a.amtCents ? fmtCents(a.amtCents) : null, esc(a.date), a.receiptNo ? "#" + esc(a.receiptNo) : null]
                  .filter(Boolean)
                  .join(" · ")
              : `${esc(a.date)} · ${esc(a.subject.slice(0, 32))}`;
          return `<button class="or-btn or-alt" data-j="${j}">${label}</button>`;
        })
        .join("")}` : ""}
    </div>`);
  $$(".or-alt", body).forEach((btn) => {
    btn.onclick = async () => {
      const alt = alternates[Number(btn.dataset.j)];
      busy = true;
      lastToast = "";
      toast(`Fetching that receipt${alt.receiptNo ? " (#" + esc(alt.receiptNo) + ")" : ""}…`);
      const f = await chrome.runtime.sendMessage({ type: "FETCH_FILE", messageId: alt.id });
      busy = false;
      const newAlts = [match, ...alternates.filter((a) => a !== alt)];
      showMatchCard(state, { ...alt, file: f?.ok ? f.file : null, memo: match.memo }, false, newAlts);
    };
  });
  $("#or-attach", body).onclick = async () => {
    busy = true;
    try {
      // Guard against writing to the wrong charge: if the user navigated to a
      // different expense while this card sat open, the visible page no longer
      // matches what we matched — abort rather than attach to the wrong one.
      const now = detailState();
      if (!now || now.amountCents !== state.amountCents) {
        toast("This looks like a different charge now — reopen it and press Verify again.", "or-warn");
        return;
      }
      const memoValue = $("#or-memo")?.value || match.memo;
      toast("Attaching…");
      if (!state.hasReceipt && match.file?.dataB64) await attachReceipt(match.file);
      if (!state.hasMemo) await writeMemo(memoValue);
      try {
        chrome.runtime.sendMessage({ type: "RECORD_ATTACHED", messageId: match.id });
        chrome.runtime.sendMessage({ type: "BADGE_ADJUST", delta: -1 }); // one fewer outstanding
      } catch (_) {}
      await watchVerification();
    } catch (e) {
      toast(`Partial attach: ${esc(e.message)}`, "or-warn");
    } finally {
      busy = false;
    }
  };
  // The card is now the resting state; release busy so a real page navigation
  // can refresh it. flowActive() still protects it via the #or-attach check,
  // so background mutations won't clobber it.
  busy = false;
}

// ---------------------------------------------------------------- render ----
function render() {
  if (!(globalThis.chrome && chrome.runtime && chrome.runtime.id)) return; // orphaned
  const detail = detailState();
  if (detail) {
    if (detail.hasReceipt && detail.hasMemo) {
      toast(
        `This ${fmtCents(detail.amountCents)} ${esc(detail.merchant)} charge is fully verified ✓<div class="or-linkrow"><a href="#" id="or-back">← Back to expenses</a></div>`,
        "or-ok"
      );
      bindBack();
      collapseSoon(6000);
      return;
    }
    const missing = [!detail.hasReceipt && "receipt", !detail.hasMemo && "memo"].filter(Boolean).join(" and ");
    log("detail state:", detail);
    setMode("open");
    clearTimeout(collapseTimer);
    const btnLabel = detail.hasReceipt && !detail.hasMemo ? "Draft the memo ✍️" : "Find receipt in Gmail 🔎";
    const b = setBody(`
      <div class="or-card">
        <div><b>${esc(detail.merchant)}</b> needs a ${missing} 🧾</div>
        <button class="or-btn or-primary" id="or-find">${btnLabel}</button>
      </div>`);
    $("#or-find", b).onclick = () => runFindFlow(detail);
    return;
  }
  if (!/personal-expenses\/all/.test(location.pathname)) {
    // Some other Ramp page (settings, insights, a closed drawer): nothing to
    // do here — don't leave a stale card from a previous page lying around.
    if (!flowActive()) setMode("chip");
    return;
  }
  {
    const un = listUnverified();
    const badgeCount =
      un.length || (document.body.textContent.match(/Missing items/g) || []).length;
    try {
      chrome.runtime.sendMessage({ type: "BADGE", count: badgeCount });
    } catch (_) {}
    if (un.length) {
      checkingStreak = 0;
      // One card per unverified charge, verifiable straight from the list.
      setMode("open");
      clearTimeout(collapseTimer);
      const b = setBody(
        un
          .slice(0, 5)
          .map(
            (u, i) => `
        <div class="or-card">
          <div>${u.merchant ? `<b>${esc(u.merchant)}</b> ${fmtCents(u.amountCents)}` : "Unverified expense"} · needs verification</div>
          <button class="or-btn or-primary or-verify" data-i="${i}">Verify ⚡</button>
        </div>`
          )
          .join("")
      );
      $$(".or-verify", b).forEach((btn) => {
        btn.onclick = () => verifyFromList(un[Number(btn.dataset.i)], Number(btn.dataset.i));
      });
    } else {
      const bodyText = document.body.textContent;
      const missingCount = (bodyText.match(/Missing items/g) || []).length;
      if (missingCount) {
        // Row-climb failed but the status text exists: degrade gracefully.
        setMode("open");
        toast(
          missingCount === 1
            ? "1 expense needs a receipt. Click it 🧾"
            : `${missingCount} expenses need receipts. Click one 🧾`
        );
      } else if (bodyText.includes("Fully approved")) {
        checkingStreak = 0;
        toast("Everything's approved 🎉", "or-ok");
        setMode("chip"); // nothing to do: get out of the way
      } else {
        // Table hasn't painted yet — stay quiet instead of flashing states.
        // But if the anchors NEVER show up, Ramp's UI may have changed out
        // from under us: say so loudly rather than failing silent (canary).
        checkingStreak++;
        if (checkingStreak >= 8) {
          setMode("open");
          toast(
            "I can't read this page anymore. Ramp may have updated their UI, which means One Ramp needs an update 🛠",
            "or-warn"
          );
        } else {
          toast("Checking your expenses 👀");
          setMode("chip");
        }
      }
    }
  }
}

// Watch SPA navigation. A real path change should refresh even a resting card
// (it belongs to the old page) — but never interrupt an in-flight hunt/attach.
let lastPath = "";
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    setTimeout(() => {
      if (!busy) render();
    }, 1500); // let the SPA paint
  }
}, 800);

// Never clobber a flow the user is in the middle of.
const flowActive = () =>
  busy ||
  (panel &&
    ($("#or-attach", panel) ||
      $("#or-retry", panel) ||
      (panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT")));

// When the extension is reloaded, this copy of the script is orphaned and
// chrome.runtime disappears. Go silent instead of spraying errors — the
// freshly injected copy takes over on the next page refresh.
const alive = () => !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

// Re-scan whenever the page actually changes: Ramp paints its tables late and
// streams new charges into open pages, so a mutation observer (debounced)
// beats any timer. The 30s interval stays as a backstop.
let moTimer = null;
const observer = new MutationObserver(() => {
  if (!alive()) return observer.disconnect();
  if (moTimer) return;
  moTimer = setTimeout(() => {
    moTimer = null;
    if (!flowActive()) render();
  }, 1200);
});
observer.observe(document.body, { childList: true, subtree: true });

const tick = setInterval(() => {
  if (!alive()) return clearInterval(tick);
  if (!flowActive()) render();
}, 30000);

// Yield to Ramp's own UI: when any open menu/dialog/popover overlaps our
// footprint, fade out (clicks pass through) and fade back when it closes.
function overlayIntersects() {
  if (!panel || !document.contains(panel)) return false;
  const r = panel.getBoundingClientRect();
  return $$('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]').some((el) => {
    if (panel.contains(el)) return false;
    const o = el.getBoundingClientRect();
    return (
      o.width > 0 &&
      o.height > 0 &&
      !(o.right < r.left || o.left > r.right || o.bottom < r.top || o.top > r.bottom)
    );
  });
}
const fadeTick = setInterval(() => {
  if (!alive()) return clearInterval(fadeTick);
  positionPanel(); // keep the left/corner slide in sync with SPA navigation
  if (panel && !busy) panel.classList.toggle("or-hidden", overlayIntersects());
}, 300);

setTimeout(() => {
  if (alive()) render();
}, 2500);
