// Builds profiles/<id>/master_profile.md from profiles/<id>/resume_versions.json.
//
// Run: node scripts/build_master_profile.js --profile <id>
//
// Deterministic + idempotent: running twice without changes to resume_versions.json
// produces byte-identical output. See RFC 043 for schema.
//
// Reads:
//   profiles/<id>/resume_versions.json
//
// Writes:
//   profiles/<id>/master_profile.md  (overwritten — manual overrides not preserved on this iteration)
//
// Storybank (STAR-blocks) lives separately at
// profiles/<id>/interview-coach-state/coaching_state.md and is referenced from
// the generated master, not copied into it.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- arg parsing ----------

function parseArgs(argv) {
  const args = { profile: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") args.profile = argv[++i];
    else if (argv[i] === "--root") args.root = argv[++i]; // override for tests
  }
  return args;
}

// ---------- pure helpers ----------

function segmentsToText(segments) {
  if (!Array.isArray(segments)) return "";
  return segments.map((s) => (s && typeof s.text === "string" ? s.text : "")).join("");
}

function segmentsToMarkdown(segments) {
  if (!Array.isArray(segments)) return "";
  return segments
    .map((s) => {
      if (!s || typeof s.text !== "string") return "";
      return s.bold ? `**${s.text}**` : s.text;
    })
    .join("");
}

function normalizeForDedupe(text) {
  return text
    .toLowerCase()
    .replace(/[–—]/g, "-") // en/em dash
    .replace(/[^a-z0-9\s%$.\-]/g, "") // strip everything but alphanumerics + a few meaningful chars
    .replace(/\s+/g, " ")
    .trim();
}

// Stable sort of archetype names (preserve source order from versions object).
function archetypeOrder(versions) {
  return Object.keys(versions);
}

// Dedupe bullets across archetypes for a single role.
// Returns: [{ canonical: <markdown>, plain: <text>, used_in: [archetype], alternates: [markdown] }]
function dedupeBullets(versions, bulletGetter) {
  const archetypes = archetypeOrder(versions);
  const clusters = new Map(); // key -> { canonical, plain, used_in: Set, alternates: [] }

  for (const arch of archetypes) {
    const bullets = bulletGetter(versions[arch]);
    if (!Array.isArray(bullets)) continue;
    for (const bullet of bullets) {
      if (!Array.isArray(bullet)) continue;
      const md = segmentsToMarkdown(bullet);
      const plain = segmentsToText(bullet);
      const key = normalizeForDedupe(plain);
      if (!key) continue;
      if (!clusters.has(key)) {
        clusters.set(key, {
          canonical: md,
          plain,
          used_in: new Set([arch]),
          alternates: [],
        });
      } else {
        const c = clusters.get(key);
        c.used_in.add(arch);
        if (c.canonical !== md && !c.alternates.includes(md)) {
          c.alternates.push(md);
        }
      }
    }
  }

  return Array.from(clusters.values()).map((c) => ({
    canonical: c.canonical,
    plain: c.plain,
    used_in: Array.from(c.used_in),
    alternates: c.alternates,
  }));
}

// Compute Visibility for a role based on archetype coverage.
function computeVisibility(usedIn, totalArchetypes, alwaysThreshold = 15) {
  if (usedIn.length >= alwaysThreshold) return { visibility: "always", variants: null };
  if (usedIn.length === 0) return { visibility: "always", variants: null }; // baseline-only role
  return { visibility: "variant-specific", variants: usedIn };
}

// Union skills from skillsFixed (values) + per-archetype skillsProduct/skillsDomain.
function buildSkillsInventory(rv) {
  const buckets = new Map(); // label → Set of skills

  // skillsFixed has labels
  if (Array.isArray(rv.shared_sections?.skillsFixed)) {
    for (const s of rv.shared_sections.skillsFixed) {
      if (!s.label || !s.value) continue;
      const set = buckets.get(s.label) || new Set();
      for (const item of s.value
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean)) {
        set.add(item);
      }
      buckets.set(s.label, set);
    }
  }

  // skillsProduct/skillsDomain are per-archetype
  const product = new Set();
  const domain = new Set();
  for (const arch of Object.keys(rv.versions || {})) {
    const v = rv.versions[arch];
    if (Array.isArray(v.skillsProduct)) {
      for (const s of v.skillsProduct) {
        if (typeof s === "string") product.add(s.trim());
      }
    }
    if (Array.isArray(v.skillsDomain)) {
      for (const s of v.skillsDomain) {
        if (typeof s === "string") domain.add(s.trim());
      }
    }
  }
  if (product.size) buckets.set("Product (across all archetypes)", product);
  if (domain.size) buckets.set("Domain (across all archetypes)", domain);

  return Array.from(buckets.entries()).map(([label, set]) => ({
    label,
    skills: Array.from(set).sort((a, b) => a.localeCompare(b)),
  }));
}

