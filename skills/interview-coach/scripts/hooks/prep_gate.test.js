// Unit tests for the exam-prep entry hook.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const gate = require("./prep_gate.js");

test("triggers on a calculation round in Russian", () => {
  assert.equal(gate.shouldRemind("Среда, интервью с Лёшей — секция по статистике и A/B"), true);
  assert.equal(gate.shouldRemind("готовимся к секции 2, там доверительные интервалы"), true);
  assert.equal(gate.shouldRemind("собес по SQL в четверг"), true);
});

test("triggers in English", () => {
  assert.equal(gate.shouldRemind("technical interview round with SQL and metrics"), true);
});

test("does not trigger without an exam marker", () => {
  assert.equal(gate.shouldRemind("интервью с нанимающим менеджером в пятницу"), false);
  assert.equal(gate.shouldRemind("расскажи про эту компанию перед интервью"), false);
});

test("does not trigger without a round marker", () => {
  assert.equal(gate.shouldRemind("объясни ещё раз доверительный интервал"), false);
  assert.equal(gate.shouldRemind("посчитай метрики по этой выборке"), false);
});

test("resume and offer prompts stay quiet", () => {
  assert.equal(gate.shouldRemind("поправь резюме под эту вакансию"), false);
  assert.equal(gate.shouldRemind("пришёл оффер, что отвечать"), false);
});

test("a prompt that mixes comp talk with a real exam round still triggers", () => {
  // The AND of markers is the filter; an explicit suppression list would have
  // wrongly silenced this one.
  assert.equal(
    gate.shouldRemind("рекрутер написал про зарплату, и ещё сказал что будет секция по статистике"),
    true
  );
});

test("empty and non-string prompts are safe", () => {
  assert.equal(gate.shouldRemind(""), false);
  assert.equal(gate.shouldRemind(undefined), false);
  assert.equal(gate.shouldRemind(null), false);
});

test("«интервью» alone is not read as «интервал»", () => {
  assert.equal(gate.shouldRemind("интервью в среду"), false);
});

test("reminder names the entry protocol and the banned phrases", () => {
  const text = gate.buildReminder();
  assert.match(text, /документ работодателя/);
  assert.match(text, /дословно/);
  assert.match(text, /ДО первого объяснения/);
  assert.match(text, /prep-exam\.md/);
  assert.match(text, /100% пройдено/);
  assert.match(text, /Готовность объявляет кандидат/);
});

test("reminder lists open rounds with their debt counts", () => {
  const text = gate.buildReminder([
    { file: "profiles/jared/.../2026-08-05_plata_exam.md", openDebts: 2 },
  ]);
  assert.match(text, /Открытые раунды/);
  assert.match(text, /plata_exam\.md/);
  assert.match(text, /открытых долгов: 2/);
});

test("scanOpenRounds fails open on a missing directory", () => {
  assert.deepEqual(gate.scanOpenRounds("/nonexistent-path-for-test"), []);
});
