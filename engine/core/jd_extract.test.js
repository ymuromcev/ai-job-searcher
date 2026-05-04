const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractSchedule,
  extractRequirements,
  extractFromJd,
} = require("./jd_extract.js");

// --- Fixtures (realistic healthcare JD slices) -------------------------------

// 1. Kaiser Permanente — Medical Receptionist (full-time, days, BLS preferred).
const KAISER_RECEPTIONIST = `
TITLE: Medical Receptionist II
LOCATION: Sacramento, CA
DEPARTMENT: Primary Care

Job Summary:
Under direct supervision, greets and registers patients in a friendly,
service-oriented manner.

Schedule: Full-time, day shift, Monday through Friday.

Minimum Qualifications:
- High school diploma or equivalent required
- 1+ years of customer service experience required
- Bilingual Spanish preferred
- BLS certification preferred
- Experience with Epic EHR a plus
`;

// 2. Sutter Health — Patient Service Rep (per diem, evenings/weekends).
const SUTTER_PSR = `
Patient Service Representative — Per Diem

The Patient Service Representative is responsible for scheduling,
registration, and insurance verification across the Sutter Sacramento
campuses.

Hours: Per diem, evening and weekend coverage required.

Required Qualifications:
- HS diploma or GED
- 2+ years experience in a healthcare front-desk role
- CPR certification within 90 days of hire

Preferred:
- Spanish-speaking preferred
- Experience with Epic
`;

// 3. Dignity Health — Front Desk Coordinator (part-time, no shift specified).
const DIGNITY_FRONTDESK = `
Front Desk Coordinator

Position type: Part-time, 24-32 hours/week.

What you'll do:
- Check in patients and verify demographic information
- Collect copays at time of service
- Coordinate provider schedules

Qualifications:
- High school diploma required
- Associate's degree preferred
- 1-2 years of medical office experience required
- BLS preferred
- Knowledge of Cerner is a plus
`;

// 4. Sono Bello — Aesthetic Patient Coordinator (full-time, no shift, sales-y).
const SONO_BELLO = `
Aesthetic Patient Coordinator

Sono Bello, the largest cosmetic surgery specialist in the country,
is hiring an Aesthetic Patient Coordinator for our Sacramento center.

Schedule: Full time, 40 hours per week. Some Saturdays required.

Requirements:
- Bachelor's degree preferred
- 3+ years of consultative sales experience required
- Bilingual a plus (Spanish, Russian, or Mandarin)
- No clinical certification required
`;

// 5. Stonebrook Dental — Dental Receptionist (part-time, RDA NOT required).
const STONEBROOK_DENTAL = `
Dental Office Receptionist — Part Time

About the role:
We are looking for a friendly receptionist to join our small dental practice.

Hours: Part-time, 20 hours per week, daytime only.

Qualifications:
- High school diploma or equivalent
- 6 months of customer service experience
- Familiarity with Dentrix or Open Dental preferred
- RDA license NOT required
`;

// 6. Generic non-healthcare JD (Stripe-like) — should return null/sparse.
const STRIPE_PM = `
Senior Product Manager, Capital

You will own the full product lifecycle for Stripe Capital.

Requirements:
- 7+ years of product management experience at a high-growth company
- Strong analytical skills (SQL, A/B testing)
- Experience with credit products preferred
`;

// 7. Pure JD body with no recognizable schedule signal.
const NO_SCHEDULE = `
We are seeking a dedicated team member to join our growing organization.
Apply on our careers page.
`;

// --- extractSchedule --------------------------------------------------------

test("extractSchedule: Kaiser → Full-time", () => {
  assert.equal(extractSchedule(KAISER_RECEPTIONIST), "Full-time");
});

test("extractSchedule: Sutter Per Diem", () => {
  assert.equal(extractSchedule(SUTTER_PSR), "Per Diem");
});

test("extractSchedule: Dignity Part-time", () => {
  assert.equal(extractSchedule(DIGNITY_FRONTDESK), "Part-time");
});

test("extractSchedule: Sono Bello → Full-time (employment type wins over Saturday hint)", () => {
  assert.equal(extractSchedule(SONO_BELLO), "Full-time");
});

test("extractSchedule: Stonebrook Part-time", () => {
  assert.equal(extractSchedule(STONEBROOK_DENTAL), "Part-time");
});

test("extractSchedule: Stripe PM JD has no employment-type vocabulary → null", () => {
  // No "full-time"/"part-time" signal even though it's clearly a full-time role.
  // Conservative null is correct here — we'd rather under-fill than push a
  // wrong canonical value to Notion.
  assert.equal(extractSchedule(STRIPE_PM), null);
});

test("extractSchedule: empty / nullish input returns null", () => {
  assert.equal(extractSchedule(""), null);
  assert.equal(extractSchedule(null), null);
  assert.equal(extractSchedule(undefined), null);
});

test("extractSchedule: hours-per-week fallback (40 → Full-time)", () => {
  const text = "Position details: 40 hours/week. Benefits include medical and dental.";
  assert.equal(extractSchedule(text), "Full-time");
});

test("extractSchedule: hours-per-week fallback (20 → Part-time)", () => {
  const text = "Schedule: 20 hours per week, mornings.";
  assert.equal(extractSchedule(text), "Part-time");
});

test("extractSchedule: shift-only signal (Days) when no employment type present", () => {
  const text = "We are hiring for the day shift. Compensation: hourly.";
  assert.equal(extractSchedule(text), "Days");
});

