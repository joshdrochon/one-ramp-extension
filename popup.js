const statusEl = document.getElementById("status");
const btn = document.getElementById("connect");

function show(res) {
  if (res?.ok) {
    statusEl.textContent = `You're in as ${res.email} 🎉`;
    statusEl.className = "ok";
    btn.textContent = "Reconnect Gmail";
  } else {
    statusEl.textContent = "Your receipts are hiding in Gmail 🧾";
    statusEl.className = "dim";
  }
}

chrome.runtime.sendMessage({ type: "GMAIL_STATUS" }, show);

btn.onclick = () => {
  statusEl.textContent = "Opening Google sign-in…";
  chrome.runtime.sendMessage({ type: "CONNECT_GMAIL" }, (res) => {
    show(res);
    if (!res?.ok) statusEl.textContent = `Connection failed: ${res?.error || "unknown"}`;
  });
};

// The AI judge runs invisibly off the baked-in proxy (DEFAULT_AI_ENDPOINT in
// background.js). Power-user overrides still exist in chrome.storage.local
// (aiKey / aiEndpoint / aiModel) — settable from the service-worker console —
// but they get no UI: this popup stays zero-overhead by design.
