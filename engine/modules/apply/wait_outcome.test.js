const test = require("node:test");
const assert = require("node:assert/strict");

const { waitForOutcome } = require("./_dom.js");

// A page whose blocker check always says "email_verification" (the code
// field stays on screen while the resubmit is processed).
function codePage() {
  return { evaluate: async () => "email_verification", url: () => "https://x/apply" };
}

test("waitForOutcome stops on a blocker by default", async () => {
  const r = await waitForOutcome(codePage(), {
    isSuccess: async () => null,
    timeoutMs: 1000,
    pollMs: 1,
  });
  assert.deepEqual([r.ok, r.reason], [false, "email_verification"]);
});

test("waitForOutcome looks past an ignored blocker and still sees the confirmation", async () => {
  let polls = 0;
  const r = await waitForOutcome(codePage(), {
    isSuccess: async () => (++polls >= 3 ? { url: "done", text: "Thank you" } : null),
    ignoreBlockers: ["email_verification"],
    timeoutMs: 1000,
    pollMs: 1,
  });
  assert.equal(r.ok, true);
  assert.equal(polls, 3);
});
