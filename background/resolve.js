// Turns Jev answers into concrete values and a fill plan, gated by confidence.
// This file never calls Jev; it only interprets answers already received.

export const THRESHOLDS = {
  choiceGreen: 0.75,
  choiceYellow: 0.5,
  noulGreenHi: 0.8,
  noulGreenLo: 0.2,
  noulYellowHi: 0.65,
  noulYellowLo: 0.35
};

export const COLORS = {
  green: "#22c55e",
  yellow: "#eab308",
  grey: "#9ca3af",
  blue: "#3b82f6"
};

export function normalizeStr(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Tries an exact/normalized match of `value` against a field's options. This
// is only a cheap shortcut for the unambiguous cases (saves a Jev round trip
// for the common "value already equals an option verbatim" case); anything
// it can't confirm safely is left for Jev's Round 2 semantic match rather
// than guessed here. A loose substring/length-diff heuristic used to live
// here but could misfire (e.g. "India" containing-matching "Indiana") — real
// disambiguation like that belongs to Jev, not string heuristics.
export function exactMatchOption(options, value) {
  if (!value || !options || !options.length) return null;
  const target = normalizeStr(value);
  if (!target) return null;

  for (const o of options) {
    if (normalizeStr(o.text) === target) return o.oid;
  }
  // A 2-letter code matching an option that leads with that exact code as
  // its own word, e.g. value "IN" against option text "IN - India" or "IN India".
  if (/^[a-z]{2}$/.test(target)) {
    for (const o of options) {
      const firstWord = normalizeStr(o.text).split(" ")[0];
      if (firstWord === target) return o.oid;
    }
  }
  return null;
}

function choiceColor(confidence) {
  if (confidence >= THRESHOLDS.choiceGreen) return "green";
  if (confidence >= THRESHOLDS.choiceYellow) return "yellow";
  return null; // below threshold -> leave empty
}

function noulColor(v) {
  if (v >= THRESHOLDS.noulGreenHi || v <= THRESHOLDS.noulGreenLo) return "green";
  if (v >= THRESHOLDS.noulYellowHi || v <= THRESHOLDS.noulYellowLo) return "yellow";
  return null;
}

// Applies Round 1 answers. Returns per-field resolution objects describing
// what's known so far and what (if anything) still needs Round 2.
export function applyRound1(answersByKey, fields, bundle) {
  const resolved = new Map(); // globalKey -> resolution

  fields.forEach(({ globalKey, descriptor }) => {
    const ans = answersByKey[globalKey];
    if (!ans || ans.type !== "choice") {
      resolved.set(globalKey, { status: "skip" });
      return;
    }
    const chosen = ans.choice;
    const confidence = ans.confidence ?? 0;
    if (!chosen || chosen === "skip" || confidence < THRESHOLDS.choiceYellow) {
      resolved.set(globalKey, { status: "skip", confidence, probabilities: ans.probabilities });
      return;
    }

    if (descriptor.kind === "checkbox") {
      const value = chosen === "terms_consent" ? false /* human-only by default */ : bundle.preferenceValue[chosen];
      resolved.set(globalKey, {
        status: "checkbox",
        checked: !!value,
        keyUsed: chosen,
        confidence,
        color: chosen === "terms_consent" ? "grey" : choiceColor(confidence),
        probabilities: ans.probabilities
      });
      return;
    }

    if (descriptor.kind === "textarea" && Object.prototype.hasOwnProperty.call(bundle.answerCriteria, chosen)) {
      resolved.set(globalKey, {
        status: "needs-answer-confirm",
        answerId: chosen,
        answerTopic: bundle.answerCriteria[chosen],
        answerText: bundle.answerText[chosen],
        confidence,
        probabilities: ans.probabilities
      });
      return;
    }

    const value = bundle.values[chosen];
    if (value === undefined) {
      resolved.set(globalKey, { status: "skip", confidence, probabilities: ans.probabilities });
      return;
    }

    if (descriptor.options && descriptor.options.length) {
      const oid = exactMatchOption(descriptor.options, value);
      if (oid) {
        resolved.set(globalKey, { status: "select", oid, keyUsed: chosen, value, confidence, color: choiceColor(confidence), probabilities: ans.probabilities });
      } else {
        resolved.set(globalKey, { status: "needs-option-match", keyUsed: chosen, value, confidence, probabilities: ans.probabilities });
      }
      return;
    }

    if (descriptor.kind === "checkbox_group") {
      resolved.set(globalKey, { status: "needs-checkbox-group", keyUsed: chosen, value, confidence, probabilities: ans.probabilities });
      return;
    }

    resolved.set(globalKey, { status: "text", keyUsed: chosen, value, confidence, color: choiceColor(confidence), probabilities: ans.probabilities });
  });

  return resolved;
}

export function applyRound2(resolved, round2AnswersByKey, fields) {
  const fieldByKey = new Map(fields.map((f) => [f.globalKey, f]));

  for (const [globalKey, r] of resolved.entries()) {
    const field = fieldByKey.get(globalKey);
    if (!field) continue;

    if (r.status === "needs-option-match") {
      const ans = round2AnswersByKey[globalKey + "__opt"];
      if (ans && ans.type === "choice" && ans.choice !== "none_match" && (ans.confidence ?? 0) >= THRESHOLDS.choiceYellow) {
        resolved.set(globalKey, { ...r, status: "select", oid: ans.choice, color: choiceColor(ans.confidence), confidence: ans.confidence });
      } else {
        resolved.set(globalKey, { ...r, status: "skip" });
      }
    } else if (r.status === "needs-answer-confirm") {
      const ans = round2AnswersByKey[globalKey + "__ans"];
      const noul = ans && ans.type === "noul" ? ans.noul : (r.confidence >= THRESHOLDS.choiceGreen ? 1 : null);
      if (noul !== null && noul !== undefined && noul >= 0.7) {
        resolved.set(globalKey, { status: "text", keyUsed: r.answerId, value: r.answerText, confidence: noul, color: noulColor(noul) || "yellow" });
      } else {
        resolved.set(globalKey, { status: "skip" });
      }
    } else if (r.status === "needs-checkbox-group") {
      const field2 = field.descriptor;
      const chosenOids = [];
      let bestColor = null;
      (field2.options || []).forEach((o) => {
        const ans = round2AnswersByKey[globalKey + "__opt_" + o.oid];
        if (ans && ans.type === "noul" && ans.noul >= 0.6) {
          chosenOids.push(o.oid);
          const c = noulColor(ans.noul) || "yellow";
          if (c === "yellow") bestColor = bestColor || "yellow";
          else if (!bestColor) bestColor = "green";
        }
      });
      resolved.set(globalKey, chosenOids.length
        ? { status: "checkbox_group", oids: chosenOids, keyUsed: r.keyUsed, color: bestColor || "green" }
        : { status: "skip" });
    }
  }
  return resolved;
}

// Builds the final per-frame fill plan from resolved fields + pre-existing
// (already-filled) fields that were excluded from Jev entirely.
export function buildFillPlan(fields, resolved, keptFields) {
  const plan = [];

  keptFields.forEach(({ frameId, localId }) => {
    plan.push({ frameId, localId, action: "none", color: COLORS.blue, reason: "kept" });
  });

  fields.forEach(({ globalKey, frameId, localId, descriptor }) => {
    const r = resolved.get(globalKey);
    if (!r || r.status === "skip") {
      plan.push({ frameId, localId, action: "none", color: descriptor.required ? COLORS.grey : null, reason: "skip" });
      return;
    }
    if (r.status === "checkbox") {
      plan.push({ frameId, localId, action: "toggle", checked: r.checked, color: COLORS[r.color] || COLORS.grey, keyUsed: r.keyUsed, confidence: r.confidence });
      return;
    }
    if (r.status === "select") {
      if (!r.color) { plan.push({ frameId, localId, action: "none", color: COLORS.grey, reason: "low-confidence" }); return; }
      plan.push({ frameId, localId, action: "selectOption", oid: r.oid, color: COLORS[r.color], keyUsed: r.keyUsed, confidence: r.confidence });
      return;
    }
    if (r.status === "checkbox_group") {
      plan.push({ frameId, localId, action: "toggleGroup", oids: r.oids, color: COLORS[r.color] || COLORS.yellow, keyUsed: r.keyUsed });
      return;
    }
    if (r.status === "text") {
      if (!r.color) { plan.push({ frameId, localId, action: "none", color: COLORS.grey, reason: "low-confidence" }); return; }
      let value = r.value;
      if (descriptor.maxlength && value && value.length > descriptor.maxlength) {
        value = truncateAtSentence(value, descriptor.maxlength);
      }
      plan.push({ frameId, localId, action: "setValue", value, color: COLORS[r.color], keyUsed: r.keyUsed, confidence: r.confidence });
      return;
    }
    plan.push({ frameId, localId, action: "none", color: null, reason: "unresolved" });
  });

  return plan;
}

function truncateAtSentence(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  return lastStop > max * 0.5 ? slice.slice(0, lastStop + 1) : slice;
}
