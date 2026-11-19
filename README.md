# pi-autotune

Finish a task in pi, type `/learn`, and keep working. In the background, pi-autotune
replays that session, studies what went wrong, and works out a better **harness** for
your pi: the system-prompt additions, skills, bundled scripts and extensions around the
model. The model's weights stay frozen. When it's done it shows you the exact change and
the evidence for it, and asks once: **Apply these changes to your pi?**

It implements the method of *Harness²: recursive agent-harness optimization*
(arXiv:2610.14224), written from the paper, for pi.

```
/learn                       learn from this session in the background; asks before applying
/learn undo                  restore your pi as it was before the last apply
/learn stop                  cancel a running /learn
/learn model                 change the improved model or the improver
/learn <task-folder>...      learn from task folders instead (task.md + workspace/)
/learn ... --verify <dir>    also measure the result on held-out task folders with checks
```

The first `/learn` asks one thing, once: which model should study the runs (the
*improver*). It lists your own models first, and you can type to search. Progress shows
in a widget above the editor: the current step, a checklist of all steps, and the
latest event.

## Where the replay starts

When a session starts, pi-autotune quietly saves how the folder looked: the commit,
uncommitted changes and untracked files in a git repo, or a copy-on-write copy of a plain
folder (environment folders such as `.venv` and `node_modules` are skipped). `/learn`
replays your requests from exactly that state, in a throwaway copy.

For sessions that started before pi-autotune was installed, the starting state is
rebuilt: the last commit before the session in a git repo; otherwise, the files that
already existed when it started, with the session's own edits reversed. Anything that
can't be rebuilt exactly is listed when `/learn` starts. Sessions run in your home
directory are skipped, since there's no project folder to replay.

## What it does

For each task (the current session, or a task folder):

