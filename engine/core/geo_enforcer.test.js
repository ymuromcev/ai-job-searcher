// Tests for geo_enforcer (RFC 013, L-4).

const test = require("node:test");
const assert = require("node:assert");

const { enforceGeo, isRemoteLoc, hasUsMarker } = require("./geo_enforcer.js");

// --- Mode: unrestricted ----------------------------------------------------

test("unrestricted mode passes everything", () => {
  const geo = { mode: "unrestricted" };
  assert.deepStrictEqual(
    enforceGeo(["Sacramento, CA"], geo),
    { ok: true, reason: null, matchedBy: "unrestricted" }
  );
  assert.deepStrictEqual(
    enforceGeo(["Munich, Germany"], geo),
    { ok: true, reason: null, matchedBy: "unrestricted" }
  );
  assert.deepStrictEqual(
    enforceGeo([], geo),
    { ok: true, reason: null, matchedBy: "unrestricted" }
  );
});

test("unrestricted mode still applies blocklist", () => {
  const geo = { mode: "unrestricted", blocklist: ["Napa"] };
  const r = enforceGeo(["Napa, CA"], geo);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "geo_blocklist");
});

test("missing geo block defaults to unrestricted (defensive)", () => {
  const r = enforceGeo(["Anywhere"], null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.matchedBy, "unrestricted");
});

// --- Mode: metro -----------------------------------------------------------

test("metro mode: city + state match passes", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento", "Roseville", "Folsom"],
    states: ["CA"],
  };
  const r = enforceGeo(["Sacramento, CA"], geo);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.matchedBy, "city:Sacramento");
});

test("metro mode: bare city (no state info) accepted — Sutter Health adapter case", () => {
  // Sutter Health adapter outputs locations like "Roseville" (no state).
  // No state info present → city-match is unambiguous → accept.
  const geo = {
    mode: "metro",
    cities: ["Roseville", "Sacramento"],
    states: ["CA"],
  };
  assert.strictEqual(enforceGeo(["Roseville"], geo).ok, true);
  assert.strictEqual(enforceGeo(["Sacramento"], geo).ok, true);
});

test("metro mode: city match but state miss → reject (Auburn ambiguity)", () => {
  const geo = {
    mode: "metro",
    cities: ["Auburn"],
    states: ["CA"],
  };
  // Alabama Auburn — same name, different state
  const r = enforceGeo(["Auburn, AL"], geo);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "geo_metro_miss");
});

test("metro mode: city miss → reject", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento"],
    states: ["CA"],
  };
  const r = enforceGeo(["Los Angeles, CA"], geo);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "geo_metro_miss");
});

test("metro mode: remote_ok=false rejects remote postings", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento"],
    states: ["CA"],
    remote_ok: false,
  };
  const r = enforceGeo(["Remote"], geo);
  assert.strictEqual(r.ok, false);
});

test("metro mode: remote_ok=true allows remote postings", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento"],
    states: ["CA"],
    remote_ok: true,
  };
  const r = enforceGeo(["Remote"], geo);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.matchedBy, "remote");
});

test("metro mode: multi-location — one match is enough", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento"],
    states: ["CA"],
  };
  const r = enforceGeo(["New York, NY", "Sacramento, CA", "Austin, TX"], geo);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.matchedBy, "city:Sacramento");
});

test("metro mode: multi-location — all miss → reject", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento"],
    states: ["CA"],
  };
  const r = enforceGeo(["New York, NY", "Austin, TX"], geo);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "geo_metro_miss");
});

test("metro mode: 'Hybrid - Sacramento, CA' substring match", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento"],
    states: ["CA"],
  };
  const r = enforceGeo(["Hybrid - Sacramento, CA"], geo);
  assert.strictEqual(r.ok, true);
});

test("metro mode: empty locations → geo_no_location", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento"],
    states: ["CA"],
  };
  assert.strictEqual(enforceGeo([], geo).reason, "geo_no_location");
  assert.strictEqual(enforceGeo([""], geo).reason, "geo_no_location");
  assert.strictEqual(enforceGeo(null, geo).reason, "geo_no_location");
});

test("metro mode: blocklist beats positive match for that single location", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento", "Napa"],
    states: ["CA"],
    blocklist: ["Napa"],
  };
  // Single-location: Napa is blocklisted → reject
  const r1 = enforceGeo(["Napa, CA"], geo);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, "geo_blocklist");
  // Multi-location: Sacramento ALSO listed → that one passes, blocklist is per-loc
  const r2 = enforceGeo(["Napa, CA", "Sacramento, CA"], geo);
  assert.strictEqual(r2.ok, true);
});

// --- Mode: us-wide ---------------------------------------------------------

test("us-wide: 'United States' marker passes", () => {
  const geo = { mode: "us-wide" };
  const r = enforceGeo(["United States"], geo);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.matchedBy, "country:US");
});

test("us-wide: state code passes", () => {
  const geo = { mode: "us-wide" };
  assert.strictEqual(enforceGeo(["Sacramento, CA"], geo).ok, true);
  assert.strictEqual(enforceGeo(["New York, NY"], geo).ok, true);
});

