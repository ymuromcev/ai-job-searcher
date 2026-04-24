# Contributing

This is a personal project, open-sourced as a portfolio artifact — not
a product seeking maintainers. That said, contributions are welcome
and read:

- **Issues** — bug reports, rough edges, questions: please open one.
  Include a minimal reproducer when you can.
- **Pull requests** — please open an issue first to discuss direction.
  Small, focused diffs with a test land fastest.
- **Security** — if you think you've found something sensitive, please
  email directly instead of opening a public issue:
  [ymuromcev@gmail.com](mailto:ymuromcev@gmail.com).

## Ground rules

- Keep `engine/` free of personal preferences and PII.
- New behaviour that touches multiple files goes through a short RFC
  in `rfc/NNN-title.md` first. Template in
  [docs/ai-assistant-notes.md](docs/ai-assistant-notes.md).
- Add a test. `npm test` runs on Node 20+ with no external services.
- Pre-commit hook is mandatory: `npm run setup-hooks` once after clone.

## What not to send

- Mass refactors without a discussed plan.
- New adapters / features that pull in heavy dependencies. Keep the
  engine boring.
- Changes to `profiles/<id>/` for anyone other than `_example`.
