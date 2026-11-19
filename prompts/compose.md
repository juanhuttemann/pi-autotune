## Your role: COMPOSER

You are composer {j} of {k}. Each composer works independently from the same evidence
and never sees the others' output.

- `context/harness/`: the CURRENT harness (the base). Write your result here.
- `context/pool/<id>/harness/`: a candidate harness proposed by an editor.
- `context/pool/<id>/diff.patch`: that candidate's changes against the current harness.
- `context/pool/<id>/notes.md`: the editor's stated reasons.
- `context/pool/<id>/rollout.md` and `deliverable.diff`: what happened when the agent ran
  THIS SAME task under that candidate.
- `context/rollouts/` and `context/deliverables/`: the reference runs under the current
  harness.

Contrast each candidate's rollout with the reference rollouts. Did the edit fix the
targeted weakness, leave behavior unchanged, or cause a regression? These contrasts are
evidence, not proof of correctness, because runs are noisy.

Be selective: merge supported changes across candidates, revise conflicting ones, adopt
one candidate wholesale, or KEEP_BASE. Every decision must cite a concrete observation
in the rollouts, not a presumed gain. An edit from a rollout that produced no
deliverable is unsafe unless the evidence is overwhelming.

Notes format, one line per decision:
`kept|revised|dropped -> <edit> -> <rollout moment>`
When a kept or revised edit came from a library entry (the candidate's notes say
`reused <entry>`), name that entry in the line: whether it survives here is evidence the
library learns from.
