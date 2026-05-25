<!--
Adapted from olegvg/resume-tailor-plugin (license: MIT)
Source: ~/.claude/plugins/cache/resume-tailor-wrapper/resume-tailor/1.0.0/skills/resume-tailor/references/ats-rules.md
Date: 2026-05-24
Context: BL-123 / RFC 044 — Strong-fit tailoring loop

Selected: Format Rules (lines 1-41) + Anti-Patterns (lines 106-129).
Omitted: Keyword Strategy and ATS Scoring Formula — replaced in Step B
reimplementation because they contradict Scale.jobs 2025 research
(lexical mirror, no semantic variants, no cap-at-3).
-->

# ATS Rules & Scoring Heuristics

## Format Rules

### Layout
- Single column ONLY. No multi-column, no tables for layout, no text boxes
- No graphics, icons, charts, progress bars for skill levels
- Contact info in document body (NOT in header/footer — Workday and others skip headers entirely)
- No "skill bars" or percentage ratings — ATS cannot parse visual skill levels
- Photos can disrupt ATS parsing (shift text positions, break field extraction). For ATS submissions — no photo. Add photo only for direct submissions in EU/CIS markets where expected
- No special characters (★ ● ◆) — use standard bullets or dashes
- No em dashes in dates — use hyphens

### Section Headings
Use these exact standard headings (ATS systems look for them):
- EN: "Executive Summary", "Core Skills", "Professional Experience", "Education", "Certifications"
- RU: "Краткое описание", "Ключевые навыки", "Опыт работы", "Образование", "Сертификации"
- Creative alternatives ("My Journey", "What I Bring") break ATS section detection

### File Format (updated 2026)
- `.pdf` (text-based) — now parses as well as DOCX across Greenhouse, Lever, Workday, iCIMS. Default choice — preserves formatting perfectly
- `.docx` — still has 23% fewer parsing errors with design tools (Workday data); use when portal explicitly requests it or legacy ATS suspected
- HTML-to-PDF (weasyprint, Puppeteer, Chrome print) — produces clean text-based PDFs that parse correctly
- **Test:** if you can highlight and copy text in the PDF, ATS can read it
- Never: `.pages`, `.odt`, Google Docs links, scanned/image-based PDFs

### Typography
- Fonts: Calibri, Arial, Garamond, Cambria (10-12pt body, 13-14pt headings)
- Margins: 0.5-1 inch (0.75 inch recommended)
- No decorative fonts or unusual typefaces

### Dates
- Consistent format throughout the entire document
- Preferred: MM/YYYY or Month YYYY
- Never mix formats (e.g., "Jan 2024" in one place and "01/2024" in another)

### Acronyms
- Spell out on first use with acronym in parentheses
- Example: "Application Programming Interface (API)"
- After first use, acronym only is fine

---

## Anti-Patterns to Detect and Flag

### Executive Summary
- NEVER start with: "Seasoned", "Dynamic", "Results-driven", "Passionate", "Highly motivated"
- NEVER use: "[Title] with N+ years of experience in [broad field]" as opening
- MUST be specific to the target role, mentioning the actual job title and 1-2 headline metrics

### Content
- Metrics without business context: "Increased revenue 30%" — of what baseline? what division?
- Responsibilities-only descriptions without achievement bullets
- Role descriptions that could apply to anyone in that title (not specific to this person)
- Unexplained gaps > 6 months (flag to user, don't auto-fill or hide)

### Structure
- "References available upon request" — remove entirely (outdated convention)
- Objective statements (replaced by Executive Summary)
- Skill percentage ratings or proficiency bars
- Aggregated achievement blocks detached from specific roles/periods

### Tailoring
- Over-narrowing: stripping relevant domain experience to match JD literally
- Under-tailoring: generic resume not customized for this specific role
- Early career elimination: condensing significant roles to nothing just because they're old
- Ignoring transferable skills from adjacent domains