test("us-wide: full state name passes", () => {
  const geo = { mode: "us-wide" };
  assert.strictEqual(enforceGeo(["California"], geo).ok, true);
  assert.strictEqual(enforceGeo(["Texas"], geo).ok, true);
});

test("us-wide: non-US rejected", () => {
  const geo = { mode: "us-wide" };
  const r = enforceGeo(["Munich, Germany"], geo);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "geo_country_miss");
});

test("us-wide: remote_ok=true allows Remote", () => {
  const geo = { mode: "us-wide", remote_ok: true };
  assert.strictEqual(enforceGeo(["Remote"], geo).ok, true);
});

test("us-wide: 'USA' / '(US)' / 'U.S.' markers all match", () => {
  const geo = { mode: "us-wide" };
  assert.strictEqual(enforceGeo(["USA"], geo).ok, true);
  assert.strictEqual(enforceGeo(["Boston (US)"], geo).ok, true);
  assert.strictEqual(enforceGeo(["U.S. - Anywhere"], geo).ok, true);
});

// --- Mode: remote-only -----------------------------------------------------

test("remote-only: 'Remote' passes", () => {
  const geo = { mode: "remote-only" };
  const r = enforceGeo(["Remote"], geo);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.matchedBy, "remote");
});

test("remote-only: 'Anywhere' passes", () => {
  const geo = { mode: "remote-only" };
  assert.strictEqual(enforceGeo(["Anywhere"], geo).ok, true);
});

test("remote-only: physical location rejected", () => {
  const geo = { mode: "remote-only" };
  const r = enforceGeo(["Sacramento, CA"], geo);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "geo_remote_only_miss");
});

// --- Helpers ---------------------------------------------------------------

test("isRemoteLoc detects common variants", () => {
  assert.strictEqual(isRemoteLoc("remote"), true);
  assert.strictEqual(isRemoteLoc("anywhere"), true);
  assert.strictEqual(isRemoteLoc("work from home"), true);
  assert.strictEqual(isRemoteLoc("wfh - any location"), true);
  assert.strictEqual(isRemoteLoc("sacramento, ca"), false);
});

test("hasUsMarker detects US markers and state codes", () => {
  assert.strictEqual(hasUsMarker("united states"), true);
  assert.strictEqual(hasUsMarker("usa"), true);
  assert.strictEqual(hasUsMarker("sacramento, ca"), true);
  assert.strictEqual(hasUsMarker("california"), true);
  assert.strictEqual(hasUsMarker("munich, germany"), false);
  // Boundary check — "ca" should not match inside word
  assert.strictEqual(hasUsMarker("cairo, egypt"), false);
});

// --- Single-string legacy fallback ----------------------------------------

test("single string locations (legacy) accepted", () => {
  const geo = {
    mode: "metro",
    cities: ["Sacramento"],
    states: ["CA"],
  };
  const r = enforceGeo("Sacramento, CA", geo);
  assert.strictEqual(r.ok, true);
});

// --- Lilia full profile fixture --------------------------------------------

test("Lilia metro profile: Sacramento area variants pass", () => {
  const geo = {
    mode: "metro",
    cities: [
      "Sacramento", "Roseville", "Folsom", "Rocklin", "Citrus Heights",
      "Elk Grove", "Auburn", "Rancho Cordova", "Davis", "West Sacramento",
      "Carmichael", "Fair Oaks",
    ],
    states: ["CA"],
    remote_ok: false,
    blocklist: ["Napa", "Stockton", "Lodi", "Vacaville", "Modesto"],
  };
  // Healthcare local roles
  assert.strictEqual(enforceGeo(["Roseville, CA"], geo).ok, true);
  assert.strictEqual(enforceGeo(["Folsom, CA"], geo).ok, true);
  assert.strictEqual(enforceGeo(["Sacramento, California"], geo).ok, true);
  // Auburn AL gets rejected by state mismatch
  assert.strictEqual(enforceGeo(["Auburn, AL"], geo).ok, false);
  // Out of metro
  assert.strictEqual(enforceGeo(["Los Angeles, CA"], geo).ok, false);
  // Blocked cities
  assert.strictEqual(enforceGeo(["Napa, CA"], geo).reason, "geo_blocklist");
  assert.strictEqual(enforceGeo(["Stockton, CA"], geo).reason, "geo_blocklist");
  // Remote not allowed
  assert.strictEqual(enforceGeo(["Remote"], geo).ok, false);
  // Munich (Fresenius global posting) — rejected
  assert.strictEqual(enforceGeo(["Munich, Germany"], geo).ok, false);
});

test("Jared unrestricted profile: passes both US and global", () => {
  const geo = { mode: "unrestricted", remote_ok: true };
  assert.strictEqual(enforceGeo(["Sacramento, CA"], geo).ok, true);
  assert.strictEqual(enforceGeo(["London, UK"], geo).ok, true);
  assert.strictEqual(enforceGeo(["Remote"], geo).ok, true);
  assert.strictEqual(enforceGeo([], geo).ok, true);
});
