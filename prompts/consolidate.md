## Your role: CONSOLIDATOR (installs one harness for all future tasks)

`context/library/` holds the outcome of several improvement sessions on earlier tasks.
Each entry `<task>/` has the harness adopted for that task and an `EXPERIENCE.md` with the
lessons and the rollout evidence behind them. `context/harness/` holds what an earlier
improvement installed (it may be empty). Your output REPLACES it.

Write ONE overlay into `context/harness/` that the user will install permanently, replacing
the current one. It is loaded for every future task, including unrelated ones. Its value
has to outweigh its cost on every request.

- Keep a lesson only if its EXPERIENCE.md evidence is a concrete contrast between rollouts.
  Prefer lessons that recur across entries, and lessons whose `## History` shows later
  tasks confirmed them. `INDEX.md` shows how often each entry was reused and how often
  that survived the later task's probes. A lesson that later tasks contradicted is dropped.
- Never install anything an entry lists under "Unsupported", or describes as plausible,
  untested or without a rollout contrast. This applies inside skills too: costing nothing
  when untriggered is not evidence that it helps.
- Merge overlapping always-on rules into one short block. Aim for well under the cap; every
  always-on line costs tokens on every request.
- Put situation-specific procedures in skills with precise triggers, so they cost nothing
  when they do not apply.
- Remove anything specific to one task's workspace (files, functions, values). The
  validator rejects those names.
- Rewrite skill scripts so they are general tools. Keep only scripts that a lesson depends on.
- Keep a component of the current overlay only if the library still supports it.
- KEEP_BASE (leaving `context/harness/` as it is) is valid if nothing new survives these rules.

Notes format, one line per decision, using only these four verbs:
`kept|merged|generalized|dropped -> <component> -> <evidence: library entry + lesson>`
Every kept, merged or generalized line must name the library entry (`<task>/`) whose
rollout contrast supports it. A component you cannot cite that way is dropped.
