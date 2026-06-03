// Pure. Builds a LinkedIn people-search URL for a company, optionally narrowed
// by role keywords and location. Zero network, zero automation — it only
// assembles a URL string a human clicks.
//
// RFC 059 (BL-169): the engine emits a prefab LinkedIn people-search URL for
// Medium+/Strong vacancies. The operator opens it; LinkedIn itself surfaces
// "N of your connections work here" and the operator decides warm vs cold.
//
// ToS note (load-bearing): this helper performs NO fetch, scrape, or
// connection-send. It imports nothing network-related. A US bias is expressed
// purely as a keyword string — never a LinkedIn `geoUrn` (those require
// LinkedIn's internal region ids, which must not be hardcoded/scraped).

const LINKEDIN_PEOPLE_SEARCH_BASE = "https://www.linkedin.com/search/results/people/";

// Role-derived keyword fragments. We can't know the specific hiring manager's
// name, so we bias the search toward the people who own the hire: the recruiter
// and the hiring manager. Kept deliberately generic — the operator narrows by
// hand once LinkedIn renders the results.
const ROLE_KEYWORD_FRAGMENTS = ["recruiter", "hiring manager"];

// ToS-safe US geo bias: a keyword string, not a geoUrn.
const US_KEYWORD_BIAS = "United States";

// Build the `keywords` query value: company first, then optional role-derived
// fragments, then the US bias. Plain space-joined; URLSearchParams handles the
// encoding of spaces / `&` / unicode.
function buildKeywords({ company, roleTitle, location }) {
  const parts = [String(company).trim()];
  if (roleTitle && String(roleTitle).trim()) {
    parts.push(...ROLE_KEYWORD_FRAGMENTS);
  }
  if (location && String(location).trim()) {
    parts.push(String(location).trim());
  }
  parts.push(US_KEYWORD_BIAS);
  return parts.join(" ");
}

// → "https://www.linkedin.com/search/results/people/?keywords=...&origin=..."
//
// - Missing `company` → throws.
// - Missing `roleTitle` / `location` → company-only (still a valid) URL.
function buildCompanyPeopleSearchUrl({ company, roleTitle, location } = {}) {
  if (!company || !String(company).trim()) {
    throw new Error("buildCompanyPeopleSearchUrl: `company` is required");
  }
  const params = new URLSearchParams();
  params.set("keywords", buildKeywords({ company, roleTitle, location }));
  // `origin` mirrors what LinkedIn appends for a globally-typed search; it has
  // no automation effect, it just makes the prefab URL look native.
  params.set("origin", "GLOBAL_SEARCH_HEADER");
  return `${LINKEDIN_PEOPLE_SEARCH_BASE}?${params.toString()}`;
}

module.exports = { buildCompanyPeopleSearchUrl };
