// Doc-guard for the pipeline-fit-evaluator subagent prompt (RFC 060 / BL-192).
// The agent file lives outside the test glob (`.claude/agents/`), so this test
// reaches it by path. It guards the fit-scoring contract against regression:
// the evaluator must score against the generated achievement digest
// (`memory.fitProfile`), generically, not against the old domain rubric.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const AGENT_PATH = path.resolve(__dirname, "../.claude/agents/pipeline-fit-evaluator.md");

test("pipeline-fit-evaluator: exists and is the fit subagent", () => {
  assert.ok(fs.existsSync(AGENT_PATH), "pipeline-fit-evaluator.md missing");
  const text = fs.readFileSync(AGENT_PATH, "utf8");
  assert.match(text, /^name:\s*pipeline-fit-evaluator/m);
});

test("pipeline-fit-evaluator: scores against the achievement digest, generically", () => {
  const text = fs.readFileSync(AGENT_PATH, "utf8");
  // fitProfile is the fit basis; resumeKeyPoints is demoted to fallback only.
  assert.match(text, /profile_context\.memory\.fitProfile/);
  assert.match(text, /Achievement-overlap rubric/i);
  // Generic: no domain is privileged; AI roles can be Strong.
  assert.match(text, /there is no domain that is privileged over another/i);
  assert.match(text, /AI-product \/ AI-native-PM role/i);
  // seed/confirmed does not gate.
  assert.match(text, /Every achievement counts equally regardless of its `seed`\/`confirmed`/);
});

test("pipeline-fit-evaluator: old resumeKeyPoints domain rubric is gone", () => {
  const text = fs.readFileSync(AGENT_PATH, "utf8");
  assert.doesNotMatch(
    text,
    /core domain match \(per `profile_context\.memory\.resumeKeyPoints`\)/,
    "old domain-rubric Strong rule must be gone"
  );
});
