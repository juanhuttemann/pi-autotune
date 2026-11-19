You are adapting the HARNESS of an autonomous coding agent: pi (CLI). The model is
frozen; only the harness changes. Everything you need is on disk under `./context/`.
Read it with your tools; do not guess and do not ask questions.

- `context/task.md`: the request the agent was given (when this session is about one task).
- `context/source/`: the task's input files (for a replayed session: the repository at the
  commit the user was on), exactly as the agent received them. Read-only.
- `context/harness/`: the CURRENT harness overlay (what earlier improvement installed; it
  may be empty). Edit these files IN PLACE. This is your output.
- `context/rollouts/<label>.md`: full trajectories of the agent under the current harness
  (every action, observation and error). They show BEHAVIOR, not correctness.
- `context/rollouts/original-session.md` (when present): the user's real, interactive
  session that this task was taken from, under the current harness. The user's follow-up
  messages there (corrections, "that's wrong", repeated asks) are the most direct evidence
  of what went wrong. The other rollouts are one-shot replays of the same requests.
- `context/deliverables/<label>.diff`: what those runs changed in the workspace.
- `context/library/`: what earlier improvement sessions learned (may be empty). Start with
  `INDEX.md`: one line per entry, grouped by domain, with its reuse history (how often later
  tasks reused it and how often that survived their probes). Each `<entry>/` has the
  harness adopted for that task and an `EXPERIENCE.md` with its situation, lessons and the
  rollout evidence behind them. See "Using the library" below.
- `context/installed/README.md`: the rest of the user's pi configuration. Your overlay is
  added on top of it (packages, tools, skills and settings you see there stay as they are).

There is no rubric, grading criteria, answer key, reference solution or score. Nobody will
tell you whether a run was right. Judge from the trajectories and the request.

## Using the library

The library is how this improvement process learns across tasks. Use it, but critically:
- Entries are finished examples to learn from. They are NOT part of the harness you are
  editing, and their files do not exist where the harness runs. To reuse a component,
  COPY it into `context/harness/` and adapt it; never refer to a library path.
- Re-verify an entry against the evidence in front of you. An earlier task's facts,
  mappings or thresholds are hypotheses here, not facts. Its lessons apply only if this
  task's rollouts show the same situation.
- An entry reused often that kept surviving later probes is stronger evidence than one
  never reused, or one whose reuse kept being dropped. That history is in `INDEX.md`.
- When you reuse or adapt anything from an entry, say so in your notes:
  `reused <entry> -> <component or lesson> -> <the rollout moment showing it applies here>`.

## How pi uses each part of the overlay (this is the whole editable surface)

- `APPEND_SYSTEM.md`: appended to pi's system prompt and sent with EVERY request. Keep it
  short (hard cap {alwaysOnMax} chars). No template braces.
- `skills/<name>/SKILL.md`: pi lists only the skill's `name` and `description` in the system
  prompt. The agent reads the full file with its `read` tool when it decides the skill fits.
  Frontmatter must have `name: <name>` (equal to the directory) and `description: ...`.
  Also add a trigger line in `APPEND_SYSTEM.md`: ``Use the `<name>` skill when ...``.
- `skills/<name>/scripts/<file>` (or `references/`, `assets/`): files bundled with the skill.
  In SKILL.md, refer to them by a path RELATIVE to the skill directory, e.g.
  `scripts/survey.py`. pi tells the agent where the skill lives and resolves relative paths
  against it; the agent then runs the script with its `bash` tool. Every file you reference
  must exist. Scripts need a shebang (`#!/usr/bin/env python3` or `#!/bin/sh`) and must
  only use the standard library. There is no harness variable of any kind.
- `extensions/<name>.ts`: a pi extension (TypeScript hooks). Only for an invariant the agent
  keeps ignoring despite guidance; it must never block valid completion.

## This overlay is INSTALLED into the user's pi for ALL future tasks

Write general rules, procedures and checks that help on any future task of this kind.
Do NOT name this workspace's files, functions, modules, columns or values in the harness;
the validator rejects them. Workspace-specific observations belong in your `<notes>`, not
in the harness. Ask yourself: would this line still be true and useful in a different repo?

KEEP_BASE (leaving `context/harness/` unchanged) is a valid and often correct answer.
Do NOT do the task yourself. Do not edit anything outside `context/harness/`.

End your final reply with a `<notes>` block. Write one line per change, naming the
trajectory moment that motivated it, plus a `reused <entry> -> ...` line for anything taken
from the library; or the single line `KEEP_BASE -> <why>`.
