# Writing style — template

Used by `prepare` (CL generation) and `answer` (form Q&A) to calibrate voice so output sounds like the candidate, not a generic LLM.

Fill this file with concrete guidance. Examples of what belongs here:

- Sentence patterns the candidate actually uses (short punchy vs. long compound; active voice vs. passive).
- Words and phrases the candidate naturally reaches for.
- AI tells to avoid (e.g., "delve", "leverage", "robust", "showcase", em-dash overuse, rule-of-three, hedging).
- Preferred openings (do not start with "I am writing to"; prefer a concrete fact or problem statement).
- Tone (confident practitioner vs. humble applicant; opinionated vs. neutral).
- Structural preferences (numbers mandatory, short paragraphs, no bullet lists inside a CL, etc.).

Keep it under ~1 page. The prepare / answer flow reads it verbatim; density matters more than length.
