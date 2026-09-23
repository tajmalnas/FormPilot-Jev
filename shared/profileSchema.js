// Shared profile schema, key descriptions, and validation.
// Loaded as a plain script (no bundler) in both the options page and the
// background service worker (via importScripts-free ES module import).

export const SCHEMA_VERSION = 1;

export const IDENTITY_DESC = {
  first_name: "Given / first name only",
  middle_name: "Middle name",
  last_name: "Family / last name / surname",
  preferred_name: "Preferred name or nickname",
  date_of_birth: "Date of birth, raw stored value (ISO YYYY-MM-DD)",
  gender: "Gender / sex, e.g. Male, Female, Non-binary, Prefer not to say",
  pronouns: "Personal pronouns, e.g. he/him, she/her, they/them",
  nationality: "Nationality / citizenship, e.g. Indian, American",
  marital_status: "Marital status, e.g. Single, Married",
  veteran_status: "Veteran status, e.g. Not a veteran, Veteran, Prefer not to say",
  disability_status: "Disability status for voluntary EEO disclosure, e.g. No, Yes, Prefer not to say",
  race_ethnicity: "Race / ethnicity for voluntary EEO disclosure"
};

export const CONTACT_DESC = {
  email: "Email address",
  phone_country_code: "Phone country calling code, e.g. +91",
  phone_national: "Phone number without country code, as stored",
  address_line1: "Street address line 1",
  address_line2: "Street address line 2 (apartment, suite, unit)",
  city: "City / town",
  state: "State / province / region",
  postal_code: "Postal / ZIP code",
  country: "Country name",
  country_iso2: "Country 2-letter ISO code, e.g. IN, US"
};

export const LINKS_DESC = {
  linkedin: "LinkedIn profile URL",
  github: "GitHub profile URL",
  portfolio: "Personal portfolio or website URL",
  x: "X (Twitter) profile URL"
};

export const WORK_DESC = {
  current_title: "Current job title",
  current_company: "Current employer name",
  years_experience: "Total years of professional experience (number)",
  notice_period_days: "Notice period in days"
};

export function emptyProfile() {
  return {
    schema_version: SCHEMA_VERSION,
    identity: {
      first_name: "", middle_name: "", last_name: "",
      preferred_name: "", date_of_birth: "", gender: "", pronouns: "",
      nationality: "", marital_status: "", veteran_status: "",
      disability_status: "", race_ethnicity: ""
    },
    contact: {
      email: "", phone_country_code: "", phone_national: "",
      address_line1: "", address_line2: "", city: "", state: "",
      postal_code: "", country: "", country_iso2: ""
    },
    links: { linkedin: "", github: "", portfolio: "", x: "" },
    work: {
      current_title: "", current_company: "", years_experience: "",
      notice_period_days: "", work_authorization: {}
    },
    education: [],
    skills: [],
    languages: [],
    answers: [],
    preferences: [],
    custom: []
  };
}

// Lightweight structural validation (no external deps like zod/ajv, so the
// extension needs no build step). Returns { valid, errors: string[] }.
export function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== "object") {
    return { valid: false, errors: ["Profile must be a JSON object."] };
  }
  const requireObject = (key) => {
    if (profile[key] !== undefined && (typeof profile[key] !== "object" || profile[key] === null || Array.isArray(profile[key]))) {
      errors.push(`"${key}" must be an object.`);
    }
  };
  const requireArray = (key) => {
    if (profile[key] !== undefined && !Array.isArray(profile[key])) {
      errors.push(`"${key}" must be an array.`);
    }
  };

  requireObject("identity");
  requireObject("contact");
  requireObject("links");
  requireObject("work");
  requireArray("education");
  requireArray("skills");
  requireArray("languages");
  requireArray("answers");
  requireArray("preferences");
  requireArray("custom");

  (profile.answers || []).forEach((a, i) => {
    if (!a || !a.id || !a.topic || typeof a.text !== "string") {
      errors.push(`answers[${i}] needs "id", "topic", and "text".`);
    }
  });
  (profile.preferences || []).forEach((p, i) => {
    if (!p || !p.id || !p.statement || typeof p.value !== "boolean") {
      errors.push(`preferences[${i}] needs "id", "statement", and a boolean "value".`);
    }
  });
  (profile.custom || []).forEach((c, i) => {
    if (!c || !c.key || !c.description || c.value === undefined) {
      errors.push(`custom[${i}] needs "key", "description", and "value".`);
    }
  });
  (profile.education || []).forEach((e, i) => {
    if (!e || typeof e !== "object") {
      errors.push(`education[${i}] must be an object.`);
    }
  });

  const hasAnyContact = profile.identity && (profile.identity.first_name || profile.identity.last_name);
  if (!hasAnyContact) {
    errors.push("identity.first_name or identity.last_name should be filled in for FormPilot to be useful.");
  }

  return { valid: errors.length === 0, errors };
}
