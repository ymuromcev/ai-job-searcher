// Registry board page (RFC 068 §8). Reads everything; the writes are a
// rating on the «Банк ответов» tab (POST /api/rating) and «Открыть
// заполненной» on «Доделать руками» (POST /api/open).
//
// Everything that comes from the server is other people's text (company
// names, titles, reasons, answers): it goes into the document with
// textContent only, and a link is let through only when it is http(s).
/* global document, location, Node */
"use strict";

const KEY = new URLSearchParams(location.search).get("k") || "";

const state = {
  registry: null,
  sort: { key: "applied_date", dir: -1 },
  q: "",
  status: "",
  by: "",
  loaded: { week: false, sources: false, bank: false },
  bank: null,
  bankFresh: false,
  bankFilter: "all",
  bankQ: "",
  expanded: new Set(),
  saving: new Set(),
};

const $ = (sel) => document.querySelector(sel);

function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function safeHref(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function linkCell(url, text) {
  const td = el("td");
  const href = safeHref(url);
  if (!href) {
    td.textContent = "—";
    return td;
  }
  const a = el("a", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  td.appendChild(a);
  return td;
}

function message(text) {
  $("#message").textContent = text || "";
}

function api(path, method, body) {
  const headers = { "X-Board-Token": KEY };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(path, {
    method: method || "GET",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  }).then((res) =>
    res
      .json()
      .catch(() => ({}))
      .then((body) => {
        if (!res.ok) throw new Error(body.error || "сервер ответил " + res.status);
        return body;
      })
  );
}

function ruDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + "." + m[2] + "." + m[1] : "—";
}

function fillBody(tbody, rows) {
  tbody.textContent = "";
  for (const cells of rows) {
    const tr = el("tr");
    for (const cell of cells) tr.appendChild(cell instanceof Node ? cell : el("td", cell));
    tbody.appendChild(tr);
  }
}

// --- header ----------------------------------------------------------------

function renderHeader() {
  const r = state.registry;
  $("#title").textContent = "Отклики — " + r.profile;
  const s = r.summary;
  const by = s.byAppliedBy;
  const parts = [
    "Подано: " +
      s.applied +
      " (бот " +
      by.bot +
      ", сам " +
      by.manual +
      ", старый бот " +
      by.legacy_bot +
      ")",
    "интервью: " + s.interviews,
    "офферы: " + s.offers,
    "отказы: " + s.rejected,
    "доделать руками: " + s.todo,
    "в очереди у бота: " + s.queued,
  ];
  $("#summary").textContent = parts.join(" · ");
  document.title = "Отклики — " + r.profile;
}

// --- «Отклики» -------------------------------------------------------------

const FIT_RANK = { Strong: 3, Medium: 2, Weak: 1 };

function compare(a, b) {
  const { key, dir } = state.sort;
  let x = a[key] || "";
  let y = b[key] || "";
  if (key === "fit_score") {
    x = FIT_RANK[x] || 0;
    y = FIT_RANK[y] || 0;
    return (x - y) * dir;
  }
  // Empty values sink to the bottom whichever way we sort.
  if (!x && y) return 1;
  if (x && !y) return -1;
  return String(x).localeCompare(String(y), "ru") * dir;
}

function fillSelect(select, values) {
  const current = select.value;
  while (select.options.length > 1) select.remove(1);
  for (const v of values) {
    const opt = el("option", v);
    opt.value = v;
    select.appendChild(opt);
  }
  select.value = values.includes(current) ? current : "";
}

function renderResponses() {
  const all = state.registry.responses;
  fillSelect($("#f-status"), [...new Set(all.map((r) => r.status_label))].sort());
  fillSelect($("#f-by"), [...new Set(all.map((r) => r.applied_by_label))].sort());

  const q = state.q.toLowerCase();
  const shown = all
    .filter((r) => !state.status || r.status_label === state.status)
    .filter((r) => !state.by || r.applied_by_label === state.by)
    .filter((r) => !q || [r.company, r.title].join(" ").toLowerCase().includes(q))
    .sort(compare);

  fillBody(
    $("#responses-table tbody"),
    shown.map((r) => [
      r.company,
      r.title,
      ruDate(r.applied_date),
      r.applied_by_label,
      r.status_label,
      r.fit_score || "—",
      linkCell(r.url, "вакансия"),
    ])
  );
  $("#responses-empty").hidden = all.length > 0;
  $("#responses-table").hidden = all.length === 0;
  $("#responses-count").textContent =
    all.length === 0 ? "" : "Показано " + shown.length + " из " + all.length;

  for (const th of document.querySelectorAll("#responses-table th[data-sort]")) {
    const base = th.dataset.label || th.textContent;
    th.dataset.label = base;
    th.textContent =
      th.dataset.sort === state.sort.key ? base + (state.sort.dir > 0 ? " ▲" : " ▼") : base;
  }
}

// --- «Доделать руками» -----------------------------------------------------

// «Открыть заполненной»: the server starts a visible browser window on this
// Mac with the form already filled; the owner solves the captcha and presses
// Submit there, and the job moves to Applied by itself.
function openCell(r) {
  const td = el("td");
  const b = el("button", "Открыть заполненной");
  b.type = "button";
  b.addEventListener("click", () => {
    b.disabled = true;
    message("Открываю " + r.company + ": окно браузера появится примерно через полминуты");
    api("/api/open", "POST", { key: r.key })
      .then(() => {
        b.textContent = "Открыто";
      })
      .catch((err) => {
        b.disabled = false;
        message("Не открылось: " + err.message);
      });
  });
  td.appendChild(b);
  return td;
}

function renderTodo() {
  const rows = state.registry.todo;
  fillBody(
    $("#todo-table tbody"),
    rows.map((r) => [
      r.company,
      r.title,
      r.apply_state_label,
      r.reason,
      openCell(r),
      linkCell(r.url, "вакансия"),
    ])
  );
  $("#todo-empty").hidden = rows.length > 0;
  $("#todo-table").hidden = rows.length === 0;
}

// --- «Неделя» --------------------------------------------------------------

function renderWeek(data) {
  const root = $("#week-tables");
  root.textContent = "";
  for (const t of data.tables) {
    root.appendChild(el("h2", t.title));
    if (t.note) root.appendChild(el("p", t.note));
    if (t.rows.length === 0) {
      root.appendChild(el("p", t.empty));
      continue;
    }
    const table = el("table");
    const head = el("tr");
    for (const c of t.columns) head.appendChild(el("th", c));
    const thead = el("thead");
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = el("tbody");
    fillBody(tbody, t.rows);
    table.appendChild(tbody);
    root.appendChild(table);
  }
}

// --- «Источники и сайты подачи» --------------------------------------------

function renderSources(data) {
  fillBody(
    $("#sources-table tbody"),
    data.sources.map((s) => [
      s.name,
      s.status_label,
      ruDate(s.last_run),
      String(s.found_7d),
      s.last_error || "—",
    ])
  );
  $("#sources-empty").hidden = data.sources.length > 0;
  $("#sources-table").hidden = data.sources.length === 0;

  fillBody(
    $("#sites-table tbody"),
    data.sites.map((s) => [
      s.name,
      s.status_label,
      String(s.submitted_7d),
      s.attempts_last20 ? s.errors_last20 + " из " + s.attempts_last20 : "—",
      s.top_reason || "—",
    ])
  );
  $("#sites-empty").hidden = data.sites.length > 0;
  $("#sites-table").hidden = data.sites.length === 0;
}

// --- «Банк ответов» --------------------------------------------------------

const LONG_ANSWER = 220; // characters; longer answers start collapsed to 3 lines

function isLong(text) {
  return text.length > LONG_ANSWER || text.split("\n").length > 3;
}

function cell(label, content) {
  const td = el("td");
  td.dataset.label = label;
  if (content instanceof Node) td.appendChild(content);
  else td.textContent = content === "" || content === null ? "—" : String(content);
  return td;
}

function answerCell(r) {
  const td = el("td");
  td.dataset.label = "Ответ";
  const text = el("div", r.answer);
  text.className = "answer";
  td.appendChild(text);
  if (isLong(r.answer)) {
    const open = state.expanded.has(r.id);
    if (!open) text.classList.add("clamp");
    const b = el("button", open ? "свернуть" : "развернуть");
    b.type = "button";
    b.className = "more";
    b.addEventListener("click", () => {
      if (state.expanded.has(r.id)) state.expanded.delete(r.id);
      else state.expanded.add(r.id);
      renderBank();
    });
    td.appendChild(b);
  }
  return td;
}

function sourceCell(r) {
  const td = el("td");
  td.dataset.label = "Источник";
  td.appendChild(el("span", r.origin_label));
  if (r.notes && r.origin !== "bot") {
    const note = el("span", r.notes);
    note.className = "note";
    td.appendChild(note);
  }
  return td;
}

function ratingCell(r) {
  const td = el("td");
  td.dataset.label = "Оценка";
  if (!r.ratable) {
    td.textContent = "—";
    return td;
  }
  const box = el("span");
  box.className = "stars";
  const busy = state.saving.has(r.id);
  for (let n = 1; n <= 5; n += 1) {
    const b = el("button", r.rating !== null && n <= r.rating ? "★" : "☆");
    b.type = "button";
    b.title = "оценка " + n;
    b.setAttribute("aria-label", "оценка " + n);
    b.setAttribute("aria-pressed", String(r.rating === n));
    b.disabled = busy;
    b.addEventListener("click", () => rate(r, n));
    box.appendChild(b);
  }
  if (r.rating !== null) {
    const clear = el("button", "сбросить");
    clear.type = "button";
    clear.className = "clear";
    clear.disabled = busy;
    clear.addEventListener("click", () => rate(r, null));
    box.appendChild(clear);
  }
  td.appendChild(box);
  return td;
}

function bankShown() {
  const q = state.bankQ.toLowerCase();
  return state.bank.rows
    .filter((r) => state.bankFilter !== "unrated" || r.rating === null)
    .filter((r) => state.bankFilter !== "bot" || r.origin === "bot")
    .filter(
      (r) =>
        !q ||
        [r.question, r.answer, r.company, r.role, r.category, r.notes]
          .join(" ")
          .toLowerCase()
          .includes(q)
    );
}

function renderBankSummary(all, shown) {
  const rated = all.filter((r) => r.rating !== null);
  const avg = rated.length
    ? (rated.reduce((s, r) => s + r.rating, 0) / rated.length).toFixed(1).replace(".", ",")
    : "—";
  $("#bank-summary").textContent = [
    "Всего ответов: " + all.length,
    "от бота: " + all.filter((r) => r.origin === "bot").length,
    "с оценкой: " + rated.length,
    "без оценки: " + (all.length - rated.length),
    "средняя оценка: " + avg,
    "показано: " + shown.length,
  ].join(" · ");
}

function renderBank() {
  const data = state.bank;
  const notice = $("#bank-notice");
  notice.textContent = data.notice || "";
  notice.hidden = !data.notice;
  const all = data.rows;
  const shown = bankShown();
  fillBody(
    $("#bank-table tbody"),
    shown.map((r) => [
      cell("Вопрос", r.question),
      answerCell(r),
      cell("Компания", r.company),
      cell("Роль", r.role),
      cell("Категория", r.category),
      sourceCell(r),
      cell("Дата", r.date ? ruDate(r.date) : ""),
      cell("Взят ботом", String(r.uses)),
      ratingCell(r),
    ])
  );
  renderBankSummary(all, shown);
  $("#bank-empty").hidden = all.length > 0;
  $("#bank-table").hidden = all.length === 0;
}

function rate(r, rating) {
  if (state.saving.has(r.id)) return;
  const before = r.rating;
  r.rating = rating;
  state.saving.add(r.id);
  renderBank();
  api("/api/rating", "POST", { id: r.id, rating })
    .then(() => message(""))
    .catch((err) => {
      r.rating = before;
      message("Оценка не сохранилась: " + err.message);
    })
    .then(() => {
      state.saving.delete(r.id);
      renderBank();
    });
}

// --- loading ---------------------------------------------------------------

function loadRegistry() {
  return api("/api/registry").then((data) => {
    state.registry = data;
    renderHeader();
    renderResponses();
    renderTodo();
  });
}

function loadTab(tab) {
  if (tab === "week") {
    return api("/api/week").then((data) => {
      state.loaded.week = true;
      renderWeek(data);
    });
  }
  if (tab === "sources") {
    return api("/api/sources").then((data) => {
      state.loaded.sources = true;
      renderSources(data);
    });
  }
  if (tab === "bank") {
    const fresh = state.bankFresh;
    state.bankFresh = false;
    return api("/api/bank" + (fresh ? "?fresh=1" : "")).then((data) => {
      state.loaded.bank = true;
      state.bank = data;
      renderBank();
    });
  }
  return Promise.resolve();
}

function fail(err) {
  message("Не удалось загрузить данные: " + err.message);
}

function showTab(tab) {
  for (const b of document.querySelectorAll("#tabs button")) {
    b.classList.toggle("on", b.dataset.tab === tab);
  }
  for (const id of ["responses", "todo", "week", "sources", "bank"]) {
    $("#" + id).hidden = id !== tab;
  }
  if (state.loaded[tab] === false) {
    state.loaded[tab] = "loading"; // one request per tab, however fast the clicks
    loadTab(tab).catch((err) => {
      state.loaded[tab] = false;
      fail(err);
    });
  }
}

function currentTab() {
  const on = document.querySelector("#tabs button.on");
  return on ? on.dataset.tab : "responses";
}

function wire() {
  for (const b of document.querySelectorAll("#tabs button")) {
    b.addEventListener("click", () => showTab(b.dataset.tab));
  }
  $("#q").addEventListener("input", (e) => {
    state.q = e.target.value.trim();
    renderResponses();
  });
  $("#f-status").addEventListener("change", (e) => {
    state.status = e.target.value;
    renderResponses();
  });
  $("#f-by").addEventListener("change", (e) => {
    state.by = e.target.value;
    renderResponses();
  });
  $("#bank-filter").addEventListener("change", (e) => {
    state.bankFilter = e.target.value;
    if (state.bank) renderBank();
  });
  $("#bank-q").addEventListener("input", (e) => {
    state.bankQ = e.target.value.trim();
    if (state.bank) renderBank();
  });
  for (const th of document.querySelectorAll("#responses-table th[data-sort]")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort =
        state.sort.key === key
          ? { key, dir: -state.sort.dir }
          : { key, dir: key === "applied_date" ? -1 : 1 };
      renderResponses();
    });
  }
  $("#refresh").addEventListener("click", () => {
    message("");
    state.loaded.week = false;
    state.loaded.sources = false;
    state.loaded.bank = false;
    state.bankFresh = true; // «Обновить» re-reads the bank, past the server cache
    const tab = currentTab();
    loadRegistry()
      .then(() => loadTab(tab))
      .catch(fail);
  });
  $("#quit").addEventListener("click", () => {
    api("/api/quit", "POST")
      .then(() => {
        const id = state.registry ? state.registry.profile : "<id>";
        document.body.textContent = "";
        document.body.appendChild(
          el("p", "Реестр закрыт. Открыть снова: node engine/cli.js board --profile " + id)
        );
      })
      .catch((err) => message("Не закрылся: " + err.message));
  });
}

wire();
loadRegistry().catch(fail);
