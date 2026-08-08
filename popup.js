const statusEl = document.getElementById("status");
const btn = document.getElementById("connect");
const disc = document.getElementById("disconnect");

function show(res) {
  if (res?.ok) {
    statusEl.textContent = `Connected as ${res.email} 🎉`;
    statusEl.className = "ok";
    btn.textContent = "Switch account";
    disc.hidden = false;
  } else {
    statusEl.textContent = res?.email
      ? `Disconnected — reconnect ${res.email}, or switch accounts 🧾`
      : "Your receipts are hiding in Gmail 🧾";
    statusEl.className = "dim";
    btn.textContent = "Connect Gmail";
    disc.hidden = true;
  }
}

chrome.runtime.sendMessage({ type: "GMAIL_STATUS" }, show);

// Connect and "Switch account" are one action: launchWebAuthFlow always opens
// Google's account chooser, so the user can land on ANY of their inboxes.
btn.onclick = () => {
  statusEl.textContent = "Opening Google sign-in…";
  statusEl.className = "dim";
  chrome.runtime.sendMessage({ type: "CONNECT_GMAIL" }, (res) => {
    show(res);
    if (!res?.ok) statusEl.textContent = `Connection failed: ${res?.error || "unknown"}`;
  });
};

disc.onclick = () => {
  statusEl.textContent = "Signing out…";
  chrome.runtime.sendMessage({ type: "DISCONNECT_GMAIL" }, () => {
    show({ ok: false });
    statusEl.textContent = "Signed out. Connect any Gmail to start 👋";
  });
};

// The AI judge runs invisibly off the baked-in proxy (DEFAULT_AI_ENDPOINT in
// background.js). Power-user overrides still exist in chrome.storage.local
// (aiKey / aiEndpoint / aiModel) — settable from the service-worker console —
// but they get no UI: this popup stays zero-overhead by design.
