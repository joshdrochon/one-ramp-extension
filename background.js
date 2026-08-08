/**
 * One Ramp — background service worker.
 * Owns: Gmail OAuth (chrome.identity), Gmail API calls, receipt-file retrieval,
 * and the matching engine. The content script asks; this worker answers.
 * Nothing here ever writes to Ramp — writes happen in the page, on user click.
 */

const log = (...a) => console.log("[OneRamp]", ...a);

// ---------------------------------------------------------------- vendors ---
// Per-vendor search patterns and memo templates. A vendor rule REPLACES the
// generic search, so only add one when the receipt's real sender is known — a
// wrong sender here means that vendor's receipt is never found. `memo` may be a
// string, or a function of the cleaned merchant name.
const VENDORS = [
  {
    match: /anthropic/i,
    query: "from:mail.anthropic.com",
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
  {
    // Google's CONSUMER subscriptions (Google One, AI Pro, YouTube Premium, Play
    // apps, Gemini, extra storage) bill through Google Play, so the receipt comes
    // from the Play sender — not a "Google One" address. Confirmed live:
    // googleplay-noreply@google.com, subject "Your Google Play Order Receipt".
    // Deliberately scoped to consumer products so it never hijacks Google
    // Cloud / Ads / Workspace, which bill separately from different senders.
    match: /google\s*(one|play|ai|storage|gemini)|youtube\s*premium|g\.co\/helppay/i,
    query: "from:googleplay-noreply@google.com",
    memo: (m) => `${m} subscription`,
  },
  {
    // Apple App Store / iTunes bills show on the card as "APPLE.COM/BILL"; the
    // receipt is from Apple (no_reply@email.apple.com), subject "Your receipt
    // from Apple". That card descriptor never appears in the email, so search the
    // sender, not the merchant string.
    match: /apple\.com\/bill|itunes|app\s*store/i,
    query: "from:apple.com",
    memo: "Apple / App Store purchase",
  },
  {
    // Figma bills from figma.com (support+notifications@figma.com). Confirmed live.
    match: /figma/i,
    query: "from:figma.com",
    memo: "Figma subscription",
  },
];

// Card statements wrap the real vendor name in cruft — asterisks, help URLs,
// phone/store numbers, "INC/LLC", commas — none of which appears in the receipt
// email. Strip it so the merchant term actually matches:
// "GOOGLE *Google One g.co/helppay# CA" → "GOOGLE Google One CA".
function cleanMerchant(m) {
  return String(m || "")
    .replace(/\bg\.co\/\S+/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[*#,]+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|pbc)\b\.?/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Resolve a vendor rule's memo (string or merchant-aware function).
const memoFor = (rule, merchant) =>
  rule
    ? typeof rule.memo === "function"
      ? rule.memo(cleanMerchant(merchant) || merchant)
      : rule.memo
    : null;

// Generic fallback for vendors without a rule. Unquoted (a card descriptor rarely
// appears verbatim in the receipt) and broadened with subscription/statement;
// amount + time scoring filters any false positives the looser match admits.
const GENERIC_QUERY = (merchant) =>
  `${cleanMerchant(merchant) || merchant} (receipt OR invoice OR order OR payment OR subscription OR statement)`;

// ------------------------------------------------------------------- auth ---
// Auth runs on chrome.identity.launchWebAuthFlow (NOT getAuthToken). getAuthToken
// is pinned to the Chrome profile's primary Google account, so it can't let a
// user pick a different inbox — launchWebAuthFlow shows Google's account chooser
// and works for any account. We use the implicit flow (response_type=token): no
// client secret, so nothing secret ships in this public repo. The tradeoff is
// these tokens don't auto-refresh, so we cache the access token + expiry and
// silently re-mint via launchWebAuthFlow (interactive:false) when it lapses.
const WEB_CLIENT_ID =
  "607338298511-ia1oed8i2m28v1g9ensg73shlc9bs0ed.apps.googleusercontent.com";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_SKEW_MS = 60 * 1000; // re-mint a minute early so no call rides a dying token

/**
 * Build the Google OAuth (implicit) URL. prompt:'select_account' forces the
 * account chooser (explicit Connect/Switch); login_hint keeps a silent re-mint
 * on the SAME account so background finds never change which inbox is connected.
 */
function authUrl({ prompt, loginHint } = {}) {
  const p = new URLSearchParams({
    client_id: WEB_CLIENT_ID,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: GMAIL_SCOPE,
  });
  if (prompt) p.set("prompt", prompt);
  if (loginHint) p.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Pull {token, expiresAt} out of the #access_token=…&expires_in=… redirect. */
function parseTokenFromRedirect(redirectUrl) {
  const frag = String(redirectUrl || "").split("#")[1] || "";
  const params = new URLSearchParams(frag);
  const token = params.get("access_token");
  if (!token) throw new Error(params.get("error") || "no access_token in redirect");
  const expiresIn = Number(params.get("expires_in") || 3600);
  return { token, expiresAt: Date.now() + expiresIn * 1000 };
}

function launchAuth(interactive, opts = {}) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl(opts), interactive }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl)
        return reject(new Error(chrome.runtime.lastError?.message || "auth flow dismissed"));
      try { resolve(parseTokenFromRedirect(redirectUrl)); }
      catch (e) { reject(e); }
    });
  });
}

