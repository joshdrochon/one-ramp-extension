# One Ramp ⚡

A Chrome extension that kills the Ramp receipt chore. When a Ramp card charge
needs verification, One Ramp finds the matching receipt email in your Gmail,
attaches it, and drafts a one-line memo — you click once to confirm. Nothing is
written to Ramp without your click.

Built for the cohort. Deterministic matching (vendor + exact amount + date) does
the routine 95%; an AI judge handles the ambiguous rest; you're always the final
gate.

## Install (students — ~2 minutes)

1. Download this repo: **Code → Download ZIP** (or `git clone`), and unzip it.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `one-ramp-extension` folder.
4. Click the puzzle-piece icon in the toolbar and **pin** One Ramp (so you see its badge).
5. Click the One Ramp icon → **Connect Gmail** → approve read-only access.
   - You'll see a "Google hasn't verified this app" screen — that's expected for a
     pilot; click **Continue**. (Ask Josh to add your Gmail to the tester list first.)
6. Open [your Ramp expenses](https://app.ramp.com/home/personal-expenses/all). When a
   charge needs a receipt, the panel pops up with it already found. One click, done.

To get updates later: `git pull` (or re-download) and hit the **reload** arrow on the
One Ramp card in `chrome://extensions`.

## What it can and can't see

- Reads your Gmail **read-only** (to find receipts) and reads the Ramp page you're on.
- Writes to Ramp **only** the receipt + memo, and **only** when you click Attach.
- Never touches reimbursements, never deletes anything, never sends your data anywhere
  except Gmail (to search) and — for ambiguous matches only — a small hosted judge.
- No account, no password, no servers holding your data.

## How it works

The content script detects unverified charges by reading Ramp's own on-page text
(resilient to cosmetic redesigns). The background service worker searches Gmail via
OAuth, scores candidate receipt emails, optionally consults the AI judge, and fetches
the receipt PDF. On your click it sets the file on Ramp's upload input and writes the
memo through the page, then watches for Ramp's "Auto-verified".

## Maintainer setup (Josh)

Two one-time things make the pilot zero-config for students:

- **Google OAuth client** (so Connect Gmail works): a Google Cloud project with the
  Gmail API enabled, an OAuth consent screen in Testing mode, testers added, and a
  Chrome-extension OAuth client bound to extension ID
  `bekbkgepohkfkpjihhcdllobmobclmjj`. The client ID goes in `manifest.json`.
- **AI judge proxy** (so students never hold an API key): the Cloudflare Worker in the
  companion `one-ramp-proxy` project holds the org Anthropic key and is gated by a
  shared token. Its URL is baked in as `DEFAULT_AI_ENDPOINT` in `background.js`.

> **Note on the proxy token.** `ONE_RAMP_PROXY_TOKEN` in `background.js` is a soft gate,
> not a secret — in a public repo it's visible. It blocks casual/CORS abuse; the real
> backstops are watching usage in the Anthropic console and rotating the key (or the
> token) if needed.

Vendor search patterns and memo templates live in `VENDORS` at the top of
`background.js` — three lines to add a new vendor.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 config: permissions, pinned key, OAuth client ID |
| `background.js` | Gmail OAuth + search, matching engine, AI judge, receipt fetch |
| `content.js` | Ramp page detection, panel UI, attach + memo on click |
| `ui.css` | Panel + chip styling |
| `popup.html` / `popup.js` | Toolbar popup: Connect Gmail, status |
| `icons/` | Logo at 16/32/48/128px + SVG master |

## License

MIT
