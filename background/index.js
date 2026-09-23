import { callJev, JevError, MODEL } from "./jev.js";
import { buildRound1Batches, buildOptionMatchQuestions, buildAnswerConfirmQuestions, buildCheckboxGroupQuestions, batchQuestionsByTokens } from "./questions.js";
import { applyRound1, applyRound2, buildFillPlan, COLORS } from "./resolve.js";
import { computeProfileBundle } from "./derive.js";
import * as storage from "./storage.js";

const SCAN_TIMEOUT_MS = 1500;
const SCAN_IDLE_MS = 350;

function scanTab(tabId) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const collected = [];
    let sendError = null;
    let idleTimer = null;
    let hardTimer = null;

    function finish() {
      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      resolve({ frames: collected, sendError });
    }

    function listener(msg, sender) {
      if (msg && msg.type === "SCAN_RESULT" && msg.requestId === requestId && sender.tab && sender.tab.id === tabId) {
        collected.push({ frameId: sender.frameId, fields: msg.fields || [], pageContext: msg.pageContext });
        clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, SCAN_IDLE_MS);
      }
    }

    chrome.runtime.onMessage.addListener(listener);
    // No listener answering at all (distinct from "the page has no fields")
    // almost always means the content script's connection to this tab is
    // stale — e.g. the extension was reloaded after this page was already
    // open. Chrome tears down the old content script's messaging channel on
    // reload; only refreshing the page re-injects a live one.
    chrome.tabs.sendMessage(tabId, { type: "SCAN", requestId }).catch((err) => { sendError = err && err.message; });
    hardTimer = setTimeout(finish, SCAN_TIMEOUT_MS);
  });
}

async function runFill(tabId) {
  const profile = await storage.getProfile();
  if (!profile) return { error: "No profile saved yet. Open FormPilot Settings and upload your profile." };

  const keyState = await storage.getApiKeyState();
  if (keyState.state === "missing") return { error: "No API key saved yet. Open FormPilot Settings and add your TypeSafe key." };
  if (keyState.state === "locked") return { error: "Your remembered key is locked. Open the FormPilot popup and unlock it with your passphrase." };
  const apiKey = keyState.key;

  const { frames: frameResults, sendError } = await scanTab(tabId);
  if (!frameResults.length) {
    if (sendError) {
      return { error: "FormPilot's content script isn't connected on this page — usually because the extension was reloaded after this tab was already open. Refresh this page (not just the extension) and try again." };
    }
    return { error: "FormPilot scanned this page but didn't find any fillable fields." };
  }

  const bundle = computeProfileBundle(profile);
  const pageContext = (frameResults.find((f) => f.frameId === 0) || frameResults[0]).pageContext || {};

  const allFields = [];
  const keptFields = [];
  const phoneSplitFields = [];
  frameResults.forEach(({ frameId, fields }) => {
    fields.forEach((descriptor, localId) => {
      const globalKey = `f${frameId}_${localId}`;
      if (descriptor.kind === "phone_split") {
        phoneSplitFields.push({ frameId, localId, descriptor });
      } else if (descriptor.current_value) {
        keptFields.push({ frameId, localId });
      } else if (descriptor.kind !== "file" && descriptor.kind !== "unsupported") {
        allFields.push({ globalKey, frameId, localId, descriptor });
      }
    });
  });

  // Splitting a phone number across boxes is arithmetic, not a judgment call
  // — handled entirely in code, never sent to Jev.
  const phoneSplitPlan = buildPhoneSplitPlan(phoneSplitFields, bundle);

  if (!allFields.length) {
    const plan = [...buildFillPlan([], new Map(), keptFields), ...phoneSplitPlan];
    const summary0 = summarize(plan);
    await sendPlanToFrames(tabId, plan, summary0);
    await storage.saveLastRun(summary0);
    return summary0;
  }

  let round1Answers = {};
  try {
    const batches = buildRound1Batches(allFields, bundle, pageContext);
    const results = await Promise.all(batches.map((b) => callJev({ apiKey, model: MODEL, state: b.state, questions: b.questions })));
    results.forEach((r) => Object.assign(round1Answers, r.answers || {}));
  } catch (err) {
    return { error: err instanceof JevError ? err.message : `Round 1 failed: ${err.message}` };
  }

  const resolved = applyRound1(round1Answers, allFields, bundle);

  const optionNeeding = [];
  const answerNeeding = [];
  const groupNeeding = [];
  for (const field of allFields) {
    const r = resolved.get(field.globalKey);
    if (!r) continue;
    if (r.status === "needs-option-match") {
      optionNeeding.push({ globalKey: field.globalKey + "__opt", descriptor: field.descriptor, chosenValue: r.value });
    } else if (r.status === "needs-answer-confirm") {
      answerNeeding.push({ globalKey: field.globalKey + "__ans", descriptor: field.descriptor, answerTopic: r.answerTopic });
    } else if (r.status === "needs-checkbox-group") {
      // Prefer the real array (e.g. profile.skills) over re-splitting a
      // joined string, which breaks on items that themselves contain commas.
      const chosenValues = bundle.listValues[r.keyUsed] || String(r.value).split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
      (field.descriptor.options || []).forEach((o) => {
        groupNeeding.push({ globalKey: field.globalKey + "__opt_" + o.oid, optionText: o.text, chosenValues: chosenValues.length ? chosenValues : [r.value] });
      });
    }
  }

  if (optionNeeding.length || answerNeeding.length || groupNeeding.length) {
    const merged = {
      ...buildOptionMatchQuestions(optionNeeding),
      ...buildAnswerConfirmQuestions(answerNeeding),
      ...buildCheckboxGroupQuestions(groupNeeding)
    };
    try {
      const round2State = { page: pageContext };
      const batches = batchQuestionsByTokens(merged, round2State);
      const results = await Promise.all(batches.map((qs) => callJev({ apiKey, model: MODEL, state: round2State, questions: qs })));
      const round2Answers = {};
      results.forEach((r) => Object.assign(round2Answers, r.answers || {}));
      applyRound2(resolved, round2Answers, allFields);
    } catch (err) {
      // Round 2 failure shouldn't lose Round 1 progress; affected fields just fall back to skip.
      for (const field of allFields) {
        const r = resolved.get(field.globalKey);
        if (r && r.status && r.status.startsWith("needs-")) resolved.set(field.globalKey, { status: "skip" });
      }
    }
  }

  const plan = [...buildFillPlan(allFields, resolved, keptFields), ...phoneSplitPlan];
  const summary = summarize(plan);
  await sendPlanToFrames(tabId, plan, summary);
  await storage.saveLastRun(summary);
  return summary;
}

