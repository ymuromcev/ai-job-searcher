// Pure categorizer: maps an application question to one of the canonical
// Q&A categories used in the Notion application_qa DB.
//
// Canonical categories (must match Notion DB option set):
//   Behavioral, Technical, Culture Fit, Logistics, Salary, Other,
//   Experience, Motivation
// (Experience + Motivation were added additively in Stage 16 follow-up
//  migration — see scripts/stage16/migrate_application_qa.js.)

const CATEGORIES = [
  "Behavioral",
  "Technical",
  "Culture Fit",
  "Logistics",
  "Salary",
  "Other",
  "Experience",
  "Motivation",
];

// Patterns ordered by specificity. First match wins. Each entry: [regex, category].
// `/i` flag handles case. Trailing `\b` is omitted on stem patterns
// (e.g. `relocat`, `sponsor`, `influence`) so plurals and derivatives
// like "influences", "relocating", "sponsorship" still match.
//
// Behavioral patterns deliberately come BEFORE Technical so that
// "What's your experience with conflict?" (Behavioral, despite "experience
// with") and similar STAR-style introspective questions match correctly.
const PATTERNS = [
  // Salary — high specificity, must come before "expectations"-style motivation
  [/\b(salary|compensation|\bcomp\b|pay range|pay expectations|desired (salary|comp)|how much|expected (salary|comp))/i, "Salary"],

  // Logistics — work auth, visa, start date, location practicalities
  [/\b(visa|sponsor|relocat|start date|notice period|earliest start|when (can|could) you start|work authoriz|right to work|legally authorized|us citizen|green card)/i, "Logistics"],

  // Motivation — why join / why excited / what motivates / look forward to
  [/\bwhy (do you|are you) (want|interested|excited)\b/i, "Motivation"],
  [/\bwhy (this|that|our|us|the company|our company|our team)\b/i, "Motivation"],
  // "Why <something>?" generic — matches single-token company names ("Why Notion?",
  // "Why Anthropic?") or short forms ("Why join?", "Why apply?"). Anchors at
  // end-of-string-or-punctuation to avoid catching unrelated mid-sentence "why".
  [/\bwhy [A-Za-z][\w&-]*\s*\??\s*$/i, "Motivation"],
  [/\bwhy join\b/i, "Motivation"],
  [/\bwhat (motivates|excites|draws) you\b/i, "Motivation"],
  [/\b(look forward to|excited about|drew you to)\b/i, "Motivation"],

  // Culture fit — values, ideal team, working style preferences
  [/\b(culture|values|ideal team|work environment|how do you (like to )?work|prefer to work|team dynamic)\b/i, "Culture Fit"],

  // Behavioral — STAR-style prompts + influences/inspirations (introspective).
  // Must run before Technical to catch "experience with conflict" etc.
  [/\b(tell me about a time|describe a (time|situation)|give an example|walk me through (a|the))\b/i, "Behavioral"],
  [/\b(conflict|disagree|biggest (\w+\s)?(failure|mistake|challenge))/i, "Behavioral"],
  [/\b(admire|inspire|role model|learn the most from)/i, "Behavioral"],
  // "biggest professional influence" / "biggest influences" — explicit Behavioral.
  [/\bbiggest (\w+\s)?(influence|inspiration|mentor)/i, "Behavioral"],
  // "Who are your influences" / "professional influences" — Behavioral.
  // Carved out separately from the generic 'influence' stem so phrases like
  // "technical influences on your stack" stay free to be classified by later
  // Technical patterns when applicable.
  [/\b(your|professional|biggest) (\w+\s)?influence/i, "Behavioral"],

  // Technical — tools, stack, technical depth, AI tools.
  // Tightened: bare 'code' and 'api' are too noisy ("code of conduct",
  // "rapid api" etc.). Use scoped variants instead.
  [/\b(worked with|tools|stack|technical depth|technical background|programming|source code|code review|(writing|written|wrote|ship|shipped|production) code|sql|python|claude code|chatgpt|llm|ai tools|public api|rest api|graphql api)\b/i, "Technical"],
  // 'experience with <noun>' is Technical UNLESS the noun is behavioral —
  // which is already handled above by the Behavioral patterns running first.
  [/\bexperience with\b/i, "Technical"],

  // Experience — years, past roles, projects, achievements (catch-all for "tell me about your X")
  [/\b(years of experience|prior (role|experience)|past (role|projects)|background|tell me about your (work|experience|background|projects)|what is your experience|describe your experience|biggest (achievement|win|accomplishment)|proudest)\b/i, "Experience"],
];

function categorize(question) {
  const q = String(question || "");
  if (!q.trim()) return "Other";
  for (const [re, cat] of PATTERNS) {
    if (re.test(q)) return cat;
  }
  return "Other";
}

function isValidCategory(cat) {
  return CATEGORIES.includes(cat);
}

module.exports = { categorize, isValidCategory, CATEGORIES };
