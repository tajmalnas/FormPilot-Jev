// Turns field descriptors + the profile bundle into Jev questions.
// Round 1: one Choice per field -> which profile/derived/answer/preference key fits.
// Round 2: only for fields that still need an exact option or stored-answer match.

const MAX_OPTIONS_PER_QUESTION = 255;
// A fixed field-count-per-request cap doesn't work: with a rich profile the
// criteria pool routinely reaches 60-80 keys, and each field's question
// carries that whole pool (questions are evaluated in isolation, so each one
// must be self-contained). A wide real-world form (e.g. RoboForm's ~40-field
// test page) can then blow well past the model's token limit even at a
// count of 40. Batch by actual estimated size instead, per the build plan's
// own guidance ("if a round would exceed ~50k tokens, split"). Kept well
// under the documented 64k combined / 32k single-question ceiling to leave
// margin for tokenizer estimation error.
const MAX_TOKENS_PER_REQUEST = 25000;

function isDateLikeKey(key) {
  return /dob|date/i.test(key);
}

function trimCriteria(criteria, mustKeep = []) {
  const entries = Object.entries(criteria);
  if (entries.length <= MAX_OPTIONS_PER_QUESTION) return criteria;
  const kept = entries.filter(([k]) => mustKeep.includes(k));
  const rest = entries.filter(([k]) => !mustKeep.includes(k)).slice(0, MAX_OPTIONS_PER_QUESTION - kept.length);
  return Object.fromEntries([...kept, ...rest]);
}

// Rough char/4 estimate (same heuristic the build plan itself suggests) —
// good enough to stay safely under the real limit, not meant to be exact.
export function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

// Splits a { key: questionObj } map into token-budget-safe chunks. `state`'s
// own token cost is counted against every chunk since it's sent alongside
// each one. A single question that alone exceeds the budget still gets its
// own chunk (nothing more we can do without dropping its content).
export function batchQuestionsByTokens(questionsMap, state, maxTokens = MAX_TOKENS_PER_REQUEST) {
  const stateTokens = estimateTokens(state || {});
  const batches = [];
  let current = {};
  let currentTokens = stateTokens;

  Object.entries(questionsMap).forEach(([key, question]) => {
    const qTokens = estimateTokens(question);
    if (Object.keys(current).length && currentTokens + qTokens > maxTokens) {
      batches.push(current);
      current = {};
      currentTokens = stateTokens;
    }
    current[key] = question;
    currentTokens += qTokens;
  });
  if (Object.keys(current).length) batches.push(current);

  return batches.length ? batches : [{}];
}

// fields: [{ globalKey, frameId, localId, descriptor }]
export function buildRound1Batches(fields, bundle, pageContext) {
  const scalarCriteria = { ...bundle.descriptions };
  const dateCriteria = Object.fromEntries(Object.entries(scalarCriteria).filter(([k]) => isDateLikeKey(k)));

  const state = { page: pageContext || {} };

  const allQuestions = {};
  fields.forEach(({ globalKey, descriptor }) => {
    let criteria;
    if (descriptor.kind === "checkbox") {
      criteria = { ...bundle.preferenceCriteria, terms_consent: "Mandatory terms/privacy/consent agreement", skip: "Nothing in the profile fits" };
    } else if (descriptor.kind === "checkbox_group") {
      criteria = trimCriteria({ ...scalarCriteria, skip: "Nothing in the profile fits" });
    } else if (descriptor.input_type === "date" || descriptor.input_type === "month") {
      criteria = trimCriteria({ ...dateCriteria, skip: "Nothing in the profile fits" });
    } else if (descriptor.kind === "textarea") {
      criteria = trimCriteria({ ...scalarCriteria, ...bundle.answerCriteria, skip: "Nothing in the profile fits" });
    } else {
      criteria = trimCriteria({ ...scalarCriteria, skip: "Nothing in the profile fits" });
    }

    allQuestions[globalKey] = {
      type: "choice",
      instructions: {
        field: {
          label: descriptor.label,
          hints: (descriptor.hints || []).slice(0, 8).map((h) => String(h).slice(0, 200)),
          section: descriptor.section,
          kind: descriptor.kind,
          required: !!descriptor.required
        },
        question: "Which item from the user's profile should be entered into `field`? Pick the option whose meaning and format match `field` exactly. Pick skip if nothing fits or the field should be left for the user."
      },
      criteria
    };
  });

  return batchQuestionsByTokens(allQuestions, state).map((questions) => ({ state, questions }));
}

// needing: [{ globalKey, descriptor, chosenValue }] where descriptor.options exists (select/radio/combobox/checkbox_group)
export function buildOptionMatchQuestions(needing) {
  const questions = {};
  needing.forEach(({ globalKey, descriptor, chosenValue }) => {
    let opts = descriptor.options || [];
    if (opts.length > 50) {
      // pre-filter to top 50 by naive substring/fuzzy relevance to keep requests small
      const needle = String(chosenValue || "").toLowerCase();
      opts = [...opts]
        .sort((a, b) => score(b.text, needle) - score(a.text, needle))
        .slice(0, 50);
    }
    const criteria = {};
    // Defensive: an empty criteria description gets the whole request
    // rejected by TypeSafe (400), so never let a blank slip through here
    // even if some future option source doesn't already guard against it.
    opts.forEach((o) => { criteria[o.oid] = (o.text && o.text.trim() ? o.text : `(option ${o.oid})`).slice(0, 200); });
    criteria.none_match = "No option represents the user's value";

    questions[globalKey] = {
      type: "choice",
      instructions: {
        field_label: descriptor.label,
        user_value: String(chosenValue),
        question: "Which option in this dropdown/group represents `user_value` for the question `field_label`? Pick none_match if no option represents it."
      },
      criteria
    };
  });
  return questions;
}

function score(text, needle) {
  if (!needle) return 0;
  const t = text.toLowerCase();
  if (t === needle) return 100;
  if (t.includes(needle) || needle.includes(t)) return 50;
  const setA = new Set(t.split(/\W+/));
  const setB = new Set(needle.split(/\W+/));
  let overlap = 0;
  setA.forEach((w) => { if (setB.has(w)) overlap++; });
  return overlap;
}

// needing: [{ globalKey, descriptor, answerTopic }]
export function buildAnswerConfirmQuestions(needing) {
  const questions = {};
  needing.forEach(({ globalKey, descriptor, answerTopic }) => {
    questions[globalKey] = {
      type: "noul",
      instructions: {
        question: `Is the stored answer topic \`answer_topic\` an appropriate reply to the field \`field_label\`? Return a high value if yes, low if no.`,
        field_label: descriptor.label,
        answer_topic: answerTopic
      },
      criteria: { true: "The stored answer fits this field", false: "It does not fit" }
    };
  });
  return questions;
}

// needing: [{ globalKey, optionText, chosenValues: string[] }]
export function buildCheckboxGroupQuestions(needing) {
  const questions = {};
  needing.forEach(({ globalKey, optionText, chosenValues }) => {
    questions[globalKey] = {
      type: "noul",
      instructions: {
        question: "Is `option_text` one of the items in `user_values`? Return a high value if yes, low if no.",
        option_text: optionText,
        user_values: chosenValues
      },
      criteria: { true: "It is one of the items", false: "It is not" }
    };
  });
  return questions;
}
