const { test } = require("node:test");
const assert = require("node:assert/strict");

const { classify } = require("./classifier.js");

test("classify: rejection phrases → REJECTION", () => {
  const cases = [
    "Unfortunately, we have decided to move forward with other candidates.",
    "We won't be moving forward with your application at this time.",
    "After careful consideration, we have chosen another candidate.",
    "The position has been filled.",
    "We're not proceeding with your application.",
  ];
  for (const body of cases) {
    const r = classify({ subject: "Application update", body });
    assert.equal(r.type, "REJECTION", `failed: ${body}`);
    assert.ok(r.evidence, "evidence missing");
  }
});

test("classify: interview invites → INTERVIEW_INVITE", () => {
  const cases = [
    "We'd like to schedule a phone screen with you next week.",
    "Could you share your availability for an interview?",
    "Please book a time on my Calendly.",
    // Replaced 2026-05-12: original case was "Next steps in the process:
    // a 30-minute chat." which relied on the /next steps in (the|our)
    // (process|interview)/i pattern. That pattern was dropped because it
    // fired on ACK boilerplate (Tyson & Mendes regression below). The
    // replacement uses the `invite you to a chat` pattern that survived.
    "We invite you for a phone screen this week.",
  ];
  for (const body of cases) {
    const r = classify({ subject: "Next steps", body });
    assert.equal(r.type, "INTERVIEW_INVITE", `failed: ${body}`);
  }
});

test("classify: assessments / challenges → INFO_REQUEST", () => {
  const r1 = classify({
    subject: "Assessment link",
    body: "Please complete the following assessment.",
  });
  assert.equal(r1.type, "INFO_REQUEST");
  const r2 = classify({ subject: "Take-home", body: "Here is your take-home coding challenge." });
  assert.equal(r2.type, "INFO_REQUEST");
});

test("classify: application acknowledgments → ACKNOWLEDGMENT", () => {
  const r = classify({
    subject: "Thank you for applying",
    body: "We have received your application and it's under review.",
  });
  assert.equal(r.type, "ACKNOWLEDGMENT");
});

test("classify: empty/unknown → OTHER", () => {
  assert.equal(classify({ subject: "", body: "" }).type, "OTHER");
  assert.equal(classify({}).type, "OTHER");
  assert.equal(classify({ subject: "Hello", body: "Just checking in." }).type, "OTHER");
});

test("classify: rejection beats interview when both present (first-match wins)", () => {
  const r = classify({
    subject: "Interview update",
    body: "Unfortunately we will not be scheduling an interview.",
  });
  assert.equal(r.type, "REJECTION");
});

test("classify: evidence contains matched phrase", () => {
  const r = classify({ subject: "Update", body: "Unfortunately, not a match." });
  assert.equal(r.type, "REJECTION");
  assert.match(r.evidence, /unfortunately/i);
});

// Regression: 2026-04-30. Headway rejection ("we've decided not to move
// forward with your application") was classified as OTHER because none of the
// patterns covered "decided not to move forward" / "not to move forward".
test("classify: 'decided not to move forward' → REJECTION (Headway pattern)", () => {
  const r = classify({
    subject: "Thank you from Headway",
    body:
      "While we appreciate your interest, after careful review we've decided " +
      "not to move forward with your application at this time.",
  });
  assert.equal(r.type, "REJECTION");
});

test("classify: 'will not be moving forward' → REJECTION", () => {
  const r = classify({
    subject: "Update",
    body: "We will not be moving forward with your candidacy.",
  });
  assert.equal(r.type, "REJECTION");
});

test("classify: 'application was not selected' → REJECTION", () => {
  const r = classify({
    subject: "In regards to your application",
    body: "After review by our team, your application was not selected for further consideration.",
  });
  assert.equal(r.type, "REJECTION");
});

