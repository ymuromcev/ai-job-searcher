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
    /decided not to proceed/i,
    /will not be proceeding/i,
    /we have chosen/i,
    /not selected/i,
    /not able to move/i,
    /move forward with other/i,
    /no longer moving/i,
    /not a fit/i,
    /decided to move forward with/i,
    /not proceeding/i,
    /unable to move forward/i,
  ],
  INTERVIEW_INVITE: [
    /\binterview\b/i,
    /phone screen/i,
    /schedule a call/i,
    /next steps in the process/i,
    /would love to chat/i,
    /\bmeet with\b/i,
    /\bavailability\b/i,
    /calendly/i,
    /book a time/i,
  ],
  INFO_REQUEST: [
    /\bassessment\b/i,
    /take.?home/i,
    /coding challenge/i,
    /additional information/i,
    /complete the following/i,
    /questionnaire/i,
  ],
  ACKNOWLEDGMENT: [
    /received your application/i,
    /under review/i,
    /thank you for applying/i,
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
