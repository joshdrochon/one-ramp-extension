/**
 * One Ramp — background service worker.
 * Owns: Gmail OAuth (chrome.identity), Gmail API calls, receipt-file retrieval,
 * and the matching engine. The content script asks; this worker answers.
 * Nothing here ever writes to Ramp — writes happen in the page, on user click.
 */

const log = (...a) => console.log("[OneRamp]", ...a);

// ---------------------------------------------------------------- vendors ---
// Per-vendor search patterns and memo templates. Extend freely.
const VENDORS = [
  {
    match: /anthropic/i,
    query: 'from:mail.anthropic.com',
    memo: "Claude subscription / API credits",
  },
  {
    match: /openrouter/i,
    query: 'from:openrouter.ai OR "Receipt from OpenRouter"',
    memo: "OpenRouter API credits",
  },
  {
    match: /railway/i,
    query: "from:railway.app OR from:railway.com",
    memo: "Railway hosting",
  },
];
const GENERIC_QUERY = (merchant) =>
  `"${merchant}" (receipt OR invoice OR order OR payment)`;

// ------------------------------------------------------------------- auth ---
function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No token"));
      } else resolve(token);
    });
  });
}

async function gmailFetch(path, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // Testing-mode grants expire ~weekly; Chrome keeps caching the dead token,
    // so purge it here — otherwise getToken(false) keeps handing back the same
    // 401'ing token and both Retry and Reconnect loop forever.
    try { chrome.identity.removeCachedAuthToken({ token }); } catch (_) {}
    throw new Error("AUTH_EXPIRED");
  }
  if (!res.ok) throw new Error(`Gmail ${res.status} on ${path}`);
  return res.json();
}

// ------------------------------------------------------------ gmail utils ---
const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const bytesToB64 = (bytes) => {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
};
const header = (msg, name) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value || "";

/** Walk MIME tree collecting {text, html, attachments[]}. */
function walkParts(payload, out) {
  if (!payload) return out;
  const mime = payload.mimeType || "";
  if (payload.filename && payload.body?.attachmentId) {
    out.attachments.push({
      filename: payload.filename,
      mime,
      attachmentId: payload.body.attachmentId,
      size: payload.body.size,
    });
  } else if (mime === "text/plain" && payload.body?.data) {
    out.text += new TextDecoder().decode(b64urlToBytes(payload.body.data));
  } else if (mime === "text/html" && payload.body?.data) {
    out.html += new TextDecoder().decode(b64urlToBytes(payload.body.data));
  }
  (payload.parts || []).forEach((p) => walkParts(p, out));
  return out;
}

// -------------------------------------------------------------- matching ---
const toCents = (s) => Math.round(parseFloat(String(s).replace(/[$,]/g, "")) * 100);
// Accept both comma-grouped and comma-less thousands ("$1,234.56" and
// "$1234.56") — plain-text receipts often omit the comma.
const AMOUNT_RE = /\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})/g;

function amountsIn(text) {
  const found = new Set();
  let m;
  while ((m = AMOUNT_RE.exec(text || ""))) found.add(toCents(m[1]));
  return found;
}

