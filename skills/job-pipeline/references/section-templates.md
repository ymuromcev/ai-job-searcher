<!--
Adapted from olegvg/resume-tailor-plugin (license: MIT)
Source: ~/.claude/plugins/cache/resume-tailor-wrapper/resume-tailor/1.0.0/skills/resume-tailor/references/section-templates.md
Date: 2026-05-24
Context: BL-123 / RFC 044 — Strong-fit tailoring loop

EN slot-marker templates only. RU templates and RU examples from the
upstream file have been omitted (out of scope for this pipeline).
-->

# Section Templates

Slot markers use `[CAPS_SNAKE_CASE]` for values the skill fills in.

---

## Executive Summary

### EN Template
```
[TARGET_ROLE_TITLE] with [YEARS_RELEVANT] years driving [PRIMARY_DOMAIN] at [SCALE_DESCRIPTION]. [HEADLINE_ACHIEVEMENT_WITH_METRIC]. Brings [KEY_DIFFERENTIATOR_1] and [KEY_DIFFERENTIATOR_2] to [TARGET_COMPANY_CONTEXT_OR_ROLE_TYPE].
```

Example:
```
CTO and platform architect with 12 years driving fintech payment infrastructure at scale (100K+ TPS, $25M+ monthly volume). Built and led engineering orgs of 55+ across three continents, delivering PCI DSS and ISO 27001 certified systems from scratch. Brings deep high-load distributed systems expertise and hands-on security architecture to high-growth payment platforms.
```

Anti-pattern — NEVER generate this:
```
Seasoned technology leader with 15+ years of experience in software development and team management. Proven track record of delivering results in fast-paced environments.
```

---

## Core Skills

### Grouping Template
```
[CATEGORY_NAME_1]: [Skill_1] | [Skill_2] | [Skill_3] | [Skill_4]
[CATEGORY_NAME_2]: [Skill_1] | [Skill_2] | [Skill_3] | [Skill_4]
[CATEGORY_NAME_3]: [Skill_1] | [Skill_2] | [Skill_3] | [Skill_4]
```

Rules:
- 3-5 categories
- 4-6 skills per category
- Most JD-relevant category first
- JD required skills must appear here
- Pipe-delimited within categories

### Common Category Names (EN)
- Engineering Leadership & Org Design
- Platform Architecture (Distributed Systems, High-Load)
- Security & Compliance
- Payments & Financial Infrastructure
- DevOps / SRE / Cloud Infrastructure
- Data Engineering & Analytics
- Languages & Databases

---

## Professional Experience — Full Detail Role

### EN Template
```
### [COMPANY_NAME] — [COMPANY_CONTEXT]
**[JOB_TITLE]** | [START_DATE] - [END_DATE]

[1-2 sentence scope: what you owned, team size, key mandate]

Key Achievements:
- [ACTION_VERB] [specific what] [scope], resulting in [METRIC]
- [ACTION_VERB] [specific what] [scope], achieving [METRIC]
- [ACTION_VERB] [specific what] [scope], reducing/increasing [METRIC]
```

---

## Professional Experience — Condensed Role

### EN Template
```
**[JOB_TITLE]** | [COMPANY_NAME] | [START_DATE] - [END_DATE]
[1-2 most relevant achievements with metrics in a single line or two bullets]
```

---

## Achievement Bullet Formula

### The Pattern
```
[Action Verb] [what specifically you did] [within what scope/context], [resulting in] [quantified outcome] [timeframe if applicable]
```

### Quality Checklist for Each Bullet
- Has a strong action verb (not "Responsible for")
- Specifies WHAT was done (not vague)
- Includes scope/context (team size, system scale, business unit)
- Contains a quantified metric (%, $, time, count, scale)
- Metric has business context (not a floating number)

### Examples (EN)
Good:
```
Architected event-driven microservices platform processing 2M+ transactions/day, reducing P95 latency from 800ms to 120ms within 6 months
```

Bad:
```
Worked on microservices architecture and improved system performance
```

---

## Education

### EN Template
```
**[DEGREE]** in [FIELD] — [UNIVERSITY_NAME], [GRADUATION_YEAR]
```

---

## Cover Letter (Optional)

### EN Structure (3-4 paragraphs)
1. **Opening:** Why THIS company specifically (not generic). Reference something specific about the company/role.
2. **Match 1-2:** Strongest alignment between your experience and their top requirements. Include specific metrics.
3. **Match 3 + Differentiator:** Another strong match plus what makes you uniquely valuable beyond the JD.
4. **Close:** Forward-looking, specific next step. NOT "I look forward to hearing from you."