test("extractSchedule: PRN match", () => {
  const text = "Position type: PRN. Coverage as needed.";
  assert.equal(extractSchedule(text), "PRN");
});

test("extractSchedule: 'Full time' (no hyphen) also matches", () => {
  const text = "Schedule: Full time, weekdays.";
  assert.equal(extractSchedule(text), "Full-time");
});

// --- extractRequirements ----------------------------------------------------

test("extractRequirements: Kaiser → HS diploma + 1+ years + Spanish + BLS + Epic", () => {
  const out = extractRequirements(KAISER_RECEPTIONIST);
  assert.ok(out, "should produce a non-null summary");
  assert.match(out, /high school diploma/i);
  assert.match(out, /1\+ years/i);
  assert.match(out, /bilingual spanish|spanish/i);
  assert.match(out, /BLS \(preferred\)/);
  assert.match(out, /Epic/);
  // Bullet style
  assert.match(out, /^- /m);
});

test("extractRequirements: Sutter → GED + 2+ years + CPR + Spanish + Epic", () => {
  const out = extractRequirements(SUTTER_PSR);
  assert.ok(out);
  assert.match(out, /GED|hs diploma|ged/i);
  assert.match(out, /2\+ years/i);
  assert.match(out, /CPR/);
  assert.match(out, /spanish/i);
  assert.match(out, /Epic/);
});

test("extractRequirements: Dignity → HS + 1-2 years + BLS + Cerner", () => {
  const out = extractRequirements(DIGNITY_FRONTDESK);
  assert.ok(out);
  assert.match(out, /high school diploma/i);
  assert.match(out, /1-2 years|2 years/i);
  assert.match(out, /BLS \(preferred\)/);
  assert.match(out, /Cerner/);
});

test("extractRequirements: Sono Bello → Bachelor + 3+ years + bilingual", () => {
  const out = extractRequirements(SONO_BELLO);
  assert.ok(out);
  assert.match(out, /bachelor/i);
  assert.match(out, /3\+ years/i);
  assert.match(out, /bilingual/i);
});

test("extractRequirements: Stonebrook → HS + 6 months + Dentrix + Open Dental", () => {
  const out = extractRequirements(STONEBROOK_DENTAL);
  assert.ok(out);
  assert.match(out, /high school diploma/i);
  // 6 months — not years; should NOT match the years pattern.
  assert.doesNotMatch(out, /\bmonths/i);
  assert.match(out, /Dentrix/);
  assert.match(out, /Open Dental/);
});

test("extractRequirements: Stripe PM → 7+ years (no healthcare certs surfaced)", () => {
  // Falls back gracefully on non-healthcare JD: years signal still works,
  // healthcare certs simply don't fire.
  const out = extractRequirements(STRIPE_PM);
  assert.ok(out);
  assert.match(out, /7\+ years/i);
  // Should NOT pull "RN" / "BLS" / etc. out of nowhere.
  assert.doesNotMatch(out, /\bBLS\b/);
  assert.doesNotMatch(out, /\bRN\b/);
});

test("extractRequirements: empty / unrecognized JD returns null", () => {
  assert.equal(extractRequirements(NO_SCHEDULE), null);
  assert.equal(extractRequirements(""), null);
  assert.equal(extractRequirements(null), null);
});

test("extractRequirements: cap at ~500 chars with truncation marker", () => {
  // Build a JD that would produce many bullets to exercise truncation.
  const fat = `
    Required: Bachelor's degree, 5+ years experience.
    BLS required, ACLS preferred, CPR required, PALS preferred.
    CMA preferred, RMA preferred, MA required, CNA preferred.
    Bilingual Spanish required. Bilingual Mandarin preferred.
    Experience with Epic, Cerner, Athena, eClinicalWorks, NextGen, Dentrix preferred.
  `;
  const out = extractRequirements(fat);
  assert.ok(out);
  // Either truncated or under 500 chars — both acceptable. If truncated, the
  // marker bullet must be present.
  assert.ok(out.length <= 510, `length=${out.length}`);
  if (out.length > 480) {
    assert.match(out, /- …$/);
  }
});

test("extractRequirements: required vs preferred strength tagging", () => {
  const text = `
    Requirements:
    - Bachelor's degree required
    - BLS preferred
  `;
  const out = extractRequirements(text);
  assert.ok(out);
  assert.match(out, /Bachelor.*\(required\)/i);
  assert.match(out, /BLS \(preferred\)/);
});

test("extractRequirements: bare 'RN' word-boundary — does NOT match 'WARN' or 'LEARN'", () => {
  const text = "We need someone who can LEARN quickly. WARN signals are common.";
  const out = extractRequirements(text);
  // No certs should fire on this text.
  if (out !== null) {
    assert.doesNotMatch(out, /\bRN\b/);
  }
});

// --- extractFromJd convenience wrapper --------------------------------------

test("extractFromJd: Kaiser → both fields populated", () => {
  const out = extractFromJd(KAISER_RECEPTIONIST);
  assert.equal(out.schedule, "Full-time");
  assert.ok(out.requirements);
});

test("extractFromJd: empty input → both null", () => {
  const out = extractFromJd("");
  assert.deepEqual(out, { schedule: null, requirements: null });
});

test("extractFromJd: stable shape — always {schedule, requirements} keys", () => {
  const out = extractFromJd(NO_SCHEDULE);
  assert.deepEqual(Object.keys(out).sort(), ["requirements", "schedule"]);
});