function computeSourceHash(json) {
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 12);
}

// ---------- clustering ----------

// Apply user-defined achievement clusters to a list of deduped bullets.
// Each cluster def: { id, name, canonical, outcome?, match_patterns: [string], match_any?: true }
// Bullet matches cluster if any of its match_patterns appears (case-insensitive) in bullet.plain.
// First-match wins. Unmatched bullets returned separately.
function applyClusters(bullets, clusterDefs, archetypes) {
  const clusters = clusterDefs.map((def) => ({
    def,
    angles: new Map(), // key = bullet markdown → { md, used_in: Set }
  }));
  const unmatched = [];

  for (const b of bullets) {
    let matched = null;
    const bplain = b.plain.toLowerCase();
    for (const c of clusters) {
      const patterns = c.def.match_patterns || [];
      if (patterns.some((p) => bplain.includes(p.toLowerCase()))) {
        matched = c;
        break;
      }
    }
    if (matched) {
      const key = b.canonical;
      if (!matched.angles.has(key)) {
        matched.angles.set(key, { md: b.canonical, used_in: new Set() });
      }
      const angle = matched.angles.get(key);
      if (b.used_in.includes("all")) {
        for (const a of archetypes) angle.used_in.add(a);
      } else {
        for (const a of b.used_in) angle.used_in.add(a);
      }
      // Merge alternates too
      for (const alt of b.alternates || []) {
        if (!matched.angles.has(alt)) {
          matched.angles.set(alt, {
            md: alt,
            used_in: new Set(b.used_in.includes("all") ? archetypes : b.used_in),
          });
        }
      }
    } else {
      unmatched.push(b);
    }
  }

  return {
    clustered: clusters.map((c) => ({
      def: c.def,
      angles: Array.from(c.angles.values()).map((a) => ({
        md: a.md,
        used_in: Array.from(a.used_in),
      })),
    })),
    unmatched,
  };
}

function renderCluster(c, archetypes) {
  let out = `- **${c.def.name || c.def.id}**\n`;
  if (c.def.canonical) out += `  - Canonical: ${c.def.canonical}\n`;
  if (c.def.outcome) out += `  - Outcome: ${c.def.outcome}\n`;
  if (c.angles.length === 0) {
    out += `  - _(No matching archetype bullets — canonical only.)_\n`;
    return out + "\n";
  }
  out += `  - Angles by archetype:\n`;
  // Sort angles by archetype-coverage count desc, then by text for stability
  const sorted = c.angles
    .map((a) => ({
      ...a,
      coverageLabel: a.used_in.length >= archetypes.length ? "all" : a.used_in.join(", "),
    }))
    .sort((a, b) => {
      if (b.used_in.length !== a.used_in.length) return b.used_in.length - a.used_in.length;
      return a.md.localeCompare(b.md);
    });
  for (const a of sorted) {
    out += `    - ${a.md}\n`;
    out += `      - \`used_in: [${a.coverageLabel}]\`\n`;
  }
  return out + "\n";
}

// ---------- markdown rendering ----------

function renderBulletWithMeta(b, allArchetypes) {
  const isAlways = b.used_in.length >= allArchetypes.length;
  const usedInTag = isAlways ? "all" : b.used_in.join(", ");
  let out = `- ${b.canonical}\n`;
  out += `  - \`used_in: [${usedInTag}]\`\n`;
  if (b.alternates.length > 0) {
    out += `  - Alternate phrasings:\n`;
    for (const alt of b.alternates) {
      out += `    - ${alt}\n`;
    }
  }
  return out;
}

