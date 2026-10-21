const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSecurityCode,
  subjectCompany,
  companyMatches,
  pickCodeMail,
  findConfirmation,
  makeCodeWaiter,
} = require("./email_code.js");

const GH_BODY =
  "Copy and paste this code into the security code field on your application: Ab3dE9fZ " +
  "After you enter the code, resubmit your application.";

function mail(over = {}) {
  return {
    messageId: "m1",
    rfcMessageId: "<m1@x>",
    from: '"Greenhouse" <no-reply@us.greenhouse-mail.io>',
    subject: "Security code for your application to BILL",
    body: GH_BODY,
    date: "2026-10-21T11:04:36.000Z",
    ...over,
  };
}

test("parseSecurityCode reads the Greenhouse code", () => {
  assert.equal(parseSecurityCode(mail()), "Ab3dE9fZ");
  assert.equal(parseSecurityCode({ body: "Your verification code: 123456" }), "123456");
  assert.equal(parseSecurityCode({ body: "Thanks for applying" }), null);
});

test("subjectCompany / companyMatches tolerate the board's own company name", () => {
  assert.equal(subjectCompany("Security code for your application to BILL"), "BILL");
  assert.equal(companyMatches("BILL", "Bill.com"), true);
  assert.equal(companyMatches("Fleetio", "Fleetio"), true);
  assert.equal(companyMatches("Stripe", "Bill.com"), false);
  assert.equal(companyMatches("", "Bill.com"), false);
});

test("pickCodeMail: only fresh, unused Greenhouse mail for this company", () => {
  const since = Date.parse("2026-10-21T11:04:00.000Z");
  const used = new Set();
  assert.equal(
    pickCodeMail([mail()], { company: "Bill.com", sinceMs: since, used }).code,
    "Ab3dE9fZ"
  );
  // The previous attempt's code, a minute before this click → ignored.
  const prev = mail({ date: "2026-10-21T11:03:00.000Z", rfcMessageId: "<prev@x>" });
  assert.equal(pickCodeMail([prev], { company: "Bill.com", sinceMs: since, used }), null);
  // Older than the click (beyond the clock slack) → ignored.
  const old = mail({ date: "2026-10-21T10:00:00.000Z" });
  assert.equal(pickCodeMail([old], { company: "Bill.com", sinceMs: since, used }), null);
  // Another company's code → ignored.
  const other = mail({ subject: "Security code for your application to Stripe" });
  assert.equal(pickCodeMail([other], { company: "Bill.com", sinceMs: since, used }), null);
  // Not from Greenhouse → ignored.
  const spoof = mail({ from: "someone@example.com" });
  assert.equal(pickCodeMail([spoof], { company: "Bill.com", sinceMs: since, used }), null);
  // Already used → ignored.
  used.add("<m1@x>");
  assert.equal(pickCodeMail([mail()], { company: "Bill.com", sinceMs: since, used }), null);
});

test("makeCodeWaiter polls until the mail arrives and never reuses a code", async () => {
  let t = Date.parse("2026-10-21T11:04:00.000Z");
  let calls = 0;
  const waiter = makeCodeWaiter({
    fetchMails: async () => {
      calls += 1;
      return calls < 3 ? [] : [mail()];
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    timeoutMs: 60_000,
    pollMs: 10_000,
  });
  assert.equal(await waiter.wait({ company: "Bill.com", since: t }), "Ab3dE9fZ");
  assert.equal(calls, 3);
  // Same mail again → already used → times out with null.
  assert.equal(await waiter.wait({ company: "Bill.com", since: t - 30_000 }), null);
});

test("makeCodeWaiter survives a failing mailbox and gives up at the timeout", async () => {
  let t = 0;
  const waiter = makeCodeWaiter({
    fetchMails: async () => {
      throw new Error("imap down");
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    timeoutMs: 30_000,
    pollMs: 10_000,
  });
  assert.equal(await waiter.wait({ company: "Bill.com", since: 0 }), null);
});

test("findConfirmation: the employer's thank-you mail after the click, not a security code", () => {
  const since = Date.parse("2026-10-21T22:17:00.000Z");
  const thanks = {
    from: "no-reply@hq.bill.com",
    subject: "Thank You for Applying to Join BILL!",
    body: "Dear JARED, Thank you for applying to join us as a Lead Product Manager",
    date: "2026-10-21T22:18:15.000Z",
  };
  assert.equal(findConfirmation([thanks], { company: "Bill.com", sinceMs: since }), thanks);
  assert.equal(findConfirmation([thanks], { company: "Stripe", sinceMs: since }), null);
  assert.equal(
    findConfirmation([thanks], {
      company: "Bill.com",
      sinceMs: Date.parse("2026-10-21T23:00:00Z"),
    }),
    null,
    "older than the click"
  );
  assert.equal(
    findConfirmation([mail({ date: thanks.date })], { company: "Bill.com", sinceMs: since }),
    null
  );
});

test("makeCodeWaiter.confirmed polls the mailbox for the thank-you mail", async () => {
  let t = Date.parse("2026-10-21T22:17:00.000Z");
  let calls = 0;
  const kinds = [];
  const waiter = makeCodeWaiter({
    fetchMails: async (kind) => {
      kinds.push(kind);
      calls += 1;
      return calls < 2
        ? []
        : [
            {
              from: "no-reply@hq.bill.com",
              subject: "Thank You for Applying to Join BILL!",
              body: "",
              date: "2026-10-21T22:18:15.000Z",
            },
          ];
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    pollMs: 10_000,
  });
  const hit = await waiter.confirmed({ company: "Bill.com", since: t, waitMs: 60_000 });
  assert.equal(hit.subject, "Thank You for Applying to Join BILL!");
  assert.deepEqual(kinds, ["confirmation", "confirmation"]);
});
