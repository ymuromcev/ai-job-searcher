// Stage 18 — generic hub layout builder.
//
// Canonical deployment target for ALL profiles: the shape of Jared's original
// prototype hub (Intro → Candidate Profile inline → 3-col (📥 callout |
// Playbooks | Databases) → divider → Jobs Pipeline → sentinel). This script
// REPLACES scripts/stage16/build_hub_layout.js for new deployments but is
// backward-compatible with it: if a stage16 sentinel (`hub-layout-v1`) is
// already on the page, we treat the main layout as complete and only back-fill
// empty subpages (stage16 left Candidate Profile + Workflow empty).
//
// Inputs: profiles/<id>/profile.json (identity, company_tiers, preferences,
// notion.{workspace_page_id, *_db_id}).
//
// Idempotency:
//   • Main layout guarded by HUB_LAYOUT_SENTINEL in the hub body.
//   • Each subpage gets its own `⟡ stage18-<key>-v1` sentinel at the bottom
//     of the body, so re-runs skip already-populated subpages and only fill
//     the empty ones left by stage16.
//
// Usage:
//   node scripts/stage18/build_hub_layout.js --profile jared            # dry-run
//   node scripts/stage18/build_hub_layout.js --profile jared --apply

const { Client } = require("@notionhq/client");
const fs = require("fs");
const path = require("path");

const {
  REPO_ROOT,
  loadEnv,
  parseArgs,
  requireToken,
  banner,
  done,
  fatal,
  loadState,
  saveState,
  validateProfileId,
} = require("./_common.js");

// Helpers duplicated here so stage18 is self-contained (stage16 migration
// scripts are not shipped in the public release).
function indexExistingChildPages(children) {
  const byTitle = new Map();
  for (const block of children) {
    if (block.type === "child_page") {
      const title = block.child_page && block.child_page.title;
      if (title) byTitle.set(title, block.id);
    }
  }
  return byTitle;
}

function hasColumnList(children) {
  return children.some((b) => b.type === "column_list");
}

function paragraphText(block) {
  if (!block || block.type !== "paragraph") return "";
  const rt = (block.paragraph && block.paragraph.rich_text) || [];
  return rt.map((t) => t.plain_text || (t.text && t.text.content) || "").join("");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Subpage titles stay in English (stable labels used throughout the codebase
// and Notion search). The PAGE BODIES are in Russian for Workflow / Target
// Tier / Resume Versions — that's the user's working language. Candidate
// Profile body stays English (identity facts pulled verbatim from
// profile.json — labels like "Email" / "LinkedIn" don't translate well).
//
// LEGACY_TITLES lets us recognize subpages whose title was at some point
// changed (in code or by hand) so re-running build_hub_layout renames them
// back to canonical instead of creating duplicates.
const SUBPAGES = [
  { key: "candidate_profile", title: "Candidate Profile", icon: "👤", mode: "candidate_profile" },
  { key: "workflow", title: "Workflow", icon: "⚙️", mode: "workflow" },
  { key: "target_tier", title: "Target Tier", icon: "🎯", mode: "target_tier" },
  { key: "resume_versions", title: "Resume Versions", icon: "📌", mode: "resume_versions" },
];

// Includes the brief Russian-titled era (2026-04-27) so any profile that ran
// build_hub_layout during that window gets renamed back on next deploy.
const LEGACY_TITLES = {
  workflow: ["Воркфлоу"],
  target_tier: ["Тиры компаний"],
  resume_versions: ["Версии резюме"],
};

const HUB_LAYOUT_SENTINEL = "⟡ hub-layout-v1 (managed by scripts/stage18/build_hub_layout.js)";

// Accept either stage16 or stage18 sentinel — both use the same "hub-layout-v1"
// marker so we don't re-append on a profile where stage16 already ran.
function hasHubLayoutSentinelV1(children) {
  return children.some((b) => paragraphText(b).includes("hub-layout-v1"));
}

function subpageSentinel(key) {
  return `⟡ stage18-${key}-v1`;
}

// ---------------------------------------------------------------------------
// Block builders (duplicated from stage16 for independence)
// ---------------------------------------------------------------------------

function paragraph(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function heading2(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function heading3(text) {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function bullet(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  };
}

function divider() {
  return { object: "block", type: "divider", divider: {} };
}

function callout(text, emoji = "📥") {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: text } }],
      icon: { type: "emoji", emoji },
      color: "gray_background",
    },
  };
}

// Callout variant that accepts rich-text segments (mix of plain + bold + code).
// Same shape as `callout` but driven by `richText(segments)` instead of a
// single string, so we can highlight `--profile <id>` inline.
function calloutRich(segments, emoji = "💡", color = "blue_background") {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: richText(segments),
      icon: { type: "emoji", emoji },
      color,
    },
  };
}

function linkToPage(id, kind = "page_id") {
  return {
    object: "block",
    type: "link_to_page",
    link_to_page:
      kind === "database_id"
        ? { type: "database_id", database_id: id }
        : { type: "page_id", page_id: id },
  };
}

// Inline rich_text with optional bold segments. `segments` is an array of
// either plain strings or { text, bold } objects.
function richText(segments) {
  if (typeof segments === "string") {
    return [{ type: "text", text: { content: segments } }];
  }
  return segments.map((s) => {
    if (typeof s === "string") return { type: "text", text: { content: s } };
    const annotations = {};
    if (s.bold) annotations.bold = true;
    if (s.code) annotations.code = true;
    const node = { type: "text", text: { content: s.text } };
    if (Object.keys(annotations).length) node.annotations = annotations;
    return node;
  });
}

