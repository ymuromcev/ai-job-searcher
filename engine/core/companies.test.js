const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const companies = require("./companies.js");

function tmpFile(name = "companies.tsv") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-companies-"));
  return path.join(dir, name);
}

test("load returns empty when file does not exist", () => {
  const result = companies.load("/tmp/does-not-exist-aijs.tsv");
  assert.deepEqual(result.rows, []);
});

test("save + load round-trips rows including extra_json", () => {
  const file = tmpFile();
  const rows = [
    { name: "Affirm", source: "greenhouse", slug: "affirm", extra: null },
    { name: "Capital One", source: "workday", slug: "capitalone", extra: { dc: "wd1", site: "jobs" } },
    { name: "Ramp", source: "ashby", slug: "ramp", extra: null },
  ];
  companies.save(file, rows);
  const back = companies.load(file);
  assert.equal(back.rows.length, 3);
  assert.equal(back.rows[1].name, "Capital One");
  assert.deepEqual(back.rows[1].extra, { dc: "wd1", site: "jobs" });
  // Source must be lowercased even if input was mixed case.
  assert.equal(back.rows[0].source, "greenhouse");
});

test("load throws on malformed header", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "name\tats_source\nBosch\tsmartrecruiters\n");
  assert.throws(() => companies.load(file), /header mismatch/);
});

test("load throws on missing required field", () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    "name\tats_source\tats_slug\textra_json\nAcme\t\tslug\t\n"
  );
  assert.throws(() => companies.load(file), /name\/ats_source\/ats_slug are all required/);
});

test("load throws on invalid JSON in extra_json", () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    "name\tats_source\tats_slug\textra_json\nAcme\tworkday\tacme\t{not json\n"
  );
  assert.throws(() => companies.load(file), /invalid extra_json/);
});

test("load silently dedupes by (source, slug)", () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    "name\tats_source\tats_slug\textra_json\nAcme\tashby\tacme\t\nAcme\tashby\tacme\t\n"
  );
  const { rows } = companies.load(file);
  assert.equal(rows.length, 1);
});

test("merge adds new rows and updates changed ones", () => {
  const existing = [
    { name: "Affirm", source: "greenhouse", slug: "affirm", extra: null },
    { name: "Old Name", source: "ashby", slug: "ramp", extra: null },
  ];
  const incoming = [
    { name: "Old Name", source: "ashby", slug: "ramp", extra: { team: "Product" } }, // updated
    { name: "Stripe", source: "greenhouse", slug: "stripe", extra: null }, // new
    { name: "Affirm", source: "greenhouse", slug: "affirm", extra: null }, // unchanged
  ];
  const { rows, added, updated } = companies.merge(existing, incoming);
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.equal(rows.length, 3);
  const ramp = rows.find((r) => r.slug === "ramp");
  assert.deepEqual(ramp.extra, { team: "Product" });
});

test("groupBySource buckets rows for adapter consumption", () => {
  const rows = [
    { name: "A", source: "greenhouse", slug: "a", extra: null },
    { name: "B", source: "greenhouse", slug: "b", extra: null },
    { name: "C", source: "workday", slug: "c", extra: { dc: "wd5" } },
  ];
  const grouped = companies.groupBySource(rows);
  assert.deepEqual(Object.keys(grouped).sort(), ["greenhouse", "workday"]);
  assert.equal(grouped.greenhouse.length, 2);
  assert.deepEqual(grouped.workday[0], { name: "C", slug: "c", dc: "wd5" });
});

test("save uses atomic rename (no .tmp leftover)", () => {
  const file = tmpFile();
  companies.save(file, [{ name: "X", source: "lever", slug: "x", extra: null }]);
  const dir = path.dirname(file);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
  assert.deepEqual(leftovers, []);
});

test("escape strips tabs/newlines from field values", () => {
  const file = tmpFile();
  companies.save(file, [
    { name: "Bad\tName\nWith\rWhitespace", source: "lever", slug: "bad\tslug", extra: null },
  ]);
  const back = companies.load(file);
  assert.equal(back.rows.length, 1);
  assert.equal(back.rows[0].name, "Bad Name With Whitespace");
  assert.equal(back.rows[0].slug, "bad slug");
});

// --- profile column (RFC 010 part B) ---

test("parse + serialize: 5-col schema with profile round-trips", () => {
  const file = tmpFile();
  companies.save(file, [
    { name: "Affirm", source: "greenhouse", slug: "affirm", extra: null, profile: "jared" },
    { name: "Sutter Health", source: "workday", slug: "sutterhealth", extra: { dc: "wd1" }, profile: "lilia" },
    { name: "Public Co", source: "lever", slug: "pub", extra: null, profile: "" },
  ]);
  const back = companies.load(file);
  assert.equal(back.rows.length, 3);
  assert.equal(back.rows[0].profile, "jared");
  assert.equal(back.rows[1].profile, "lilia");
  assert.equal(back.rows[2].profile, "");
});

test("parse: legacy 4-col rows load with profile=\"\" (backward-compat)", () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    "name\tats_source\tats_slug\textra_json\nAffirm\tgreenhouse\taffirm\t\nStripe\tlever\tstripe\t\n"
  );
  const back = companies.load(file);
  assert.equal(back.rows.length, 2);
  assert.equal(back.rows[0].profile, "");
  assert.equal(back.rows[1].profile, "");
});

test("parse: \"both\" alias normalizes to empty profile", () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    "name\tats_source\tats_slug\textra_json\tprofile\nX\tlever\tx\t\tboth\nY\tlever\ty\t\tBOTH\n"
  );
  const back = companies.load(file);
  assert.equal(back.rows[0].profile, "");
  assert.equal(back.rows[1].profile, "");
});

test("filterByProfile: public + matching + multi-id rows visible", () => {
  const rows = [
    { name: "A", source: "x", slug: "a", profile: "jared" },
    { name: "B", source: "x", slug: "b", profile: "lilia" },
    { name: "C", source: "x", slug: "c", profile: "" },
    { name: "D", source: "x", slug: "d", profile: "jared,lilia" },
  ];
  const jared = companies.filterByProfile(rows, "jared").map((r) => r.name).sort();
  const lilia = companies.filterByProfile(rows, "lilia").map((r) => r.name).sort();
  assert.deepEqual(jared, ["A", "C", "D"]);
  assert.deepEqual(lilia, ["B", "C", "D"]);
});

test("filterByProfile: empty profileId returns all rows untouched", () => {
  const rows = [
    { name: "A", source: "x", slug: "a", profile: "jared" },
    { name: "B", source: "x", slug: "b", profile: "lilia" },
  ];
  const all = companies.filterByProfile(rows, "");
  assert.equal(all.length, 2);
});

test("groupBySource exposes profile on target", () => {
  const rows = [
    { name: "A", source: "lever", slug: "a", extra: null, profile: "jared" },
    { name: "B", source: "lever", slug: "b", extra: { dc: "wd1" }, profile: "lilia" },
  ];
  const g = companies.groupBySource(rows);
  assert.equal(g.lever[0].profile, "jared");
  assert.equal(g.lever[1].profile, "lilia");
  assert.equal(g.lever[1].dc, "wd1");
});
