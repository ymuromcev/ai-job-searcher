# debrief — Post-Interview Rapid Capture Workflow

Captures what happened in a real interview while it's still fresh. This is the bridge between the real interview and `analyze` — and for candidates without transcripts, it may be the only data source.

### When to Use

- Immediately after a real interview (same day, ideally within 1-2 hours)
- When the candidate doesn't have a transcript
- When they do have a transcript but want to capture subjective impressions before analysis
- When they need emotional processing before diving into scoring

### Sequence

1. **Emotional check first.** Before anything tactical, ask: "How are you feeling about it? One word." This serves two purposes: (a) it surfaces emotional state that affects memory quality, and (b) it shows the coach cares about the person, not just the performance. Don't skip this.
2. **Rapid question capture.** "What questions did they ask? Don't worry about exact wording — just get them down." Capture as many as they can remember. Prompt with format cues: "Was there a behavioral question? A 'tell me about a time' question? Anything unexpected?"
3. **Per-question self-assessment.** For each question they remember: "How did you feel about your answer? Strong, okay, or rough?" Don't score yet — capture their in-the-moment read.
4. **Signal reading.** "Did you notice any signals from the interviewer? Follow-up questions that showed interest? Moments where they seemed to lose interest or redirect? Any body language that stood out?" Capture these — they're high-value data even without a transcript.

   **Signal Interpretation Guide** — Help the candidate read the signals they noticed:
   | Signal | Likely Meaning | Confidence |
   |---|---|---|
   | Extended follow-ups on one topic | Genuine interest or evaluating depth — positive either way | HIGH |
   | Interviewer moved on quickly after your answer | Your answer either fully satisfied them or didn't land — look at their energy after moving on | MEDIUM |
   | "That's interesting" + follow-up | Usually positive — they want more | HIGH |
   | Interviewer checked the time or clock | Running behind schedule, not necessarily boredom — but if repeated, you may be going long | MEDIUM |
   | "Let me push back on that" | Testing conviction, not disagreeing — this is often a positive signal | HIGH |
   | Interviewer started selling the role/company to you | Strong buy signal — they want you interested | HIGH |
   | Short, closed-ended follow-ups | They may have already formed their assessment — neutral to negative | MEDIUM |
   | "We'll be in touch" with no specifics | Standard — don't read into it either way | LOW |

   Caveat: "These are common patterns, not certainties. Interviewers have different styles — some are naturally warm regardless of assessment, some are naturally terse even when impressed. Use these as directional signals, not verdicts."

   See also the Signal-Reading Module in `references/cross-cutting.md` for the full positive/negative/neutral signal framework and cross-interview pattern detection.

5. **Surprise capture.** "Was there anything you didn't expect? A question you weren't prepared for, a format difference, something about the interviewer or environment?" Unexpected moments are often the most informative for coaching.
6. **Story usage log.** "Which stories did you use? Did any of them land differently than in practice?" Cross-reference with storybank — update `Last Used` dates, increment `Use Count` for each story used, and add performance notes.
7. **Immediate tactical notes.** "Is there anything you want to do differently for the next round, based on this one?" Capture their own coaching instinct.
8. **Positioning performance check.** "How did your introduction / 'tell me about yourself' land? Did the interviewer seem engaged, or did they jump to questions quickly?" Capture this signal — it feeds back to `pitch` for positioning iteration. Record in Interview Intelligence → Effective/Ineffective Patterns if the response reveals something actionable about how the candidate's positioning lands.
9. **Recruiter/interviewer feedback capture.** "Did you get any feedback from the recruiter about this round? Even informal comments — 'they really liked your background' or 'the interviewer had some concerns about X' — are valuable signal." If feedback exists, record it for the Recruiter/Interviewer Feedback table in Interview Intelligence.
10. **Past question similarity check.** Scan the Interview Intelligence Question Bank for questions similar to what the candidate recalled. If matches exist, note them briefly: "You've seen a prioritization question like Q2 before — at [Company] in Round [N]. Your score on that one was [X]." Only surface matches that are useful (same competency tested, score trajectory, or company pattern). Don't force connections.
11. **Transcript availability check.** "Do you have a recording or transcript? If so, we can do a full `analyze` later. If not, I'll work from what you've captured here." If they do have a transcript, mention the tool it came from so they know they can paste raw output: "You can paste the raw transcript directly from Otter, Zoom, Grain, or whatever tool you used — I'll detect the format and clean it up automatically."

### With vs. Without Transcript

**If transcript is available (or coming):**
- Save the debrief data to coaching state
- Tell the candidate: "Great — I have your impressions. When you're ready, run `analyze` with the transcript and I'll compare your read to what the data shows. The gap between how you felt and how it actually went is some of the most useful coaching data."
- The debrief becomes input to `analyze`, not a replacement for it

**If no transcript exists:**
- This debrief IS the data. Run a lighter version of analysis:
  - Score what you can from the candidate's recollection (flag lower confidence)
  - Focus on signal-reading data (interviewer behavior is easier to remember than exact words)
  - Identify which dimensions you can assess vs. which require a transcript
  - Say: "I'm working from your memory here, which means my confidence is lower than a transcript analysis. I can give you directional feedback, but I wouldn't hang precise scores on this."

