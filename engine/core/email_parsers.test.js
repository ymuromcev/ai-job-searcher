const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseLinkedInSubject, parseRecruiterRole, extractSenderName } =
  require("./email_parsers.js");

test("parseLinkedInSubject: RU 'Role в компании Company'", () => {
  const r = parseLinkedInSubject("Senior Product Manager в компании Stripe");
  assert.deepEqual(r, { role: "Senior Product Manager", company: "Stripe" });
});

test("parseLinkedInSubject: RU 'Role в компании Company: extra'", () => {
  const r = parseLinkedInSubject("PM в компании Affirm: и ещё 5 вакансий");
  assert.deepEqual(r, { role: "PM", company: "Affirm" });
});

test("parseLinkedInSubject: RU 'Компания X ищет специалистов: Role'", () => {
  const r = parseLinkedInSubject("Компания Block ищет специалистов: Product Manager");
  assert.deepEqual(r, { role: "Product Manager", company: "Block" });
});

test("parseLinkedInSubject: RU 'Компания X ищет специалистов: Role с зарплатой'", () => {
  const r = parseLinkedInSubject("Компания Meta ищет специалистов: PM с зарплатой до $200k");
  assert.deepEqual(r, { role: "PM", company: "Meta" });
});

test("parseLinkedInSubject: EN 'Role at Company'", () => {
  const r = parseLinkedInSubject("Growth PM at Doordash");
  assert.deepEqual(r, { role: "Growth PM", company: "Doordash" });
});

test("parseLinkedInSubject: unrecognised → null", () => {
  assert.equal(parseLinkedInSubject(""), null);
  assert.equal(parseLinkedInSubject("Random subject line"), null);
  assert.equal(parseLinkedInSubject(null), null);
});

test("parseRecruiterRole: 'Requirement for <role>'", () => {
  assert.equal(parseRecruiterRole("Requirement for Sr. Product Manager"), "Sr. Product Manager");
  assert.equal(
    parseRecruiterRole("Requirement for Product Manager :: Remote"),
    "Product Manager"
  );
  assert.equal(
    parseRecruiterRole("Requirement for Data PM, Remote in US"),
    "Data PM"
  );
});

test("parseRecruiterRole: 'Immediate need - <region> - <role>'", () => {
  assert.equal(
    parseRecruiterRole("Immediate need - NYC - Senior Product Manager"),
    "Senior Product Manager"
  );
});

test("parseRecruiterRole: 'new opportunity for <role>'", () => {
  assert.equal(
    parseRecruiterRole("A new opportunity for a Staff PM"),
    "Staff PM"
  );
});

test("parseRecruiterRole: generic subject → null", () => {
  assert.equal(parseRecruiterRole("Your profile looks great"), null);
  assert.equal(parseRecruiterRole(""), null);
});

test("extractSenderName: 'Name <email>'", () => {
  assert.equal(extractSenderName("Jane Doe <jane@acme.com>"), "Jane Doe");
  assert.equal(extractSenderName("\"Jane D.\" <jane@acme.com>"), "\"Jane D.\"");
});

test("extractSenderName: bare email → local-part", () => {
  // Prototype behavior: when no angle brackets, regex still matches the
  // characters before @ and returns them (regex pass comes before domain fallback).
  assert.equal(extractSenderName("jane@acme.com"), "jane");
});

test("extractSenderName: empty", () => {
  assert.equal(extractSenderName(""), "");
  assert.equal(extractSenderName(null), "");
});
