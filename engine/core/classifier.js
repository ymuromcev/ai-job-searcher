// Pure rule-based email classifier.
//
// Ported from ../../Job Search/check_emails.js:114-145 (prototype). Regex sets
// are battle-tested in production across 200+ real emails in Jared's pipeline;
// keep them in sync unless the prototype is archived.
//
// Order matters: REJECTION > INTERVIEW_INVITE > INFO_REQUEST > ACKNOWLEDGMENT.
// First match wins — this avoids ambiguous double-classification (e.g. a
// rejection letter that mentions "we received your application").

// The single INTERVIEW_INVITE pattern that can also match an acknowledgment's
// description of its *future* hiring process ("...schedule an interview...").
// Named so the ACK-precedence guard in classify() can scope itself to ONLY
// this pattern — the direct-invite patterns ("your interview is on…", "invite
// you to…", Calendly, round-N, phone screen) are guard-immune and must never
// be demoted. Tightened 2026-05-30 (RFC 057 / BL-157): trailing \b rejects
// plural "interviews"; negative lookbehind rejects forward-looking prefixes
// ("expect/plan/intend to schedule"). Root case: a Sharecare/Workday ACK on
// lilia — "we have received your application … expect to schedule interviews
// in the next couple of weeks" — matched the old pattern and flipped the card
// to Interview (sent 3×, hence a phantom "Interview: 3"). Singular directed
// forms ("schedule your interview", bare "schedule interview") still match.
const SCHEDULE_INTERVIEW =
  /(?<!(?:expect|plan|planning|hope|hoping|going|aiming|aim|wish|intend|intending) to )schedule (?:(?:your|the|our|my|a|an)\s+)?(interview|phone screen)\b/i;

