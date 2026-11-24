const { test } = require("node:test");
const assert = require("node:assert/strict");

const sb = require("./storybank_audit.js");

const TABLE = `| 🇷🇺 Говоришь так | 🇬🇧 English |
|---|---|
| Строка. | Line. |
^say-s044`;

function story(id, extra = "", table = TABLE) {
  return `#### ${id} — Название\n**Контекст.** Текст.\n\n${extra}\n${table.replace("s044", id.toLowerCase())}\n\n- **Deploy for.** Что-то.\n`;
}

const FULL_CARD = `**Карточка STAR**
- **Ситуация:** Клиенты писали ночью, ответ нужен за минуты.
- **Задача:** Отвечать сразу и не говорить лишнего.
- **Действие:** Модель пишет, код решает, что уходит клиенту.
- **Результат:** Sonnet прошёл 82 проверки из 82.
`;

test("story from S040 with no card and no marker is a finding", () => {
  const f = sb.auditStorybank(story("S044"));
  assert.equal(f.length, 1);
  assert.equal(f[0].code, "no-card");
});

test("legacy story below S040 without a card is grandfathered", () => {
  assert.deepEqual(sb.auditStorybank(story("S012")), []);
});

test("complete card passes", () => {
  assert.deepEqual(sb.auditStorybank(story("S044", FULL_CARD)), []);
});

test("card missing a field is flagged with the field name", () => {
  const card = FULL_CARD.replace(/- \*\*Задача:\*\*.*\n/, "");
  const f = sb.auditStorybank(story("S044", card));
  assert.equal(f[0].code, "card-incomplete");
  assert.match(f[0].message, /Задача/);
});

test("result with a gap marker is flagged", () => {
  const card = FULL_CARD.replace(/Результат:\*\* .*/, "Результат:** ⚠️ не записан");
  assert.equal(sb.auditStorybank(story("S045", card))[0].code, "no-result");
});

test("result «нет» is flagged, «нет ошибок» style words still count as text", () => {
  assert.equal(sb.resultIsMissing("нет"), true);
  assert.equal(sb.resultIsMissing("нет."), true);
  assert.equal(sb.resultIsMissing("нетипичных ошибок не было: 0 из 82"), false);
});

test("approach marker passes without a card and is listed as approach", () => {
  const text = story("S045", "**Тип:** подход, не STAR — результата нет, сверка не включена.\n");
  assert.deepEqual(sb.auditStorybank(text), []);
  assert.deepEqual(sb.approachStoryIds(text), ["s045"]);
});

test("card below the anchor is flagged", () => {
  const text = `#### S044 — Имя\n${TABLE}\n${FULL_CARD}`;
  const f = sb.auditStorybank(text);
  assert.equal(f[0].code, "card-after-anchor");
});

const ROLES = `#### ROLES — Последние роли
**Credit Mentor**

| 🇷🇺 Говоришь так | 🇬🇧 English |
|---|---|
| Подчинялся основателям. | I reported to the founders. |
| Ушёл, когда закрыли компанию. | I left when it closed. |
| Оценка 9 из 10. | A 9 out of 10. |

**Альфа-Банк**

| 🇷🇺 Говоришь так | 🇬🇧 English |
|---|---|
| Подчинялся Head of Product. | I reported to the Head of Product. |
| Ушёл, потому что переехал. | I left because I moved. |
| Оценка 9 из 10. | A 9 out of 10. |

**КРОК**

| 🇷🇺 Говоришь так | 🇬🇧 English |
|---|---|
| Подчинялся Head of Product. | I reported to the Head of Product. |
| Ушёл: хотел строить продукт. | I left: I wanted to build product. |
| Оценка 8 из 10. | An 8 out of 10. |

> **Если спросит**
>
> | 🇷🇺 | 🇬🇧 |
> |---|---|
> | Не обновил строку. | I did not update it. |
^say-roles
`;

test("three complete roles pass", () => {
  assert.deepEqual(sb.auditStorybank(ROLES), []);
});

test("two roles fail on count", () => {
  const two = ROLES.replace(/\*\*КРОК\*\*[\s\S]*?(?=> \*\*Если)/, "");
  const f = sb.auditStorybank(two);
  assert.equal(f[0].code, "roles-count");
});

test("role with two rows fails on rows", () => {
  const short = ROLES.replace("| Оценка 8 из 10. | An 8 out of 10. |\n", "");
  assert.ok(sb.auditStorybank(short).some((f) => f.code === "roles-rows"));
});

test("role without a score fails", () => {
  const noScore = ROLES.replace("Оценка 8 из 10.", "Оценка высокая.").replace(
    "An 8 out of 10.",
    "A high score."
  );
  assert.ok(sb.auditStorybank(noScore).some((f) => f.code === "roles-score"));
});

test("quoted «если спросит» rows are not counted as role rows", () => {
  const roles = sb.parseRoles(ROLES);
  assert.equal(roles[0].rows.length, 3);
});

test("auditChange only judges stories the write touches", () => {
  const before = story("S044") + story("S046", FULL_CARD);
  const after = before.replace("Что-то.", "Что-то ещё.");
  // both S044 bodies changed? S044 and S046 share the same Deploy line.
  const findings = sb.auditChange(before, after);
  assert.ok(findings.every((f) => f.id === "S044"));
  assert.equal(sb.auditChange(before, before).length, 0);
});

test("auditChange: unrelated edit to a legacy card-less S044 is not blocked, new card-less story is", () => {
  const before = story("S044");
  const typo = before.replace("Что-то.", "Что-то, правка.");
  assert.deepEqual(sb.auditChange(before, typo), []);
  const appended = before + "\n---\n";
  assert.deepEqual(sb.auditChange(before, appended), []);
  const fresh = before + story("S057");
  assert.equal(sb.auditChange(before, fresh)[0].code, "no-card");
});

test("auditChange: a half-written card on a legacy card-less story is judged", () => {
  const before = story("S044");
  const half = story("S044", "- **Ситуация:** Было.\n");
  assert.equal(sb.auditChange(before, half)[0].code, "card-incomplete");
});

test("scores written 9/10 or 9 of 10 count; «Нет жалоб, NPS +12» is a result", () => {
  assert.deepEqual(sb.auditRoles(ROLES.replace(/(\d) из 10/g, "$1/10")), []);
  assert.equal(sb.resultIsMissing("Нет жалоб за квартал, NPS +12"), false);
  assert.equal(sb.resultIsMissing("—"), true);
});

test("deleting the roles block is flagged; anchor glued to a row is still found", () => {
  const before = "#### S001 — x\n" + ROLES;
  const after = "#### S001 — x\n";
  assert.equal(sb.auditChange(before, after)[0].code, "roles-removed");
  const glued = ROLES.replace("\n^say-roles", " ^say-roles");
  assert.ok(sb.extractRolesBlock(glued));
});

test("story ids with a letter suffix are parsed", () => {
  assert.equal(sb.parseStories(story("S040a"))[0].id, "S040a");
});
