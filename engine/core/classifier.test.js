const { test } = require("node:test");
const assert = require("node:assert/strict");

const { classify } = require("./classifier.js");

test("classify: rejection phrases → REJECTION", () => {
  const cases = [
    "Unfortunately, we have decided to move forward with other candidates.",
    "We won't be moving forward with your application at this time.",
    "After careful consideration, we have chosen another candidate.",
    // "The position has been filled." moved to POSITION_CLOSED fixtures
    // 2026-05-12 — employer-side closure, not a candidate-specific reject.
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
  // 2026-05-12 (BL-26 revision) — body updated from bare "Unfortunately we
  // will not be scheduling an interview" after bare /unfortunately/i was
  // dropped from REJECTION patterns. The point of the test is unchanged:
  // when an email contains BOTH rejection wording and interview wording,
  // REJECTION must win because ORDER puts it before INTERVIEW_INVITE.
  const r = classify({
    subject: "Interview update",
    body: "Unfortunately, we have decided not to move forward with scheduling an interview at this time.",
  });
  assert.equal(r.type, "REJECTION");
});

test("classify: evidence contains matched phrase", () => {
  // 2026-05-12 (BL-26 revision) — fixture/assertion updated. Previously
  // "Unfortunately, not a match." matched bare /unfortunately/i first and
  // evidence was "Unfortunately". After dropping bare /unfortunately/i, the
  // surviving pattern is /not a match/i and evidence is "not a match".
  const r = classify({ subject: "Update", body: "Unfortunately, not a match." });
  assert.equal(r.type, "REJECTION");
  assert.match(r.evidence, /not a match/i);
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
  // 2026-05-12 (BL-26 revision) — "Take-home assignment: please submit by
  // Friday." reworded to "Your take-home assignment: please submit by Friday."
  // after the article-less /\btake.?home (test|assignment|...)/i was tightened
  // to require (your|the) prefix. Real candidate-facing requests always have
  // the article — JD-process descriptions in ACK bodies do not.
  const fixtures = [
    "Please complete the assessment by end of week.",
    "Your take-home coding challenge is attached.",
    "Your take-home assignment: please submit by Friday.",
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

// Regression 2026-05-12 (audit follow-up) — Jared 30-day probe surfaced
// two more historical INTERVIEW_INVITE false-positives from the same
// removed regex: Remote.com (Apr 14, gmail 19d8e30054186932) and
// Hopper (Apr 30, gmail 19de0043b5146fc4). Same root cause as the
// Tyson & Mendes case — ACK boilerplate that forward-looks at "the
// first interview" / "next steps in the process". Both were later
// overwritten by genuine REJECTION emails (Notion currently shows
// Rejected/Archived), so no live phantom mutation remains — but
// locking them in as fixtures prevents the regex from sneaking back.
test("classify: ACK 'to arrange the first interview' → ACKNOWLEDGMENT (Remote.com 2026-04-14)", () => {
  const subject = "Thank you for applying to Remote";
  const body =
    "Hi Jared,\n\n" +
    "Thank you so much for applying to Remote. Your application has been " +
    "received and we will review it as soon as possible.\n\n" +
    "If your experience seems like a good fit for the position we will " +
    "contact you soon to arrange the first interview. We will always let " +
    "you know the outcome, but we may experience delays since we receive " +
    "a high number of applications.\n\n" +
    "Best wishes,\nRemote Talent Acquisition team";
  const r = classify({ subject, body });
  assert.equal(
    r.type,
    "ACKNOWLEDGMENT",
    `expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
  );
});

test("classify: ACK 'next steps in the process' → ACKNOWLEDGMENT (Hopper 2026-04-30)", () => {
  const subject = "Jared, thanks for applying to Hopper!";
  const body =
    "Hi Jared,\n\n" +
    "Thank you for your interest in joining the team at Hopper!\n\n" +
    "We truly appreciate the time and effort you put into submitting your " +
    "application.\n\n" +
    "At this time, we are experiencing a high volume of applications, and " +
    "our team is carefully reviewing each one. We will get back to you as " +
    "soon as possible regarding the next steps in the process.\n\n" +
    "Best,\nThe Hopper Team";
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

// 2026-05-12 — "filled the role" moved from REJECTION to POSITION_CLOSED.
// Employer-side signal: role gone for everyone (not a candidate-specific
// rejection). Real production case: Attentive — "We've just recently
// filled the role" (subject: "Update on your application"). Should land
// in Notion as Closed, not Rejected, so rejection-rate metric stays clean.
test("classify: 'we just recently filled the role' → POSITION_CLOSED (Attentive)", () => {
  const fixtures = [
    "Thank you for your interest. We've just recently filled the role and won't be moving forward.",
    "The position has been filled. We appreciate the time you took to apply.",
    "Unfortunately the role has been filled by another candidate.",
    "We have filled this position internally — thank you for applying.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Update on your application", body });
    assert.equal(
      r.type,
      "POSITION_CLOSED",
      `expected POSITION_CLOSED, got ${r.type} for: "${body}" (evidence: "${r.evidence}")`
    );
  }
});

// Negative control — "filled" without a role/position context (newsletter,
// product copy) must not trip POSITION_CLOSED.
test("classify: bare 'filled' without role context → not POSITION_CLOSED", () => {
  const fixtures = [
    "Your cart has been filled with the items you selected.",
    "We have filled out the paperwork for your onboarding.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Hello", body });
    assert.notEqual(
      r.type,
      "POSITION_CLOSED",
      `should NOT classify as POSITION_CLOSED: "${body}" (got ${r.type})`
    );
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

// Regression 2026-05-12 (BL-50, follow-up Q-2 from BL-44) — Deel ACK
// 14-apr on Jared (gmail id 19d8e1ad638ccebb). ATS confirmation body
// contained a conditional forward-looking line "If your profile is a
// match, we will schedule a call to discuss next steps." which the
// previous regex /schedule (?:...)?(call|meeting|chat)/ caught as
// INTERVIEW_INVITE. That mis-classification then cross-bound to Next
// Insurance through the matcher and required a manual revert. After
// tightening, only `interview`/`phone screen` remain in the trailing
// alternation; "schedule a call/chat/meeting" in ACK context falls
// through to ACKNOWLEDGMENT (via "thank you for applying"/"we have
// received your application") or OTHER.
test("classify: ACK 'we will schedule a call' → ACKNOWLEDGMENT (Deel 2026-04-14, BL-50)", () => {
  const subject = "Thank you for applying to Deel";
  const body =
    "Hi Jared,\n\n" +
    "Thank you for applying to Deel and for your interest in joining our " +
    "team! We have received your application for Senior Product Manager " +
    "and will review it carefully.\n\n" +
    "If your background is a good fit, we will schedule a call to discuss " +
    "the role in more detail. Otherwise, you will hear back from us " +
    "within 2 weeks.\n\n" +
    "Best,\nThe Deel Talent Team";
  const r = classify({ subject, body });
  assert.equal(
    r.type,
    "ACKNOWLEDGMENT",
    `expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
  );
});

// Companion negative controls for BL-50 — bare "schedule a call/meeting/chat"
// without explicit invite intent must NOT classify as INTERVIEW_INVITE.
// These fixtures are constructed (no "thank you for applying", no ACK
// boilerplate) so the only signal is the schedule phrase; we expect OTHER.
test("classify: bare 'schedule a call/meeting/chat' without invite intent → not INTERVIEW_INVITE (BL-50)", () => {
  const fixtures = [
    "Happy to schedule a call once you have a chance to review.",
    "Let me know if you'd like to schedule a meeting later this month.",
    "We typically schedule a chat after the initial screening is complete.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Re: update", body });
    assert.notEqual(
      r.type,
      "INTERVIEW_INVITE",
      `should NOT classify as INTERVIEW_INVITE: "${body}" (got ${r.type})`
    );
  }
});

// Positive control — explicit invite intent with "schedule a call" must
// STILL classify as INTERVIEW_INVITE via the surviving patterns
// (`(would|we'd) like to (schedule|set up|interview)`, `book a time`, etc).
test("classify: 'we'd like to schedule a call' → still INTERVIEW_INVITE (BL-50 no-regression)", () => {
  const fixtures = [
    "We'd like to schedule a call with you next week to discuss the role.",
    "Hi Jared, we would like to schedule a chat — please book a time on my calendar.",
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

// Regression 2026-05-12 (BL-26 revision) — Duolingo ATS confirmations on
// Jared. Both bodies are identical except for the role name (Senior Product
// Manager, Score vs DET). Body opens with "Thank you for applying" (ACK
// signal), then immediately includes a scam-warning paragraph starting with
// "Unfortunately, there is a rise in scammers pretending to be real Duolingo
// employees…". Bare /unfortunately/i in REJECTION patterns matched this
// preamble and produced REJECTION (status mutation in Notion was applied
// before the user reverted manually). Bare /unfortunately/i dropped — these
// fixtures lock the fix in. Gmail ids: 19e1897581413b89 (Score),
// 19e1884021811520 (DET).
test("classify: ACK 'Unfortunately, rise in scammers' → ACKNOWLEDGMENT (Duolingo Score 2026-05-08, BL-26)", () => {
  const subject = "Thank you for applying to Duolingo!";
  const body =
    "Hi Jared,\n\n" +
    "Thank you for applying to Duolingo! This email is to confirm your " +
    "application has been received for Senior Product Manager, Score. We " +
    "will review it as soon as we can and reach out if you seem to be a " +
    "good fit for the position.\n\n" +
    "Unfortunately, there is a rise in scammers pretending to be real " +
    "Duolingo employees. Duolingo and our employees will never ask for " +
    "your Social Security number, bank details, or passport info, and " +
    "we'll never ask you to deposit a check, purchase equipment, or " +
    "exchange money during the interview process. Real Duolingo " +
    "employees always use an email that ends in @duolingo.com or " +
    "@recruiting.duolingo.com. Stay alert and double-check these details " +
    "before sharing any information.\n\n" +
    "Warmly,\nDuolingo";
  const r = classify({ subject, body });
  assert.equal(
    r.type,
    "ACKNOWLEDGMENT",
    `expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
  );
});

test("classify: ACK 'Unfortunately, rise in scammers' → ACKNOWLEDGMENT (Duolingo DET 2026-05-08, BL-26)", () => {
  const subject = "Thank you for applying to Duolingo!";
  const body =
    "Hi Jared,\n\n" +
    "Thank you for applying to Duolingo! This email is to confirm your " +
    "application has been received for Senior Product Manager, DET. We " +
    "will review it as soon as we can and reach out if you seem to be a " +
    "good fit for the position.\n\n" +
    "Unfortunately, there is a rise in scammers pretending to be real " +
    "Duolingo employees. Duolingo and our employees will never ask for " +
    "your Social Security number, bank details, or passport info, and " +
    "we'll never ask you to deposit a check, purchase equipment, or " +
    "exchange money during the interview process. Real Duolingo " +
    "employees always use an email that ends in @duolingo.com or " +
    "@recruiting.duolingo.com. Stay alert and double-check these details " +
    "before sharing any information.\n\n" +
    "Warmly,\nDuolingo";
  const r = classify({ subject, body });
  assert.equal(
    r.type,
    "ACKNOWLEDGMENT",
    `expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
  );
});

// Regression 2026-05-12 (BL-26 revision) — Headway ATS confirmations on
// Jared (Senior PM Client Engagement, both 19de00ba5c8385f0 and
// 19df4e1978faf2e2 with identical bodies, sent 1 day apart). Greenhouse
// boilerplate that describes the future hiring process inside the ACK
// body: "the typical interview process will consist of: ... A take home
// assignment designed to assess…". Bare /\btake.?home\b/, bare
// /\bcoding challenge\b/, and the article-less
// /\btake.?home (test|assignment|project|challenge)\b/ all fired on the
// JD-future-steps description and produced INFO_REQUEST (only
// comment_only Notion action, but still noisy @-mention). Bare patterns
// dropped; the (test|assignment|…) form tightened to require an article
// (your|the) — these fixtures lock the fix in.
test("classify: ACK JD-process 'A take home assignment' → ACKNOWLEDGMENT (Headway CE 2026-05-08, BL-26)", () => {
  const subject = "Thank you for applying to Headway";
  const body =
    "Hi Jared,\n\n" +
    "Thank you for your interest in Headway! We have received your " +
    "application for Senior Product Manager, Client Engagement and are " +
    "delighted that you would consider joining our team.\n\n" +
    "The Recruiting team will review your application and will be in " +
    "touch if your qualifications match our needs at this time. If you " +
    "are not selected for this position, keep an eye on our careers " +
    "page as we're growing and adding openings.\n\n" +
    "Best,\nThe Headway Team\n\n" +
    "Curious about what happens next?\n\n" +
    "While nothing's set in stone, the typical interview process will " +
    "take 2-3 weeks and will consist of the following steps:\n\n" +
    "* The Talent team will review your application.\n" +
    "* A high-level screen with the Talent team about Headway, the " +
    "role, and your background and experience.\n" +
    "* A more in-depth conversation with the hiring manager to dig a " +
    "bit deeper into the technicalities of the role.\n" +
    "* A take home assignment designed to assess technical abilities " +
    "necessary for the role.\n" +
    "* A slate of structured interviews designed to assess for the " +
    "unique skills deemed necessary for each role.";
  const r = classify({ subject, body });
  assert.equal(
    r.type,
    "ACKNOWLEDGMENT",
    `expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
  );
});

// Companion negative control — article-less "A take home assignment" /
// "coding challenge" inside a JD-style sentence must not match
// INFO_REQUEST. (Pure pattern test, no ACK wording.)
test("classify: bare JD-style 'take home assignment' / 'coding challenge' → not INFO_REQUEST (BL-26)", () => {
  const fixtures = [
    "A take home assignment designed to assess technical abilities is part of the process.",
    "The process includes a coding challenge in a later round.",
    "A coding challenge designed to assess technical skills follows the screen.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "About the role", body });
    assert.notEqual(
      r.type,
      "INFO_REQUEST",
      `should NOT classify as INFO_REQUEST: "${body}" (got ${r.type})`
    );
  }
});

// Positive control — article-bound forms still classify as INFO_REQUEST.
test("classify: article-bound 'your/the take-home assignment' → INFO_REQUEST (BL-26 no-regression)", () => {
  const fixtures = [
    "Your take-home assignment is attached below.",
    "Please complete the take-home assignment by Friday.",
    "Your coding challenge link is here.",
    "The take-home project is due in 5 days.",
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

// Regression 2026-05-30 (RFC 057 / BL-157) — Sharecare (Workday) application
// acknowledgment on lilia (sharecare@myworkday.com, fetched read-only over
// IMAP). Subject "Application Received for <role>"; body only describes the
// future hiring process: "we have received your application … expect to
// schedule interviews in the next couple of weeks". The old
// /schedule …(interview|phone screen)/ pattern matched "schedule interviews"
// and flipped the card to Interview. Workday sent the same mail 3× → a
// phantom "Interview: 3" in the heartbeat for a single job. After fix:
// trailing \b rejects the plural, forward-looking lookbehind + ACK guard
// catch the rest. Must be ACKNOWLEDGMENT.
test("classify: Sharecare 'Application Received … expect to schedule interviews' → ACKNOWLEDGMENT (RFC 057)", () => {
  const subject = "Application Received for Data Entry Specialist - Medical Records (Remote)";
  const body =
    "Dear Lilia, This letter is to let you know that we have received your " +
    "application. We appreciate your interest in our company and the position " +
    "for which you applied. We are reviewing applications and expect to " +
    "schedule interviews in the next couple of weeks. If you are selected for " +
    "an interview, you can expect an email or phone call from us in the near " +
    "future. Thank you again for your interest in Sharecare. Regards, " +
    "Sharecare Talent Acquisition Team";
  const r = classify({ subject, body });
  assert.equal(
    r.type,
    "ACKNOWLEDGMENT",
    `expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
  );
});

// Guard control — the singular future form ("we will schedule an interview
// if you're selected") passes the trailing \b (singular) but is still an ACK
// describing its process. STRONG_ACK + FORWARD_LOOKING_INVITE both present →
// demote to ACKNOWLEDGMENT.
test("classify: ACK 'we will schedule an interview if selected' → ACKNOWLEDGMENT (RFC 057 guard)", () => {
  const r = classify({
    subject: "Application Received",
    body:
      "Thank you — we have received your application. If you are selected, we " +
      "will schedule an interview with you in the coming weeks.",
  });
  assert.equal(
    r.type,
    "ACKNOWLEDGMENT",
    `expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
  );
});

// Negative control — forward-looking "expect to schedule interviews" /
// "plan to schedule interviews" in plain process text (no ACK signal) must
// NOT classify as INTERVIEW_INVITE.
test("classify: forward-looking 'expect/plan to schedule interviews' → not INTERVIEW_INVITE (RFC 057)", () => {
  const fixtures = [
    "We expect to schedule interviews in the next couple of weeks.",
    "The team plans to schedule interviews once the role is approved.",
    "Hiring managers will schedule interviews with shortlisted candidates.",
  ];
  for (const body of fixtures) {
    const r = classify({ subject: "Process overview", body });
    assert.notEqual(
      r.type,
      "INTERVIEW_INVITE",
      `should NOT be INTERVIEW_INVITE: "${body}" (got ${r.type}, evidence: "${r.evidence}")`
    );
  }
});

// No-regression — genuine invites still match even when an application-receipt
// pleasantry is present, because the FORWARD_LOOKING cue is absent (direct
// invite, not a future-process description). Guards must not over-demote.
test("classify: receipt + direct invite ('your interview is on…') → INTERVIEW_INVITE (RFC 057 no over-demote)", () => {
  const fixtures = [
    "We have received your application. Your interview is on Thursday at 2pm PT.",
    "Thanks for applying! Please schedule your interview using the link below.",
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

// Guard-scope no-regression (RFC 057, review Finding 2) — the ACK guard must
// NOT demote a genuine invite just because a receipt phrase and a scheduling
// phrase co-occur. It demotes ONLY when the SCHEDULE_INTERVIEW pattern won AND
// the scheduling is gated by a selection condition. These two stay invites:
//   1. committal "we will schedule an interview" with no "if selected" gate;
//   2. a direct-invite pattern ("your interview is on…") wins — the stray
//      "we will schedule a follow-up" sentence must not trigger the guard.
test("classify: committal invite + receipt, no selection-condition → INTERVIEW_INVITE (RFC 057 guard scope)", () => {
  const fixtures = [
    "Thanks, we received your application earlier. Following your strong screen, we will schedule an interview next week.",
    "We have received your application. Your interview is on Thursday at 2pm. We will schedule a follow-up after.",
    // review Finding 4 — courtesy closers ("should you have questions",
    // "should you need to reschedule") must not trip the selection-condition.
    "We received your application and would like to schedule your interview. Should you have any questions, reply here.",
    "We have received your application. Please schedule your interview using the link. Should you need to reschedule, use the same link.",
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
