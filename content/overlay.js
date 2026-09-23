// Status pill (top frame only) + per-field highlight outlines + undo.
(function () {
  window.FormPilot = window.FormPilot || {};
  if (window.FormPilot.overlay) return;

  const highlighted = new Map(); // localId -> { el, prevOutline, prevOffset }

  function isTopFrame() {
    try { return window.top === window.self; } catch { return false; }
  }

  function ensurePill() {
    if (!isTopFrame()) return null;
    let pill = document.querySelector('[data-formpilot-overlay="pill"]');
    if (pill) return pill;
    pill = document.createElement("div");
    pill.setAttribute("data-formpilot-overlay", "pill");
    Object.assign(pill.style, {
      position: "fixed", bottom: "16px", right: "16px", zIndex: 2147483647,
      background: "#111827", color: "#fff", fontFamily: "system-ui, sans-serif",
      fontSize: "13px", padding: "10px 14px", borderRadius: "10px",
      boxShadow: "0 4px 16px rgba(0,0,0,.3)", display: "flex", gap: "10px",
      alignItems: "center", pointerEvents: "auto"
    });
    const text = document.createElement("span");
    text.setAttribute("data-formpilot-overlay", "text");
    const undoBtn = document.createElement("button");
    undoBtn.textContent = "Undo";
    undoBtn.setAttribute("data-formpilot-overlay", "undo");
    Object.assign(undoBtn.style, {
      background: "#374151", color: "#fff", border: "none", borderRadius: "6px",
      padding: "4px 10px", cursor: "pointer", fontSize: "12px"
    });
    undoBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "UNDO_FILL" }).catch(() => {});
    });
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.setAttribute("data-formpilot-overlay", "close");
    Object.assign(closeBtn.style, { background: "transparent", color: "#9ca3af", border: "none", cursor: "pointer", fontSize: "14px" });
    closeBtn.addEventListener("click", () => pill.remove());
    pill.appendChild(text);
    pill.appendChild(undoBtn);
    pill.appendChild(closeBtn);
    document.documentElement.appendChild(pill);
    return pill;
  }

  function updatePill(counts) {
    const pill = ensurePill();
    if (!pill) return;
    const text = pill.querySelector('[data-formpilot-overlay="text"]');
    text.textContent = `Filled ${counts.green || 0} · Check ${counts.yellow || 0} · Skipped ${counts.grey || 0}${counts.kept ? ` · Kept ${counts.kept}` : ""}`;
  }

  function highlight(entry, item) {
    const targets = entry.elements && entry.elements.length ? entry.elements : entry.element ? [entry.element] : [];
    if (!targets.length || !item.color) return;
    if (!highlighted.has(item.localId)) {
      highlighted.set(item.localId, targets.map((el) => ({ el, prevOutline: el.style.outline, prevOffset: el.style.outlineOffset })));
    }
    const tipParts = [];
    if (item.keyUsed) tipParts.push(`FormPilot: ${item.keyUsed}`);
    if (typeof item.confidence === "number") tipParts.push(`confidence ${(item.confidence * 100).toFixed(0)}%`);
    if (item.reason) tipParts.push(item.reason);
    targets.forEach((el) => {
      el.style.outline = `2px solid ${item.color}`;
      el.style.outlineOffset = "2px";
      if (tipParts.length) el.title = tipParts.join(" — ");
    });
  }

  function applyPlan(plan, counts) {
    plan.forEach((item) => {
      const entry = window.FormPilot.fieldMap.get(item.localId);
      if (entry) highlight(entry, item);
    });
    if (counts) updatePill(counts);
  }

  function undo() {
    const preFill = window.FormPilot.preFill || new Map();
    for (const [localId, snapshot] of preFill.entries()) {
      const entry = window.FormPilot.fieldMap.get(localId);
      if (!entry) continue;
      try {
        if (snapshot.kind === "text") window.FormPilot.applyFillItem({ localId, action: "setValue", value: snapshot.value });
        else if (snapshot.kind === "textarea") window.FormPilot.applyFillItem({ localId, action: "setValue", value: snapshot.value });
        else if (snapshot.kind === "select") { entry.element.selectedIndex = snapshot.selectedIndex; entry.element.dispatchEvent(new Event("change", { bubbles: true })); }
        else if (snapshot.kind === "checkbox") { if (entry.element.checked !== snapshot.checked) entry.element.click(); }
        else if (snapshot.kind === "checkbox_group") { entry.elements.forEach((cb, i) => { if (cb.checked !== snapshot.checked[i]) cb.click(); }); }
        else if (snapshot.kind === "phone_split") { window.FormPilot.applyFillItem({ localId, action: "setValueParts", values: snapshot.values }); }
        else if (snapshot.kind === "radio") { /* leave radios as user had them; nothing forced originally unless one was checked */ }
      } catch { /* best-effort restore */ }
    }
    for (const targets of highlighted.values()) {
      targets.forEach(({ el, prevOutline, prevOffset }) => {
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
        el.removeAttribute("title");
      });
    }
    highlighted.clear();
    const pill = document.querySelector('[data-formpilot-overlay="pill"]');
    if (pill) pill.remove();
  }

  window.FormPilot.overlay = { applyPlan, undo, updatePill };
})();