### Emotional Triage

Based on the emotional check in step 1, adapt:

- **Candidate feels good**: Proceed normally. Capture data. Offer `analyze` or `thankyou` as next steps.
- **Candidate feels terrible**: Don't jump to tactical feedback. Acknowledge it: "That sounds rough. Let's capture what happened while it's fresh — we can analyze it later when there's some distance." Focus on capture, not coaching. Offer `hype` if another interview is coming soon. Reference the Psychological Readiness Module's rejection reframe if needed.
- **Candidate is uncertain**: This is actually the most valuable state — they don't know how it went. Say: "Uncertainty is normal. Let's capture the data and see what it actually tells us."

### Output Schema

```markdown
## Interview Debrief: [Company] - [Round]
- Date:
- Interviewer(s):
- Format:
- Emotional read: [candidate's one-word + brief context]

## Questions Recalled
1. [Question as remembered]
   - Self-assessment: [strong / okay / rough]
   - Story used: [S### or none]
   - Notes:
2. [...]

## Interviewer Signals Observed
- Positive signals (interest, follow-ups, engagement):
- Negative signals (redirects, loss of interest, clock-checking):
- Neutral/ambiguous:

## Surprises
- [anything unexpected — questions, format, environment, interviewer behavior]

## Stories Used
| Story | Question | How It Landed (candidate read) |
|-------|----------|-------------------------------|

## Candidate's Own Takeaways
- What to do differently:
- What worked:

## Feedback Received
- Date:
- Company:
- Source: [recruiter / interviewer / hiring manager / none]
- Feedback: [verbatim or close to it]
- Linked dimension: [if mappable]

## Intelligence Notes
- Questions matched from past interviews: [any Question Bank matches, or "no prior data"]
- Company pattern observations: [anything learned about this company's interview approach]

## Transcript Status
- [ ] Transcript available → run `analyze` when ready
- [ ] No transcript → directional analysis above is what we have

**Recommended next**: `analyze` — run full transcript analysis while impressions are fresh (if transcript available). **Alternatives**: `thankyou`, `hype`, `progress`
```

### Coaching State Integration

Update `coaching_state.md` per the State Update Triggers in SKILL.md:
- Storybank updates: Last Used dates, increment Use Count for each story used, performance notes
- Interview Loop updates: round completed, stories used, signals noted
- **Outcome block: write an `## Outcome` block (see below) with `Result: pending`.** The block is the loop artifact and the single canonical record of the pending outcome (RFC 066) — do not also add a pending row to the Outcome Log table; that table gets a row only when the gate resolves (via `feedback`). The block stays until the gate resolves, then it is closed with a channel, a conditions verdict and a reconciliation.
- Interview Intelligence updates: recalled questions to Question Bank (marked "recall-only"), recruiter/interviewer feedback to Recruiter/Interviewer Feedback table, Company Patterns if new observations emerged

### Outcome Block (RFC 066 — the debrief loop artifact)

Every real round gets one `## Outcome` block. It opens at debrief with `Result: pending` and is closed when the gate resolves. `debrief_audit.js` enforces the closing fields, so write the block in this exact shape:

```markdown
## Outcome: [Company] — [Round]
- Predicted: [what you predicted at debrief — e.g., "advance to VP"]
- Result: pending | advanced | rejected | offer | ghosted
- Gate: [which gate resolves it — e.g., "recruiter screen", "VP paper review"]
- Channel: LIVE | PAPER
- Conditions: normal | [adverse conditions — e.g., "severe sleep-deprivation; cold English; va-bank"]
- Baseline: counted | quarantined
- Reconciliation: [filled only once resolved — predicted vs actual; if a miss, the calibration lesson]
```

Loop rules the audit checks (all silent while `Result: pending`):

- **Channel is mandatory once resolved.** `LIVE` = what the interviewer heard on the call. `PAPER` = what reached the next gate without the call — recruiter notes, resume, self-ratings said aloud that landed in notes. A rejection at a gate that never heard you is a PAPER loss; do not prescribe live-delivery fixes for it. A single failure can be LIVE-origin with a PAPER path (live stumbling → "communication concern" in notes → seen by a VP who never heard the call) — tag the channel that actually decided.
- **Reconcile the prediction.** When the result lands, compare it to `Predicted`. An endorsement to the *next* gate is a filter, not a pass: score it `pending` until that gate resolves, never bank it as an advance. A miss is a calibration lesson written into Cross-Dimension Root Causes, not a shrug.
- **Quarantine adverse conditions.** A loss under real adverse conditions (no sleep, cold English, va-bank) is condition-driven, not proof of skill regression — set `Baseline: quarantined` so it does not drag the skill trend. But weigh the reschedule honestly: the escape hatch is not free (delay cost, and whether the replacement slot is actually better). If it was a defensible va-bank, quarantine the run; do not also excuse it as skill.
