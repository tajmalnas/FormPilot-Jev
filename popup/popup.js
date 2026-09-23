const statusEl = document.getElementById("status");
const lockedPanel = document.getElementById("lockedPanel");
const missingPanel = document.getElementById("missingPanel");
const readyPanel = document.getElementById("readyPanel");
const resultEl = document.getElementById("result");
const undoBtn = document.getElementById("undoBtn");

function show(panel) {
  [lockedPanel, missingPanel, readyPanel].forEach((p) => p.classList.add("hidden"));
  panel.classList.remove("hidden");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshLastRun() {
  const last = await chrome.runtime.sendMessage({ type: "GET_LAST_RUN" });
  if (last && last.timestamp) {
    resultEl.textContent = `Last run: ${last.green} filled, ${last.yellow} to check, ${last.grey} skipped${last.kept ? `, ${last.kept} kept` : ""}.`;
    undoBtn.classList.remove("hidden");
  }
}

async function init() {
  const state = await chrome.runtime.sendMessage({ type: "GET_KEY_STATE" });
  const profileStore = await chrome.storage.local.get("profile");
  const hasProfile = !!profileStore.profile;

  if (state.state === "locked") {
    show(lockedPanel);
    statusEl.textContent = "Key saved but locked";
  } else if (state.state === "missing" || !hasProfile) {
    show(missingPanel);
    statusEl.textContent = !hasProfile ? "No profile yet" : "No API key yet";
  } else {
    show(readyPanel);
    statusEl.textContent = "Ready";
    await refreshLastRun();
  }
}

document.getElementById("openSettingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById("settingsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("unlockBtn").addEventListener("click", async () => {
  const passphrase = document.getElementById("passphrase").value;
  const res = await chrome.runtime.sendMessage({ type: "UNLOCK_KEY", passphrase });
  const err = document.getElementById("unlockError");
  if (res.ok) {
    err.textContent = "";
    await init();
  } else {
    err.textContent = res.error || "Could not unlock.";
  }
});

document.getElementById("fillBtn").addEventListener("click", async () => {
  const btn = document.getElementById("fillBtn");
  btn.disabled = true;
  resultEl.textContent = "Scanning and filling...";
  try {
    const tab = await getActiveTab();
    const res = await chrome.runtime.sendMessage({ type: "RUN_FILL", tabId: tab.id });
    if (res.error) {
      resultEl.textContent = res.error;
    } else {
      resultEl.textContent = `Filled ${res.green} · Check ${res.yellow} · Skipped ${res.grey}${res.kept ? ` · Kept ${res.kept}` : ""}`;
      undoBtn.classList.remove("hidden");
    }
  } catch (err) {
    resultEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

undoBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  await chrome.runtime.sendMessage({ type: "UNDO_FILL", tabId: tab.id });
  resultEl.textContent = "Undone.";
  undoBtn.classList.add("hidden");
});

init();
