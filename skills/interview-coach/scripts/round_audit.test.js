// Unit tests for the round-file detectors. One fixture per detector, plus a
// clean round that must produce zero findings.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const audit = require("./round_audit.js");

const CALL_AT = "2026-08-05T14:00:00-07:00";
const CALL_MS = Date.parse(CALL_AT);

const DEFAULT_CASES = `### K1 · малый — Тест на активации дал +2.1%, катим?

- Как понял, что прирост не шум? → интервал прироста не накрывает ноль \`[тема 1]\`
`;

function round({
  kind = "exam",
  status = "prep",
  curriculum,
  debts = "",
  datetime = CALL_AT,
  cases = DEFAULT_CASES,
} = {}) {
  const rows =
    curriculum === undefined
      ? "| 1   | «доверительные интервалы» | Wasserman 6.3 | CR 10% → 13% | отработан вслух |"
      : curriculum;
  return `---
kind: ${kind}
company: "Plata"
datetime: "${datetime}"
scope_source: "Plata_prep.docx"
sources:
  - "Wasserman, All of Statistics — ch. 6"
status: ${status}
---

# Plata — раунд

## Кейсы

${cases}

## Программа

| #   | Тема | Источник (раздел) | Прогонный кейс | Статус |
| --- | ---- | ----------------- | -------------- | ------ |
${rows}

## Долги

| id  | Дата | Долг | Почему всплыл | Закрыт |
| --- | ---- | ---- | ------------- | ------ |
${debts}
`;
}

const CLEAN_SHEET = `# Шпаргалка

## 1.1 Доверительный интервал · CI

- Триггер: эксперимент закончился, надо сказать — эффект это или шум.
- Определение: диапазон, накрывающий истинное значение с заданной вероятностью.
- Для меня: сколько ещё трафика нужно, чтобы поверить в прирост.
- Формула: h = z·√(p(1−p)/n) Вытекает из: SE доли и нормального приближения.
- 🗣️ Если спросят: «Интервал сужается как корень из n, поэтому вчетверо больше данных дают вдвое узкий интервал.»
`;

test("clean exam round with a matching cheat sheet produces no findings", () => {
  const findings = audit.auditRound({
    roundText: round(),
    cheatsheetText: CLEAN_SHEET,
    mtimeMs: CALL_MS - 30 * 3600 * 1000,
  });
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
});

test("frontmatter parses scalars and list values", () => {
  const fm = audit.parseFrontmatter(round());
  assert.equal(fm.kind, "exam");
  assert.equal(fm.company, "Plata");
  assert.equal(fm.status, "prep");
  assert.deepEqual(fm.sources, ["Wasserman, All of Statistics — ch. 6"]);
});

test("detector 1 — a topic with an empty source cell", () => {
  const text = round({
    curriculum: "| 2 | «статистические критерии» |  | CR 10% → 13% | не начат |",
  });
  const found = audit.detectMissingSource(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "missing-source");
  assert.match(found[0].message, /статистические критерии/);
});

test("detector 1 — an explicit «мой синтез» source is accepted", () => {
  const text = round({ curriculum: "| 2 | «риск-аппетит» | мой синтез | — | объяснён |" });
  assert.deepEqual(audit.detectMissingSource(text), []);
});

test("detector 2 — readiness claimed with an unfinished row", () => {
  const text = round({
    status: "ready",
    curriculum: "| 1 | «доверительные интервалы» | Wasserman 6.3 | CR | объяснён |",
  });
  const found = audit.detectUnstartedWhenReady(text);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /status: ready/);
});

test("detector 2 — silent while status is still prep", () => {
  const text = round({ curriculum: "| 1 | «интервалы» | Wasserman 6.3 | CR | не начат |" });
  assert.deepEqual(audit.detectUnstartedWhenReady(text), []);
});

test("detector 3 — an open debt is reported, a closed one is not", () => {
  const open = round({
    debts: "| D1 | 2026-07-27 | перекрытие интервалов | сказал «забудь» | — |",
  });
  assert.equal(audit.detectOpenDebts(open).length, 1);

  const closed = round({
    debts:
      "| D1 | 2026-07-27 | перекрытие интервалов | сказал «забудь» | 2026-07-28 — проговорено вслух |",
  });
  assert.deepEqual(audit.detectOpenDebts(closed), []);
});