function paragraphRich(segments) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richText(segments) },
  };
}

function bulletRich(segments) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(segments) },
  };
}

// Build a Notion table block.
// `rows` is an array of arrays of cells; each cell is either a string or a
// richText-style segment array.
function table(rows, { hasHeader = true } = {}) {
  if (!rows.length) throw new Error("table: rows empty");
  const width = rows[0].length;
  return {
    object: "block",
    type: "table",
    table: {
      table_width: width,
      has_column_header: hasHeader,
      has_row_header: false,
      children: rows.map((cells) => ({
        object: "block",
        type: "table_row",
        table_row: {
          cells: cells.map((c) => richText(c)),
        },
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Subpage bodies
// ---------------------------------------------------------------------------

// Split a comma/semicolon/newline separated list into trimmed non-empty items.
function splitList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  return v
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildCandidateProfileBlocks(profile) {
  const identity = profile.identity || {};
  const prefs = profile.preferences || {};

  // Leading heading — anchors the subpage in rendered Notion view and
  // matches the contract exercised by buildCandidateProfileBlocks tests.
  const blocks = [heading2("Candidate Profile")];

  // Identity lines — bold key, value plain. Mirrors legacy prototype format.
  const name = identity.name || identity.full_name;
  if (name) blocks.push(paragraphRich([{ text: "Name: ", bold: true }, name]));
  if (identity.location) blocks.push(paragraphRich([{ text: "Location: ", bold: true }, identity.location]));
  if (identity.email) blocks.push(paragraphRich([{ text: "Email: ", bold: true }, identity.email]));
  if (identity.phone) blocks.push(paragraphRich([{ text: "Phone: ", bold: true }, identity.phone]));
  if (identity.linkedin) blocks.push(paragraphRich([{ text: "LinkedIn: ", bold: true }, identity.linkedin]));
  if (identity.personal_site) blocks.push(paragraphRich([{ text: "Site: ", bold: true }, identity.personal_site]));
  if (prefs.status) blocks.push(paragraphRich([{ text: "Status: ", bold: true }, prefs.status]));

  // Legacy-style lists
  const roles = splitList(prefs.target_roles);
  if (roles.length) {
    blocks.push(paragraphRich([{ text: "Target Roles:", bold: true }]));
    for (const r of roles) blocks.push(bullet(r));
  }

  const industries = splitList(prefs.target_industries);
  if (industries.length) {
    blocks.push(paragraphRich([
      { text: "Target Industries: ", bold: true },
      industries.join(" · "),
    ]));
  }

  const strengths = splitList(prefs.key_strengths);
  if (strengths.length) {
    blocks.push(paragraphRich([
      { text: "Key Strengths: ", bold: true },
      strengths.join(" · "),
    ]));
  }

  // Legacy engine-era extras (kept for backward compat with simpler profiles).
  const prefLines = [];
  if (prefs.level) prefLines.push(`Level: ${prefs.level}`);
  if (prefs.years_experience !== undefined) prefLines.push(`Years of experience: ${prefs.years_experience}`);
  if (prefs.salary_min_total_comp) {
    const cur = prefs.salary_currency || "USD";
    prefLines.push(`Min total comp: ${prefs.salary_min_total_comp.toLocaleString("en-US")} ${cur}`);
  }
  if (prefs.salary_ideal_total_comp) {
    const cur = prefs.salary_currency || "USD";
    prefLines.push(`Ideal total comp: ${prefs.salary_ideal_total_comp.toLocaleString("en-US")} ${cur}`);
  }
  if (prefs.work_format) prefLines.push(`Work format: ${prefs.work_format}`);
  const locationsOk = splitList(prefs.locations_ok);
  if (locationsOk.length) prefLines.push(`Locations OK: ${locationsOk.join(", ")}`);
  if (prefLines.length) {
    blocks.push(heading3("Preferences"));
    for (const p of prefLines) blocks.push(bullet(p));
  }

  blocks.push(paragraph(subpageSentinel("candidate_profile")));
  return blocks;
}

// Build the Workflow subpage. Single generic skill-commands playbook, used by
// every profile. All commands take `--profile <id>` — the same job-pipeline /
// interview-coach skills serve every profile from one engine.
function buildWorkflowBlocks(profileId, profile) {
  const p = profileId;
  const blocks = [
    // Russian profile-binding callout at the very top — answers "как вызывать
    // команды именно для этого профиля". Loud and visible because the same
    // engine + skills serve every profile; the only per-profile knob is the
    // `--profile <id>` flag.
    calloutRich([
      { text: "Этот профиль вызывается с флагом ", bold: true },
      { text: `--profile ${p}`, code: true, bold: true },
      { text: ". Пример: " },
      { text: `node engine/cli.js scan --profile ${p}`, code: true },
      { text: ". Один и тот же движок и те же скиллы (" },
      { text: "job-pipeline", code: true },
      { text: " + " },
      { text: "interview-coach", code: true },
      { text: ") обслуживают всех кандидатов — разница только в " },
      { text: `--profile ${p}`, code: true },
      { text: " и в данных в " },
      { text: `profiles/${p}/`, code: true },
      { text: "." },
    ], "💡", "blue_background"),
    paragraphRich([
      "Автоматический пайплайн, который Claude Code запускает по запросу. Один и тот же набор из двух скиллов (",
      { text: "job-pipeline", code: true }, " наверху + ",
      { text: "interview-coach", code: true }, " внизу) обслуживает каждый профиль из общего движка — каждая команда ниже принимает ",
      { text: `--profile ${p}`, code: true }, ".",
    ]),
    bulletRich([
      { text: "job-pipeline", code: true, bold: true },
      " — верхняя часть: scan → Notion → CV/CL → submit → sync → проверка ответов в почте.",
    ]),
    bulletRich([
      { text: "interview-coach", code: true, bold: true },
      " — нижняя часть: prep → mock → debrief → negotiate, включается, как только Notion Status доходит до ",
      { text: "Interview", code: true },
      " или дальше.",
    ]),

    heading2("Команды — job-pipeline (верхняя часть)"),

    heading3("/job-pipeline scan — Найти новые вакансии"),
    bulletRich([{ text: `node engine/cli.js scan --profile ${p}`, code: true }, " — сканирует все целевые компании через включённые discovery-адаптеры (Greenhouse / Lever / Ashby / SmartRecruiters / Workday / CalCareers / RemoteOK)"]),
    bullet("Фильтр по уровню — отбраковывает Director / Principal / Staff / VP / Intern / Associate / GPM / New Grad"),
    bullet("Лимит на компанию — максимум 3 активные вакансии (Applied + To Apply)"),
    bulletRich(["Дедуп — сверка с ", { text: `profiles/${p}/applications.tsv`, code: true }, " + общим ", { text: "data/jobs.tsv", code: true }]),
    bullet("Создание в Notion — все обязательные поля заполнены, привязка Company выставлена (компания создаётся, если её ещё нет)"),
    bullet("Обновление TSV — записывается notion_id"),
    bullet("Валидация: 0 pending notion_ids, 0 пустых Company-связей, 0 over-level в активных"),
    bullet("Отчёт: добавлено X, отсеяно Y, компаний создано Z, ошибок N"),

    heading3("/job-pipeline prepare — Подготовить материалы"),
    paragraph("Две фазы: сначала черновики, потом подтверждение и пуш."),
    bulletRich([{ text: `node engine/cli.js prepare --profile ${p} --phase pre --batch 20`, code: true }, " — собирает свежие строки (status=", { text: "To Apply", code: true }, " + нет Notion page id), проверяет уровень, пропускает уже подготовленные, выбирает архетип CV, набрасывает CL, считает зарплату (Tier × Level + COL), пишет ", { text: "results-<ts>.json", code: true }]),
    bulletRich(["Просмотреть ", { text: "results-<ts>.json", code: true }]),
    bulletRich([{ text: `node engine/cli.js prepare --profile ${p} --phase commit --results-file results-<ts>.json`, code: true }, " — принять черновики: обновить TSV (resume_version + cl_key + salary), запушить страницу в Notion (создаётся со Status=", { text: "To Apply", code: true }, "), сохранить CL PDF"]),
    bullet("Правила CL — 4 абзаца (Hook → доказательная часть → релевантная часть → Close), уверенный голос практика, цифры обязательны. Перед показом пользователю прогнать через /humanizer."),
    bullet("Валидация: 0 свежих строк осталось, 0 To Apply без CL / CV"),
    bullet("Отчёт: подготовлено X, пропущено Y, заархивировано Z, ошибок N"),

    heading3("/job-pipeline sync — Синхронизировать статусы"),
    bulletRich([{ text: `node engine/cli.js sync --profile ${p}`, code: true }, " — забирает не-архивные страницы через Notion API, сравнивает с TSV"]),
    bulletRich(["Разобрать ", { text: "sync_result.json", code: true }, " — рассинхрон, пустые Company-связи, отсутствующие в TSV"]),
    bullet("Применить ВСЕ расхождения к TSV. Источник истины — Notion, без исключений."),
    bulletRich(["Applied / Rejected / Closed: обновить TSV + при Rejected дописать в ", { text: "rejection_log.md", code: true }]),
    bullet("Проверки целостности: пустые Companies, страницы без TSV, pending notion_ids"),
    bullet("Отчёт: изменений X (Applied A, Rejected B, Closed C), пустых компаний E, не в TSV F"),

    heading3("/job-pipeline check — Проверить ответы по email"),
    paragraph("Двухфазный поток через MCP (чтение Gmail делегировано Claude MCP — никаких OAuth-токенов на диске)."),
    bulletRich([{ text: `node engine/cli.js check --profile ${p} --prepare`, code: true }, " — собирает active-jobs map из TSV (To Apply / Applied / Interview / Offer), считает курсорный epoch, печатает Gmail-батчи в JSON (10 компаний на батч + LinkedIn + рекрутеры)"]),
    bulletRich(["Claude MCP читает Gmail по этим батчам и пишет ", { text: "raw_emails.json", code: true }, " в ", { text: `profiles/${p}/.gmail-state/`, code: true }]),
    bulletRich([{ text: `node engine/cli.js check --profile ${p} --apply`, code: true }, " — классифицирует каждое письмо (REJECTION / INTERVIEW_INVITE / INFO_REQUEST / ACKNOWLEDGMENT / OTHER), матчит к роли (HIGH / LOW / NONE), обновляет Notion: REJECTION → Rejected + комментарий; INTERVIEW_INVITE → Interview + комментарий; INFO_REQUEST → только комментарий; LOW match → комментарий с просьбой уточнить"]),
    bulletRich(["Обновляет логи: ", { text: "rejection_log.md", code: true }, ", ", { text: "email_check_log.md", code: true }, ", ", { text: "recruiter_leads.md", code: true }]),
    bulletRich(["Сохраняет дедуп: ", { text: "processed_messages.json", code: true }, " (автоочистка > 30 дней)"]),

    heading3("/job-pipeline validate — Ретро-зачистка по блоклистам + целостность TSV"),
    bulletRich([{ text: `node engine/cli.js validate --profile ${p}`, code: true }, " — заново применяет company + title блоклисты к существующим строкам To Apply (ловит то, что прошло до обновления фильтра)"]),
    bulletRich(["Сообщает совпадения → exit 1. С ", { text: "--apply", code: true }, ": проставляет ", { text: "status=Archived", code: true }]),
    bullet("Также проверяет целостность TSV (пустые Company-связи, протухшие notion_ids, pending ids)"),

    heading2("Ограничения (для всех режимов)"),
    bullet("Уровень: только PM / Senior PM / Lead PM. Отбраковка: Director, Principal, Staff, VP, AVP, SVP, EVP, GPM, Group PM, Head of, Associate, Junior, Intern, New Grad"),
    bullet("Лимит на компанию: максимум 3 активные позиции"),
    bullet("Fit Score: только доменное соответствие (Strong / Medium / Weak). Уровень на скор НЕ влияет."),
    bullet("Поправка на early-stage (до Series B, < 50 человек): −1 уровень"),
    bullet("Полнота Notion: на каждой странице должны быть Role, Company (relation), Status, Fit Score, Job URL, Source, Date Added, Work Format, City, State, Notes"),
    bulletRich([
      "US-маркер: блоклист по локации пропускается, если в строке есть ",
      { text: "united states", code: true }, " / ",
      { text: "usa", code: true }, " / ",
      { text: ", us", code: true }, " / ",
      { text: "(us)", code: true }, " / ",
      { text: "u.s.", code: true },
    ]),
    bullet("Письма рекрутерам: никогда не упоминать локацию / remote / переезд в исходящих — раскрываем как можно позже в воронке"),
    bullet("Humanizer обязателен на CL и черновиках писем рекрутерам перед показом пользователю"),

    heading2("Ключевые файлы"),
    bulletRich([{ text: `profiles/${p}/applications.tsv`, code: true }, " — реестр вакансий и статусов конкретного профиля (схема v2, 15 колонок)"]),
    bulletRich([{ text: "data/jobs.tsv", code: true }, " / ", { text: "data/companies.tsv", code: true }, " — общие cross-profile master pools (дедуп)"]),
    bulletRich([{ text: `profiles/${p}/cover_letter_versions.json`, code: true }, " — все данные по CL"]),
    bulletRich([{ text: `profiles/${p}/resume_versions.json`, code: true }, " — все данные по CV"]),
    bulletRich([{ text: "engine/cli.js", code: true }, " — точка входа для всех команд"]),
    bulletRich([{ text: "skills/job-pipeline/SKILL.md", code: true }, " — полное определение скилла с пошаговыми инструкциями"]),
    bulletRich([{ text: `profiles/${p}/email_check_log.md`, code: true }, " — лог всех запусков email-проверки"]),
    bulletRich([{ text: `profiles/${p}/.gmail-state/processed_messages.json`, code: true }, " — реестр дедупа Gmail"]),

    heading2("Команды — interview-coach (нижняя часть)"),
    paragraphRich([
      "Перед запуском все команды interview-coach читают ",
      { text: `profiles/${p}/interview-coach-state/constraints.md`, code: true },
      " и ",
      { text: "coaching_state.md", code: true },
      ". Состояние сохраняется между сессиями.",
    ]),

    heading3("/stories — Собрать / расширить storybank"),
    bullet("Storybank переиспользуется на всех компаниях — никогда не привязан к конкретной"),
    bullet("Стартовые истории (S001–S00N) подгружаются из резюме — по одной на каждый заметный проект или результат"),
    bulletRich(["Запустить ", { text: "stories improve S###", code: true }, ", чтобы превратить заготовку в боеспособный STAR с проверенным Earned Secret"]),
    bullet("Приоритет по leverage: первыми ставим истории, которые попадают в самые сильные опоры этого профиля"),

    heading3("/prep [company] — Бриф по компании и роли"),
    bulletRich(["Триггер: Notion Status переходит ", { text: "Applied → Interview", code: true }]),
    bullet("Читает JD и данные компании из Notion Jobs Pipeline + Companies DB"),
    bullet("Формирует: интел по интервьюерам, форматы раундов, вероятные вопросы, мэппинг историй (какие S### доставать)"),
    bulletRich(["Сохраняет в ", { text: "coaching_state.md", code: true }, " → Interview Loops"]),

    heading3("/hype — Уверенность перед интервью + план 3×3"),
    bullet("Запускать прямо перед интервью"),
    bullet("Чек-ин по уровню тревожности, 3 ведущие сильные стороны × 3 истории к развороту"),

    heading3("/mock [format] — Полная симуляция интервью"),
    bulletRich(["Форматы: ", { text: "behavioral", code: true }, " / ", { text: "system-design", code: true }, " / ", { text: "case-study", code: true }, " / ", { text: "panel", code: true }, " / ", { text: "technical", code: true }]),
    bullet("4–6 вопросов, оценка по 5 осям (Substance, Structure, Relevance, Credibility, Differentiation)"),
    bulletRich(["Триггер: следующий ", { text: "Interview", code: true }, " раунд (после phone-screen onsite / panel)"]),

    heading3("/debrief — Быстрый разбор сразу после интервью (в тот же день)"),
    bullet("Запускать сразу после любого реального интервью"),
    bullet("Фиксирует: какие были вопросы, какие истории использовали, фидбек рекрутера / интервьюера, эмоциональный срез"),
    bullet("Обновляет: Interview Intelligence, Storybank Last Used + Use Count, Outcome Log (pending)"),

    heading3("/analyze [transcript] — Разбор транскрипта"),
    bulletRich(["Положить транскрипт в ", { text: "interview-coach-state/transcripts/", code: true }]),
    bullet("Сам определяет формат (Otter / Zoom / Grain / Teams)"),
    bullet("Оценивает ответы по 5 осям, находит корневое узкое место, обновляет Active Coaching Strategy"),

    heading3("/concerns + /questions — Подготовка к onsite"),
    bulletRich([{ text: "concerns", code: true }, ": ранжированный список вероятных возражений интервьюеров + контр-стратегии"]),
    bulletRich([{ text: "questions", code: true }, ": топ-3 точечных вопроса интервьюеру (сохраняются в Interview Loops)"]),

    heading3("/negotiate — Переговоры после оффера"),
    bulletRich(["Триггер: Notion Status → ", { text: "Offer", code: true }]),
    bullet("Вход: детали оффера (база / equity / бонус / sign-on), конкурирующие офферы, BATNA, нижний предел"),
    bullet("Выход: пошаговые скрипты (звонок рекрутеру → первый counter → follow-up → закрытие)"),

    heading3("/linkedin · /pitch · /outreach — Слой позиционирования"),
    bulletRich([{ text: "linkedin", code: true }, ": аудит профиля (видимость для рекрутеров, доверие, дифференциация)"]),
    bulletRich([{ text: "pitch", code: true }, ": 30–45 сек self-pitch, опирающийся на Earned Secret"]),
    bulletRich([{ text: "outreach", code: true }, ": коучинг по cold-нетворкингу (кандидат стартует с нулевой US fintech-сети)"]),

    heading3("/progress · /feedback · /reflect — Мета-уровень"),
    bulletRich([{ text: "progress", code: true }, ": тренды, самокалибровка, ловля дрейфа (раз в 3 сессии)"]),
    bulletRich([{ text: "feedback", code: true }, ": фиксация фидбека рекрутеров, исходов, корректировок"]),
    bulletRich([{ text: "reflect", code: true }, ": ретроспектива всего поиска + архив (никогда не удаляет)"]),

    heading2("Триггеры по статусу в Notion"),
    table(
      [
        ["Переход статуса", "Команды коуча"],
        [
          [{ text: "Applied → Interview", code: true }],
          [{ text: "prep [company]", code: true }, " · ", { text: "hype", code: true }],
        ],
        [
          "после каждого раунда интервью",
          [
            { text: "debrief", code: true }, " · (опц.) ",
            { text: "analyze [transcript]", code: true }, " · ",
            { text: "mock [format]", code: true }, " · ",
            { text: "questions", code: true }, " · ",
            { text: "concerns", code: true },
          ],
        ],
        [
          [{ text: "Interview → Offer", code: true }],
          [{ text: "negotiate", code: true }],
        ],
        ["Отказ", [{ text: "feedback", code: true }, " · ", { text: "progress", code: true }]],
      ],
      { hasHeader: true }
    ),

    heading2("Ограничения — interview-coach"),
    bulletRich([
      { text: "Резюме ЗАМОРОЖЕНО", bold: true }, ": только 13 архетипов (см. подстраницу Resume Versions). ",
      { text: "/resume", code: true }, " ограничен критикой + выбором архетипа + предложениями дельт для ",
      { text: "resume_versions.json", code: true }, ". Никогда не пишет инлайн и не делает CV под конкретную компанию.",
    ]),
    bulletRich([
      { text: "JD ", bold: true }, { text: "decode", code: true, bold: true },
      { text: " batch ОТКЛЮЧЁН", bold: true }, ": дублирует upstream-пайплайн scan + filter_rules. Single-vacancy decode разрешён только для вакансий, уже лежащих в Notion, как вход в ",
      { text: "prep", code: true }, ".",
    ]),
    bulletRich([
      { text: "Role framing зашит", bold: true },
      ": разделение advisory / employment / founder для каждого опыта зафиксировано в ",
      { text: "constraints.md", code: true },
      " и должно соблюдаться во всех командах.",
    ]),
    bulletRich([{ text: "Notion = источник истины", bold: true }, ": Interview Loops в ", { text: "coaching_state.md", code: true }, " — рабочая копия. При конфликте побеждает Notion."]),
    bulletRich([{ text: "Лимит компании 3", bold: true }, " действует и здесь — коуч никогда не предлагает готовиться к 4-му раунду в той же компании."]),
    bulletRich([{ text: "Таргетинг", bold: true }, ": только PM / Senior PM / Lead PM (как в upstream)."]),
    bulletRich([{ text: "210 знаков по умолчанию", bold: true }, " для ответов в форме Application Q&A."]),
    bulletRich([{ text: "Никогда не удаляет файлы", bold: true }, " без явного разрешения. ", { text: "reflect", code: true }, " только архивирует."]),

    heading2("Ключевые файлы — interview-coach"),
    bulletRich([{ text: "skills/interview-coach/SKILL.md", code: true }, " — upstream-скилл (ставится глобально через симлинк ", { text: "~/.claude/skills/interview-coach", code: true }, ")"]),
    bulletRich([{ text: "skills/interview-coach/references/", code: true }, " — справочник команд + движковые файлы"]),
    bulletRich([{ text: `profiles/${p}/interview-coach-state/constraints.md`, code: true }, " — локальные правки на проект (заморозка резюме, role framing, ограничение decode). Читается перед каждой коуч-командой."]),
    bulletRich([{ text: `profiles/${p}/interview-coach-state/coaching_state.md`, code: true }, " — постоянное состояние (профиль, storybank, Interview Loops, Score History, Calibration)"]),
    bulletRich([{ text: `profiles/${p}/interview-coach-state/transcripts/`, code: true }, " — складывать сюда транскрипты реальных интервью для ", { text: "analyze", code: true }]),

    paragraph(subpageSentinel("workflow")),
  ];
  return blocks;
}

function buildTargetTierBlocks(profile) {
  const tiers = profile.company_tiers || {};
  const counts = { S: 0, A: 0, B: 0, C: 0 };
  for (const t of Object.values(tiers)) {
    if (counts[t] !== undefined) counts[t]++;
  }
  const totals = `S:${counts.S} | A:${counts.A} | B:${counts.B} | C:${counts.C}`;

  const rows = [
    ["S", "Главные цели — компании мечты; подаваться, как только открывается релевантная роль."],
    ["A", "Сильное стратегическое совпадение; подаваться в течение 48 часов после появления вакансии."],
    ["B", "Стоит того; подаваться, если есть ресурс и зарплата подходит."],
    ["C", "Запасные / по случаю; использовать, только если пайплайн пустой."],
  ];

  const blocks = [
    heading2("Тиры компаний"),
    paragraph(
      "Универсальная схема тиров. Каждой компании в Companies DB проставляется тир — так движок понимает, что в приоритете."
    ),
  ];
  for (const [tier, text] of rows) {
    const c = counts[tier];
    blocks.push(bullet(`${tier} (${c}) — ${text}`));
  }
  blocks.push(paragraph(`Текущие счётчики — ${totals}`));
  blocks.push(paragraph(subpageSentinel("target_tier")));
  return blocks;
}

function buildResumeVersionsSubpageBlocks(versionsFile) {
  const blocks = [
    heading2("Версии резюме"),
    paragraph(
      "Архетипы лежат в resume_versions.json. Команда `node engine/cli.js prepare …` сама подбирает нужный по тегам / совпадению с тайтлом."
    ),
  ];
  const versions = (versionsFile && versionsFile.versions) || {};
  for (const [key, v] of Object.entries(versions)) {
    const title = v.title || key;
    const summary =
      typeof v.summary === "string"
        ? v.summary
        : Array.isArray(v.summary)
        ? v.summary.map((s) => (typeof s === "string" ? s : s.text || "")).join("")
        : "";
    const line = summary
      ? `${key} — ${title}. ${summary.slice(0, 180)}`
      : `${key} — ${title}`;
    blocks.push(bullet(line));
  }
  blocks.push(paragraph(subpageSentinel("resume_versions")));
  return blocks;
}

// ---------------------------------------------------------------------------
// Hub body
// ---------------------------------------------------------------------------

// Build the hub intro paragraph. Three-tier resolution:
//   1. profile.hub.intro — verbatim override (best for hand-tuned copy).
//   2. preferences-driven template (target_roles[0] + target_industries +
//      identity.location + work_format).
//   3. Minimal fallback if preferences are sparse.
function buildIntro(profile) {
  const hub = (profile && profile.hub) || {};
  if (typeof hub.intro === "string" && hub.intro.trim()) {
    return paragraph(hub.intro.trim());
  }
  const identity = (profile && profile.identity) || {};
  const prefs = (profile && profile.preferences) || {};

  const fullName = identity.name || identity.full_name || "";
  const firstName = fullName.trim().split(/\s+/)[0] || "Candidate";
  // "JARED" → "Jared" if all-caps
  const firstNamePretty = /^[A-Z]+$/.test(firstName)
    ? firstName.charAt(0) + firstName.slice(1).toLowerCase()
    : firstName;

  const roles = splitList(prefs.target_roles);
  const primaryRole = roles[0] || "fitting";

  const industries = splitList(prefs.target_industries);
  let industryPhrase = "";
  if (industries.length === 1) industryPhrase = ` in ${industries[0]}`;
  else if (industries.length === 2) industryPhrase = ` in ${industries.join(" and ")}`;
  else if (industries.length >= 3) industryPhrase = ` in ${industries.slice(0, 2).join(", ")} and adjacent industries`;

  const location = identity.location || (splitList(prefs.locations_ok)[0] || "");

  let formatPhrase = "";
  const fmt = (prefs.work_format || "").toString().toLowerCase();
  if (fmt === "remote" || fmt === "any") formatPhrase = " Remote-friendly.";
  else if (fmt === "hybrid") formatPhrase = " Hybrid acceptable.";
  else if (fmt === "onsite" || fmt === "on-site") formatPhrase = " Onsite preferred.";

  let line = `Central command for ${firstNamePretty}'s US job search. Target: ${primaryRole} roles${industryPhrase}.`;
  if (location) line += ` Location: ${location}.`;
  line += formatPhrase;
  return paragraph(line.trim());
}

function buildLayoutBody({ profileName, profile, subpageIds, dbIds, inboxCount, updatedAt }) {
  // Back-compat: if `profile` not provided, fall back to legacy generic intro.
  const intro = profile
    ? buildIntro(profile)
    : paragraph(
        `${profileName}'s AI Job Search Hub — pipelines, companies, playbooks. Managed via \`node engine/cli.js\`.`
      );

  const col1 = {
    object: "block",
    type: "column",
    column: {
      children: [callout(`Inbox: ${inboxCount} | Updated: ${updatedAt}`, "📥")],
    },
  };

  const col2Children = [heading2("Playbooks")];
  for (const key of ["workflow", "target_tier", "resume_versions"]) {
    if (subpageIds[key]) col2Children.push(linkToPage(subpageIds[key], "page_id"));
  }
  const col2 = { object: "block", type: "column", column: { children: col2Children } };

  const col3Children = [heading2("Databases")];
  for (const key of ["companies_db_id", "application_qa_db_id", "job_platforms_db_id"]) {
    if (dbIds[key]) col3Children.push(linkToPage(dbIds[key], "database_id"));
  }
  const col3 = { object: "block", type: "column", column: { children: col3Children } };

  const columnList = {
    object: "block",
    type: "column_list",
    column_list: { children: [col1, col2, col3] },
  };

  const blocks = [intro];
  if (subpageIds.candidate_profile) {
    blocks.push(linkToPage(subpageIds.candidate_profile, "page_id"));
  }
  blocks.push(columnList);
  blocks.push(divider());
  // Sentinel LAST — its presence means the entire append succeeded.
  blocks.push(paragraph(HUB_LAYOUT_SENTINEL));
  return blocks;
}

// ---------------------------------------------------------------------------
// Notion API helpers
// ---------------------------------------------------------------------------

async function listChildren(client, pageId) {
  const out = [];
  let cursor;
  do {
    const resp = await client.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...(resp.results || []));
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function hasSubpageSentinel(client, pageId, key) {
  const children = await listChildren(client, pageId);
  const needle = subpageSentinel(key);
  return children.some((b) => paragraphText(b).includes(needle));
}

async function createSubpage(client, parentPageId, title, icon, bodyBlocks) {
  // Notion API limits pages.create to 100 children. For longer bodies we
  // create with the first 90 and append the rest in chunks.
  const FIRST_BATCH = 90;
  const args = {
    parent: { type: "page_id", page_id: parentPageId },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } },
  };
  if (icon) args.icon = { type: "emoji", emoji: icon };
  const all = bodyBlocks || [];
  if (all.length) args.children = all.slice(0, FIRST_BATCH);
  const resp = await client.pages.create(args);
  if (all.length > FIRST_BATCH) {
    await appendBlocks(client, resp.id, all.slice(FIRST_BATCH));
  }
  return resp.id;
}

async function appendBlocks(client, pageId, blocks) {
  const CHUNK = 90; // Notion API limits children to 100 per request.
  for (let i = 0; i < blocks.length; i += CHUNK) {
    await client.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + CHUNK),
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function buildSubpageBody(mode, { profile, versionsFile, profileId }) {
  if (mode === "candidate_profile") return buildCandidateProfileBlocks(profile);
  if (mode === "workflow") return buildWorkflowBlocks(profileId, profile);
  if (mode === "target_tier") return buildTargetTierBlocks(profile);
  if (mode === "resume_versions") return buildResumeVersionsSubpageBlocks(versionsFile);
  throw new Error(`unknown subpage mode: ${mode}`);
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("build_hub_layout", args);

  const id = validateProfileId(args.profile);
  const profilePath = path.join(REPO_ROOT, "profiles", id, "profile.json");
  if (!fs.existsSync(profilePath)) {
    fatal(new Error(`profile.json not found: ${profilePath}`));
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

  profile.notion = profile.notion || {};
  profile.notion.hub_layout = profile.notion.hub_layout || {};
  const workspacePageId = args.workspace_page_id || profile.notion.workspace_page_id;
  if (!workspacePageId) {
    fatal(new Error("profile.notion.workspace_page_id missing — run deploy_profile.js first"));
  }

  const token = requireToken(id);
  const client = new Client({ auth: token });

  console.log(`  workspace_page_id: ${workspacePageId}`);

  const versionsPath = path.join(
    REPO_ROOT,
    "profiles",
    id,
    (profile.resume && profile.resume.versions_file) || "resume_versions.json"
  );
  const versionsFile = fs.existsSync(versionsPath)
    ? JSON.parse(fs.readFileSync(versionsPath, "utf8"))
    : { versions: {} };

  const children = await listChildren(client, workspacePageId);
  const existingByTitle = indexExistingChildPages(children);
  const layoutComplete = hasHubLayoutSentinelV1(children);
  const columnListPresent = hasColumnList(children);
  console.log(`  existing child pages: [${[...existingByTitle.keys()].join(", ")}]`);
  console.log(`  layout sentinel v1:   ${layoutComplete}`);
  console.log(`  column_list present:  ${columnListPresent}`);

  if (columnListPresent && !layoutComplete) {
    fatal(
      new Error(
        "Detected partial hub layout (column_list present, sentinel missing).\n" +
          "  A previous --apply likely crashed mid-append. To recover:\n" +
          "    1. Open the workspace page in Notion UI.\n" +
          "    2. Delete every block below the subpage links (the 3-column section + stragglers).\n" +
          "    3. Re-run with --apply."
      )
    );
  }

  const subpageIds = { ...(profile.notion.hub_layout.subpages || {}) };

  // --- Step 1: ensure each subpage exists AND is populated (per-subpage sentinel) ---
  console.log("\n  --- subpages ---");
  for (const s of SUBPAGES) {
    const body = buildSubpageBody(s.mode, {
      profile,
      versionsFile,
      profileId: id,
    });

    // Resolve existing subpage by current title (Russian) OR legacy title
    // (English pre-rename, top-level only) OR profile.json id. The last wins
    // because users may reorganize the hub — subpages can end up nested
    // inside column_lists where listChildren on the workspace page no longer
    // surfaces them by title.
    let existingId = existingByTitle.get(s.title) || subpageIds[s.key];
    if (!existingId && LEGACY_TITLES[s.key]) {
      for (const legacy of LEGACY_TITLES[s.key]) {
        const cand = existingByTitle.get(legacy);
        if (cand) {
          existingId = cand;
          break;
        }
      }
    }
    // Rename: if we have the page id, fetch its current title directly
    // (pages.retrieve) and pages.update if it's an old/legacy title. We
    // can't rely on existingByTitle reverse lookup because the user may
    // have moved the subpage off the top level into a column_list, where
    // it doesn't appear as a direct child_page block of the workspace.
    if (existingId && (LEGACY_TITLES[s.key] || []).length) {
      try {
        const page = await client.pages.retrieve({ page_id: existingId });
        const titleProp = Object.values(page.properties || {}).find((v) => v.type === "title");
        const currentTitle = titleProp?.title?.[0]?.plain_text || "";
        if (currentTitle && currentTitle !== s.title) {
          console.log(`    [${s.key}] rename "${currentTitle}" → "${s.title}" on ${existingId}`);
          if (args.apply) {
            await client.pages.update({
              page_id: existingId,
              properties: { title: { title: [{ type: "text", text: { content: s.title } }] } },
            });
          }
        }
      } catch (err) {
        console.log(`    [${s.key}] rename check failed for ${existingId}: ${err.message}`);
      }
    }
    if (existingId) {
      subpageIds[s.key] = existingId;
      const sentinelPresent = await hasSubpageSentinel(client, existingId, s.key);
      if (sentinelPresent) {
        console.log(`    [${s.key}] exists + populated: ${existingId}`);
        continue;
      }
      console.log(`    [${s.key}] exists but empty — will append ${body.length} blocks to ${existingId}`);
      if (!args.apply) continue;
      await appendBlocks(client, existingId, body);
      console.log(`    [${s.key}] populated`);
      continue;
    }

    console.log(`    [${s.key}] will create "${s.title}" with ${body.length} blocks`);
    if (!args.apply) continue;
    const newId = await createSubpage(client, workspacePageId, s.title, s.icon, body);
    subpageIds[s.key] = newId;
    console.log(`    [${s.key}] created: ${newId}`);
  }

  // --- Step 2: append main layout body if not present ---
  console.log("\n  --- main layout ---");
  if (layoutComplete) {
    console.log("    hub sentinel v1 present — skip body append");
  } else {
    const dbIds = {
      companies_db_id: profile.notion.companies_db_id,
      application_qa_db_id: profile.notion.application_qa_db_id,
      job_platforms_db_id: profile.notion.job_platforms_db_id,
    };
    let inboxCount = 0;
    try {
      const { load } = require("../../engine/core/applications_tsv.js");
      const tsvPath = path.join(REPO_ROOT, "profiles", id, "applications.tsv");
      if (fs.existsSync(tsvPath)) {
        const { apps } = load(tsvPath);
        // "Inbox" semantics in the unified 8-status set: status="To Apply"
        // AND not yet pushed to Notion (no notion_page_id). Once a row gets
        // a Notion page (CV+CL prepared), it stays "To Apply" but leaves
        // the inbox queue.
        inboxCount = apps.filter((a) => a.status === "To Apply" && !a.notion_page_id).length;
      }
    } catch (err) {
      console.log(`    inbox count unavailable: ${err.message}`);
    }
    const updatedAt = new Date().toISOString().slice(0, 10);
    const blocks = buildLayoutBody({
      profileName: (profile.identity && (profile.identity.name || profile.identity.full_name)) || id,
      profile,
      subpageIds,
      dbIds,
      inboxCount,
      updatedAt,
    });
    console.log(`    will append ${blocks.length} blocks to workspace page`);
    if (args.apply) {
      await appendBlocks(client, workspacePageId, blocks);
      console.log("    appended");
    }
  }

  // --- Step 3: persist to profile.json + .stage18/state.json ---
  profile.notion.workspace_page_id = workspacePageId;
  profile.notion.hub_layout = { ...profile.notion.hub_layout, subpages: subpageIds };
  if (args.apply) {
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");
    const { data: state } = loadState(id);
    state.build_hub_layout = {
      done: true,
      at: new Date().toISOString(),
      subpages: subpageIds,
      sentinel: HUB_LAYOUT_SENTINEL,
    };
    saveState(id, state);
    console.log("\n  [profile.json] updated with hub_layout.subpages");
  }

  done("build_hub_layout", { profile_id: id, subpages: subpageIds });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = {
  SUBPAGES,
  LEGACY_TITLES,
  HUB_LAYOUT_SENTINEL,
  hasHubLayoutSentinelV1,
  subpageSentinel,
  buildCandidateProfileBlocks,
  buildWorkflowBlocks,
  buildTargetTierBlocks,
  buildResumeVersionsSubpageBlocks,
  buildIntro,
  buildLayoutBody,
  buildSubpageBody,
  splitList,
};
