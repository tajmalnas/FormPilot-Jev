import { validateProfile } from "../shared/profileSchema.js";

const profileText = document.getElementById("profileText");
const profileErrors = document.getElementById("profileErrors");
const profileStatus = document.getElementById("profileStatus");
const keyStatus = document.getElementById("keyStatus");
const rememberCheckbox = document.getElementById("rememberCheckbox");
const passphraseInput = document.getElementById("passphraseInput");

async function loadExistingProfile() {
  const store = await chrome.storage.local.get("profile");
  if (store.profile) {
    profileText.value = JSON.stringify(store.profile, null, 2);
    profileStatus.textContent = "Loaded your saved profile.";
  }
}

document.getElementById("profileFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  profileText.value = await file.text();
});

document.getElementById("loadTemplateBtn").addEventListener("click", async () => {
  const res = await fetch(chrome.runtime.getURL("profile.template.json"));
  profileText.value = JSON.stringify(await res.json(), null, 2);
});

document.getElementById("downloadTemplateBtn").addEventListener("click", async () => {
  const res = await fetch(chrome.runtime.getURL("profile.template.json"));
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "profile.template.json";
  a.click();
});

document.getElementById("validateSaveBtn").addEventListener("click", async () => {
  profileErrors.innerHTML = "";
  let parsed;
  try {
    parsed = JSON.parse(profileText.value);
  } catch (err) {
    profileErrors.innerHTML = `<li>Invalid JSON: ${err.message}</li>`;
    profileStatus.textContent = "";
    return;
  }
  const { valid, errors } = validateProfile(parsed);
  if (!valid) {
    profileErrors.innerHTML = errors.map((e) => `<li>${e}</li>`).join("");
    profileStatus.textContent = "";
    return;
  }
  await chrome.storage.local.set({ profile: parsed });
  profileStatus.textContent = "Profile saved. Never leaves this browser except field descriptions sent to TypeSafe on each fill.";
});

document.getElementById("exportProfileBtn").addEventListener("click", async () => {
  const store = await chrome.storage.local.get("profile");
  if (!store.profile) { profileStatus.textContent = "No profile saved yet."; return; }
  const blob = new Blob([JSON.stringify(store.profile, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "profile.json";
  a.click();
});

rememberCheckbox.addEventListener("change", () => {
  passphraseInput.classList.toggle("hidden", !rememberCheckbox.checked);
});

document.getElementById("saveKeyBtn").addEventListener("click", async () => {
  const key = document.getElementById("apiKeyInput").value.trim();
  if (!key) { keyStatus.textContent = "Enter an API key first."; keyStatus.style.color = "#b91c1c"; return; }
  const remember = rememberCheckbox.checked;
  const passphrase = passphraseInput.value;
  if (remember && !passphrase) { keyStatus.textContent = "Enter a passphrase to remember the key."; keyStatus.style.color = "#b91c1c"; return; }
  await chrome.runtime.sendMessage({ type: "SAVE_KEY", key, remember, passphrase });
  document.getElementById("apiKeyInput").value = "";
  passphraseInput.value = "";
  keyStatus.textContent = remember ? "Key saved and encrypted on this device." : "Key saved for this browser session.";
  keyStatus.style.color = "#059669";
});

document.getElementById("testKeyBtn").addEventListener("click", async () => {
  const key = document.getElementById("apiKeyInput").value.trim();
  if (!key) {
    const state = await chrome.runtime.sendMessage({ type: "GET_KEY_STATE" });
    if (state.state !== "ready") { keyStatus.textContent = "Paste a key to test, or save/unlock one first."; keyStatus.style.color = "#b91c1c"; return; }
  }
  keyStatus.textContent = "Testing...";
  keyStatus.style.color = "#4b5563";
  const testKeyValue = key || (await chrome.runtime.sendMessage({ type: "GET_KEY_STATE" })).key;
  const res = await chrome.runtime.sendMessage({ type: "TEST_KEY", apiKey: testKeyValue });
  if (res.ok) {
    keyStatus.textContent = `Key works (model: ${res.model}).`;
    keyStatus.style.color = "#059669";
  } else {
    keyStatus.textContent = res.error;
    keyStatus.style.color = "#b91c1c";
  }
});

document.getElementById("clearKeyBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_KEY" });
  keyStatus.textContent = "Key cleared.";
  keyStatus.style.color = "#4b5563";
});

document.getElementById("deleteAllBtn").addEventListener("click", async () => {
  if (!confirm("This deletes your profile and API key from this browser. Continue?")) return;
  await chrome.runtime.sendMessage({ type: "DELETE_EVERYTHING" });
  profileText.value = "";
  profileStatus.textContent = "Everything deleted.";
  keyStatus.textContent = "";
});

loadExistingProfile();
