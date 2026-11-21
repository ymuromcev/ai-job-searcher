// BL-243 / RFC 072 — company channel index + allow matcher.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildChannelIndex,
  channelFor,
  parseCompaniesTolerant,
  loadChannelIndexFromFile,
  loadChannelIndexForProfile,
  buildChannelAllow,
  EMPTY_INDEX,
} = require("./company_channel.js");

const LATAM = { channel: "ru_latam", ru_signal: "ex-Tinkoff founders" };
const ROWS = [
  { name: "Plata", source: "greenhouse", slug: "platacard", extra: LATAM, profile: "jared" },
  { name: "Unlimit", source: "lever", slug: "unlimit", extra: LATAM, profile: "jared" },
  { name: "Affirm", source: "greenhouse", slug: "affirm", extra: null, profile: "jared" },
];

const RULES = {
  channel_exceptions: {
    ru_latam: {
      allow_patterns: [
        "Mexico",
        "México",
        "Ciudad de México",
        "CDMX",
        "Colombia",
        "Bogotá",
        "Medellín",
        "LATAM",
        "Latin America",
        "Brazil",
        "Brasil",
        "São Paulo",
        "Argentina",
        "Buenos Aires",
        "Chile",
        "Peru",
        "Uruguay",
        "Montevideo",
      ],
    },
  },
};

// --- case 14: lookup by company name, case / trim / aliases -------------------

test("index: channel by company name ignores case, spaces and legal suffix", () => {
  const idx = buildChannelIndex(ROWS, { profileId: "jared" });
  assert.equal(idx.channelOf("Plata"), "ru_latam");
  assert.equal(idx.channelOf("  plata  "), "ru_latam");
  assert.equal(idx.channelOf("PLATA"), "ru_latam");
  assert.equal(idx.channelOf("Plata, Inc."), "ru_latam");
  assert.equal(idx.channelOf("Unlimit"), "ru_latam");
  assert.equal(idx.channelOf("Affirm"), "");
  assert.equal(idx.channelOf(""), "");
  assert.equal(idx.channelOf(null), "");
});

test("index: company_aliases of the profile give brands the parent's channel", () => {
  const idx = buildChannelIndex(ROWS, {
    profileId: "jared",
    aliases: { Plata: ["Plata Card", "Plata Mexico"], Affirm: ["Affirm Holdings"] },
  });
  assert.equal(idx.channelOf("Plata Card"), "ru_latam");
  assert.equal(idx.channelOf("plata mexico"), "ru_latam");
  // Affirm has no channel → its brand has none either.
  assert.equal(idx.channelOf("Affirm Holdings"), "");
});

// --- case 15: exact match, never a prefix --------------------------------------

test("index: «Unlimited Technologies» is not Unlimit (exact match, not prefix)", () => {
  const idx = buildChannelIndex(ROWS, { profileId: "jared" });
  assert.equal(idx.channelOf("Unlimited Technologies"), "");
  assert.equal(idx.channelOf("Unlimited"), "");
  assert.equal(idx.channelOf("Platanus"), "");
});

// --- case 16: unlisted brand has no channel ---------------------------------------

test("index: «Plata Card» without an alias has no channel", () => {
  const idx = buildChannelIndex(ROWS, { profileId: "jared" });
  assert.equal(idx.channelOf("Plata Card"), "");
  assert.equal(idx.channelOf("Plata Mexico"), "");
});

// --- case 17: broken / missing / other channel ------------------------------------

test("index: broken extra_json, no channel, non-string channel → no channel, no throw", () => {
  const raw = [
    "name\tats_source\tats_slug\textra_json\tprofile",
    'Plata\tgreenhouse\tplatacard\t{"channel":"ru_latam"}\tjared',
    "Broken Co\tgreenhouse\tbroken\t{not json\tjared",
    'NoChannel\tgreenhouse\tnc\t{"ru_signal":"x"}\tjared',
    'Numeric\tgreenhouse\tnum\t{"channel":5}\tjared',
    'Blank\tgreenhouse\tblank\t{"channel":"  "}\tjared',
    'Array\tgreenhouse\tarr\t["channel"]\tjared',
    "Short\tgreenhouse",
    'Latam Only\tgreenhouse\tlo\t{"channel":"latam"}\tjared',
  ].join("\n");
  const rows = parseCompaniesTolerant(raw);
  const idx = buildChannelIndex(rows, { profileId: "jared" });
  assert.equal(idx.channelOf("Plata"), "ru_latam");
  for (const n of ["Broken Co", "NoChannel", "Numeric", "Blank", "Array", "Short"]) {
    assert.equal(idx.channelOf(n), "", n);
  }
  // Another channel is indexed under its own name, never as ru_latam.
  assert.equal(idx.channelOf("Latam Only"), "latam");
  assert.notEqual(idx.channelOf("Latam Only"), "ru_latam");
});