test("detector 4 — a gap in debt ids means a deleted row", () => {
  const text = round({
    debts: [
      "| D1 | 2026-07-27 | долг один | … | 2026-07-28 — проговорено вслух |",
      "| D3 | 2026-07-28 | долг три | … | 2026-07-29 — проговорено вслух |",
    ].join("\n"),
  });
  const found = audit.detectDebtIdGap(text);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /D2/);
});

test("detector 4 — contiguous ids are clean", () => {
  const text = round({
    debts: [
      "| D1 | 2026-07-27 | долг один | … | 2026-07-28 — проговорено вслух |",
      "| D2 | 2026-07-28 | долг два | … | — |",
    ].join("\n"),
  });
  assert.deepEqual(audit.detectDebtIdGap(text), []);
});

test("detector 5 — a formula without «Вытекает из»", () => {
  const sheet = `## 1.1 Интервал · CI

- Определение: диапазон.
- Формула: h = z·√(p(1−p)/n)
- 🗣️ Если спросят: «Сужается как корень из n.»
`;
  const found = audit.detectFormulaWithoutDerivation(sheet);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "formula-without-derivation");
});

test("detector 6 — a cheat-sheet entry without a spoken line", () => {
  const sheet = `## 1.1 Интервал · CI

- Определение: диапазон.
- Формула: h = z·√(p(1−p)/n) Вытекает из: SE доли.
`;
  const found = audit.detectSpokenLineMissing(sheet);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Если спросят/);
});

test("detector 7 — a curriculum topic with no cheat-sheet entry", () => {
  const text = round({
    curriculum: [
      "| 1 | «интервалы» | Wasserman 6.3 | CR | отработан вслух |",
      "| 2 | «критерии» | Wasserman 10.1 | CR | отработан вслух |",
    ].join("\n"),
  });
  const found = audit.detectTopicNotInCheatsheet(text, CLEAN_SHEET);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /критерии/);
});

test("detector 7 — a «служебное» row needs no cheat-sheet entry of its own", () => {
  const text = round({
    curriculum: [
      "| 1 | «интервалы» | Wasserman 6.3 | CR | отработан вслух |",
      "| 2 | «нотация суммирования» — служебное, внутри темы 1 | Wasserman 1.2 | CR | объяснён |",
    ].join("\n"),
  });
  assert.deepEqual(audit.detectTopicNotInCheatsheet(text, CLEAN_SHEET), []);
});

test("detector 8 — a selling section inside an exam round", () => {
  const text = round().replace(
    "# Plata — раунд",
    "# Plata — раунд\n\n## 🗣️ 5. Твоё позиционирование\n\nтекст"
  );
  const found = audit.detectForbiddenSection(text);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /запрещена/);
});

test("detector 8 — a curriculum table inside a screening round", () => {
  const text = round({ kind: "screening" });
  const codes = audit.detectForbiddenSection(text).map((f) => f.code);
  assert.ok(codes.includes("forbidden-section"));
});

test("detector 8 — unknown kind is silent (fail-open)", () => {
  const text = round({ kind: "whatever" });
  assert.deepEqual(audit.detectForbiddenSection(text), []);
});

test("detector 9 — a write inside the freeze window", () => {
  const text = round();
  const inside = audit.detectWriteAfterFreeze(text, CALL_MS - 2 * 3600 * 1000);
  assert.equal(inside.length, 1);
  assert.match(inside[0].message, /стоп-линии/);

  const outside = audit.detectWriteAfterFreeze(text, CALL_MS - 10 * 3600 * 1000);
  assert.deepEqual(outside, []);
});

test("detector 9 — missing datetime fails open", () => {
  const text = round({ datetime: "" });
  assert.deepEqual(audit.detectWriteAfterFreeze(text, CALL_MS), []);
});

test("parseCases reads the apex, the level and the unroll nodes", () => {
  const cases = audit.parseCases(round());
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, "K1");
  assert.equal(cases[0].level, "малый");
  assert.match(cases[0].apex, /катим\?$/);
  assert.equal(cases[0].nodes.length, 1);
  assert.equal(cases[0].nodes[0].isAnswer, true);
  assert.deepEqual(cases[0].nodes[0].topics, ["1"]);
});

