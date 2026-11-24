const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const guard = require("./storybank_card_guard.js");

const PATH = "/repo/profiles/jared/interview-coach-state/coaching_state.md";
const CARD = `**Карточка STAR**
- **Ситуация:** Ночные клиенты ждали ответа.
- **Задача:** Отвечать за минуты.
- **Действие:** Модель пишет, код решает.
- **Результат:** 82 проверки из 82.
`;
const BASE = `## Storybank

#### S012 — Старая
**Контекст.** Старое.

| 🇷🇺 | 🇬🇧 |
|---|---|
| а | a |
^say-s012

#### S044 — Новая
**Контекст.** Текст.

| 🇷🇺 | 🇬🇧 |
|---|---|
| б | b |
^say-s044

## Score History
`;

function edit(oldS, newS, before = BASE) {
  return guard.decide({
    toolName: "Edit",
    filePath: PATH,
    toolInput: { file_path: PATH, old_string: oldS, new_string: newS },
    beforeText: before,
  });
}

test("other files are never touched", () => {
  const r = guard.decide({
    toolName: "Write",
    filePath: "/repo/README.md",
    toolInput: { content: "#### S099 — x\n" },
    beforeText: "",
  });
  assert.equal(r.allow, true);
});

test("editing a legacy story is allowed even though S044 has no card", () => {
  assert.equal(edit("Старое.", "Старое, правка.").allow, true);
});

test("an unrelated edit to a legacy card-less S044 is allowed, half a card is blocked", () => {
  assert.equal(edit("Текст.", "Текст, правка.").allow, true);
  const r = edit("**Контекст.** Текст.\n", "**Контекст.** Текст.\n- **Ситуация:** Было.\n");
  assert.equal(r.allow, false);
  assert.match(r.reason, /card-incomplete/);
});

test("adding the card to S044 is allowed", () => {
  assert.equal(edit("**Контекст.** Текст.\n", `**Контекст.** Текст.\n\n${CARD}`).allow, true);
});

test("approach marker is accepted", () => {
  const r = edit(
    "**Контекст.** Текст.\n",
    "**Контекст.** Текст.\n\n**Тип:** подход, не STAR — результата нет.\n"
  );
  assert.equal(r.allow, true);
});

test("a brand-new story without a card via Write is blocked", () => {
  const after = BASE.replace(
    "## Score History",
    "#### S057 — Ещё\n\n| a | b |\n|---|---|\n| x | y |\n^say-s057\n\n## Score History"
  );
  const r = guard.decide({
    toolName: "Write",
    filePath: PATH,
    toolInput: { content: after },
    beforeText: BASE,
  });
  assert.equal(r.allow, false);
  assert.match(r.reason, /S057/);
});

test("MultiEdit is simulated edit by edit", () => {
  const r = guard.decide({
    toolName: "MultiEdit",
    filePath: PATH,
    toolInput: {
      edits: [
        { old_string: "**Контекст.** Текст.\n", new_string: `**Контекст.** Текст.\n\n${CARD}` },
        { old_string: "Старое.", new_string: "Старое 2." },
      ],
    },
    beforeText: BASE,
  });
  assert.equal(r.allow, true);
});

test("fail-open when old_string is not found", () => {
  assert.equal(edit("нет такой строки", "x").allow, true);
});

test("incomplete roles block is blocked", () => {
  const roles = `#### ROLES — Последние роли\n**А**\n\n| a | b |\n|---|---|\n| x | y |\n^say-roles\n`;
  const r = edit("## Score History", `${roles}\n## Score History`);
  assert.equal(r.allow, false);
  assert.match(r.reason, /roles-count/);
});

test("CLI: blocked write exits 2, malformed input exits 0", () => {
  const script = path.join(__dirname, "storybank_card_guard.js");
  const bad = spawnSync("node", [script], { input: "not json", encoding: "utf8" });
  assert.equal(bad.status, 0);
  const empty = spawnSync("node", [script], { input: "", encoding: "utf8" });
  assert.equal(empty.status, 0);
});