// --- token cache in chrome.storage.local (survives service-worker restarts) ---
async function storedToken() {
  const { gmailToken, gmailTokenExp } = await chrome.storage.local.get(["gmailToken", "gmailTokenExp"]);
  if (gmailToken && gmailTokenExp && Date.now() < gmailTokenExp - TOKEN_SKEW_MS) return gmailToken;
  return null;
}
async function saveToken(token, expiresAt, email) {
  const patch = { gmailToken: token, gmailTokenExp: expiresAt };
  if (email) patch.gmailEmail = email;
  await chrome.storage.local.set(patch);
}
/** Full sign-out: drop the token AND the remembered account. */
async function clearToken() {
  await chrome.storage.local.remove(["gmailToken", "gmailTokenExp", "gmailEmail"]);
}

/**
 * Return a usable access token. Order: fresh cached token → silent re-mint
 * (Google session still alive) → interactive only when allowed. Interactive here
 * re-auths the SAME account (login_hint, no picker); the account *chooser* is
 * reserved for the explicit Connect/Switch action so a background find never
 * hijacks which inbox is connected.
 */
async function getToken(interactive) {
  const cached = await storedToken();
  if (cached) return cached;
  const { gmailEmail } = await chrome.storage.local.get("gmailEmail");
  try {
    const { token, expiresAt } = await launchAuth(false, { loginHint: gmailEmail });
    await saveToken(token, expiresAt);
    return token;
  } catch (_) {
    if (!interactive) throw new Error("AUTH_EXPIRED");
  }
  const { token, expiresAt } = await launchAuth(true, { loginHint: gmailEmail, prompt: "consent" });
  await saveToken(token, expiresAt);
  return token;
}

