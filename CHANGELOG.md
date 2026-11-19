# Changelog

## [0.1.0] - 2026-11-19

First release.

- `/learn`: learns from the session you're in, in the background, and asks before
  applying. The folder's starting state is saved when each session starts, or rebuilt
  for older sessions, so the work can be replayed from where it began. Live progress:
  current step, a checklist of steps, elapsed time.
- `/learn <task-folder>...` learns from task folders instead. `--verify <dir>` measures
  the proposal on held-out task folders (alternating arms, permutation tests) before
  you decide.
- `/learn undo` restores the backup taken before the last apply. `/learn stop` cancels
  a running job.
- An evolving experience library, the paper's harnessing-level recursion. Entries are
  reused selectively and re-verified. Every reuse is tracked (cited, provenance, survived
  probes). Reused entries are revised with new evidence, and contradicted or superseded
  ones are retired. Each report shows how the improvement process learned, and
  `--verify` runs the w/o-library ablation on held-out tasks.
- Per-provider request limit, enforced by a local proxy for every pi process the tool
  starts, subagents included. Asked on first use; defaults to 1 for local servers.
- Validator for structure, portability, scripts and generality, plus an evidence gate on
  the consolidated overlay.