test("detector 10 — a curriculum topic no case reaches", () => {
  const text = round({
    curriculum: [
      "| 1 | «интервалы» | Wasserman 6.3 | CR | отработан вслух |",
      "| 2 | «мощность и MDE» | Kohavi 17 | CR | не начат |",
    ].join("\n"),
  });
  const found = audit.detectTopicNotInAnyCase(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "topic-not-in-any-case");
  assert.match(found[0].message, /мощность и MDE/);
  assert.match(found[0].message, /Выкинуть нельзя/);
});

test("detector 10 — a «служебное» row needs no case of its own", () => {
  const text = round({
    curriculum: [
      "| 1 | «интервалы» | Wasserman 6.3 | CR | отработан вслух |",
      "| 2 | «нотация суммирования» — служебное, внутри темы 1 | Wasserman 1.2 | CR | объяснён |",
    ].join("\n"),
  });
  assert.deepEqual(audit.detectTopicNotInAnyCase(text), []);
});

test("detector 10 — a topic covered only at the big apex counts as covered", () => {
  const text = round({
    curriculum: [
      "| 1 | «интервалы» | Wasserman 6.3 | CR | отработан вслух |",
      "| 2 | «многократные сравнения» | Kohavi 17 | CR | отработан вслух |",
    ].join("\n"),
    cases: [
      DEFAULT_CASES,
      "### K2 · большой — Трафика на три теста, инициатив семь: что берём и как меряем",
      "",
      "- Почему нельзя взять все семь? → растёт шанс ложного «сработало» `[тема 2]`",
      "- Что уже закрыто ниже: `[K1]`",
    ].join("\n"),
  });
  assert.deepEqual(audit.detectTopicNotInAnyCase(text), []);
});

test("detector 10 — no case section is a finding only once readiness is claimed", () => {
  assert.deepEqual(audit.detectTopicNotInAnyCase(round({ cases: "" })), []);

  const ready = audit.detectTopicNotInAnyCase(round({ cases: "", status: "ready" }));
  assert.equal(ready.length, 1);
  assert.equal(ready[0].code, "no-cases");
});

test("detector 11 — an unroll node backed by nothing", () => {
  const text = round({
    cases: [
      "### K1 · малый — Тест на активации дал +2.1%, катим?",
      "",
      "- Как понял, что не шум? → интервал не накрывает ноль `[тема 1]`",
      "- А байесовский фактор что скажет? → он был бы выше порога",
    ].join("\n"),
  });
  const found = audit.detectCaseNodeWithoutSource(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "case-node-without-source");
  assert.match(found[0].message, /байесовский/);
});

test("detector 11 — «мой синтез» and a bare question are both accepted", () => {
  const text = round({
    cases: [
      "### K1 · малый — Тест на активации дал +2.1%, катим?",
      "",
      "- Как понял, что не шум? → интервал не накрывает ноль `[тема 1]`",
      "- Что скажем стейкхолдеру? → рамка «эффект есть, размер уточним» — мой синтез",
      "- Хватило ли объёма?",
    ].join("\n"),
  });
  assert.deepEqual(audit.detectCaseNodeWithoutSource(text), []);
});

test("detector 12 — an apex that names the apparatus is a step, not a case", () => {
  const text = round({
    cases: [
      "### K1 · малый — Посчитать стандартную ошибку для метрики активации",
      "",
      "- Как считается? → SE = √(p(1−p)/n) `[тема 1]`",
    ].join("\n"),
  });
  const found = audit.detectApexNamesMachinery(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "apex-names-machinery");
  assert.match(found[0].message, /цена ошибки/);
});

test("detector 12 — a decision apex passes even when its nodes are all machinery", () => {
  assert.deepEqual(audit.detectApexNamesMachinery(round()), []);
});

test("detector 13 — a definition with no situational trigger", () => {
  const sheet = `## 1.1 Интервал · CI

- Определение: диапазон.
- Формула: h = z·√(p(1−p)/n) Вытекает из: SE доли.
- 🗣️ Если спросят: «Сужается как корень из n.»
`;
  const found = audit.detectTriggerMissing(sheet);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "trigger-missing");
  assert.match(found[0].message, /Триггер/);
  assert.deepEqual(audit.detectTriggerMissing(CLEAN_SHEET), []);
});

test("formatReport states the readiness rule when findings exist", () => {
  const report = audit.formatReport(
    [{ code: "open-debt", message: "долг D1 не закрыт" }],
    "round.md"
  );
  assert.match(report, /1 находок/);
  assert.match(report, /Готовность объявляет кандидат/);
  assert.match(audit.formatReport([], "round.md"), /чисто/);
});
