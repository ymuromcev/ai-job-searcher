// Registry board page (RFC 068 §8). Read-only.
//
// Everything that comes from the server is other people's text (company
// names, titles, reasons): it goes into the document with textContent only,
// and a link is let through only when it is http(s).
/* global document, location, Node */
"use strict";

const KEY = new URLSearchParams(location.search).get("k") || "";

const state = {
  registry: null,
  sort: { key: "applied_date", dir: -1 },
  q: "",
  status: "",
  by: "",
  loaded: { week: false, sources: false },
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

function api(path, method) {
  return fetch(path, {
    method: method || "GET",
    headers: { "X-Board-Token": KEY },
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

function renderTodo() {
  const rows = state.registry.todo;
  fillBody(
    $("#todo-table tbody"),
    rows.map((r) => [
      r.company,
      r.title,
      r.apply_state_label,
      r.reason,
      linkCell(r.url, "открыть форму"),
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
  return Promise.resolve();
}

function fail(err) {
  message("Не удалось загрузить данные: " + err.message);
}

function showTab(tab) {
  for (const b of document.querySelectorAll("#tabs button")) {
    b.classList.toggle("on", b.dataset.tab === tab);
  }
  for (const id of ["responses", "todo", "week", "sources"]) {
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