async function gmailFetch(path, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // Token died mid-flight (revoked or lapsed). Drop the cached copy — but keep
    // gmailEmail so the next getToken() can silently re-mint the SAME account —
    // otherwise Retry keeps re-sending the dead token.
    await chrome.storage.local.remove(["gmailToken", "gmailTokenExp"]);
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

// --- receipt PDF generation (no deps, no DOM: runs in the service worker) -----
// Many receipts (Google Play, Apple, and plenty of SaaS) are inline-HTML emails
// with no attachment and no hosted PDF — nothing to drop onto Ramp. Rather than
// give up, we build a clean text PDF from the email's own content. Courier
// (monospace) keeps wrapping predictable; text is sanitized to printable ASCII so
// the resulting PDF is always valid.
function pdfSanitize(s) {
  return String(s || "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/[•●·]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/\t/g, "  ")
    .replace(/\r/g, "")
    .replace(/[^\x20-\x7E\n]/g, ""); // drop remaining non-ASCII + control (keep \n)
}
function pdfWrap(text, width) {
  const out = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.length <= width) { out.push(line); continue; }
    let cur = "";
    for (const tok of line.split(/(\s+)/)) {
      if (!tok) continue;
      if ((cur + tok).length <= width) { cur += tok; continue; }
      if (cur.trim()) out.push(cur.replace(/\s+$/, ""));
      let w = /^\s/.test(tok) ? "" : tok;
      while (w.length > width) { out.push(w.slice(0, width)); w = w.slice(width); }
      cur = w;
    }
    if (cur.trim()) out.push(cur.replace(/\s+$/, ""));
  }
  return out;
}
/** Build a minimal, valid single-font PDF from plain text. Returns base64. */
function buildReceiptPdf(text) {
  const COLS = 84, ROWS = 56, FS = 10, LEAD = 12, X = 54, TOP = 738;
  let lines = pdfWrap(pdfSanitize(text), COLS);
  if (!lines.length) lines = [""];
  const pages = [];
  for (let i = 0; i < lines.length; i += ROWS) pages.push(lines.slice(i, i + ROWS));
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  const objs = {};
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, k) => `${4 + 2 * k} 0 R`);
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  pages.forEach((pg, k) => {
    const pageNum = 4 + 2 * k, contentNum = 5 + 2 * k;
    objs[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const body = pg.map((ln) => `(${esc(ln)}) Tj T*`).join("\n");
    const stream = `BT /F1 ${FS} Tf ${LEAD} TL ${X} ${TOP} Td\n${body}\nET`;
    objs[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  const total = 3 + 2 * pages.length;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let n = 1; n <= total; n++) {
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return btoa(pdf);
}

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
  // 3) No attachment and no hosted PDF: BUILD a PDF from the email's own content,
  //    so an inline-HTML receipt (Google Play, Apple, many SaaS) still yields a
  //    file to attach instead of leaving nothing to drop onto Ramp.
  try {
    const raw = (parts.text && parts.text.trim())
      ? parts.text
      : (parts.html || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    const clean = raw
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#0?39;|&rsquo;/gi, "'")
      .replace(/&quot;/gi, '"').replace(/&gt;/gi, ">").replace(/&lt;/gi, "<")
      .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
    const head = [
      header(msg, "Subject") || "Receipt",
      "From: " + header(msg, "From"),
      "Date: " + new Date(Number(msg.internalDate)).toLocaleString(),
      "-".repeat(60), "",
    ].join("\n");
    const dataB64 = buildReceiptPdf(head + "\n" + clean);
    if (dataB64) return { filename: "receipt.pdf", mime: "application/pdf", dataB64, source: "generated" };
  } catch (e) {
    log("receipt PDF generation failed:", String(e.message || e));
  }
  // Last resort: hand back a hosted link (if any) for a manual save.
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
      // A Stripe-hosted receipt link the user can open to eyeball the receipt
      // before attaching (mirrors the manual download-and-look step). Public
      // link, no login needed.
      viewUrl: ((parts.html || parts.text || "").match(RECEIPT_LINK_RE) || [])[0]?.replace(/&amp;/g, "&") || null,
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
  const token = await getToken(false);
  // The connected inbox, handed back to the panel so a "no receipt found" reads
  // as "not in THIS account" (Koby runs 2-3) rather than "the receipt's missing".
  const { gmailEmail: account = null } = await chrome.storage.local.get("gmailEmail");
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
  if (!candidates.length)
    return {
      ok: false,
      account,
      error: `No receipt emails found for "${merchant}" near ${chargeDate.toDateString()}.`,
    };

  // Time distance (ms) from a candidate receipt to the charge.
  const chargeMs = +chargeDate;
  const td = (c) => Math.abs(Number(c._msg.internalDate) - chargeMs);
  const exact = candidates.filter((c) => c.amtCents === amountCents);

  let best, ambiguous = false, ai = null;

  if (dateHasTime && exact.length) {
    // Dominant real case: one or more SAME-AMOUNT receipts from the vendor. The
    // right one is the receipt closest IN TIME to the charge — exactly how a
    // human disambiguates two identical-price top-ups. The score's proximity
    // term is day-scale and can't separate same-day twins, which is what matched
    // a 5:52 charge to a 5:18 receipt instead of the 5:54 one.
    exact.sort((a, b) => td(a) - td(b));
    best = exact[0];
    // Genuine twin: another same-amount receipt within 5 min of the winner's gap.
    ambiguous = exact.length > 1 && td(exact[1]) - td(exact[0]) < 5 * 60 * 1000;
    log("exact nearest-time pick:", best.subject, best.date, "gap(min):", Math.round(td(best) / 60000), "ambiguous:", ambiguous);
  } else {
    // No exact-amount receipt (possible tip / tax / currency case) or the charge
    // time is unknown → fall back to score, and let the judge reason it out.
    best = candidates[0];
    const second = candidates[1];
    ambiguous = !!second && best.score - second.score < 0.05;
    if (cfg && (best.score < 0.8 || ambiguous)) {
      log("no exact-amount match — escalating to AI judge via", cfg.endpoint);
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
            account,
            error: `No confident match. AI judge: ${ai.rationale || "none of the candidates correspond to this charge."}`,
          };
        }
      } catch (_) {}
    }
  }

  const file = await getReceiptFile(token, best._msg, best._html);
  const memo = (ai && ai.memo) || memoFor(vendorRule, merchant) || `${merchant} purchase`;
  const strip = ({ _msg, _html, _amounts, ...rest }) => rest;

  // Alternates = "not it? pick the right one." Same-amount receipts only for a
  // known SaaS/Stripe vendor (a different amount is a different purchase); for an
  // unknown vendor keep a couple different-amount fallbacks (tip/tax/FX). Sorted
  // by time proximity so the closest twin is offered first.
  const others = candidates.filter((c) => c !== best);
  const sameAmt = others.filter((c) => c.amtCents === amountCents);
  if (dateHasTime) sameAmt.sort((a, b) => td(a) - td(b));
  const altPool = vendorRule
    ? sameAmt
    : [...sameAmt, ...others.filter((c) => c.amtCents !== amountCents)];

  // Confident only when the nearest same-amount receipt is actually near the
  // charge in time (≤15 min — receipts post within minutes) with no near-twin. A
  // far-off nearest match (the real receipt may not have arrived yet) is shown as
  // a "possible" match so the human checks rather than trusting it.
  const closeInTime = dateHasTime && exact.length > 0 && td(best) <= 15 * 60 * 1000;
  const confident =
    (closeInTime && !ambiguous) ||
    (!dateHasTime && best.score >= 0.8 && !ambiguous) ||
    (best.aiConfidence || 0) >= 0.75;

  return {
    ok: true,
    confident,
    account,
    match: { ...strip(best), file, memo },
    alternates: altPool.slice(0, 3).map(strip),
  };
}