// Regression: 2026-04-30 incident. ATS confirmation emails (Greenhouse, Ashby,
// Figma, Lever) all contain the boilerplate "If you are not selected for this
// position, keep an eye on our jobs page". The bare /not selected/i pattern
// caught this conditional and incorrectly produced REJECTION. After fix:
// /not selected/i removed; the more specific /your application was not
// selected/i kept. These 5 fixtures are real production emails from the
// 2026-04-30 mis-classification incident. See incidents.md.
test("classify: ATS confirmation 'if you are not selected' → ACKNOWLEDGMENT (incident 2026-04-30)", () => {
  const fixtures = [
    {
      label: "Headway (Greenhouse)",
      subject: "Thank you for applying to Headway",
      body:
        "Thank you for your interest in Headway! We have received your application " +
        "for Senior Product Manager, Client Engagement and are delighted that you " +
        "would consider joining our team.\n\n" +
        "The Recruiting team will review your application and will be in touch if " +
        "your qualifications match our needs at this time. If you are not selected " +
        "for this position, keep an eye on our careers page.",
    },
    {
      label: "Hopper (Ashby)",
      subject: "Jared, thanks for applying to Hopper!",
      body:
        "Thank you for your interest in joining the team at Hopper! We truly " +
        "appreciate the time and effort you put into submitting your application. " +
        "We will be in touch if your qualifications match our needs for the role. " +
        "If you are not selected for this position, keep an eye on our careers page.",
    },
    {
      label: "Figma (Greenhouse) — AI Platform",
      subject: "Thank you for your application to Figma",
      body:
        "Thank you for your interest in Figma! We wanted to let you know we received " +
        "your application for Product Manager, AI Platform, and we are delighted " +
        "that you would consider joining our team. While we're not able to respond " +
        "to every applicant, our recruiting team will contact you if your skills and " +
        "experience are a strong match for the role. If you are not selected for " +
        "this position, keep an eye on our jobs page.",
    },
    {
      label: "Figma (Greenhouse) — Figma Weave",
      subject: "Thank you for your application to Figma",
      body:
        "Thank you for your interest in Figma! We wanted to let you know we received " +
        "your application for Product Manager, Figma Weave (New York, United States). " +
        "If you are not selected for this position, keep an eye on our jobs page.",
    },
    {
      label: "WHOOP (Lever)",
      subject: "Thank you for your application to WHOOP",
      body:
        "Thank you for your interest in WHOOP! We wanted to let you know we received " +
        "your application for our Senior Product Manager, AI role. We will review " +
        "your application and get in touch if your qualifications match our needs " +
        "for the role. If you are not selected for this position, keep an eye on our " +
        "jobs page.",
    },
  ];
  for (const f of fixtures) {
    const r = classify({ subject: f.subject, body: f.body });
    assert.equal(
      r.type,
      "ACKNOWLEDGMENT",
      `${f.label}: expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
    );
  }
});

test("classify: specific 'your application was not selected' still caught (no regression)", () => {
  const r = classify({
    subject: "Update on your application",
    body: "After careful consideration, your application was not selected at this time.",
  });
  assert.equal(r.type, "REJECTION");
});

// Regression: Lilia incident 2026-05-02. Indeed match-alert digests embed
// raw JD body text. The bare /\binterview\b/, /\bavailability\b/,
// /\bquestionnaire\b/, /\bassessment\b/ patterns matched JD prose like
// "competitive interview process" / "share your availability for the
// shift" / "skills assessment included" / "personality questionnaire".
// These produced 7+ false INTERVIEW_INVITE / INFO_REQUEST classifications
// which then mutated Notion statuses on unrelated pipeline rows.
//
// After fix: patterns require explicit invite/request CONTEXT.
// Sender-allowlist (isJobAlert) catches the digests upstream too, but the
// classifier must be safe even on raw JD-like text that slips through.
test("classify: JD body 'interview process' (not invite) → OTHER (Lilia incident)", () => {
  const fixtures = [
    "Our hiring process includes a competitive interview process and skills evaluation.",
    "We expect successful candidates to navigate a multi-stage interview process.",
    "About the role: collaborative team, hybrid schedule, structured interview process.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Medical Receptionist - Roseville", body });
    assert.equal(
      r.type,
      "OTHER",
      `expected OTHER for: "${body}", got ${r.type} (evidence: "${r.evidence}")`
    );
  }
});

test("classify: JD body 'availability' (shift/role context, not invite) → OTHER", () => {
  const fixtures = [
    "Schedule: Monday-Friday. Must have weekend availability as needed.",
    "Open availability required for evening and weekend shifts.",
    "Position requires flexible availability across multiple clinic locations.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Front Desk - Sutter Health", body });
    assert.equal(
      r.type,
      "OTHER",
      `expected OTHER for: "${body}", got ${r.type} (evidence: "${r.evidence}")`
    );
  }
});

test("classify: JD body 'assessment' / 'questionnaire' (job context) → OTHER", () => {
  const fixtures = [
    "Duties include patient intake assessment and benefits verification.",
    "Conduct initial assessment of patient needs and route to appropriate provider.",
    "Help patients complete intake questionnaire prior to their appointment.",
    "Annual skills assessment is part of our continuing-education program.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Medical Office Coordinator", body });
    assert.equal(
      r.type,
      "OTHER",
      `expected OTHER for: "${body}", got ${r.type} (evidence: "${r.evidence}")`
    );
  }
});

// Positive controls — real interview invites must STILL match after tightening.
test("classify: real interview invites still match after tightening", () => {
  const fixtures = [
    "Hi Lilia, we'd like to schedule an interview with you next Tuesday.",
    "Please share your availability for a 30-minute call this week.",
    "Your interview is on Thursday at 2pm PT — link in calendar invite.",
    "We invite you to a phone screen — book a time on my calendar via Calendly.",
    "Interview invitation: Senior Medical Receptionist — Kaiser Permanente",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Next steps", body });
    assert.equal(
      r.type,
      "INTERVIEW_INVITE",
      `expected INTERVIEW_INVITE for: "${body}", got ${r.type} (evidence: "${r.evidence}")`
    );
  }
});

// Positive controls — real assessment requests must still match.
test("classify: real assessment / take-home requests still match after tightening", () => {
  const fixtures = [
    "Please complete the assessment by end of week.",
    "Your take-home coding challenge is attached.",
    "Take-home assignment: please submit by Friday.",
    "Complete the following questionnaire to move to the next round.",
    "Please provide the additional information we requested.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Next steps", body });
    assert.equal(
      r.type,
      "INFO_REQUEST",
      `expected INFO_REQUEST for: "${body}", got ${r.type} (evidence: "${r.evidence}")`
    );
  }
});

// RFC 029 — relaxed `schedule X interview` pattern. ATS scheduling emails
// (dentemploy + others) routinely say "schedule your interview" with a
// possessive word between schedule and interview. Original `(an? )?` only
// matched a/an/empty, missing all real-world variants.
test("classify: 'schedule your/the/our interview' → INTERVIEW_INVITE (RFC 029)", () => {
  const fixtures = [
    "Please schedule your interview using the link below.",
    "Click here to schedule the interview at a time that works.",
    "Once the assessment is done, schedule our interview.",
    "Schedule my interview as soon as possible.",
    "Schedule a interview", // baseline no-regression
    "Schedule an interview", // baseline no-regression
    "Schedule interview at your convenience", // baseline no-regression (bare)
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Next steps", body });
    assert.equal(
      r.type,
      "INTERVIEW_INVITE",
      `expected INTERVIEW_INVITE for: "${body}", got ${r.type}`
    );
  }
});

// RFC 029 — Round-N invite subject lines. ATS systems (Greenhouse, Ashby,
// dentemploy, others) emit subjects like "First Round Interview" or "Round 2
// interview"; these are unambiguous intent and must classify as invites.
test("classify: 'first round / round N interview' → INTERVIEW_INVITE (RFC 029)", () => {
  const fixtures = [
    { subject: "Let's Chat - First Round Interview for Front Office", body: "" },
    { subject: "First-round interview at Acme", body: "" },
    { subject: "Round 1 interview confirmation", body: "" },
    { subject: "Round 2 interview - next steps", body: "" },
    { subject: "Round three interview", body: "" },
  ];
  for (const f of fixtures) {
    const r = classify(f);
    assert.equal(
      r.type,
      "INTERVIEW_INVITE",
      `expected INTERVIEW_INVITE for subject "${f.subject}", got ${r.type}`
    );
  }
});

// RFC 029 — dentemploy fixture: the actual body of the email Lilia got on
// 2026-04-29 that check tick missed for 14 days. Must classify as
// INTERVIEW_INVITE end-to-end (subject + body).
test("classify: dentemploy First Round Interview body → INTERVIEW_INVITE (RFC 029)", () => {
  const subject = "Let's Chat - First Round Interview for Front Office";
  const body = [
    "Hi Lilia,",
    "Thank you for your interest in the Front Office role at Make a Smile!",
    "We'd love to learn more about your background. Please follow these steps:",
    "*Step 1: Complete our Application*",
    "*Step 2: 15-minute assessment*",
    "*Step 3: Schedule your Interview*",
    "Once the form and assessment are completed, you can schedule your interview",
    "by clicking the link below.",
    "*Step 4: Join the Interview*",
    "Best regards,",
    "Ryan M — DentEmploy Recruiting Department",
  ].join("\n");
  const r = classify({ subject, body });
  assert.equal(r.type, "INTERVIEW_INVITE", `got ${r.type} (evidence: ${r.evidence})`);
});

// Negative control — the relaxed pattern must NOT match JD body text that
// happens to mention "schedule" without interview intent.
test("classify: 'schedule flexibility' / 'schedule team interviews' → not INTERVIEW_INVITE", () => {
  const fixtures = [
    "Schedule flexibility required for evening shifts.",
    "Must accommodate the team's busy schedule each week.",
    "We schedule monthly all-hands meetings.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Position details", body });
    assert.notEqual(
      r.type,
      "INTERVIEW_INVITE",
      `should NOT classify as INTERVIEW_INVITE: "${body}" (got ${r.type})`
    );
  }
});

// Regression 2026-05-12 — Lilia unmatched probe, Tyson & Mendes ACK
// (gmail id 19d9d946a8271376, real body from production IMAP fetch).
// Greenhouse ATS confirmation. Body says "our team will be in touch
// regarding next steps in the interview process" — forward-looking ACK
// language, not actual invite intent. The bare /next steps in (the|our)
// (process|interview)/i pattern was producing a false-positive
// INTERVIEW_INVITE classification and mutating Notion. Dropped from
// INTERVIEW_INVITE patterns entirely. Real invites still match via
// schedule/invite/phone-screen/book-a-time/calendly patterns.
test("classify: ACK 'next steps in the interview process' → ACKNOWLEDGMENT (Tyson & Mendes 2026-05-12)", () => {
  const subject = "Thank you for applying at Tyson & Mendes";
  const body =
    "Hi Lilia,\n\n" +
    "Thank you so much for your interest in Tyson & Mendes and for taking " +
    "the time to apply for the Legal Assistant position. We wanted to let " +
    "you know that we received your application and are looking forward to " +
    "reviewing it. Following the review, our team will be in in touch " +
    "regarding next steps in the interview process.\n\n" +
    "In the meantime, feel free to visit our Careers page on our website " +
    "to learn more about our organization.\n\n" +
    "Have a great day!\n\n" +
    "Thank you,\nT&M Recruiting Team";
  const r = classify({ subject, body });
  assert.equal(
    r.type,
    "ACKNOWLEDGMENT",
    `expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
  );
});

// Companion fixture — same employer, real REJECTION sent ~10 days later
// (Apr 27, gmail seen by user). Confirms the existing REJECTION pattern
// /decided to move forward with other (candidates)?/i still catches the
// genuine rejection wording after the INTERVIEW_INVITE patterns tightened.
test("classify: real REJECTION still caught after INVITE tightening (Tyson & Mendes 2026-04-27)", () => {
  const subject = "Thank you for your interest in Tyson & Mendes";
  const body =
    "Hi Lilia,\n\n" +
    "Thank you for your interest in Tyson & Mendes and for taking the " +
    "time to apply.\n\n" +
    "We truly appreciate the opportunity to review your background and " +
    "qualifications. After careful consideration, we have decided to move " +
    "forward with other candidates at this time.\n\n" +
    "We encourage you to keep an eye on our careers page and consider " +
    "applying for future opportunities.\n\n" +
    "Warmly,\nT&M Recruiting Team";
  const r = classify({ subject, body });
  assert.equal(r.type, "REJECTION", `got ${r.type} (evidence: "${r.evidence}")`);
});

// Regression 2026-05-12 — Lilia unmatched probe, Lyra Health closure
// (gmail id 19dbcc95c93ca1af, real body from production IMAP fetch).
// Lever ATS letter opens with "Thank you for your interest in Lyra Health"
// (ACK-like) and announces "the Onboarding Support Specialist position is
// now closed". Semantically this is NOT a rejection — the role was
// withdrawn, the candidate wasn't told "no". New POSITION_CLOSED type
// maps to Notion "Closed" (distinct from "Rejected").
test("classify: 'position is now closed' → POSITION_CLOSED (Lyra Health 2026-05-12)", () => {
  const subject = "Thank you for considering Lyra";
  const body =
    "Hi Lilia,\n\n" +
    "Thank you for your interest in Lyra Health!\n\n" +
    "We wanted to inform you that the Onboarding Support Specialist " +
    "position is now closed. Our team continues to grow, so we invite " +
    "you to continue checking our careers page for other opportunities " +
    "with Lyra!\n\n" +
    "All the best,\nLyra Talent Acquisition Team";
  const r = classify({ subject, body });
  assert.equal(r.type, "POSITION_CLOSED", `got ${r.type} (evidence: "${r.evidence}")`);
});

test("classify: 'role is now closed' / 'position has closed' → POSITION_CLOSED", () => {
  const fixtures = [
    "Update: the Senior PM role is now closed.",
    "We're writing to let you know the position has closed.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Application update", body });
    assert.equal(r.type, "POSITION_CLOSED", `failed: "${body}" got ${r.type}`);
  }
});

