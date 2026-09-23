// Message router for this frame. Loaded once per frame via manifest
// content_scripts (scan.js, fill.js, overlay.js run first and populate
// window.FormPilot).
(function () {
  if (window.__formpilotIndexLoaded) return;
  window.__formpilotIndexLoaded = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;

    if (msg.type === "SCAN") {
      try {
        const { fields, pageContext } = window.FormPilot.scan();
        chrome.runtime.sendMessage({ type: "SCAN_RESULT", requestId: msg.requestId, fields, pageContext }).catch(() => {});
      } catch (err) {
        chrome.runtime.sendMessage({ type: "SCAN_RESULT", requestId: msg.requestId, fields: [], pageContext: {} }).catch(() => {});
      }
      return false;
    }

    if (msg.type === "FILL") {
      let filled = 0;
      (msg.plan || []).forEach((item) => {
        if (item.action && item.action !== "none") {
          if (window.FormPilot.applyFillItem(item)) filled++;
        }
      });
      window.FormPilot.overlay.applyPlan(msg.plan || [], msg.summary);
      sendResponse({ filled });
      return true;
    }

    if (msg.type === "UNDO") {
      window.FormPilot.overlay.undo();
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
})();
