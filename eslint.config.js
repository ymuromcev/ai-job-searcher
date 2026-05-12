// ESLint 9 flat config (BL-20: baseline).
//
// Stance: minimum-friction baseline. Pull in @eslint/js recommended +
// turn off anything that fights Prettier (via eslint-config-prettier).
// We do NOT add custom rules on top — the goal is `npm run lint` passing
// on existing code, not refactoring the codebase. Stricter rules can be
// layered in later via a follow-up BL.

const js = require("@eslint/js");
const prettierConfig = require("eslint-config-prettier");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "private/**",
      "profiles/**",
      "data/**",
      "coverage/**",
      "dist/**",
      "**/*.min.js",
      // worktrees the user creates on the side; not part of the lint surface.
      ".claude/worktrees/**",
      // Vendor / bundled third-party JS (Obsidian plugins are pre-built
      // bundles; not our source).
      ".obsidian/**",
    ],
  },
  js.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.nodeBuiltin,
      },
    },
    rules: {
      // Tests deliberately use `_url`, `_opts` to mark unused fn args without
      // confusing the reader. Keep that pattern lint-clean. WARN, not error —
      // BL-20 baseline accepts existing unused vars as-is; future tightening
      // is a separate BL.
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // ESLint 10 added these to recommended. The pre-BL-20 codebase predates
      // them and the violations are cosmetic / stylistic. Disable for baseline;
      // tighten later via follow-up BL.
      "no-useless-escape": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    // Test files: relax unused-vars even further (test scaffolding sometimes
    // declares fixtures that aren't used by every test in a file).
    files: ["**/*.test.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },
];