test("index: a row for another profile is invisible; null / junk input is safe", () => {
  const rows = [{ name: "Plata", extra: LATAM, profile: "lilia" }];
  assert.equal(buildChannelIndex(rows, { profileId: "jared" }).channelOf("Plata"), "");
  assert.equal(buildChannelIndex(rows).channelOf("Plata"), "ru_latam");
  assert.equal(buildChannelIndex(null).size, 0);
  assert.equal(buildChannelIndex([null, {}, { name: 5 }]).size, 0);
  assert.equal(channelFor(null, "Plata"), "");
  assert.equal(channelFor(undefined, "Plata"), "");
  assert.equal(channelFor(EMPTY_INDEX, "Plata"), "");
});

test("loadChannelIndexFromFile: missing file → empty index; real file parsed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chan-"));
  assert.equal(loadChannelIndexFromFile(path.join(dir, "nope.tsv")).channelOf("Plata"), "");
  const file = path.join(dir, "companies.tsv");
  fs.writeFileSync(
    file,
    'name\tats_source\tats_slug\textra_json\tprofile\nPlata\tgreenhouse\tplatacard\t{"channel":"ru_latam"}\tjared\n'
  );
  assert.equal(
    loadChannelIndexFromFile(file, { profileId: "jared" }).channelOf("Plata"),
    "ru_latam"
  );
});

test("loadChannelIndexForProfile: reads the pool only when the profile has channel_exceptions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chan-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(
    path.join(dir, "data", "companies.tsv"),
    'name\tats_source\tats_slug\textra_json\tprofile\nPlata\tgreenhouse\tplatacard\t{"channel":"ru_latam"}\t\n'
  );
  const withRules = { id: "jared", filterRules: RULES, company_aliases: { Plata: ["Plata Card"] } };
  const idx = loadChannelIndexForProfile(withRules, dir);
  assert.equal(idx.channelOf("Plata"), "ru_latam");
  assert.equal(idx.channelOf("Plata Card"), "ru_latam");
  // Case 18: a profile without the block (lilia) gets nothing.
  const lilia = { id: "lilia", filterRules: { location_blocklist: [] } };
  assert.equal(loadChannelIndexForProfile(lilia, dir).channelOf("Plata"), "");
  assert.equal(loadChannelIndexForProfile({ id: "x" }, dir).channelOf("Plata"), "");
});

// --- allow matcher (case 24) -----------------------------------------------------

test("allow: cities, accents and country names pass; boundaries hold", () => {
  const allow = buildChannelAllow(RULES, "ru_latam");
  for (const loc of [
    "Mexico City",
    "Mexico City, Mexico",
    "Ciudad de México",
    "CDMX",
    "México",
    "Bogotá",
    "Bogota, Colombia",
    "Medellín",
    "São Paulo",
    "Sao Paulo, Brazil",
    "Brasil",
    "Buenos Aires",
    "Montevideo",
    "Remote, Brazil",
    "Remote - LATAM",
    "Latin America",
    "Santiago, Chile",
    "Lima, Peru",
    "mexico city",
  ]) {
    assert.equal(allow.test(loc), true, loc);
  }
  for (const loc of [
    "Cyprus",
    "Limassol, Cyprus",
    "London",
    "Moscow",
    "Yerevan",
    "Belgrade",
    "Madrid",
    "Albuquerque, New Mexico",
    "Peruvian Hall",
    "Chilean",
    "",
  ]) {
    assert.equal(allow.test(loc), false, loc || "(empty)");
  }
});

test("allow: no block / other channel / empty list → null (no exception)", () => {
  assert.equal(buildChannelAllow({}, "ru_latam"), null);
  assert.equal(buildChannelAllow(null, "ru_latam"), null);
  assert.equal(buildChannelAllow(RULES, ""), null);
  assert.equal(buildChannelAllow(RULES, "latam"), null);
  assert.equal(buildChannelAllow(RULES, "constructor"), null);
  assert.equal(buildChannelAllow({ channel_exceptions: { ru_latam: {} } }, "ru_latam"), null);
  assert.equal(
    buildChannelAllow({ channel_exceptions: { ru_latam: { allow_patterns: [] } } }, "ru_latam"),
    null
  );
});

// --- BL-243 round 2, point 7: Unlimit's «Sao Paolo» typo and «Lima» --------------

test("allow (example profile): «Sao Paolo» (typo) and «Lima» pass; «Limassol» does not", () => {
  const example = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "..", "profiles", "_example", "filter_rules.example.json"),
      "utf8"
    )
  );
  const allow = buildChannelAllow(example, "ru_latam");
  for (const loc of ["Sao Paolo", "Sao Paolo, Brazil", "São Paulo", "Lima", "Lima, Peru"]) {
    assert.equal(allow.test(loc), true, loc);
  }
  for (const loc of ["Limassol, Cyprus", "Cyprus"]) {
    assert.equal(allow.test(loc), false, loc);
  }
});