// Splits the profile's phone digits across a multi-box phone field by each
// box's maxlength, left to right. No Jev call: this is pure arithmetic.
function buildPhoneSplitPlan(phoneSplitFields, bundle) {
  const digits = bundle.phoneDigits || "";
  return phoneSplitFields.map(({ frameId, localId, descriptor }) => {
    if (!digits) {
      return { frameId, localId, action: "none", color: descriptor.required ? COLORS.grey : null, reason: "no phone in profile" };
    }
    const parts = descriptor.parts || [];
    const totalNeeded = parts.reduce((a, b) => a + b, 0);
    const values = [];
    let idx = 0;
    for (const len of parts) {
      values.push(digits.slice(idx, idx + len));
      idx += len;
    }
    const exactFit = digits.length === totalNeeded;
    return {
      frameId, localId, action: "setValueParts", values,
      color: exactFit ? COLORS.green : COLORS.yellow,
      keyUsed: "phone_national_only (split across boxes)",
      reason: exactFit ? undefined : "digit count didn't line up exactly with the boxes — please check"
    };
  });
}

async function sendPlanToFrames(tabId, plan, summary) {
  const byFrame = new Map();
  plan.forEach((item) => {
    if (!byFrame.has(item.frameId)) byFrame.set(item.frameId, []);
    byFrame.get(item.frameId).push(item);
  });
  if (!byFrame.has(0)) byFrame.set(0, []); // ensure the top frame gets the pill even with nothing to fill there
  await Promise.all(
    [...byFrame.entries()].map(([frameId, items]) =>
      chrome.tabs.sendMessage(tabId, { type: "FILL", plan: items, summary }, { frameId }).catch(() => {})
    )
  );
}

function summarize(plan) {
  const s = { green: 0, yellow: 0, grey: 0, kept: 0, total: plan.length, timestamp: Date.now() };
  plan.forEach((p) => {
    if (p.color === "#22c55e") s.green++;
    else if (p.color === "#eab308") s.yellow++;
    else if (p.color === "#3b82f6") s.kept++;
    else if (p.color === "#9ca3af") s.grey++;
  });
  return s;
}

async function testKey(apiKey) {
  try {
    const res = await callJev({
      apiKey,
      model: MODEL,
      state: {},
      questions: { ping: { type: "noul", instructions: "Return a high value to confirm the connection works.", criteria: { true: "works", false: "doesn't" } } }
    });
    return { ok: true, model: res.model };
  } catch (err) {
    return { ok: false, error: err instanceof JevError ? err.message : err.message };
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "fill-form") return;
  const tabId = await getActiveTabId();
  if (tabId) await runFill(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type === "SCAN_RESULT") return false; // handled by the per-call listener in scanTab

  (async () => {
    switch (msg.type) {
      case "RUN_FILL": {
        const tabId = msg.tabId || (await getActiveTabId());
        sendResponse(tabId ? await runFill(tabId) : { error: "No active tab." });
        break;
      }
      case "UNDO_FILL": {
        const tabId = msg.tabId || (await getActiveTabId());
        if (tabId) await chrome.tabs.sendMessage(tabId, { type: "UNDO" }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "TEST_KEY": {
        sendResponse(await testKey(msg.apiKey));
        break;
      }
      case "SAVE_KEY": {
        await storage.saveApiKey({ key: msg.key, remember: msg.remember, passphrase: msg.passphrase });
        sendResponse({ ok: true });
        break;
      }
      case "UNLOCK_KEY": {
        sendResponse(await storage.unlockRememberedKey(msg.passphrase));
        break;
      }
      case "GET_KEY_STATE": {
        sendResponse(await storage.getApiKeyState());
        break;
      }
      case "CLEAR_KEY": {
        await storage.clearApiKey();
        sendResponse({ ok: true });
        break;
      }
      case "GET_LAST_RUN": {
        sendResponse(await storage.getLastRun());
        break;
      }
      case "DELETE_EVERYTHING": {
        await storage.deleteEverything();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ error: "Unknown message type." });
    }
  })();

  return true; // keep the message channel open for the async response
});
