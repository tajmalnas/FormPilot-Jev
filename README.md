# FormPilot

A Chrome extension that fills web forms from a profile you save locally, using
Jev (TypeSafe AI) to decide *which* value goes *where*. No build step — load
it as an unpacked extension and it works.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `formpilot` folder.
4. Pin the FormPilot icon to your toolbar (optional).

## Set up

1. Click the FormPilot icon → **Open Settings** (or right-click the icon →
   Options).
2. Under **Profile**, click **Load template** to see the expected shape, edit
   it with your real details (or upload your own `profile.json`), then
   **Validate & Save**.
3. Under **API key**, paste your TypeSafe API key. Leave "Remember" unchecked
   to keep it in memory only (cleared when Chrome fully quits), or check it
   and set a passphrase to keep it encrypted on this device across restarts.
   Click **Save key**, then **Test key** to confirm it works.

## Use it

Go to any page with a form, then either:

- Click the FormPilot icon → **Fill this form**, or
- Press **Alt+Shift+F**.

Fields get colored outlines: **green** = filled confidently, **yellow** =
filled but double-check it, **grey** = left empty (needs your input),
**blue** = already had a value and was left alone. Nothing is ever
auto-submitted — review and submit yourself. Use **Undo** in the popup or the
on-page pill to revert.

## What ships in this version

- Text/email/tel/url/number/search/date/month inputs, textareas,
  `contenteditable` blocks, native `<select>`, radio groups, single
  checkboxes and checkbox groups.
- Two-round Jev decisioning (which profile key fits a field, then which exact
  option/stored answer matches it), confidence gating, and a fill plan
  applied with native setters + real events so React/Vue/Angular forms pick
  it up.
- Requests are batched by actual estimated token size, not a fixed field
  count — a large form (30-40+ fields) combined with a rich profile's
  criteria pool can otherwise blow past TypeSafe's per-request token limit
  (`max_tokens_exceeded`, HTTP 400) in a single call. FormPilot now
  automatically splits into as many parallel Jev calls as needed so large
  forms still fill correctly; it just costs more requests, not less
  accuracy.
- Works inside iframes on the same or different origins (the content script
  is declared for `<all_urls>` in every frame, so no extra permission prompt
  is needed mid-flow).
- Derived values computed in code (never by Jev): full name, phone in a few
  formats, date-of-birth in several formats + age, one-line address, and
  per-entry + "most recent" education fields.
- Undo, per-field tooltips (key used + confidence), and a small status pill.
- Bare `<select>` triplets (Month/Day/Year date-of-birth pickers, and similar)
  are labeled correctly even though they usually have no `<label>` at all —
  the visible "Month"/"Day"/"Year" text is the select's own placeholder
  option, which is now read directly, and the option *values* themselves
  (numbers 1-12, 1-31, 4-digit years, month names) are pattern-matched in
  code as a fallback signal. Without this, three sibling selects that only
  share one group heading ("Date of birth") were indistinguishable to Jev.
- Profile fields for the things job applications actually ask beyond contact
  info: `gender`, `pronouns`, `nationality`, `marital_status`,
  `veteran_status`, `disability_status`, `race_ethnicity`, per-country
  `work.work_authorization` (flattened into Yes/No answers Jev can match a
  radio/dropdown against), and `skills`/`languages` lists (matched precisely
  per checkbox by Jev, not by a fragile comma-split).
- A field asking "Sex" or "Are you authorized to work in the US?" doesn't
  need your profile's *key names* to match the field's wording — Round 1
  already reads the field's label against each key's plain-English
  *description* and picks the best fit semantically. The fixes above are
  about making sure the data exists to be picked, not about teaching it to
  read labels (it already could).
- Phone numbers split across 2-4 boxes (area code / prefix / line number,
  common on US-style forms) are detected and filled directly from the
  profile's digit string — this is arithmetic, so it's done in code rather
  than asking Jev to count and split digits, which the build plan explicitly
  flags as something the model is bad at.
- Tightened option matching: the old "close enough" substring fallback (e.g.
  it could match "India" to "Indiana") was removed. Now an option is either
  matched exactly/normalized in code, or the real decision is left to Jev's
  Round 2 semantic match — no more silent wrong guesses from a string
  heuristic standing in for actual judgment.

## Known limitations (deferred from the full build plan)

- No adapters yet for Google Forms / Workday / Greenhouse / Lever /
  react-select-style custom widgets — those still get *some* fill attempts
  through the generic native-input path, but complex custom dropdowns may
  need manual completion.
- No dynamic re-scan after a field reveals new fields (e.g. "Other, please
  specify") — just press Alt+Shift+F again once new fields appear.
- Multi-select `<select multiple>` and closed shadow roots are skipped.
- The phone-split detector assumes the boxes read left-to-right as
  contiguous digits of the national number (e.g. area code, then prefix,
  then line number) and flags itself yellow when the digit count doesn't
  line up exactly with the boxes' combined length — it doesn't know about a
  separate leading country-code box mixed into the same group.
- No per-site allow/deny list or "sensitive keys always yellow" setting yet.
- No page-level "is this actually a form" gate — FormPilot will attempt any
  page with fillable fields, including logins (it always skips password/OTP/
  card fields, but a login's username field could still get an email filled
  in).
- Uses a broad `<all_urls>` content-script match for simplicity/reliability
  rather than the plan's `activeTab`-triggered injection. Fine for personal
  use; before a Chrome Web Store submission this should switch to the
  narrower on-click injection model described in the build plan.

## File layout

Mirrors `FormPilot-Jev-Build-Plan.md`: `background/` (service worker, Jev
client, question builder, resolver, derived values, storage), `content/`
(scanner, filler, overlay, message router), `options/` and `popup/` (UI),
`shared/` (profile schema + validation).
# FormPilot-Jev
