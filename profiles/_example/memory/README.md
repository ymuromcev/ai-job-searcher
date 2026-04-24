# `memory/` — profile-level context

Files in `profiles/<id>/memory/` are read by the `prepare`, `answer`, and `check` commands (once implemented) as source-of-truth for the candidate's voice, facts, and preferences. They are gitignored alongside the rest of `profiles/<id>/`.

Required:

- `user_writing_style.md` — voice calibration for generated CL / Q&A.
- `user_resume_key_points.md` — canonical experience / proof-points.

Optional (add as you discover constraints — one file per feedback lesson, prefixed `feedback_*.md`):

- `feedback_210_char_limit.md` — example: fixed answer-length preference.
- `feedback_credit_mentor_positioning.md` — example: project framing rules.
- etc.

Templates in this folder (`*.example.md`) are safe defaults. Copy them into your profile and edit.