1. **Reference.** Your pi, exactly as configured, replays the task. The full transcript
   is kept, next to your original session. Your follow-up messages there ("that's
   wrong", "also do X") are the most direct evidence of what went wrong.
2. **Propose.** Two editors on the *improver* model each edit a copy of the overlay. The
   **invariant** editor works on *how the agent works* (procedure, tools, verification).
   The **domain** editor works on *what a practitioner knows* (contracts, traps,
   checkable rules). Keeping the harness unchanged is always a valid answer.
3. **Probe.** Your pi runs the same task again under each candidate.
4. **Compose.** A composer compares the candidates' transcripts with the reference.
   It keeps, revises or drops each edit, and every decision must cite a moment in the
   runs.
5. **Reflect and update the library.** Lessons supported by a contrast between runs go
   into a persistent library, which every later `/learn` builds on. See below.

Finally, a **consolidator** merges the library into **one** overlay that is general
enough to install for all future work. Nothing is installed until you approve it.

## How the improvement process itself improves

Harness² asks whether self-improvement can improve *both* the current harness *and how
future harnesses are improved*. The second half is the library: R_{t+1} = Update(R_t,
H*_t, D_t).

- **What it stores.** Each entry is the full harness adopted for one task plus its
  `EXPERIENCE.md`: domain, situation, lessons with the rollout evidence behind them,
  components, and what is unsupported. An index lists every entry by domain.
- **How it's used.** Every later editor, composer and consolidator reads the library.
  They reuse components selectively, copying and adapting them, and re-verify an earlier
  task's facts as hypotheses.
- **How it learns about itself.** This goes beyond the paper; its Appendix G lists these as
  next steps. Every reuse is recorded: was the entry cited, how much of the new harness came
  from it (the paper's provenance measure), and did that survive the new task's probes? The
  reflector then revises the reused entries with the new task's evidence (`confirmed`,
  `contradicted` or `refined`, with the rollout moment) and adjusts confidence. Entries the
  evidence contradicts or supersedes are retired; old versions and retired entries are
  archived, never deleted. The index shows each entry's track record, so later editors
  weigh entries by how they held up.
- **How you see it.** Every report has a section "How the improvement process learned":
  what was reused, what survived, what was revised or retired, and the library's size.
- **How it's measured.** With `--verify`, each held-out task is improved twice from the
  same reference run: once with the library, once with an empty one, the paper's
  w/o-library ablation. Both resulting harnesses are then run on that task, alternating,
  and compared with a permutation test. The library is frozen during the test, and
  held-out tasks never enter it.

**No score steers anything.** Nothing is graded during training. With `--verify`, the
held-out checks run only after the proposal is final, and only for the report.

## The parts of pi it edits

| File | How pi uses it |
|---|---|
| `APPEND_SYSTEM.md` (a marked block) | appended to the system prompt on every request (capped) |
| `skills/<name>/SKILL.md` | listed by name and description; the body is read only when relevant |
| `skills/<name>/scripts/…` | helper scripts bundled with that skill |
| `extensions/<name>.ts` | hooks, for rules the agent keeps ignoring |

A validator rejects:
- off-surface files and paths that won't exist on your machine;
- scripts whose interpreter you don't have, or that fail a syntax check;
- skills that collide with ones you already have;
- anything naming files or functions from the training workspaces, since the overlay is
  installed for all work.

Your own text in `APPEND_SYSTEM.md` is never touched. Only the block between
`<!-- pi-autotune:begin -->` and `<!-- pi-autotune:end -->` belongs to this tool. A later
A later `/learn` replaces that block, so changes don't stack.

## Safety

- **Your pi config is never written during a job.** Every run uses a copy-on-write copy
  of `~/.pi/agent` (without sessions; credentials are linked, not copied) with the
  candidate overlay on top. The report says whether the real config changed during the
  job.
- **Replays** run in a throwaway copy of the starting state (for a git repo, a clone with
  the remote removed). The replayed requests can still run commands and reach the
  network, as they did the first time.
- **The improver model reads** the requests, the code and the run transcripts. Pick a
  provider you're comfortable sending those to.
- **Apply** backs up every file it touches. `/learn undo` restores the backup.

## Concurrency

`/learn` never assumes your model server can take parallel requests: anything that looks
local gets **1** at a time, and cloud APIs get 4. The start message shows the limits in use;
change them in the config. The limit is enforced by a small local proxy that every pi
process it starts goes through. That covers the runs themselves, their subagents, and
nested pi. Time spent waiting in that queue is reported separately from run time.

Your own interactive pi session doesn't go through that proxy. If you keep using the same
local model while `/learn` runs, the two will share the GPU.

## Task folders (and `--verify`)

```
my-task/
  task.md       the request
  workspace/    the agent's starting files
  check         optional: run as `check <workspace>`; print {"passed": n, "total": m}
                as the last line, or exit 0 for pass
  task.json     optional: {"check": ["python3", "check.py"]} to run the grader another way
```

Everything outside `workspace/` and `task.md` is hidden from every model. A tripwire
refuses any model context that mentions those files.

With `--verify <dir>`:
- The held-out tasks are fingerprinted before training starts.
- Your current pi and the proposed pi run alternately, *n* times each (`--runs`, default 5).
- The report gives per-task means, perfect runs, permutation-test p-values, a pooled
  stratified test, run time, the extra tokens per request, and whether the overlay
  actually loaded.

## Configuration

`~/.pi/agent/pi-autotune/config.json`. Everything is optional and asked for when needed.

| Key | Default | |
|---|---|---|
| `worker` | your current model | the model being improved |
| `improver` | asked once | the model that edits the harness |
| `concurrency` | 1 for local servers, 4 for cloud APIs | max in-flight requests per provider, e.g. `{"vllm": 1, "openrouter": 4}` |
| `verifyRuns` | 5 | runs per arm for `--verify` |
| `workerTimeoutSec` / `editorTimeoutSec` | 900 / 1200 | per run |
| `alwaysOnMax` | 4000 | cap on always-on characters |

State lives in `~/.pi/agent/pi-autotune/`: the library, the ledger, reports, backups, and
what is currently installed. Run records go in `~/.cache/pi-autotune/`.

## Limits

- k = 1: one propose, probe and compose pass per task. The paper's wider and deeper modes
  aren't exposed yet.
- A replay sends all your requests from the session as one request, in order. It can't
  react the way you did in the moment, so the original session is kept as evidence too.
- Runs take longer with an overlay that makes the agent check its work. `--verify`
  reports that cost.
- The library ablation in `--verify` is expensive: per held-out task, two full improvement
  passes plus 2 × `--runs` evaluation runs.

## Development

```
npm install
npm test          # unit tests, no model calls
npm run typecheck
pi -e ./src/index.ts
```