test("classify: 'no longer accepting applications' → POSITION_CLOSED", () => {
  const r = classify({
    subject: "Update on the role",
    body: "We are no longer accepting applications for this position.",
  });
  assert.equal(r.type, "POSITION_CLOSED");
});

test("classify: paused/on-hold variants → POSITION_CLOSED", () => {
  const fixtures = [
    "The position has been paused while we reorganize the team.",
    "Unfortunately the role has been put on hold for the quarter.",
    "We've paused hiring for this role until further notice.",
    "We have paused hiring across the org.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Hiring update", body });
    assert.equal(r.type, "POSITION_CLOSED", `failed: "${body}" got ${r.type}`);
  }
});

// Priority test — closure beats rejection wording. If a letter contains
// both "unfortunately" and "position is now closed", the closure is the
// concrete fact about the role and we want Notion → "Closed", not
// "Rejected". ORDER puts POSITION_CLOSED before REJECTION (2026-05-12).
test("classify: closure beats rejection wording when both present (priority)", () => {
  const r = classify({
    subject: "Update",
    body:
      "Unfortunately, we have to let you know that the position is now " +
      "closed. We appreciated your interest.",
  });
  assert.equal(r.type, "POSITION_CLOSED", `got ${r.type} (evidence: "${r.evidence}")`);
});

// Negative control — generic "closed" without position context must NOT
// match (e.g. "our office is closed for the holiday").
test("classify: bare 'closed' without position/role context → not POSITION_CLOSED", () => {
  const fixtures = [
    "Our office is closed for the holiday — we will respond Monday.",
    "Applications are closed for the cohort.", // no "position is closed"
    "The deadline has closed; we are reviewing submissions.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Update", body });
    assert.notEqual(
      r.type,
      "POSITION_CLOSED",
      `should NOT classify as POSITION_CLOSED: "${body}" (got ${r.type})`
    );
  }
});