// --------------------------------------------------------------- router -----
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  (async () => {
    try {
      if (req.type === "FIND_RECEIPT") sendResponse(await findReceipt(req));
      else if (req.type === "CONNECT_GMAIL") {
        // Always show Google's account chooser (select_account) so the user picks
        // WHICH inbox — the whole reason we use launchWebAuthFlow instead of
        // getAuthToken (which is pinned to the Chrome profile's primary account).
        const { token, expiresAt } = await launchAuth(true, { prompt: "select_account" });
        const profile = await gmailFetch("profile", token);
        await saveToken(token, expiresAt, profile.emailAddress);
        sendResponse({ ok: true, email: profile.emailAddress });
      } else if (req.type === "DISCONNECT_GMAIL") {
        // Sign out: best-effort server-side revoke, then wipe the local identity
        // so the next connect starts clean at the account picker.
        const { gmailToken } = await chrome.storage.local.get("gmailToken");
        if (gmailToken) {
          try {
            await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(gmailToken), {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
            });
          } catch (_) {}
        }
        await clearToken();
        sendResponse({ ok: true });
      } else if (req.type === "GMAIL_STATUS") {
        try {
          const token = await getToken(false);
          const profile = await gmailFetch("profile", token);
          await chrome.storage.local.set({ gmailEmail: profile.emailAddress });
          sendResponse({ ok: true, email: profile.emailAddress });
        } catch {
          // Report the last-known account even when disconnected, so the popup
          // can offer to reconnect it by name.
          const { gmailEmail } = await chrome.storage.local.get("gmailEmail");
          sendResponse({ ok: false, email: gmailEmail || null });
        }
      } else if (req.type === "RECORD_ATTACHED") {
        const { usedIds = [] } = await chrome.storage.local.get("usedIds");
        if (req.messageId && !usedIds.includes(req.messageId)) usedIds.push(req.messageId);
        await chrome.storage.local.set({ usedIds: usedIds.slice(-200) });
        sendResponse({ ok: true });
      } else if (req.type === "FETCH_FILE") {
        const token = await getToken(false);
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
