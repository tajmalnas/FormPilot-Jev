// Builds every value FormPilot can type, plus a human description for each,
// from the raw profile. Jev never invents values or does arithmetic; it only
// ever picks among the keys produced here.
import { IDENTITY_DESC, CONTACT_DESC, LINKS_DESC, WORK_DESC } from "../shared/profileSchema.js";

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function pad2(n) { return String(n).padStart(2, "0"); }

function parseISODate(s) {
  if (!s || typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  return { y: Number(y), mo: Number(mo), d: Number(d) };
}

function computeAge(dob) {
  if (!dob) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.y;
  const hadBirthdayThisYear =
    today.getMonth() + 1 > dob.mo ||
    (today.getMonth() + 1 === dob.mo && today.getDate() >= dob.d);
  if (!hadBirthdayThisYear) age -= 1;
  return age;
}

function buildDerivedDates(dobRaw) {
  const dob = parseISODate(dobRaw);
  const values = {};
  const descriptions = {};
  if (dob) {
    values.dob_iso = dobRaw;
    values.dob_dd_mm_yyyy = `${pad2(dob.d)}/${pad2(dob.mo)}/${dob.y}`;
    values.dob_mm_dd_yyyy = `${pad2(dob.mo)}/${pad2(dob.d)}/${dob.y}`;
    values.dob_day = String(dob.d);
    values.dob_day_padded = pad2(dob.d);
    values.dob_month_number = String(dob.mo);
    values.dob_month_number_padded = pad2(dob.mo);
    values.dob_month_name = MONTH_NAMES[dob.mo - 1] || "";
    values.dob_month_name_short = (MONTH_NAMES[dob.mo - 1] || "").slice(0, 3);
    values.dob_year = String(dob.y);
    const age = computeAge(dob);
    if (age !== null) values.age = String(age);
  }
  descriptions.dob_iso = "Date of birth, ISO format YYYY-MM-DD";
  descriptions.dob_dd_mm_yyyy = "Date of birth, DD/MM/YYYY";
  descriptions.dob_mm_dd_yyyy = "Date of birth, MM/DD/YYYY";
  descriptions.dob_day = "Day of month of date of birth, no leading zero, e.g. 5";
  descriptions.dob_day_padded = "Day of month of date of birth, zero-padded, e.g. 05";
  descriptions.dob_month_number = "Month number of date of birth, no leading zero, e.g. 4";
  descriptions.dob_month_number_padded = "Month number of date of birth, zero-padded, e.g. 04";
  descriptions.dob_month_name = "Month name of date of birth, e.g. April";
  descriptions.dob_month_name_short = "Month abbreviation of date of birth, e.g. Apr";
  descriptions.dob_year = "Birth year";
  descriptions.age = "Current age in years";
  return { values, descriptions };
}

function buildDerivedPhone(countryCode, national) {
  const values = {};
  const descriptions = {
    phone_e164: "Phone number with + country code, no spaces",
    phone_with_code_spaced: "Phone number with country code, spaced",
    phone_national_only: "Phone number without country code"
  };
  let digits = "";
  if (national) {
    digits = national.replace(/[^\d]/g, "");
    values.phone_national_only = national;
    if (countryCode) {
      const cc = countryCode.startsWith("+") ? countryCode : `+${countryCode}`;
      values.phone_e164 = `${cc}${digits}`;
      values.phone_with_code_spaced = `${cc} ${national}`;
    }
  }
  // Exposed for splitting a national number across a multi-box phone field
  // (see content/scan.js "phone_split" detection) — never sent to Jev.
  return { values, descriptions, digits };
}

function buildDerivedName(identity) {
  const values = {};
  const descriptions = {
    full_name: "Full name (first + last)",
    full_name_last_first: "Full name, last name first (\"Last, First\")"
  };
  const first = identity.first_name || "";
  const last = identity.last_name || "";
  if (first || last) {
    values.full_name = [first, identity.middle_name, last].filter(Boolean).join(" ");
    values.full_name_last_first = [last, first].filter(Boolean).join(", ");
  }
  return { values, descriptions };
}

function buildDerivedAddress(contact) {
  const parts = [
    contact.address_line1, contact.address_line2, contact.city,
    contact.state, contact.postal_code, contact.country
  ].filter(Boolean);
  return {
    values: parts.length ? { address_single_line: parts.join(", ") } : {},
    descriptions: { address_single_line: "Full address as one line" }
  };
}

function mostRecentIndex(education) {
  let bestIdx = -1, bestYear = -Infinity;
  education.forEach((e, i) => {
    const y = Number(e.end_year) || -Infinity;
    if (y >= bestYear) { bestYear = y; bestIdx = i; }
  });
  return bestIdx;
}

function buildDerivedEducation(education) {
  const values = {};
  const descriptions = {};
  if (!Array.isArray(education) || education.length === 0) return { values, descriptions };

  const fields = ["degree", "field", "institution", "end_year"];
  const fieldDesc = {
    degree: "Degree name (e.g. BTech, MSc)",
    field: "Field of study / major",
    institution: "Institution / university name",
    end_year: "Graduation year"
  };

  education.forEach((e, i) => {
    fields.forEach((f) => {
      if (e[f] !== undefined && e[f] !== "") {
        const key = `education_${i + 1}_${f}`;
        values[key] = String(e[f]);
        descriptions[key] = `${fieldDesc[f]} (education entry ${i + 1})`;
      }
    });
  });

  const latestIdx = mostRecentIndex(education);
  if (latestIdx >= 0) {
    const latest = education[latestIdx];
    fields.forEach((f) => {
      if (latest[f] !== undefined && latest[f] !== "") {
        const key = `latest_degree_${f === "field" ? "field" : f}`;
        values[key] = String(latest[f]);
        descriptions[key] = `${fieldDesc[f]} (most recent education entry)`;
      }
    });
  }
  return { values, descriptions };
}

const COUNTRY_NAMES = {
  us: "the United States", in: "India", gb: "the United Kingdom", ca: "Canada",
  au: "Australia", de: "Germany", fr: "France", ae: "the UAE", sg: "Singapore"
};

// Work authorization is a country -> boolean map on the profile, e.g.
// { "US": true, "IN": false }. Flattened here into plain "Yes"/"No" values
// (not booleans) so an exact-text match against a Yes/No radio/select
// succeeds without needing a Jev round trip for something this simple.
function buildDerivedWorkAuth(workAuthorization) {
  const values = {};
  const descriptions = {};
  Object.entries(workAuthorization || {}).forEach(([iso2, authorized]) => {
    const code = iso2.toLowerCase();
    const key = `work_authorized_${code}`;
    values[key] = authorized ? "Yes" : "No";
    descriptions[key] = `Authorized to work in ${COUNTRY_NAMES[code] || iso2.toUpperCase()} (Yes/No)`;
  });
  return { values, descriptions };
}

// Skills/languages are list-valued: exposed both as a joined string (for a
// single free-text field asking "list your skills") and as a real array
// (listValues) so checkbox-group matching in Round 2 checks each item
// precisely instead of re-splitting a comma-joined string.
function buildDerivedLists(profile) {
  const values = {};
  const descriptions = {};
  const listValues = {};
  const addList = (key, items, description) => {
    const clean = (items || []).map((s) => String(s).trim()).filter(Boolean);
    if (!clean.length) return;
    listValues[key] = clean;
    values[key] = clean.join(", ");
    descriptions[key] = description;
  };
  addList("skills", profile.skills, "List of the candidate's professional skills");
  addList("languages", profile.languages, "List of languages the candidate speaks");
  return { values, descriptions, listValues };
}

// Combines raw profile scalars + derived values into one flat pool, plus a
// parallel description map. Also returns answer/preference/custom pools
// separately since Round 1 offers them only to specific field kinds.
export function computeProfileBundle(profile) {
  const values = {};
  const descriptions = {};
  const listValues = {};

  const addSection = (section, descMap) => {
    Object.entries(section || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "" && typeof v !== "object") {
        values[k] = String(v);
        descriptions[k] = descMap[k] || k;
      }
    });
  };

  addSection(profile.identity, IDENTITY_DESC);
  addSection(profile.contact, CONTACT_DESC);
  addSection(profile.links, LINKS_DESC);
  addSection(profile.work, WORK_DESC);

  (profile.custom || []).forEach((c) => {
    if (c && c.key) {
      values[c.key] = String(c.value);
      descriptions[c.key] = c.description || c.key;
    }
  });

  const name = buildDerivedName(profile.identity || {});
  const dates = buildDerivedDates((profile.identity || {}).date_of_birth);
  const phone = buildDerivedPhone((profile.contact || {}).phone_country_code, (profile.contact || {}).phone_national);
  const address = buildDerivedAddress(profile.contact || {});
  const education = buildDerivedEducation(profile.education || []);
  const workAuth = buildDerivedWorkAuth((profile.work || {}).work_authorization);
  const lists = buildDerivedLists(profile);

  [name, dates, phone, address, education, workAuth, lists].forEach(({ values: v, descriptions: d }) => {
    Object.assign(values, v);
    Object.assign(descriptions, d);
  });
  Object.assign(listValues, lists.listValues);

  const answerCriteria = {};
  const answerText = {};
  (profile.answers || []).forEach((a) => {
    if (a && a.id) { answerCriteria[a.id] = a.topic; answerText[a.id] = a.text; }
  });

  const preferenceCriteria = {};
  const preferenceValue = {};
  (profile.preferences || []).forEach((p) => {
    if (p && p.id) { preferenceCriteria[p.id] = p.statement; preferenceValue[p.id] = !!p.value; }
  });

  return { values, descriptions, listValues, phoneDigits: phone.digits, answerCriteria, answerText, preferenceCriteria, preferenceValue };
}