function renderMaster(rv, profileId, opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString().slice(0, 10);
  const sourceHash = opts.sourceHash || computeSourceHash(JSON.stringify(rv));
  const archetypes = archetypeOrder(rv.versions || {});

  const roleIds = ["credit_mentor", "alfa", "croc", "ferma", "smmacc"];
  const roleKeyMap = {
    credit_mentor: "creditMentor",
    alfa: "alfa",
    croc: "croc",
    ferma: "ferma",
    smmacc: "smmacc",
  };

  let out = "";

  // Frontmatter
  out += "---\n";
  out += `profile_id: ${profileId}\n`;
  out += `generated_at: ${generatedAt}\n`;
  out += `source: profiles/${profileId}/resume_versions.json\n`;
  out += `source_hash: ${sourceHash}\n`;
  out += `generator: scripts/build_master_profile.js\n`;
  out += `rfc: 043\n`;
  out += "---\n\n";

  out += `# Master Profile — ${rv.contact?.name || profileId}\n\n`;
  out +=
    "_Generated file. Edit `resume_versions.json` (or storybank) and re-run `node scripts/build_master_profile.js --profile " +
    profileId +
    "` to regenerate. Manual edits to this file will be overwritten._\n\n";

  // Contact
  out += "## Contact\n\n";
  if (rv.contact) {
    if (rv.contact.name) out += `- Name: ${rv.contact.name}\n`;
    if (rv.contact.email) out += `- Email: ${rv.contact.email}\n`;
    if (rv.contact.phone) out += `- Phone: ${rv.contact.phone}\n`;
    if (rv.contact.location) out += `- Location: ${rv.contact.location}\n`;
    if (rv.contact.linkedin) out += `- LinkedIn: ${rv.contact.linkedin}\n`;
  }
  out += "\n";

  // Career Narrative — from rv.career_narrative if present, else placeholder
  out += "## Career Narrative\n\n";
  if (typeof rv.career_narrative === "string" && rv.career_narrative.trim()) {
    out += rv.career_narrative.trim() + "\n\n";
  } else {
    out +=
      "<!-- TODO: add `career_narrative` to resume_versions.json. Placeholder until first manual fill. -->\n\n";
    out += `Across ${roleIds.length} roles spanning fintech, AI-native product execution, and consumer-growth startups, the candidate has shipped ${rv.versions ? Object.keys(rv.versions).length : 0} distinct PM archetype variants from a single career foundation. Edit this section manually.\n\n`;
  }

  // Visibility Schema
  out += "## Visibility Schema\n\n";
  out +=
    "Each role and section carries a Visibility tag controlling inclusion in generated CVs.\n\n";
  out += "| Value | Meaning |\n";
  out += "|---|---|\n";
  out += "| `always` | Include in all resume variants |\n";
  out += "| `variant-specific` | Only in variants listed in the role's `Variants` field |\n";
  out += "| `on-request` | Never include unless user explicitly asks |\n";
  out += "| `reference-only` | Alias/metadata — never include in output |\n\n";
  out += `**Known variants (archetypes from \`resume_versions.json\`, count=${archetypes.length}):**\n\n`;
  for (const a of archetypes) {
    const v = rv.versions[a];
    out += `- \`${a}\` — ${v.title || ""}\n`;
  }
  out += "\n";

  // Roles
  out += "## Roles\n\n";
  for (const roleId of roleIds) {
    const role = rv.shared_roles?.[roleId];
    if (!role) continue;
    const verKey = roleKeyMap[roleId];

    // Collect bullets: shared_experience baseline (single compound bullet) + version-specific bullets
    const versionBullets = dedupeBullets(rv.versions || {}, (v) => {
      const intro = v[verKey]; // sometimes a single bullet (array of segments)
      const bullets = v[verKey + "Bullets"]; // array of bullets
      const result = [];
      if (Array.isArray(intro) && intro.length && typeof intro[0]?.text === "string") {
        result.push(intro);
      }
      if (Array.isArray(bullets)) {
        for (const b of bullets) {
          if (Array.isArray(b)) result.push(b);
        }
      }
      return result;
    });

    // Baseline from shared_experience: single compound bullet (array of segments)
    const baselineBullet = rv.shared_experience?.[roleId];
    if (
      Array.isArray(baselineBullet) &&
      baselineBullet.length &&
      typeof baselineBullet[0]?.text === "string"
    ) {
      const md = segmentsToMarkdown(baselineBullet);
      const plain = segmentsToText(baselineBullet);
      // Always prepend if not already in dedup pool
      const key = normalizeForDedupe(plain);
      if (!versionBullets.find((b) => normalizeForDedupe(b.plain) === key)) {
        versionBullets.unshift({
          canonical: md,
          plain,
          used_in: archetypes.length ? ["all"] : [],
          alternates: [],
        });
      }
    }

    // Compute visibility from bullet usage union
    const allUsedIn = new Set();
    for (const b of versionBullets) {
      if (b.used_in.includes("all")) {
        for (const a of archetypes) allUsedIn.add(a);
      } else {
        for (const a of b.used_in) allUsedIn.add(a);
      }
    }
    const usedInArr = Array.from(allUsedIn);
    const vis = computeVisibility(usedInArr, archetypes.length);

    out += `### ${role.role || roleId} — ${role.company || ""}\n\n`;
    out += `- Visibility: \`${vis.visibility}\`\n`;
    if (vis.variants) out += `- Variants: [${vis.variants.join(", ")}]\n`;
    if (role.dates) out += `- Dates: ${role.dates}\n`;
    if (role.location) out += `- Location: ${role.location}\n`;
    if (role.description) out += `- Company context: ${role.description}\n`;
    if (role.length_constrained_priority === "drop_first") {
      out += `- Length-constrained priority: \`drop_first\` — first role to drop when CV must fit one page.\n`;
    } else if (role.length_constrained_priority === "keep_first") {
      out += `- Length-constrained priority: \`keep_first\` — last role to drop under length constraints.\n`;
    }
    out += "\n";

    if (versionBullets.length === 0) {
      out += "_(No achievement bullets in source.)_\n\n";
      continue;
    }

    // Apply achievement clusters if defined for this role
    const clusterDefs = rv.achievement_clusters?.[roleId];
    if (Array.isArray(clusterDefs) && clusterDefs.length > 0) {
      const { clustered, unmatched } = applyClusters(versionBullets, clusterDefs, archetypes);
      out += "**Achievement clusters (canonical statement + per-archetype angles):**\n\n";
      for (const c of clustered) {
        out += renderCluster(c, archetypes);
      }
      if (unmatched.length > 0) {
        out += "**Other achievements (not clustered):**\n\n";
        for (const b of unmatched) {
          const covers =
            b.used_in.includes("all") || b.used_in.length >= archetypes.length
              ? ["all"]
              : b.used_in;
          out += renderBulletWithMeta({ ...b, used_in: covers }, archetypes);
        }
      }
    } else {
      out += "**Achievements (deduped across archetypes):**\n\n";
      for (const b of versionBullets) {
        const covers =
          b.used_in.includes("all") || b.used_in.length >= archetypes.length ? ["all"] : b.used_in;
        out += renderBulletWithMeta({ ...b, used_in: covers }, archetypes);
      }
    }
    out += "\n";
  }

  // Personal Projects
  if (Array.isArray(rv.shared_projects) && rv.shared_projects.length) {
    out += "## Personal Projects\n\n";
    for (const p of rv.shared_projects) {
      out += `### ${p.name || "Project"}${p.dates ? " — " + p.dates : ""}\n\n`;
      if (p.url) out += `- URL: ${p.url}\n`;
      if (p.description) out += `- ${p.description}\n`;
      out += "\n";
    }
  }

  // Education
  if (Array.isArray(rv.shared_sections?.education) && rv.shared_sections.education.length) {
    out += "## Education\n\n";
    for (const ed of rv.shared_sections.education) {
      out += `- Visibility: \`always\`\n`;
      out += `- ${ed.degree || ""}\n`;
      if (ed.school) out += `  - ${ed.school}\n`;
      if (ed.dates) out += `  - ${ed.dates}\n`;
    }
    out += "\n";
  }

  // Certifications
  if (Array.isArray(rv.certifications) && rv.certifications.length) {
    out += "## Certifications\n\n";
    for (const c of rv.certifications) {
      const vis = c.archetypes ? `variant-specific` : `always`;
      out += `- Visibility: \`${vis}\`\n`;
      if (vis === "variant-specific") out += `  - Variants: [${c.archetypes.join(", ")}]\n`;
      out += `  - ${c.name || ""}\n`;
      if (c.issuer) out += `  - Issuer: ${c.issuer}\n`;
      if (c.displayDate) out += `  - Date: ${c.displayDate}\n`;
    }
    out += "\n";
  }

  // Awards
  if (Array.isArray(rv.awards) && rv.awards.length) {
    out += "## Awards\n\n";
    for (const a of rv.awards) {
      const vis = a.archetypes ? `variant-specific` : `always`;
      out += `- Visibility: \`${vis}\`\n`;
      if (vis === "variant-specific") out += `  - Variants: [${a.archetypes.join(", ")}]\n`;
      out += `  - ${a.name || ""}\n`;
      if (a.displayDate) out += `  - Date: ${a.displayDate}\n`;
      if (a.context) out += `  - Context: ${a.context}\n`;
    }
    out += "\n";
  }

  // Skills Inventory
  out += "## Skills Inventory\n\n";
  out +=
    "Full union of skills from `skillsFixed` + per-archetype `skillsProduct` / `skillsDomain`. Not filtered for any single CV — tailoring subagent picks per JD.\n\n";
  const inv = buildSkillsInventory(rv);
  for (const bucket of inv) {
    out += `### ${bucket.label}\n\n`;
    for (const s of bucket.skills) out += `- ${s}\n`;
    out += "\n";
  }

  // Languages — from rv.languages if present
  out += "## Languages\n\n";
  if (Array.isArray(rv.languages) && rv.languages.length) {
    for (const l of rv.languages) {
      const level = l.level ? ` — ${l.level}` : "";
      out += `- ${l.name || ""}${level}\n`;
    }
    out += "\n";
  } else {
    out += "<!-- TODO: add `languages: [{name, level}]` to resume_versions.json. -->\n\n";
    out += "- _(Manual entry expected — not present in `resume_versions.json`.)_\n\n";
  }

  // STAR Stories reference
  out += "## STAR Stories\n\n";
  out += `Full STAR-stories (Situation / Task / Action / Result + Earned Secret) live in:\n\n`;
  out += `\`profiles/${profileId}/interview-coach-state/coaching_state.md\`\n\n`;
  out +=
    "Tailoring subagents must read both this file AND `coaching_state.md` in parallel to assemble factual grounding for a tailored CV. Format: bilingual RU/EN, first-person STAR per `feedback_storybank_first_person`.\n\n";

  // Notes
  out += "## Notes\n\n";
  out +=
    "- `resume_versions.json` remains primary source for Weak/Medium archetype CV generation (job-pipeline Step 7). This master is derived.\n";
  out += "- See `rfc/043-master-profile-schema.md` for full design rationale.\n";
  out +=
    "- Re-run `node scripts/build_master_profile.js --profile " +
    profileId +
    "` after any change to `resume_versions.json`.\n";

  return out;
}