const dayMs = 86400000;
const gmailDate = (d) =>
  `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

/**
 * Score a Gmail message against a charge.
 * Amount is the strong signal; sender/vendor and date proximity break ties.
 * Observed in the wild: receipt emails can be stamped up to a day after the
 * charge date (settlement offset), hence the ±3 day window.
 */
function scoreMessage({ amountCents, chargeDate, vendorRule, dateHasTime }, msg, bodyText) {
  const reasons = [];
  let score = 0;
  const inSubject = amountsIn(header(msg, "Subject"));
  const inBody = amountsIn(bodyText + " " + (msg.snippet || ""));
  if (inSubject.has(amountCents) || inBody.has(amountCents)) {
    score += 0.6;
    reasons.push("exact amount match");
  }
  const from = header(msg, "From");
  if (vendorRule && vendorRule.match.test(from)) {
    score += 0.3;
    reasons.push("known vendor sender");
  }
  const msgDate = new Date(Number(msg.internalDate));
  const dist = Math.abs(msgDate - chargeDate) / dayMs;
  // Honest precision: a day-only charge date can't rank by hour proximity,
  // so it gets half the say — ties then fall to the judge, not to noise.
  const w = dateHasTime ? 0.1 : 0.05;
  if (dist <= 3) {
    score += w * (1 - dist / 3);
    reasons.push(`date within ${dist.toFixed(1)}d`);
  }
  return { score, reasons };
}

/** Strict verdict validation: a malformed judge response is discarded, not obeyed. */
function validVerdict(v, nCandidates) {
  if (!v || typeof v !== "object") return null;
  const idx = v.match_index;
  const idxOk = idx === null || idx === undefined || (Number.isInteger(idx) && idx >= 0 && idx < nCandidates);
  if (!idxOk) return null;
  return {
    match_index: Number.isInteger(idx) ? idx : null,
    confidence: typeof v.confidence === "number" ? Math.max(0, Math.min(1, v.confidence)) : 0,
    rationale: String(v.rationale || "").slice(0, 200),
    memo: String(v.memo || "").slice(0, 120),
    followup_query: typeof v.followup_query === "string" ? v.followup_query.slice(0, 200) : null,
  };
}

// ------------------------------------------------------- receipt retrieval ---
// Only ever fetch receipt bytes from Stripe's own hosts. Without this, a
// crafted "receipt" email could point the second-hop PDF link at an attacker
// URL and get arbitrary bytes uploaded to Ramp as the receipt (or loop us).
const STRIPE_HOST = /^https:\/\/([a-z0-9-]+\.)*stripe\.com\//i;
async function fetchAsPdfOrImage(url, depth = 0) {
  if (depth > 2 || !STRIPE_HOST.test(url)) return null;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (/application\/pdf|image\//.test(type)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { mime: type.split(";")[0], dataB64: bytesToB64(bytes) };
    }
    if (/text\/html/.test(type)) {
      // Stripe receipt pages link to their own PDF render — stay on Stripe.
      const html = await res.text();
      const pdfLink = (html.match(/https:\/\/[^"' ]*stripe\.com\/[^"' ]*\/pdf[^"' ]*/) || [])[0];
      if (pdfLink && pdfLink !== url) return fetchAsPdfOrImage(pdfLink, depth + 1);
    }
  } catch (_) {}
  return null;
}

const RECEIPT_LINK_RE =
  /https:\/\/(?:pay|invoice)\.stripe\.com\/[^\s"'<>]+/g;

async function getReceiptFile(token, msg, bodyHtml) {
  const parts = walkParts(msg.payload, { text: "", html: "", attachments: [] });
  // 1) A real receipt attachment wins — but prefer PDFs, and skip tiny images
  //    (vendor logos / social icons are inline images that would otherwise be
  //    grabbed as "the receipt"). Real receipt images are well over 8KB.
  const docs = parts.attachments.filter((a) => /pdf|image/.test(a.mime));
  const att =
    docs.find((a) => /pdf/.test(a.mime)) ||
    docs
      .filter((a) => /image/.test(a.mime) && (a.size || 0) >= 8000)
      .sort((x, y) => (y.size || 0) - (x.size || 0))[0];
  if (att) {
    const data = await gmailFetch(
      `messages/${msg.id}/attachments/${att.attachmentId}`,
      token
    );
    return {
      filename: att.filename,
      mime: att.mime,
      dataB64: bytesToB64(b64urlToBytes(data.data)),
      source: "attachment",
    };
  }
  // 2) A hosted Stripe receipt/invoice link → fetch the PDF render.
  const links = (bodyHtml || "").match(RECEIPT_LINK_RE) || [];
  for (const link of links) {
    const file = await fetchAsPdfOrImage(link.replace(/&amp;/g, "&"));
    if (file) {
      const ext = file.mime.includes("pdf") ? "pdf" : "png";
      return { filename: `receipt.${ext}`, ...file, source: "stripe-link" };
    }
  }
  // 3) Nothing fetchable — hand the link back for a manual save.
  return links.length ? { manualLink: links[0] } : null;
}

// ----------------------------------------------------------- ai fallback ----
/**
 * The escalation tier lives INSIDE the extension: when the deterministic join
 * is unsure (score < 0.8) or empty-handed, we call Claude with the charge and
 * the candidate emails and get a structured verdict back. The human gate is
 * unchanged — the AI proposes, the user's click disposes. With no key
 * configured this whole tier is skipped and behavior degrades gracefully.
 */
const AI_SYSTEM = `You are the escalation judge inside One Ramp, a tool that matches credit-card charges to receipt emails. Given a charge and candidate emails, decide which candidate (if any) is the receipt for the charge. Reason about sales tax, tips added at settlement, currency conversion, vendor-name variants, and billing-platform senders (Stripe, Paddle, etc.). Respond with ONLY a JSON object, no prose:
{"match_index": <candidate index or null>, "confidence": <0 to 1>, "rationale": "<ONE short sentence, 15 words max — state the deciding fact only>", "memo": "<one-line business-purpose memo for this charge>", "followup_query": "<only when match_index is null: a better Gmail search query to try>"}`;

/**
 * Zero-config cohort default: when this is set to the deployed one-ramp-proxy
 * URL, every install has the AI judge on with no setup — the org key lives
 * only on the Worker. Popup settings still override for power users.
 */
const DEFAULT_AI_ENDPOINT = "https://one-ramp-proxy.joshdrochon.workers.dev";
// Gate token for the proxy (must match DEFAULT_TOKEN / PROXY_TOKEN in the
// Worker). Only sent to the proxy, never to api.anthropic.com directly.
const ONE_RAMP_PROXY_TOKEN = "or_pilot_7Kd9mQ2xVb";

async function aiConfig() {
  const { aiKey, aiModel, aiEndpoint } = await chrome.storage.local.get([
    "aiKey",
    "aiModel",
    "aiEndpoint",
  ]);
  const endpoint =
    aiEndpoint ||
    DEFAULT_AI_ENDPOINT ||
    (aiKey ? "https://api.anthropic.com/v1/messages" : "");
  if (!endpoint) return null; // tier disabled
  return {
    key: aiKey || "",
    model: aiModel || "claude-haiku-4-5",
    endpoint,
  };
}

async function aiAssess(cfg, payload) {
  const viaProxy = !cfg.endpoint.includes("api.anthropic.com");
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Only the direct-Anthropic path needs the API key header; the proxy
      // holds the org key itself and just wants the gate token.
      ...(viaProxy ? { "x-one-ramp-token": ONE_RAMP_PROXY_TOKEN } : { "x-api-key": cfg.key }),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 400,
      system: AI_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    }),
  });
  if (!res.ok) throw new Error(`AI call failed (${res.status})`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  const json = text.match(/\{[\s\S]*\}/);
  return json ? JSON.parse(json[0]) : null;
}

// ------------------------------------------------------------ find flow -----
async function buildCandidates(refs, token, ctx) {
  const out = [];
  for (const ref of refs) {
   try {
    const msg = await gmailFetch(`messages/${ref.id}?format=full`, token);
    const parts = walkParts(msg.payload, { text: "", html: "", attachments: [] });
    const bodyText = parts.text || parts.html.replace(/<[^>]+>/g, " ");
    const { score, reasons } = scoreMessage(ctx, msg, bodyText);
    const amounts = [...amountsIn(bodyText + " " + (msg.snippet || ""))];
    const subject = header(msg, "Subject");
    const hasDoc = parts.attachments.some((a) => /pdf|image/.test(a.mime));
    // Admission rule: a candidate must look like a receipt — an amount, a
    // receipt-ish subject, or a document attachment. Login links, security
    // alerts, and marketing from vendor domains don't qualify.
    if (!amounts.length && !hasDoc && !/receipt|invoice|order|payment|statement/i.test(subject)) {
      log("skipping non-receipt email:", subject);
      continue;
    }
    out.push({
      id: msg.id,
      subject,
      from: header(msg, "From"),
      date: new Date(Number(msg.internalDate)).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      receiptNo: (header(msg, "Subject").match(/#([\d-]+)/) || [])[1] || null,
      amtCents: amounts.includes(ctx.amountCents) ? ctx.amountCents : amounts[0] || 0,
      score: Math.round(score * 100) / 100,
      reasons,
      _msg: msg,
      _html: parts.html || parts.text,
      _amounts: amounts,
    });
   } catch (e) {
     // One deleted/failed message must not sink the whole search.
     log("candidate fetch skipped:", ref.id, String(e.message || e));
   }
  }
  return out;
}

const slimFor = (c, i) => ({
  index: i,
  subject: c.subject,
  from: c.from,
  date: c.date,
  snippet: (c._msg.snippet || "").slice(0, 200),
  amounts_cents: c._amounts,
  deterministic_score: c.score,
});

async function findReceipt({ merchant, amountCents, dateISO, dateHasTime }) {
  const token = await getToken(false).catch(() => getToken(true));
  const chargeDate = new Date(dateISO);
  const vendorRule = VENDORS.find((v) => v.match.test(merchant)) || null;
  const windowQ = `after:${gmailDate(new Date(chargeDate - 3 * dayMs))} before:${gmailDate(
    new Date(+chargeDate + 4 * dayMs)
  )}`;
  const q = `${vendorRule ? vendorRule.query : GENERIC_QUERY(merchant)} ${windowQ}`;
  const ctx = { amountCents, chargeDate, vendorRule, dateHasTime };
  const charge = {
    merchant,
    amount_cents: amountCents,
    // Never fabricate precision: tell the judge when time of day is unknown.
    date: dateHasTime ? chargeDate.toLocaleString() : chargeDate.toLocaleDateString() + " (time of day unknown)",
  };

  log("findReceipt:", merchant, amountCents, "query:", q);
  const list = await gmailFetch(
    `messages?q=${encodeURIComponent(q)}&maxResults=20`,
    token
  );
  let candidates = await buildCandidates(list.messages || [], token, ctx);
  log("candidates:", candidates.map((c) => `${c.subject} [${c.score}]`));
  const cfg = await aiConfig();

  // Empty-handed → ask the judge for a smarter query, try once more.
  if (!candidates.length && cfg) {
    try {
      const probe = validVerdict(await aiAssess(cfg, { charge, tried_query: q, candidates: [] }), 0);
      if (probe?.followup_query) {
        const l2 = await gmailFetch(
          `messages?q=${encodeURIComponent(probe.followup_query + " " + windowQ)}&maxResults=20`,
          token
        );
        candidates = await buildCandidates(l2.messages || [], token, ctx);
      }
    } catch (_) {}
  }

  // A receipt that's already attached to some transaction is spent — never
  // propose it again. (Recorded at attach time in chrome.storage.)
  const { usedIds = [] } = await chrome.storage.local.get("usedIds");
  const before = candidates.length;
  candidates = candidates.filter((c) => !usedIds.includes(c.id));
  if (candidates.length < before)
    log("excluded", before - candidates.length, "already-attached receipt(s)");

  candidates.sort((a, b) => b.score - a.score);
  let best = candidates[0];
  if (!best)
    return {
      ok: false,
      error: `No receipt emails found for "${merchant}" near ${chargeDate.toDateString()}.`,
    };

  // Two candidates within a hair of each other (e.g. same vendor + same
  // amount on consecutive days) is ambiguity, not a match — never present
  // it as confident, and give the judge a crack at it.
  const second = candidates[1];
  const ambiguous = !!second && best.score - second.score < 0.05;
  if (ambiguous) log("ambiguous: top two scores", best.score, second.score);

  // Unsure → let the judge pick (or reject) among the top candidates.
  let ai = null;
  if ((best.score < 0.8 || ambiguous) && cfg) {
    log("score below 0.8 — escalating to AI judge via", cfg.endpoint);
    try {
      const slim = candidates.slice(0, 5).map(slimFor);
      const raw = await aiAssess(cfg, { charge, tried_query: q, candidates: slim });
      ai = validVerdict(raw, slim.length);
      if (!ai && raw) log("judge verdict FAILED validation:", raw);
      if (ai && ai.match_index != null && candidates[ai.match_index]) {
        best = candidates[ai.match_index];
        best.aiRationale = ai.rationale;
        best.aiConfidence = ai.confidence;
      } else if (ai && ai.match_index == null) {
        return {
          ok: false,
          error: `No confident match. AI judge: ${ai.rationale || "none of the candidates correspond to this charge."}`,
        };
      }
    } catch (_) {}
  }

  const file = await getReceiptFile(token, best._msg, best._html);
  const memo = (ai && ai.memo) || (vendorRule ? vendorRule.memo : `${merchant} purchase`);
  const strip = ({ _msg, _html, _amounts, ...rest }) => rest;
  return {
    ok: true,
    confident: (best.score >= 0.8 && !ambiguous) || (best.aiConfidence || 0) >= 0.75,
    match: { ...strip(best), file, memo },
    alternates: candidates.filter((c) => c !== best).slice(0, 3).map(strip),
  };
}

// --------------------------------------------------------------- router -----
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  (async () => {
    try {
      if (req.type === "FIND_RECEIPT") sendResponse(await findReceipt(req));
      else if (req.type === "CONNECT_GMAIL") {
        // Purge any stale cached token first so a revoked grant actually shows
        // Google's consent screen instead of silently returning the dead token.
        const stale = await getToken(false).catch(() => null);
        if (stale) await new Promise((r) => chrome.identity.removeCachedAuthToken({ token: stale }, r));
        const token = await getToken(true);
        const profile = await gmailFetch("profile", token);
        sendResponse({ ok: true, email: profile.emailAddress });
      } else if (req.type === "GMAIL_STATUS") {
        try {
          const token = await getToken(false);
          const profile = await gmailFetch("profile", token);
          sendResponse({ ok: true, email: profile.emailAddress });
        } catch {
          sendResponse({ ok: false });
        }
      } else if (req.type === "RECORD_ATTACHED") {
        const { usedIds = [] } = await chrome.storage.local.get("usedIds");
        if (req.messageId && !usedIds.includes(req.messageId)) usedIds.push(req.messageId);
        await chrome.storage.local.set({ usedIds: usedIds.slice(-200) });
        sendResponse({ ok: true });
      } else if (req.type === "FETCH_FILE") {
        const token = await getToken(false).catch(() => getToken(true));
        const msg = await gmailFetch(`messages/${req.messageId}?format=full`, token);
        const parts = walkParts(msg.payload, { text: "", html: "", attachments: [] });
        const file = await getReceiptFile(token, msg, parts.html || parts.text);
        sendResponse({ ok: true, file });
      } else if (req.type === "BADGE_ADJUST") {
        const current = parseInt(await chrome.action.getBadgeText({}), 10) || 0;
        const next = Math.max(0, current + (req.delta | 0));
        chrome.action.setBadgeText({ text: next ? String(next) : "" });
        sendResponse({ ok: true });
      } else if (req.type === "BADGE") {
        const n = req.count | 0;
        chrome.action.setBadgeText({ text: n ? String(n) : "" });
        chrome.action.setBadgeBackgroundColor({ color: "#E4F222" });
        if (chrome.action.setBadgeTextColor)
          chrome.action.setBadgeTextColor({ color: "#1F1E1B" });
        sendResponse({ ok: true });
      } else if (req.type === "AI_STATUS") {
        const cfg = await aiConfig();
        sendResponse({
          ok: true,
          on: !!cfg,
          viaProxy: !!cfg && !cfg.endpoint.includes("api.anthropic.com"),
        });
      } else sendResponse({ ok: false, error: "unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // keep the message channel open for async response
});