const PATTERNS = {
  REJECTION: [
    // Bare /unfortunately/i removed 2026-05-12 (BL-26 revision). Duolingo ACK
    // confirmations (no-reply@duolingo.com, both Sr PM Score + Sr PM DET
    // 2026-05-08) embed a scam-warning paragraph: "Unfortunately, there is a
    // rise in scammers pretending to be real Duolingo employees..." Bare
    // /unfortunately/i fired on this preamble and produced REJECTION. Real
    // rejections always contain explicit action wording (not moving forward
    // / decided not to proceed / not a match / etc.), all covered by the
    // patterns below — removing the bare softener costs no real rejection
    // coverage. Regression fixtures: Duolingo Score (19e1897581413b89) +
    // Duolingo DET (19e1884021811520). See incidents.md 2026-05-12 BL-26
    // revision.
    /not moving forward/i,
    /other candidates/i,
    /won.t be moving forward/i,
    /not a match/i,
    // /position has been filled/ and /has been filled/ moved to
    // POSITION_CLOSED 2026-05-12 — "We just recently filled the role" is an
    // employer-side closure signal (role evaporated), not a candidate-
    // specific rejection. Notion gets "Closed", rejection-rate metric stays
    // clean. See incidents 2026-05-12 audit follow-up.
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
  // POSITION_CLOSED — added 2026-05-12 (Lilia Lyra Health probe). Semantically
  // distinct from REJECTION: the *role* was withdrawn, the candidate was not
  // rejected. Mapped to Notion status "Closed" (not "Rejected"). Priority is
  // ABOVE REJECTION — if a letter contains both "unfortunately" and "position
  // is now closed", the closure is the concrete fact about the role; the
  // rejection word may just be ACK-style softener. See incidents 2026-05-12.
  POSITION_CLOSED: [
    /position is (now )?closed/i,
    /role is (now )?closed/i,
    /position has closed/i,
    /no longer accepting applications/i,
    /position has been (paused|put on hold)/i,
    /role has been (paused|put on hold)/i,
    /we('ve| have) paused hiring/i,
    // "We've just recently filled the role" (Attentive) / "The position has
    // been filled". Employer-side closure: role gone for everyone, not a
    // candidate-specific reject. Moved here from REJECTION 2026-05-12.
    // Patterns require role/position context — bare /has been filled/ used
    // to live in REJECTION and matched "your cart has been filled" etc.
    /(?:role|position) has been filled/i,
    /filled (?:the|this) (?:role|position)/i,
  ],
  // INTERVIEW_INVITE patterns must require interview-INTENT context. Bare
  // \binterview\b / \bavailability\b were removed 2026-05-02 after Lilia
  // incident: Indeed digest emails embed JD body text containing "interview
  // process" / "share your availability" as job descriptions, which produced
  // 7+ false INTERVIEW_INVITE matches. New patterns require either an
  // explicit invite verb (schedule/invite/like to interview) or interview-
  // intent phrasing (interview with us/your interview).
  INTERVIEW_INVITE: [
    // Relaxed 2026-05-12 (RFC 029) — original /(an? )?/ only matched
    // "schedule interview" / "schedule a interview" / "schedule an interview".
    // ATS scheduling emails (dentemploy + others) routinely say "schedule
    // your interview" / "schedule the interview" / "schedule our interview".
    // Whitelist of pre-words to avoid false-positives like "schedule monthly
    // meetings" / "schedule team-wide calls".
    //
    // Tightened 2026-05-12 (BL-50, Q-2 follow-up from BL-44): dropped
    // `call|meeting|chat` from the trailing alternation. ATS ACK boilerplate
    // routinely says "we will schedule a call to discuss" / "happy to
    // schedule a chat" — forward-looking ACK language, NOT an invite. Real
    // invites with those words are still caught by:
    //   - /(would|we'd) like to (schedule|set up|interview)/ ("we'd like to
    //     schedule a call")
    //   - /invite you (to|for) (interview|phone screen|conversation|chat)/
    //   - /book a time (on (my|the) calendar|with (me|us)|to (chat|meet|talk))/
    //   - /would love to (chat|connect|meet|talk) (with you|to discuss)/
    //   - /(your|let me know your) availability (for|to) (call|chat|conversation)/
    // Real trigger: Deel ACK 14-apr (Jared dry-run, 2026-05-12), which
    // also cross-bound to Next Insurance via matcher.
    // RFC 057 / BL-157 — see SCHEDULE_INTERVIEW definition above. Extracted to
    // a named const so the ACK-precedence guard can scope to this pattern only.
    SCHEDULE_INTERVIEW,
    /(would|we'd) like to (schedule|set up|interview)/i,
    /invite you (to|for) (an? )?(interview|phone screen|conversation|chat)/i,
    /your interview (is|with|on)/i,
    /interview with us/i,
    /interview (request|invitation|invite)/i,
    // ATS subject lines for round-N invites. Added 2026-05-12 (RFC 029) —
    // "First Round Interview" / "Round 2 interview" are unambiguous intent.
    /first[- ]round interview/i,
    /round (one|1|two|2|three|3) interview/i,
    /\bphone screen\b/i,
    // 2026-05-12 — Tyson & Mendes probe (Lilia unmatched set). The bare
    // /next steps in (the|our) (process|interview)/i fired on ACK boilerplate
    // "we'll be in touch regarding next steps in the interview process".
    // This is forward-looking ACK language, not actual invite intent. Dropped
    // entirely — real invites are still covered by schedule/invite/phone-screen
    // /book-a-time/calendly/your-interview-is/round-N patterns. If we ever
    // need this back, it must require an explicit invite verb in proximity.
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
    // Compound "take-home coding challenge" needs an optional prefix on
    // `coding challenge` so it still matches alongside the bare forms.
    // Without this, "Your take-home coding challenge is attached" stalls
    // because `take.?home` matches "take-home" but `(is|link|...)` doesn't
    // line up with the following " coding". 2026-05-12 (BL-26 revision).
    /(your|the) (assessment|questionnaire|take.?home(?:\s+coding\s+challenge)?|coding challenge) (is|link|attached|below|here)/i,
    // Inverse word order: "Here is your <noun>" / "Attached is your <noun>"
    // / "Please find your <noun>". Real coordinator emails routinely use
    // this phrasing — the main /(your|the) … (is|attached|…)/i pattern
    // only catches the forward order. Same noun alternation. Added
    // 2026-05-12 (BL-26 revision) when bare /\btake.?home\b/i was removed.
    /(?:here|attached) (?:is|are|please find) (?:your|the) (assessment|questionnaire|take.?home(?:\s+coding\s+challenge)?|coding challenge|exercise)/i,
    /(assessment|questionnaire|coding challenge|take.?home) (link|invitation|invite|deadline)/i,
    /(please|kindly) (complete|fill out|provide|share|submit)/i,
    /(send|submit|provide) (us )?(your|the) (additional|requested) (information|details|materials)/i,
    /(we|i) need (some )?additional (information|details) (from you|to proceed)/i,
    /complete the following (form|questionnaire|assessment|steps)/i,
    // 2026-05-12 (BL-26 revision) — Headway ATS confirmations
    // (no-reply@us.greenhouse-mail.io, Sr PM Client Engagement
    // 19de00ba5c8385f0 + 19df4e1978faf2e2) describe the future hiring
    // process inside the ACK body: "the typical interview process will
    // take 2-3 weeks and will consist of: ... A take home assignment
    // designed to assess technical abilities". Bare /\btake.?home\b/i,
    // /\bcoding challenge\b/i, and the article-less
    // /\btake.?home (test|assignment|project|challenge)\b/i all fired on
    // this JD-future-steps description and produced INFO_REQUEST. Same
    // failure mode as the 2026-05-02 Indeed-digest incident with bare
    // /\binterview\b/, /\bavailability\b/, /\bassessment\b/.
    //
    // After fix: article-bound versions only. Real candidate-facing
    // requests use "your take-home" / "the take-home" / "your coding
    // challenge" / explicit complete-the-attached wording.
    /(your|the) take.?home (test|assignment|project|challenge)/i,
    /(your|the) coding challenge/i,
  ],
  ACKNOWLEDGMENT: [
    /received your application/i,
    /under review/i,
    /thank you for applying/i,
    /thanks for applying/i,
    /thank you for your (application|interest)/i,
    /application confirmed/i,
    // 2026-05-30 (RFC 057 / BL-157) — autoresponder subject lines. Sharecare
    // (Workday) sends "Application Received for <role>" with a body that only
    // describes the future hiring process. The subject alone is an
    // unambiguous acknowledgment signal.
    /application (received|confirmation)/i,
    /we have received/i,
    /we.ve received/i,
  ],
};

// ACK-precedence guard inputs (RFC 057 / BL-157). first-match-wins returns
// INTERVIEW_INVITE before ACKNOWLEDGMENT, so an acknowledgment that says it
// will schedule an interview *conditionally on selection* ("we have received
// your application … if you are selected we will schedule an interview")
// would still mutate the card. The guard (in classify) demotes to
// ACKNOWLEDGMENT only when ALL of: (a) the winning match came from
// SCHEDULE_INTERVIEW specifically — direct-invite patterns are immune; (b) a
// strong application-receipt signal is present; (c) the scheduling is gated
// by a selection condition. A committal invite ("we will schedule an
// interview next week", "your interview is on Thursday") has no selection
// condition and is left as INTERVIEW_INVITE.
const STRONG_ACK = [
  /received your application/i,
  /your application (?:has been|was) received/i,
  /application (?:received|confirmation)/i,
];
const ACK_CONDITIONAL = [
  /\bif (?:you(?:'re| are)? )?(?:selected|chosen|shortlisted|a (?:good |strong )?(?:fit|match)|advance|move forward|proceed)/i,
  /\bif selected\b/i,
  // Selection-scoped only. A bare /should (you|your application)/ matched the
  // routine courtesy closers real invites carry ("should you have any
  // questions", "should you need to reschedule") and demoted them — review
  // Finding 4. Require an advance/selection verb after "should you".
  /\bshould you (?:be )?(?:selected|chosen|shortlisted|advance|proceed|move forward)\b/i,
];

// POSITION_CLOSED goes BEFORE REJECTION (2026-05-12). When both signals are
// present ("unfortunately…the position is now closed"), the closure is the
// concrete fact and we want the Notion card → "Closed", not "Rejected".
const ORDER = [
  "POSITION_CLOSED",
  "REJECTION",
  "INTERVIEW_INVITE",
  "INFO_REQUEST",
  "ACKNOWLEDGMENT",
];

function classify({ subject, body } = {}) {
  const text = `${subject || ""} ${body || ""}`;
  for (const type of ORDER) {
    for (const pattern of PATTERNS[type]) {
      const match = text.match(pattern);
      if (match) {
        // ACK-precedence guard (RFC 057 / BL-157): a conditional-on-selection
        // "schedule an interview" inside an application-acknowledgment is the
        // ACK's description of its own future process, not an action signal.
        // Scoped to SCHEDULE_INTERVIEW only — direct-invite patterns (your
        // interview is on…, invite you to…, Calendly, round-N) are immune.
        if (
          type === "INTERVIEW_INVITE" &&
          pattern === SCHEDULE_INTERVIEW &&
          STRONG_ACK.some((p) => p.test(text)) &&
          ACK_CONDITIONAL.some((p) => p.test(text))
        ) {
          return { type: "ACKNOWLEDGMENT", evidence: match[0] };
        }
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
