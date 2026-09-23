// Field discovery + label resolution. Runs in every frame (declared via
// manifest content_scripts). Shares state with fill.js/overlay.js/index.js
// through the window.FormPilot namespace.
(function () {
  window.FormPilot = window.FormPilot || {};
  if (window.FormPilot.scan) return; // already loaded in this frame

  const SENSITIVE_NAME_RE = /otp|one.?time|cvv|card.?number|card.?num|security.?code/i;
  const TEXT_INPUT_TYPES = new Set(["text", "email", "tel", "url", "number", "search", "date", "month", ""]);

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function isOverlayEl(el) {
    return !!el.closest("[data-formpilot-overlay]");
  }

  function deCamel(s) {
    return String(s || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function textOf(el) {
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function labelFromFor(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return textOf(lab);
    }
    const wrap = el.closest("label");
    if (wrap) return textOf(wrap);
    return "";
  }

  function labelFromAria(el) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    return el.getAttribute("aria-label") || "";
  }

  function nearestSectionHeading(el) {
    let node = el;
    for (let depth = 0; depth < 6 && node; depth++) {
      let sib = node.previousElementSibling;
      let hops = 0;
      while (sib && hops < 6) {
        if (/^H[1-6]$/.test(sib.tagName) || sib.tagName === "LEGEND" || sib.getAttribute?.("role") === "heading") {
          const t = textOf(sib);
          if (t && t.length <= 100) return t;
        }
        sib = sib.previousElementSibling;
        hops++;
      }
      node = node.parentElement;
    }
    return undefined;
  }

  // A native <select> for "Month"/"Day"/"Year" almost never has its own
  // <label> — the text the user sees IS the select's own first/placeholder
  // option. Without this, three sibling selects that only share a group
  // heading ("Date of birth") are indistinguishable to Jev. Skip generic
  // placeholders ("Select...", "Choose one") since those add no signal.
  function selectPlaceholderLabel(el) {
    if (el.tagName !== "SELECT" || !el.options.length) return "";
    const first = el.options[0];
    // Only trust this as a label when it's structurally a placeholder option
    // (empty value or disabled) — otherwise a normal list that just happens
    // to start alphabetically (e.g. a country select starting "Afghanistan")
    // would get mislabeled with its first real option instead of falling
    // through to a proper label/section heading.
    if (first.value !== "" && !first.disabled) return "";
    const text = (first.textContent || "").trim();
    if (!text || !/[a-z]/i.test(text)) return ""; // purely numeric first option isn't a label, it's a value
    if (/^(select|choose|please select|--|\.\.\.)/i.test(text)) return "";
    return text;
  }

  const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  // When a select's label is weak or missing (common for bare Month/Day/Year
  // triplets), the option *values themselves* are still a strong structural
  // signal — a code-only inference that gives Jev something concrete to
  // reason about instead of leaving it guessing from nothing.
  function inferOptionPatternHint(options) {
    const texts = options.map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|--|\.\.\.)/i.test(t));
    if (texts.length < 3) return null;

    if (texts.every((t) => /^\d{1,4}$/.test(t))) {
      const nums = texts.map(Number);
      const max = Math.max(...nums), min = Math.min(...nums);
      if (max <= 12 && texts.length <= 12) return "options are numbers 1-12, likely a month selector";
      if (max <= 31 && texts.length >= 15) return "options are numbers up to 31, likely a day-of-month selector";
      if (min >= 1900 && max <= 2100) return "options are 4-digit years, likely a year selector";
    }
    if (texts.length >= 10 && texts.length <= 12 && texts.every((t) => MONTH_ABBR.some((m) => t.toLowerCase().startsWith(m)))) {
      return "options are month names, likely a month selector";
    }
    return null;
  }

  function resolveLabelAndHints(el) {
    const hints = [];
    const forLabel = labelFromFor(el);
    const ariaLabel = labelFromAria(el);
    const selectPlaceholder = selectPlaceholderLabel(el);
    const placeholder = el.getAttribute("placeholder") || "";
    const title = el.getAttribute("title") || "";
    const name = el.getAttribute("name") || "";
    const id = el.id || "";
    const autocomplete = el.getAttribute("autocomplete") || "";

    if (selectPlaceholder) hints.push(`select shows: ${selectPlaceholder}`);
    if (placeholder) hints.push(`placeholder: ${placeholder}`);
    if (autocomplete) hints.push(`autocomplete: ${autocomplete}`);
    if (name) hints.push(`name: ${name}`);
    if (id) hints.push(`id: ${id}`);
    if (title) hints.push(`title: ${title}`);

    const label =
      forLabel || ariaLabel || selectPlaceholder || nearestSectionHeading(el) || placeholder || title ||
      deCamel(name) || deCamel(id) || deCamel(autocomplete) || "Untitled field";

    return { label: label.slice(0, 200), hints };
  }

  function isRequired(el, label) {
    return !!(el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label));
  }

  function collectAllCandidates(root, out) {
    root.querySelectorAll(
      'input, textarea, select, [contenteditable="true"]'
    ).forEach((el) => out.push(el));
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) collectAllCandidates(el.shadowRoot, out);
    });
  }

  function buildOptionsFromSelect(select) {
    // oid encodes the option's real index (assigned before filtering) so
    // fill-time lookup (el.options[index]) still works after blanks are
    // dropped. A truly blank option (no text, no value) is a common native
    // placeholder slot, not a real selectable answer — sending it to Jev as
    // an empty-string criteria description gets the whole request rejected.
    return [...select.options]
      .map((o, i) => ({ oid: `o${i}`, text: (o.textContent || o.value || "").trim().slice(0, 200), value: o.value }))
      .filter((o) => o.text.length > 0);
  }

  function radioGroupLabel(radio) {
    return labelFromFor(radio) || labelFromAria(radio) || textOf(radio.nextElementSibling) || radio.value || "";
  }

  const PHONE_GROUP_RE = /phone|mobile|contact.?(no|number)|tel(ephone)?\b/i;

  // Some sites split a phone number across 2-4 short boxes (area code /
  // prefix / line number, or country code + number). Jev is unreliable at
  // counting/splitting digits, so this is detected and handled entirely in
  // code: grouped boxes become one "phone_split" descriptor and the actual
  // splitting happens at fill time from the profile's digit string.
  function detectPhoneGroups(candidates) {
    const qualifying = candidates.filter((el) => {
      if (el.tagName !== "INPUT") return false;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (!["text", "tel", "number", ""].includes(type)) return false;
      if (!isVisible(el) || el.disabled || el.readOnly) return false;
      return el.maxLength >= 2 && el.maxLength <= 4;
    });
    if (qualifying.length < 2) return { descriptors: [], consumed: new Set() };

    function groupBy(getKey) {
      const map = new Map();
      qualifying.forEach((el) => {
        const key = getKey(el);
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(el);
      });
      return map;
    }

    const consumed = new Set();
    const groups = [];

    function tryGroups(map) {
      for (const [container, els] of map.entries()) {
        if (els.length < 2 || els.length > 4) continue;
        if (els.some((e) => consumed.has(e))) continue;
        const hintText = [
          textOf(container),
          ...els.map((e) => `${e.getAttribute("placeholder") || ""} ${e.getAttribute("name") || ""} ${e.getAttribute("id") || ""} ${e.getAttribute("autocomplete") || ""}`)
        ].join(" ");
        const sectionText = nearestSectionHeading(container) || "";
        if (!PHONE_GROUP_RE.test(hintText) && !PHONE_GROUP_RE.test(sectionText)) continue;
        const sorted = els.slice().sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        sorted.forEach((e) => consumed.add(e));
        groups.push(sorted);
      }
    }

    tryGroups(groupBy((el) => el.parentElement));
    tryGroups(groupBy((el) => el.parentElement && el.parentElement.parentElement));

    const descriptors = groups.map((sorted) => {
      const { label, hints } = resolveLabelAndHints(sorted[0]);
      return {
        kind: "phone_split",
        label: label && label !== "Untitled field" ? label : "Phone number",
        hints,
        section: nearestSectionHeading(sorted[0]),
        required: sorted.some((e) => isRequired(e, label)),
        parts: sorted.map((e) => e.maxLength),
        elements: sorted
      };
    });

    return { descriptors, consumed };
  }

  function scanFrame() {
    const fields = [];
    const fieldMap = new Map();
    const preFill = new Map();

    const candidates = [];
    collectAllCandidates(document.body || document.documentElement, candidates);

    const { descriptors: phoneGroupDescriptors, consumed: phoneConsumed } = detectPhoneGroups(candidates);
    phoneGroupDescriptors.forEach(({ elements, ...descriptor }) => {
      const localId = fields.length;
      fields.push(descriptor);
      fieldMap.set(localId, { elements });
      preFill.set(localId, { kind: "phone_split", values: elements.map((e) => e.value) });
    });

    const handledRadioGroups = new Set();
    const handledCheckboxGroups = new Set();

    for (const el of candidates) {
      if (phoneConsumed.has(el)) continue;
      if (isOverlayEl(el) || !isVisible(el)) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.getAttribute("aria-hidden") === "true") continue;

      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();

      if (tag === "INPUT" && (type === "hidden" || type === "password" || type === "submit" || type === "button" || type === "reset" || type === "image")) continue;

      const nameAttr = el.getAttribute("name") || el.id || "";
      if (SENSITIVE_NAME_RE.test(nameAttr) || el.getAttribute("autocomplete") === "one-time-code") continue;

      if (tag === "INPUT" && type === "radio") {
        const groupKey = nameAttr || el.closest("[role=radiogroup], fieldset")?.outerHTML.slice(0, 50) || Math.random();
        if (handledRadioGroups.has(groupKey)) continue;
        handledRadioGroups.add(groupKey);
        const group = nameAttr
          ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(nameAttr)}"]`)].filter(isVisible)
          : [el];
        if (!group.length) continue;
        const { label, hints } = resolveLabelAndHints(group[0]);
        const options = group.map((r, i) => ({ oid: `o${i}`, text: radioGroupLabel(r).slice(0, 200) || `Option ${i + 1}` }));
        const localId = fields.length;
        fields.push({
          kind: "radio", label, hints, section: nearestSectionHeading(group[0]),
          required: group.some((r) => isRequired(r, label)), options,
          current_value: group.find((r) => r.checked) ? "checked" : undefined
        });
        fieldMap.set(localId, { elements: group, optionsMap: new Map(group.map((r, i) => [`o${i}`, r])) });
        preFill.set(localId, { kind: "radio", checkedValue: group.find((r) => r.checked)?.value });
        continue;
      }

      if (tag === "INPUT" && type === "checkbox") {
        const siblings = nameAttr ? [...document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(nameAttr)}"]`)].filter(isVisible) : [el];
        if (siblings.length > 1) {
          if (handledCheckboxGroups.has(nameAttr)) continue;
          handledCheckboxGroups.add(nameAttr);
          const { label, hints } = resolveLabelAndHints(siblings[0]);
          const options = siblings.map((c, i) => ({ oid: `o${i}`, text: (labelFromFor(c) || labelFromAria(c) || textOf(c.nextElementSibling) || c.value || `Option ${i + 1}`).slice(0, 200) }));
          const localId = fields.length;
          fields.push({ kind: "checkbox_group", label, hints, section: nearestSectionHeading(siblings[0]), required: false, options });
          fieldMap.set(localId, { elements: siblings, optionsMap: new Map(siblings.map((c, i) => [`o${i}`, c])) });
          preFill.set(localId, { kind: "checkbox_group", checked: siblings.map((c) => c.checked) });
          continue;
        }
        const { label, hints } = resolveLabelAndHints(el);
        const localId = fields.length;
        fields.push({ kind: "checkbox", label, hints, section: nearestSectionHeading(el), required: isRequired(el, label), current_value: el.checked ? "checked" : undefined });
        fieldMap.set(localId, { element: el });
        preFill.set(localId, { kind: "checkbox", checked: el.checked });
        continue;
      }

      if (tag === "SELECT") {
        if (el.multiple) continue; // custom multi-select handling is out of scope for v1
        const { label, hints } = resolveLabelAndHints(el);
        const options = buildOptionsFromSelect(el);
        const patternHint = inferOptionPatternHint(options);
        if (patternHint) hints.push(patternHint);
        const localId = fields.length;
        fields.push({
          kind: "select", label, hints, section: nearestSectionHeading(el),
          required: isRequired(el, label), options,
          current_value: el.selectedIndex > 0 ? el.value : undefined
        });
        fieldMap.set(localId, { element: el, optionsMap: new Map(options.map((o) => [o.oid, el.options[Number(o.oid.slice(1))]])) });
        preFill.set(localId, { kind: "select", selectedIndex: el.selectedIndex });
        continue;
      }

      if (tag === "TEXTAREA" || el.getAttribute("contenteditable") === "true") {
        const { label, hints } = resolveLabelAndHints(el);
        const isCE = el.getAttribute("contenteditable") === "true";
        const currentVal = isCE ? el.textContent.trim() : el.value.trim();
        const localId = fields.length;
        fields.push({
          kind: "textarea", input_type: isCE ? "contenteditable" : undefined,
          label, hints, section: nearestSectionHeading(el), required: isRequired(el, label),
          maxlength: el.maxLength > 0 ? el.maxLength : undefined,
          current_value: currentVal || undefined
        });
        fieldMap.set(localId, { element: el, contentEditable: isCE });
        preFill.set(localId, { kind: "textarea", value: isCE ? el.textContent : el.value });
        continue;
      }

      if (tag === "INPUT" && (TEXT_INPUT_TYPES.has(type) || type === "date" || type === "month")) {
        const { label, hints } = resolveLabelAndHints(el);
        const localId = fields.length;
        fields.push({
          kind: "text", input_type: type || "text",
          label, hints, section: nearestSectionHeading(el), required: isRequired(el, label),
          pattern: el.getAttribute("pattern") || undefined,
          maxlength: el.maxLength > 0 ? el.maxLength : undefined,
          current_value: el.value.trim() || undefined
        });
        fieldMap.set(localId, { element: el });
        preFill.set(localId, { kind: "text", value: el.value });
        continue;
      }

      if (tag === "INPUT" && type === "file") {
        const { label, hints } = resolveLabelAndHints(el);
        const localId = fields.length;
        fields.push({ kind: "file", label, hints, section: nearestSectionHeading(el), required: isRequired(el, label) });
        fieldMap.set(localId, { element: el });
        continue;
      }
    }

    window.FormPilot.fieldMap = fieldMap;
    window.FormPilot.preFill = preFill;

    const pageContext = {
      title: (document.title || "").slice(0, 200),
      host: location.host,
      main_heading: textOf(document.querySelector("h1")).slice(0, 200) || undefined,
      form_heading: textOf(document.querySelector('form h1, form h2, [role="heading"]')).slice(0, 200) || undefined
    };

    return { fields, pageContext };
  }

  window.FormPilot.scan = scanFrame;
})();
