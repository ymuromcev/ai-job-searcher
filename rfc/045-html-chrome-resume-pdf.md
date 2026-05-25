# RFC 045 — HTML + Chrome headless resume PDF renderer

- Status: **proposed**
- Date: 2026-05-25
- Refs: BL-126 (this RFC's parent), RFC 044 (Strong tailoring loop — consumer of `generateResumePdf`), RFC 043 (master profile)
- Tier: M (per `DEVELOPMENT.md` — renderer replacement, two callers re-wired, new external dependency on Chrome binary)

## Problem

BL-126 set out to produce a 1-page tailored resume PDF in OpenArt-style. We implemented `engine/modules/generators/resume_pdf.js` on top of `pdfkit` (456 lines), iterated three times, and the output is still wrong:

1. **Glyph corruption.** pdfkit's WinAnsi-encoded Helvetica drops or mangles characters: "Launched" rendered as "Łaunched", arrows became mojibake. We added per-character ASCII fallbacks (`→` → `->`) and survived only the ASCII subset by accident; real candidates and real JD text will keep hitting this.
2. **No CSS.** Layout is hand-computed coordinates: `lineGap: 2.05`, `margins.top: 28.8`, `underlineOffset: 1`. Every visual tweak is a math change in a generator file, not a stylesheet edit.
3. **Section bleed.** Manual y-cursor accounting let the Projects section merge into Experience under certain bullet counts — a class of bug that has no equivalent in CSS-driven flow layout.
4. **The "good" PDF already exists in HTML.** We hand-built `/tmp/jared_perplexity_pm_resume.html` to nail the OpenArt look, ran it through Chrome headless, and got `/tmp/Jared-Moore-Perplexity-PM-Builder.pdf` — the reference the user signed off on visually.

User verbatim, after the third pdfkit fix attempt:

> «Нет, сделано плохо, в проектах вообще перемешано все. Почему мы не можем просто взять ту технологию, которая сначала сгенерирвоала хороший вариант?»

The answer is: we can, and we should. This RFC pivots the renderer to **HTML template + Chrome headless print-to-pdf**.

## Approach

`generateResumePdf(data, outPath, opts)` keeps its signature and contract. Internally it switches to a three-stage pipeline:

```
subagent JSON
   │
   ▼
compressForOnePage(data)         // deterministic safety-net (in renderer, NOT subagent)
   │
   ▼
renderHtml(data, template)       // slot-substitution into HTML template
   │            writes /tmp/<slug>-<rand>.html
   ▼
htmlToPdf(htmlPath, outPath)     // spawn Chrome headless
   │
   ▼
{ path: outPath, pageCount: N }
```

No template-engine dependency. Template uses comment-form slots like `<!-- SLOT:summary -->...<!-- /SLOT:summary -->` and inline simple slots `{{contact_line}}`. Comment-form for block content (so the template is still valid HTML you can open in a browser to preview the layout), inline `{{}}` for one-line values inside attributes/short strings. We pick comment-blocks over Mustache because they preview cleanly in browsers and have zero runtime cost — a single `String.prototype.replace` per slot, no escaping concerns since we control all input shape.

## File layout

- **New** `engine/modules/generators/resume_template.html` — extracted verbatim from `/tmp/jared_perplexity_pm_resume.html`, with hand-written content replaced by slot markers. CSS lives in `<style>` inline, identical to the reference. This is the editable file when the user wants to tweak fonts/spacing/colors.
- **New** `engine/modules/generators/resume_pdf_chrome.js` — the renderer. Exports the same `generateResumePdf(data, outPath, opts)` so `prepare.js` and `regen_resumes.js` change one `require()` line each. Returns `{ path, pageCount }`.
- **New** `engine/modules/generators/resume_pdf_chrome.test.js` — unit tests (slot replacement, compression, mocked Chrome spawn).
- **Deprecated** `engine/modules/generators/resume_pdf.js` + `.test.js` — delete vs keep-as-stub is a user decision (see Open questions). My default recommendation is **delete** in the same commit: it's 456 lines of dead code, the git history is sufficient archive.

## Chrome wrapper

**Invocation** (single subprocess per call):

```
<chrome_bin> --headless --disable-gpu --no-pdf-header-footer \
             --print-to-pdf=<absOutPath> file://<absHtmlPath>
```

**Binary discovery**, in order:

1. `process.env.CHROME_BIN` if set.
2. macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
3. Linux: first existing of `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on `PATH`.
4. None found → throw with a clear remediation message:
   > `generateResumePdf: Chrome binary not found. Install Google Chrome (https://www.google.com/chrome/) or set CHROME_BIN to a Chromium/Chrome executable path.`

We **do not** auto-install Chrome and we **do not** touch `.env`. The user adds `CHROME_BIN` to `.env` only if their setup is non-standard.

**Process control**: `child_process.spawn` with a 20s timeout (Chrome rarely needs more than 2-3s for a one-page render; longer means something is wrong). HTML is written to a unique temp file under `os.tmpdir()` and `unlink`'d in a `finally` block whether render succeeds or fails. Subprocess stderr is captured and surfaced in the thrown error on non-zero exit.

## Compression placement

The deterministic 1-page safety-net (`compressForOnePage`) lives **inside the renderer**, before HTML rendering. It does **not** live in the subagent prompt.

Reason: BL-126 acceptance test on Perplexity PM Builder showed the subagent ignored the soft compression hints in the prompt (Block C work) and emitted four full roles + multiple projects, producing a 2-page PDF. The hints work most of the time but not reliably. Putting compression at render time guarantees one page regardless of subagent output drift, model version, or future prompt edits.

The logic is the safety-net already drafted (uncommitted) in the current `resume_pdf.js`:

- Keep the two most recent roles in full; collapse older PM roles into a single "Earlier PM roles" paragraph with bolded company names + headline metrics.
- Cap at 4 bullets per kept role.
- Collapse the Projects section to one paragraph (project names bold, one-line each, semicolon-separated).
- Cap Summary at ~4 lines (truncate sentences after the limit, preserve trailing period).

The function is pure: `compressForOnePage(data) → compressedData`. Same data shape in and out, just shorter arrays. Easy to unit-test, easy to disable for debugging by passing `opts.compress = false`.

## Page-count detection

`package.json` currently has no PDF parsing dep. Cheapest option: read the rendered PDF as bytes and count `/Type /Page` occurrences (excluding `/Type /Pages`) via a regex. This is robust for Chrome-generated PDFs (they don't use object streams that would hide the marker) and adds zero dependencies.

```
const buf = fs.readFileSync(outPath);
const text = buf.toString("binary");
const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
```

If this turns out flaky against future Chrome output, the fallback is `pdf-parse` (a 10KB dep) — but we add it only if the regex fails on a real PDF.

## Integration points

Two callers, both `require("./resume_pdf")` today:

- `engine/commands/prepare.js:1742` — tailored-row path in `runCommit`. Change: `require("../modules/generators/resume_pdf_chrome")`. Signature is identical (`async (data, outPath, opts) → {path, pageCount}`), the existing `pageCount > 1` warning at lines 1767-1773 keeps working.
- `scripts/regen_resumes.js:11` — archetype regen for `profiles/<id>/resumes/`. Same one-line require swap.

No call-site logic changes. The `opts.layout` parameter (`one_page` | `two_page` | `ru_long`) is preserved; `one_page` is the only preset implemented in v1, the others fall through to it (same behavior as today's pdfkit version).

## Trade-offs

| | pdfkit (current) | Chrome headless (proposed) |
|---|---|---|
| Glyph fidelity | WinAnsi only, mojibake on anything non-ASCII | Full Unicode, system fonts |
| Layout language | Hand-computed coordinates in JS | Real CSS, browser-grade layout engine |
| Visual iteration | Edit JS, re-run, eyeball output | Edit HTML/CSS in a browser, then commit |
| Output match to reference | Approximate, off by pixels | Bit-identical to the approved `/tmp/Jared-Moore-Perplexity-PM-Builder.pdf` (same HTML, same renderer) |
| External deps | `pdfkit` npm package | Chrome binary on host (already present for most devs) |
| Per-call cost | ~10ms in-process | ~500ms subprocess spawn + render |
| CI story | Pure Node, runs anywhere | Needs Chrome OR mocked spawn in tests |
| Failure modes | Silent glyph corruption, section bleed | Loud (Chrome non-zero exit, stderr surfaced) |

The per-call cost is irrelevant in practice: `generateResumePdf` is called once per tailored row, batches are 5-20 rows, the human-facing latency is dominated by the LLM tailor loop (~30s/row) not the render (~0.5s/row).

Chrome binary requirement is the real cost. Mitigation: clear error message on missing binary + `CHROME_BIN` escape hatch + the macOS path is hard-coded so the user's local box just works.

## Testing strategy

Unit tests (`resume_pdf_chrome.test.js`), all hermetic, no real Chrome:

- `compressForOnePage`: 4-roles input → 2 roles + "Earlier PM roles" paragraph; 5-bullet role → 4 bullets; multi-project → single paragraph; short input passes through unchanged.
- Slot substitution: each `<!-- SLOT:x -->` marker is replaced; unfilled markers leave no residue; HTML-escape applied where needed (`&`, `<`, `>` in user text).
- Chrome spawn: inject a fake `spawn` via dependency-injection (renderer accepts `opts.spawnFn` for tests). Assert correct argv, assert stderr surfaces in thrown error on non-zero exit, assert tmp HTML is cleaned up on both paths.
- Page-count regex: synthetic PDF bytes with 1, 2, 3 `/Type /Page` markers.

Integration test (`resume_pdf_chrome.integration.test.js`): gated on `process.env.CHROME_BIN` or default macOS path being present. Renders a fixed input → asserts the PDF exists, is non-empty, and reports `pageCount === 1`. Skipped in CI by default (`test.skip` if no binary).

## Rollout

Single commit, no feature flag:

1. Add `resume_template.html` + `resume_pdf_chrome.js` + tests.
2. Switch `prepare.js` and `regen_resumes.js` to the new require.
3. Delete `resume_pdf.js` + `resume_pdf.test.js` (subject to user choice — see Open questions).
4. Update `CHANGELOG.md` under `[Unreleased] / Changed`.
5. Update `README.md` Setup section: mention Chrome dependency + `CHROME_BIN`.

The user's `profiles/jared/` regen flow (`scripts/regen_resumes.js`) keeps working — same CLI, same output paths, just better PDFs.

## Out of scope

- **Lilia's `ru_long` Cyrillic layout.** Already a known follow-up in BL-126 risks. Chrome handles Cyrillic natively (one of the wins of this pivot), but the layout preset itself — different fonts, two-page allowance, density — is its own design pass.
- **SaaS / hosted deployment.** Out of scope per project charter; Chrome dependency is fine for self-host.
- **Alternative renderers (puppeteer, weasyprint).** Puppeteer is Chrome + a node API wrapper — adds 300MB of deps to do what `child_process.spawn` does in 20 lines. Weasyprint needs Python + system libraries, even heavier. Direct Chrome wins on minimalism.
- **Online preview / live-edit UX.** The HTML template is editable by hand and previewable in any browser; that's the v1 author tooling.

## DoD

- [ ] RFC 045 approved by user.
- [ ] `resume_pdf_chrome.js` + `resume_template.html` + tests landed.
- [ ] `prepare.js` (line 1742) and `scripts/regen_resumes.js` (line 11) rewired to the new module.
- [ ] Old `resume_pdf.js` + `.test.js` deleted (or stubbed — see Open questions).
- [ ] `npm test` green; integration test passes locally with Chrome present.
- [ ] Acceptance test: re-render Perplexity PM Builder from `profiles/jared/prepare_results_20260525_204500.json` → 1-page PDF, visually matching `/tmp/Jared-Moore-Perplexity-PM-Builder.pdf`, 37/37 mirror phrases retained.
- [ ] `CHANGELOG.md` entry under `[Unreleased] / Changed`.
- [ ] `README.md` Setup section mentions Chrome requirement + `CHROME_BIN` env var.
- [ ] BL-126 transitioned to `done` with final notes.

## Open questions (do not block approval)

1. **Delete vs stub `resume_pdf.js`?** Recommendation: delete. Alternative: keep as a one-line stub re-exporting the new module for any external caller (none known in this repo).
2. **Page-count regex vs `pdf-parse` dep?** Recommendation: regex first, add `pdf-parse` only if the regex misfires on a real Chrome PDF.
3. **HTML template location: `engine/modules/generators/` vs `docs/templates/`?** Recommendation: keep it next to the renderer that owns it. Easier to find when editing layout.
