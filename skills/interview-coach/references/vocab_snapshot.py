#!/usr/bin/env python3
"""Extract the candidate's MASTERED English words from a Reword backup.

Reword is a spaced-repetition app; its backup is a SQLite DB whose WORD
table carries SuperMemo SM-2 state per word. This script distills that
into a small plain-text snapshot the interview-coach skill loads to
calibrate spoken-English answers (see SKILL.md "Vocabulary calibration").

PII-free by construction: the backup path is an argument, never hardcoded.
The 305 MB DB is read column-projected (never SELECT *), so this is fast
and light. Re-run before every konspekt/story generation so the snapshot
always reflects the latest export.

Status encoding (reverse-engineered, verified against real data):
  Q_REC = grade of the last answer, 0..4
  S_REC = SR box / stage, 0..6
  MASTERED = marked-known (Q_REC >= 3 AND S_REC == 0)
             OR drilled to a high box (S_REC >= 4)
  LEARNING = mid boxes (S_REC in 1..3)        [reported in meta only]
  UNSTUDIED = no signal (Q_REC == 0 AND S_REC == 0)  -> NOT "unknown"

Exit codes: 0 ok, 2 backup missing/unreadable, 3 schema mismatch.
"""

import argparse
import datetime
import os
import sqlite3
import sys


def _die(code, msg):
    sys.stderr.write("vocab_snapshot: " + msg + "\n")
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser(description="Reword backup -> mastered-words snapshot")
    ap.add_argument("--backup", required=True, help="path to reword_en.backup (SQLite)")
    ap.add_argument("--out", required=True, help="path to write the snapshot .txt")
    args = ap.parse_args()

    if not os.path.isfile(args.backup):
        _die(2, "backup not found: " + args.backup)

    try:
        # read-only, do not create if missing
        db = sqlite3.connect("file:%s?mode=ro" % args.backup, uri=True)
    except sqlite3.Error as e:
        _die(2, "cannot open backup: " + str(e))

    cur = db.cursor()
    cols = {r[1].upper() for r in cur.execute("PRAGMA table_info(WORD)")}
    if not {"WORD", "Q_REC", "S_REC"} <= cols:
        _die(3, "WORD table missing expected columns (WORD, Q_REC, S_REC)")

    mastered = set()
    learning = 0
    unstudied = 0
    total = 0
    for word, q, s in cur.execute("SELECT WORD, Q_REC, S_REC FROM WORD"):
        total += 1
        if not word:
            continue
        q = q or 0
        s = s or 0
        if (q >= 3 and s == 0) or (s >= 4):
            mastered.add(word.strip().lower())
        elif 1 <= s <= 3:
            learning += 1
        elif q == 0 and s == 0:
            unstudied += 1
    db.close()

    src_mtime = datetime.datetime.fromtimestamp(os.path.getmtime(args.backup))
    now = datetime.datetime.now()
    words = sorted(mastered)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("# reword mastered-words snapshot\n")
        f.write("# source: %s\n" % os.path.basename(args.backup))
        f.write("# backup_exported: %s\n" % src_mtime.strftime("%Y-%m-%d %H:%M"))
        f.write("# generated: %s\n" % now.strftime("%Y-%m-%d %H:%M"))
        f.write("# counts: total=%d mastered=%d learning=%d unstudied=%d\n"
                % (total, len(words), learning, unstudied))
        f.write("# one lowercased word/phrase per line below\n")
        for w in words:
            f.write(w + "\n")

    # machine-readable one-liner for the skill / logs
    sys.stdout.write(
        "OK mastered=%d learning=%d unstudied=%d total=%d backup_exported=%s out=%s\n"
        % (len(words), learning, unstudied, total,
           src_mtime.strftime("%Y-%m-%d"), args.out)
    )


if __name__ == "__main__":
    main()
