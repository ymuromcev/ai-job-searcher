// Pure rule-based email classifier.
//
// Ported from ../../Job Search/check_emails.js:114-145 (prototype). Regex sets
// are battle-tested in production across 200+ real emails in Jared's pipeline;
// keep them in sync unless the prototype is archived.
//
// Order matters: REJECTION > INTERVIEW_INVITE > INFO_REQUEST > ACKNOWLEDGMENT.
// First match wins — this avoids ambiguous double-classification (e.g. a
// rejection letter that mentions "we received your application").

const PATTERNS = {
  REJECTION: [
    /unfortunately/i,
    /not moving forward/i,
    /other candidates/i,
    /won.t be moving forward/i,
    /not a match/i,
    /position has been filled/i,
    /has been filled/i,
    /decided not to proceed/i,
    /will not be proceeding/i,
    /we have chosen/i,
    // NOTE: bare /not selected/i was REMOVED 2026-04-30 — too broad. ATS
    // confirmation emails (Greenhouse/Ashby/Figma/Lever) all use the
    // boilerplate "If you are not selected for this position, keep an eye on
    // our jobs page", which is conditional, not a real rejection. The more
    // specific /your application was not selected/i below still catches the
    // genuine rejection wording. See classifier.test.js regression cases.
    /not able to move/i,
    /move forward with other/i,
    /no longer moving/i,
    /not a fit/i,
    /decided to move forward with/i,
    /not proceeding/i,
    /unable to move forward/i,
    /decided not to move forward/i,
    /not to move forward/i,
    /will not be moving forward/i,
    /won.t be able to move forward/i,
    /not be moving forward/i,
    /decided to move forward with candidates whose/i,
    /your application was not selected/i,
  ],
  // INTERVIEW_INVITE patterns must require interview-INTENT context. Bare
  // \binterview\b / \bavailability\b were removed 2026-05-02 after Lilia
  // incident: Indeed digest emails embed JD body text containing "interview
  // process" / "share your availability" as job descriptions, which produced
  // 7+ false INTERVIEW_INVITE matches. New patterns require either an
  // explicit invite verb (schedule/invite/like to interview) or interview-
  // intent phrasing (interview with us/your interview).
  INTERVIEW_INVITE: [
    /schedule (an? )?(interview|phone screen|call|meeting|chat)/i,
    /(would|we'd) like to (schedule|set up|interview)/i,
    /invite you (to|for) (an? )?(interview|phone screen|conversation|chat)/i,
    /your interview (is|with|on)/i,
    /interview with us/i,
    /interview (request|invitation|invite)/i,
    /\bphone screen\b/i,
    /next steps in (the|our) (process|interview)/i,
    /would love to (chat|connect|meet|talk) (with you|to discuss)/i,
    /\bmeet with (the|our) (team|hiring|recruiting)/i,
    /share your availability/i,
    /(your|let me know your) availability (for|to) (an? )?(interview|call|chat|conversation)/i,
    /book a time (on (my|the) calendar|with (me|us)|to (chat|meet|talk))/i,
    // "calendly" is brand-specific and only ever appears in scheduling
    // contexts — safe to keep bare.
    /\bcalendly\b/i,
  ],
  // INFO_REQUEST patterns must reference an action the candidate must take.
  // Bare /assessment/ and /questionnaire/ were removed 2026-05-02 — JD body
  // text often mentions "skills assessment" or "personality questionnaire"
  // as part of the role description, not as a request to the candidate.
  INFO_REQUEST: [
    /(complete|take|finish) (the|your|an?) (assessment|questionnaire|coding challenge|take.?home|exercise)/i,
    /(your|the) (assessment|questionnaire|take.?home|coding challenge) (is|link|attached|below|here)/i,
    /(assessment|questionnaire|coding challenge|take.?home) (link|invitation|invite|deadline)/i,
    /(please|kindly) (complete|fill out|provide|share|submit)/i,
    /\btake.?home (test|assignment|project|challenge)\b/i,
    /(send|submit|provide) (us )?(your|the) (additional|requested) (information|details|materials)/i,
    /(we|i) need (some )?additional (information|details) (from you|to proceed)/i,
    /complete the following (form|questionnaire|assessment|steps)/i,
    // "coding challenge" and "take-home" are unambiguous — they only ever
    // refer to candidate-facing exercises in hiring contexts.
    /\bcoding challenge\b/i,
    /\btake.?home\b/i,
  ],
  ACKNOWLEDGMENT: [
    /received your application/i,
    /under review/i,
    /thank you for applying/i,
    /thanks for applying/i,
    /thank you for your (application|interest)/i,
    /application confirmed/i,
    /we have received/i,
    /we.ve received/i,
  ],
};

const ORDER = ["REJECTION", "INTERVIEW_INVITE", "INFO_REQUEST", "ACKNOWLEDGMENT"];

function classify({ subject, body } = {}) {
  const text = `${subject || ""} ${body || ""}`;
  for (const type of ORDER) {
    for (const pattern of PATTERNS[type]) {
      const match = text.match(pattern);
      if (match) {
        return { type, evidence: match[0] };
      }
    }
  }
  return { type: "OTHER", evidence: null };
}

module.exports = {
  classify,
  PATTERNS,
  ORDER,
};
