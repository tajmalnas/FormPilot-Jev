// Framework-safe value writing. Plain code only — no AI involved here.
(function () {
  window.FormPilot = window.FormPilot || {};
  if (window.FormPilot.applyFillItem) return;

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    el.focus();
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }

  function setContentEditable(el, value) {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.blur();
  }

  function setCheckedState(el, checked) {
    if (!!el.checked !== !!checked) el.click();
  }

  function selectNativeOption(entry, oid) {
    const el = entry.element;
    const option = entry.optionsMap.get(oid);
    if (!option) return false;
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function selectRadioOption(entry, oid) {
    const radio = entry.optionsMap.get(oid);
    if (!radio) return false;
    setCheckedState(radio, true);
    return true;
  }

  function applyFillItem(item) {
    const entry = window.FormPilot.fieldMap.get(item.localId);
    if (!entry) return false;

    try {
      switch (item.action) {
        case "setValue": {
          if (entry.contentEditable) setContentEditable(entry.element, item.value);
          else setNativeValue(entry.element, item.value);
          return true;
        }
        case "selectOption": {
          if (entry.element && entry.element.tagName === "SELECT") return selectNativeOption(entry, item.oid);
          return selectRadioOption(entry, item.oid);
        }
        case "toggle": {
          setCheckedState(entry.element, item.checked);
          return true;
        }
        case "toggleGroup": {
          (item.oids || []).forEach((oid) => {
            const cb = entry.optionsMap.get(oid);
            if (cb) setCheckedState(cb, true);
          });
          return true;
        }
        case "setValueParts": {
          (entry.elements || []).forEach((el, i) => {
            if (item.values[i] !== undefined) setNativeValue(el, item.values[i]);
          });
          return true;
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  window.FormPilot.applyFillItem = applyFillItem;
})();