// ---------- main ----------

function main(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv);
  if (!args.profile) {
    console.error("Usage: node scripts/build_master_profile.js --profile <id>");
    return 1;
  }

  const root = args.root || path.join(__dirname, "..");
  const rvPath = path.join(root, "profiles", args.profile, "resume_versions.json");

  if (!fs.existsSync(rvPath)) {
    console.error(`resume_versions.json not found at ${rvPath}`);
    return 1;
  }

  const raw = fs.readFileSync(rvPath, "utf8");
  const rv = JSON.parse(raw);
  const sourceHash = computeSourceHash(raw);

  // Default to a fixed date when explicitly requested (for tests). Otherwise
  // use today's date, but extract from a stable file mtime if --stable-date.
  const generatedAt = opts.generatedAt || new Date().toISOString().slice(0, 10);

  const md = renderMaster(rv, args.profile, { generatedAt, sourceHash });

  const outPath = path.join(root, "profiles", args.profile, "master_profile.md");
  fs.writeFileSync(outPath, md, "utf8");
  console.log(`Wrote ${outPath} (${md.length} bytes, source_hash=${sourceHash})`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  renderMaster,
  dedupeBullets,
  buildSkillsInventory,
  normalizeForDedupe,
  segmentsToMarkdown,
  segmentsToText,
  computeVisibility,
  computeSourceHash,
  applyClusters,
  renderCluster,
};
