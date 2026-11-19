import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { configHash, makeEditorAgent, makeProbeAgent, type Route, routeModels, snapshot } from "./agentdir.ts";
import type { Config, Paths } from "./config.ts";
import { leakHits } from "./events.ts";
import { Library, provenance, retiredReason } from "./library.ts";
import { type PiResult, runPi } from "./pi.ts";
import type { Limiter } from "./proxy.ts";
import { checkScripts, skillNames, validate } from "./surface.ts";
import type { Score, Task } from "./tasks.ts";
import { readTree, type Tree, treeDiff, treesEqual, writeTree } from "./tree.ts";
import { mkdirp, readJson, rmrf, Semaphore, writeJson, writeText } from "./util.ts";

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const prompt = (name: string) => readFileSync(join(PROMPTS, `${name}.md`), "utf8");

const EDITOR_FLAGS = ["-na", "-nc", "--no-mcp", "-ne", "-ns", "-np"];

export interface RunMeta {
	label: string;
	task: string;
	model: string;
	rc: PiResult["rc"];
	secs: number;
	queueSecs: number;
	requests: number;
	cost: number;
	toolCalls: number;
	toolErrors: number;
	tools: Record<string, number>;
	firstInputTokens: number | null;
	outputTokens: number;
	modelErrors: string[];
	system: PiResult["system"];
	skillReads: number;
	skillScriptRuns: number;
	touched: string[];
	leaks: string[];
	final: string;
}

export interface EditResult {
	tree: Tree;
	notes: string;
	cost: number;
	validator: string[][];
	fellBack: boolean;
}

export interface UsedEntry {
	entry: string;
	cited: boolean;
	containment: number;
	kept: boolean;
}

export interface TaskSummary {
	task: string;
	title: string;
	adoptedChanged: boolean;
	adopted: Tree;
	notes: Record<string, string>;
	/** A new library entry was written. */
	library: boolean;
	/** Share of the adopted harness's new lines found in each library entry. */
	provenance: Record<string, number>;
	used: UsedEntry[];
	revised: string[];
	retired: string[];
	skipped?: string;
}

export interface TrainOpts {
	/** The library editors read; null = the paper's w/o-library ablation. */
	library: Library | null;
	/** Reflect and update the library afterwards. False freezes it (held-out measurement). */
	write: boolean;
	/** Label prefix that keeps an ablation arm's runs and edits apart. */
	arm?: string;
}

/** A library entry counts as reused when at least this share of a candidate came from it. */
export const REUSE_MIN = 0.2;

/** The steps of one /learn, in order, for progress display. */
export const STAGES = ["reference", "propose", "probe", "compose", "check", "reflect", "merge", "verify"] as const;
export type Stage = (typeof STAGES)[number];

export interface JobDeps {
	paths: Paths;
	config: Config;
	worker: string;
	improver: string;
	limiter: Limiter;
	routes: Route[];
	/** What was applied before: the part of the harness this job may replace. */
	owned: Tree;
	log: (line: string) => void;
	/** Progress: which step is running, with a short human detail. */
	stage?: (stage: Stage, detail: string) => void;
	signal: AbortSignal;
}

export class Job {
	readonly dir: string;
	readonly snap: string;
	private runSlots = new Map<string, Semaphore>();
	private forbidden = new Set<string>();
	private existingSkills = new Set<string>();
	editorCost = 0;
	workerCost = 0;

	readonly id: string;
	readonly d: JobDeps;
	constructor(id: string, d: JobDeps) {
		this.id = id;
		this.d = d;
		this.dir = join(d.paths.work, id);
		this.snap = join(this.dir, "_snapshot");
		this.lib = new Library(join(d.paths.state, "library"));
	}

	/** The persistent experience library R (shared by every /learn). */
	readonly lib: Library;

	async init(): Promise<void> {
		mkdirp(this.dir);
		await snapshot(this.d.paths.agentDir, this.snap, this.d.owned);
		for (const d of [join(this.snap, "skills"), join(homedir(), ".agents", "skills")])
			if (existsSync(d)) for (const n of readdirSync(d)) this.existingSkills.add(n);
		// Names from earlier jobs' training tasks stay forbidden in anything installed.
		for (const e of this.lib.entries()) for (const n of this.lib.names(e)) this.forbidden.add(n);
	}

	ledger(row: Record<string, unknown>): void {
		mkdirp(this.d.paths.state);
		appendFileSync(join(this.d.paths.state, "ledger.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), job: this.id, ...row })}\n`);
	}

	private slot(model: string): Semaphore {
		const prov = model.split("/")[0];
		let s = this.runSlots.get(prov);
		if (!s) {
			s = new Semaphore(Math.max(1, this.d.config.concurrency[prov] ?? 1));
			this.runSlots.set(prov, s);
		}
		return s;
	}

	private route(runId: string) {
		return (dir: string) => routeModels(dir, runId, this.d.limiter, this.d.routes);
	}

	private checkAbort(): void {
		if (this.d.signal.aborted) throw new Error("stopped");
	}

	// ------------------------------------------------------------ worker runs

	/** Run a task with the user's real pi + overlay. Idempotent by label within a job. */
	async execute(task: Task, overlay: Tree, label: string): Promise<RunMeta> {
		const rd = join(this.dir, "tasks", task.id, "runs", label);
		const metaPath = join(rd, "meta.json");
		if (existsSync(metaPath)) return readJson<RunMeta>(metaPath, null as unknown as RunMeta);
		this.checkAbort();
		return this.slot(this.d.worker).with(async () => {
			this.checkAbort();
			const wd = join(this.dir, "scratch", task.id, label);
			rmrf(wd);
			const wsRoot = join(wd, "workspace");
			const cwd = await task.prepareWorkspace(wsRoot);
			const runId = `${task.id}.${label}`;
			await makeProbeAgent(this.snap, join(wd, "agent"), this.d.paths.agentDir, overlay, this.route(runId));
			this.d.log(`[${task.id}] ${label}: running`);
			mkdirp(rd);
			const r = await runPi({
				agentDir: join(wd, "agent"),
				cwd,
				prompt: task.prompt,
				model: this.d.worker,
				eventsPath: join(rd, "events.jsonl"),
				timeoutSec: this.d.config.workerTimeoutSec,
				signal: this.d.signal,
				command: this.d.config.piCommand,
			});
			const q = this.d.limiter.stats(runId);
			writeText(join(rd, "trajectory.md"), r.trajectory);
			writeText(join(rd, "deliverable.diff"), await task.deliverable(wsRoot));
			writeJson(join(rd, "harness.json"), overlay);
			const sub = relative(wsRoot, cwd);
			const touched = r.touchedPaths
				.map((p) => (isAbsolute(p) ? (p.startsWith(wsRoot) ? relative(wsRoot, p) : null) : normalize(join(sub, p))))
				.filter((p): p is string => !!p && !p.startsWith(".."));
			const meta: RunMeta = {
				label,
				task: task.id,
				model: this.d.worker,
				rc: r.rc,
				secs: r.secs,
				queueSecs: Math.round(q.queueMs / 100) / 10,
				requests: q.requests,
				cost: r.cost,
				toolCalls: r.toolCalls,
				toolErrors: r.toolErrors,
				tools: r.tools,
				firstInputTokens: r.firstInputTokens,
				outputTokens: r.outputTokens,
				modelErrors: r.modelErrors,
				system: r.system,
				skillReads: r.skillReads,
				skillScriptRuns: r.skillScriptRuns,
				touched,
				leaks: leakHits(`${r.trajectory}\n${r.final}`, task.hiddenMarkers),
				final: r.final,
			};
			// Retrospective grade (only for task folders with a check). Stored apart from
			// everything that is ever copied into a model's context.
			if (task.check) {
				const g: Score | null = await task.check(wsRoot).catch(() => null);
				writeJson(join(this.dir, "grades", task.id, `${label}.json`), g);
			}
			writeJson(metaPath, meta);
			this.workerCost += r.cost;
			rmrf(wd);
			this.ledger({ stage: "run", task: task.id, label, rc: r.rc, secs: r.secs, queueSecs: meta.queueSecs, cost: r.cost });
			this.d.log(`[${task.id}] ${label}: rc=${r.rc} ${r.secs}s, ${r.toolCalls} tool calls${meta.queueSecs > 1 ? `, ${meta.queueSecs}s queued` : ""}`);
			return meta;
		});
	}

	grade(task: Task, label: string): Score | null {
		return readJson<Score | null>(join(this.dir, "grades", task.id, `${label}.json`), null);
	}

	private view(task: Task, label: string) {
		const rd = join(this.dir, "tasks", task.id, "runs", label);
		return {
			trajectory: readFileSync(join(rd, "trajectory.md"), "utf8"),
			deliverable: readFileSync(join(rd, "deliverable.diff"), "utf8"),
		};
	}

	// ------------------------------------------------------------ editors

	private installedContext(ctx: string): void {
		const settings = readJson<Record<string, unknown>>(join(this.snap, "settings.json"), {});
		const pk = (settings.packages as unknown[] | undefined) ?? [];
		const pkNames = pk.map((p) => (typeof p === "string" ? p : ((p as { source?: string }).source ?? JSON.stringify(p))));
		const lines = [
			"# The rest of the user's pi configuration (read-only; your overlay is added on top)",
			"",
			`- packages/extensions loaded: ${pkNames.join(", ") || "none"}`,
			`- defaultThinkingLevel: ${settings.defaultThinkingLevel ?? "default"}`,
			`- other skills already available: ${[...this.existingSkills].sort().join(", ") || "none"}`,
			`- the user's own APPEND_SYSTEM.md: ${existsSync(join(this.snap, "APPEND_SYSTEM.md")) ? "yes, copied here as APPEND_SYSTEM.md" : "none"}`,
			"",
			"The tools the agent actually had are visible in the rollouts' [ACTION] lines.",
		];
		writeText(join(ctx, "installed", "README.md"), `${lines.join("\n")}\n`);
		if (existsSync(join(this.snap, "APPEND_SYSTEM.md"))) cpSync(join(this.snap, "APPEND_SYSTEM.md"), join(ctx, "installed", "APPEND_SYSTEM.md"));
	}

	private assertNoLeak(root: string, markers: string[]): void {
		const walk = (d: string) => {
			for (const n of readdirSync(d)) {
				const p = join(d, n);
				if (statSync(p).isDirectory()) walk(p);
				else if (statSync(p).size < 5_000_000) {
					const hits = leakHits(readFileSync(p, "utf8"), markers);
					if (hits.length) throw new Error(`LEAK: grader material ${JSON.stringify(hits)} in model context: ${p}`);
				}
			}
		};
		walk(root);
	}

	private validateTree(tree: Tree): string[] {
		return validate(tree, { forbidden: this.forbidden, existingSkills: this.existingSkills, alwaysOnMax: this.d.config.alwaysOnMax });
	}

	/** One agentic editing session on the improver model, with one validator retry. */
	async editor(
		scopeDir: string,
		label: string,
		instructions: string,
		buildCtx: (ctx: string) => Promise<void>,
		start: Tree,
		markers: string[],
		checkNotes?: (notes: string, tree: Tree) => string[],
	): Promise<EditResult> {
		const od = join(this.dir, scopeDir, "edits", label);
		const resPath = join(od, "result.json");
		if (existsSync(resPath)) return readJson<EditResult>(resPath, null as unknown as EditResult);
		this.checkAbort();
		return this.slot(this.d.improver).with(async () => {
			const wd = join(this.dir, "scratch", scopeDir, `edit-${label}`);
			rmrf(wd);
			const ws = join(wd, "ws");
			const ctx = join(ws, "context");
			await buildCtx(ctx);
			mkdirp(join(ctx, "harness"));
			writeTree(start, join(ctx, "harness"));
			this.installedContext(ctx);
			this.assertNoLeak(ws, markers);
			const runId = `${scopeDir}.${label}`.replace(/\//g, ".");
			makeEditorAgent(join(wd, "agent"), this.d.paths.agentDir, this.d.improver, this.route(runId));
			const text = prompt("editor_common").replaceAll("{alwaysOnMax}", String(this.d.config.alwaysOnMax)) + "\n" + instructions;
			const go = (p: string, n: number) =>
				runPi({
					agentDir: join(wd, "agent"),
					cwd: ws,
					prompt: p,
					model: this.d.improver,
					eventsPath: join(od, `events${n}.jsonl`),
					timeoutSec: this.d.config.editorTimeoutSec,
					flags: EDITOR_FLAGS,
					signal: this.d.signal,
					command: this.d.config.piCommand,
				});
			mkdirp(od);
			this.d.log(`editor ${label}: working`);
			let r = await go(text, 1);
			let cost = r.cost;
			let notes = r.final;
			let traj = r.trajectory;
			let tree = readTree(join(ctx, "harness"));
			const notesOf = (t: string) => (/<notes>([\s\S]*?)<\/notes>/.exec(t)?.[1] ?? t).trim();
			const check = async () => [...this.validateTree(tree), ...(await checkScripts(tree)), ...(checkNotes?.(notesOf(notes), tree) ?? [])];
			let errs = await check();
			const attempts = [errs];
			if (errs.length) {
				this.d.log(`editor ${label}: validator rejected ${errs.length} issue(s); one retry`);
				const fix = `${text}\n\n## Your previous edit was REJECTED by the validator\n${errs.map((e) => `- ${e}`).join("\n")}\nYour edits are still in context/harness/. Fix them and reply again with <notes>.`;
				r = await go(fix, 2);
				cost += r.cost;
				notes = r.final;
				traj += `\n\n[RETRY]\n${r.trajectory}`;
				tree = readTree(join(ctx, "harness"));
				errs = await check();
				attempts.push(errs);
			}
			let fellBack = false;
			if (errs.length) {
				this.d.log(`editor ${label}: rejected twice; keeping its starting harness`);
				tree = start;
				notes = `FALLBACK (validator: ${errs.join("; ")})\n\n${notes}`;
				fellBack = true;
			}
			const res: EditResult = { tree, notes: notesOf(notes), cost, validator: attempts, fellBack };
			writeText(join(od, "trajectory.md"), traj);
			writeJson(resPath, res);
			this.editorCost += cost;
			rmrf(wd);
			this.ledger({ stage: "edit", scope: scopeDir, label, cost, rejected: attempts.map((a) => a.length), fellBack });
			this.d.log(`editor ${label}: done ($${cost.toFixed(4)})`);
			return res;
		});
	}

	private async baseContext(task: Task, ctx: string, refs: string[], lib: Library | null): Promise<void> {
		mkdirp(ctx);
		writeText(join(ctx, "task.md"), task.prompt);
		if (task.original) writeText(join(ctx, "rollouts", "original-session.md"), task.original);
		await task.sourceForEditors(join(ctx, "source"));
		for (const lab of refs) {
			const v = this.view(task, lab);
			writeText(join(ctx, "rollouts", `${lab}.md`), v.trajectory);
			writeText(join(ctx, "deliverables", `${lab}.diff`), v.deliverable);
		}
		// A task never sees its own entry (from an earlier /learn of the same session).
		if (lib) lib.exportTo(join(ctx, "library"), [task.id]);
		else writeText(join(ctx, "library", "INDEX.md"), "# Library index\n\n(empty)\n");
	}

	// ------------------------------------------------------------ task-level recursion (k = 1)

	/**
	 * One task through Propose → Probe → Compose, then (harnessing level) Reflect and Update.
	 * `opts.library` null is the paper's w/o-library ablation: editors see an empty library and
	 * nothing is written. `opts.write` false freezes the library (held-out measurement).
	 */
	async trainTask(task: Task, opts: TrainOpts = { library: this.lib, write: true }): Promise<TaskSummary> {
		const H = this.d.owned;
		const arm = opts.arm ?? "";
		const lib = opts.library;
		const scope = join("tasks", task.id, arm || "train");
		const st = (s: Stage, detail: string) => this.d.stage?.(s, detail);
		const base: TaskSummary = { task: task.id, title: task.title, adoptedChanged: false, adopted: H, notes: {}, library: false, provenance: {}, used: [], revised: [], retired: [] };
		st("reference", "replaying the task with your pi as it is");
		const ref = await this.execute(task, H, "ref1"); // shared by every arm: same harness, same task
		for (const s of ref.system.skills) if (!skillNames(H).includes(s)) this.existingSkills.add(s);
		const names = await task.names(ref.touched);
		for (const n of names) this.forbidden.add(n);
		if (ref.rc === "timeout" || ref.modelErrors.length || !ref.toolCalls) {
			this.d.log(`[${task.id}] reference run unusable (rc=${ref.rc}, ${ref.modelErrors.length} model errors); skipping`);
			return { ...base, skipped: "reference run unusable" };
		}
		const visible = (lib?.entries() ?? []).filter((x) => x !== task.id).length;
		st("propose", visible ? `two editors study the run and ${visible} library entr${visible === 1 ? "y" : "ies"}` : "two editors study the run and propose changes");
		const [inv, dom] = await Promise.all(
			(["inv", "dom"] as const).map((s) =>
				this.editor(scope, `${s}1`, prompt(`propose_${s}`), (c) => this.baseContext(task, c, ["ref1"], lib), H, task.hiddenMarkers),
			),
		);
		const cands: Array<{ id: string; r: EditResult; probe: string }> = [];
		for (const [id, r] of [["inv1", inv], ["dom1", dom]] as const) {
			if (treesEqual(r.tree, H)) continue; // KEEP_BASE
			const same = cands.find((c) => treesEqual(c.r.tree, r.tree));
			cands.push({ id, r, probe: same ? same.probe : `${arm}probe_${id}` }); // identical candidates share one probe
		}
		const notes: Record<string, string> = { inv1: inv.notes, dom1: dom.notes };
		if (!cands.length) {
			this.d.log(`[${task.id}] both editors kept the base harness; nothing to compose`);
			return { ...base, notes };
		}
		const probes = [...new Set(cands.map((c) => c.probe))];
		let probed = 0;
		const probeMsg = () => `testing ${probes.length} candidate${probes.length > 1 ? "s" : ""} (${probed}/${probes.length})`;
		st("probe", probeMsg());
		await Promise.all(
			probes.map((p) =>
				this.execute(task, cands.find((c) => c.probe === p)!.r.tree, p).then(() => {
					probed++;
					st("probe", probeMsg());
				}),
			),
		);
		st("compose", "keeping only the edits the runs support");
		const comp = await this.editor(
			scope,
			"compose1",
			prompt("compose").replaceAll("{j}", "1").replaceAll("{k}", "1"),
			async (ctx) => {
				await this.baseContext(task, ctx, ["ref1"], lib);
				for (const c of cands) {
					const pd = join(ctx, "pool", c.id);
					writeTree(c.r.tree, join(pd, "harness"));
					const v = this.view(task, c.probe);
					writeText(join(pd, "diff.patch"), treeDiff(H, c.r.tree) || "(identical to current harness)");
					writeText(join(pd, "notes.md"), c.r.notes);
					writeText(join(pd, "rollout.md"), v.trajectory);
					writeText(join(pd, "deliverable.diff"), v.deliverable);
				}
			},
			H,
			task.hiddenMarkers,
		);
		notes.compose1 = comp.notes;
		const adopted = comp.tree; // k = 1: the composed harness is adopted directly
		writeJson(join(this.dir, scope, "adopted.json"), adopted);

		// How the library took part: cited by name, material reused (provenance), and whether
		// that material survived probe + compose into the adopted harness.
		const entries = (lib?.entries() ?? []).filter((x) => x !== task.id);
		const provAdopted = lib && !treesEqual(adopted, H) ? provenance(adopted, H, lib, entries) : {};
		const provCands = cands.map((c) => (lib ? provenance(c.r.tree, H, lib, entries) : {}));
		const cited = lib ? lib.cited([inv.notes, dom.notes, comp.notes].join("\n")) : [];
		const keptLines = comp.notes.split("\n").filter((l) => /^[\s>*`-]*(kept|revised)\b/i.test(l)).join("\n");
		const citedKept = lib ? lib.cited(keptLines) : [];
		const used: UsedEntry[] = entries
			.map((e) => {
				const containment = Math.max(0, ...provCands.map((pc) => pc[e] ?? 0));
				return { entry: e, cited: cited.includes(e), containment, kept: !treesEqual(adopted, H) && ((provAdopted[e] ?? 0) >= REUSE_MIN || citedKept.includes(e)) };
			})
			.filter((u) => u.cited || u.containment >= REUSE_MIN);
		const summary: TaskSummary = { ...base, adoptedChanged: !treesEqual(adopted, H), adopted, notes, provenance: provAdopted, used };
		if (!opts.write) return summary; // frozen library: no reflection, no update

		const reuse = cands.find((c) => treesEqual(c.r.tree, adopted));
		const finalLabel = treesEqual(adopted, H) ? "ref1" : reuse ? reuse.probe : `${arm}final1`;
		if (finalLabel === `${arm}final1`) {
			st("check", "running the merged fix once, to see it work as a whole");
			await this.execute(task, adopted, finalLabel);
		}
		st("reflect", used.length ? `writing down lessons; re-checking ${used.length} reused entr${used.length === 1 ? "y" : "ies"}` : "writing down the lessons the runs support");
		const refl = await this.reflect(task, cands, comp.notes, adopted, finalLabel, lib, used);
		if (lib) {
			const at = new Date().toISOString();
			for (const u of used) lib.recordUse(u.entry, { job: this.id, task: task.id, at, cited: u.cited, containment: u.containment, kept: u.kept });
			for (const [e, text] of Object.entries(refl.revisions)) {
				const why = retiredReason(text);
				lib.revise(e, text, this.id, task.id, why ? `retired: ${why}` : "revised with this task's evidence");
				summary.revised.push(e);
				if (why) {
					lib.retire(e, why);
					summary.retired.push(e);
				}
			}
			if (refl.experience) {
				lib.add(task.id, adopted, refl.experience, names, this.id, task.id);
				summary.library = true;
			}
			lib.writeIndex();
			this.ledger({ stage: "library", task: task.id, used: used.map((u) => u.entry), revised: summary.revised, retired: summary.retired, added: summary.library });
		}
		return summary;
	}

	private async reflect(
		task: Task,
		cands: Array<{ id: string; r: EditResult; probe: string }>,
		composeNotes: string,
		adopted: Tree,
		finalLabel: string,
		lib: Library | null,
		used: UsedEntry[],
	): Promise<{ experience: string | null; revisions: Record<string, string> }> {
		const od = join(this.dir, "tasks", task.id, "edits", "reflect");
		const resPath = join(od, "result.json");
		if (existsSync(resPath)) return readJson(resPath, { experience: null, revisions: {} });
		const H = this.d.owned;
		return this.slot(this.d.improver).with(async () => {
			const wd = join(this.dir, "scratch", task.id, "reflect");
			rmrf(wd);
			const ws = join(wd, "ws");
			const rec = join(ws, "context", "record");
			writeText(join(rec, "task.md"), task.prompt);
			if (task.original) writeText(join(rec, "reference", "original-session.md"), task.original);
			const ref = this.view(task, "ref1");
			writeText(join(rec, "reference", "ref1.rollout.md"), ref.trajectory);
			writeText(join(rec, "reference", "ref1.deliverable.diff"), ref.deliverable);
			for (const c of cands) {
				const v = this.view(task, c.probe);
				const cd = join(rec, "candidates", c.id);
				writeTree(c.r.tree, join(cd, "harness"));
				writeText(join(cd, "diff.patch"), treeDiff(H, c.r.tree) || "(no change)");
				writeText(join(cd, "notes.md"), c.r.notes);
				writeText(join(cd, "rollout.md"), v.trajectory);
				writeText(join(cd, "deliverable.diff"), v.deliverable);
			}
			writeText(join(rec, "compose", "compose1.notes.md"), composeNotes);
			const fin = this.view(task, finalLabel);
			writeTree(adopted, join(rec, "adopted", "harness"));
			writeText(join(rec, "adopted", "diff.patch"), treeDiff(H, adopted) || "(no change: the starting harness was kept)");
			writeText(join(rec, "adopted", "rollout.md"), fin.trajectory);
			writeText(join(rec, "adopted", "deliverable.diff"), fin.deliverable);
			writeText(join(ws, "context", "library", "INDEX.md"), lib ? lib.indexText([task.id]) : "# Library index\n\n(empty)\n");
			// Entries this task reused: editable copies the reflector may revise or retire.
			const before: Record<string, string> = {};
			for (const u of used) {
				const d = join(ws, "context", "library_used", u.entry);
				before[u.entry] = lib!.experience(u.entry);
				writeText(join(d, "EXPERIENCE.md"), before[u.entry]);
				writeTree(lib!.harness(u.entry), join(d, "harness"));
				writeJson(join(d, "this_task_use.json"), {
					cited_by_an_editor: u.cited,
					share_of_a_candidate_taken_from_it: u.containment,
					survived_into_adopted_harness: u.kept,
					history: lib!.stats(u.entry).uses,
				});
			}
			this.assertNoLeak(ws, task.hiddenMarkers);
			makeEditorAgent(join(wd, "agent"), this.d.paths.agentDir, this.d.improver, this.route(`${task.id}.reflect`));
			mkdirp(od);
			this.d.log(`[${task.id}] reflector: working`);
			const r = await runPi({
				agentDir: join(wd, "agent"),
				cwd: ws,
				prompt: prompt("reflect"),
				model: this.d.improver,
				eventsPath: join(od, "events.jsonl"),
				timeoutSec: this.d.config.editorTimeoutSec,
				flags: EDITOR_FLAGS,
				signal: this.d.signal,
				command: this.d.config.piCommand,
			});
			const f = join(ws, "EXPERIENCE.md");
			const experience = existsSync(f) && readFileSync(f, "utf8").trim() ? readFileSync(f, "utf8") : null;
			const revisions: Record<string, string> = {};
			for (const u of used) {
				const p = join(ws, "context", "library_used", u.entry, "EXPERIENCE.md");
				const text = existsSync(p) ? readFileSync(p, "utf8") : "";
				// A revision must still be an experience note (or a retirement), not a wipe.
				if (text.trim() && text !== before[u.entry] && (/^##\s*Lessons/im.test(text) || retiredReason(text))) revisions[u.entry] = text;
			}
			writeText(join(od, "trajectory.md"), r.trajectory);
			writeJson(resPath, { experience, revisions, cost: r.cost, final: r.final });
			this.editorCost += r.cost;
			rmrf(wd);
			this.ledger({ stage: "reflect", task: task.id, cost: r.cost, experience: !!experience, revised: Object.keys(revisions) });
			this.d.log(`[${task.id}] reflector: ${experience ? "new entry" : "no new entry"}${Object.keys(revisions).length ? `, revised ${Object.keys(revisions).length}` : ""}`);
			return { experience, revisions };
		});
	}

	// ------------------------------------------------------------ one installable overlay

	async consolidate(): Promise<EditResult> {
		this.d.stage?.("merge", "merging the lessons into one change for your pi");
		const entries = this.lib.entries();
		if (!entries.length) {
			return { tree: this.d.owned, notes: "KEEP_BASE -> the library has no supported lessons yet", cost: 0, validator: [], fellBack: false };
		}
		return this.editor(
			"consolidate",
			"consolidate",
			prompt("consolidate"),
			async (ctx) => {
				mkdirp(ctx);
				this.lib.exportTo(join(ctx, "library"));
			},
			this.d.owned,
			[],
			(notes, tree) => (treesEqual(tree, this.d.owned) ? [] : checkConsolidateNotes(notes, entries)),
		);
	}

	/** Changed files in the real config since `before` (sessions and our own state excluded). */
	configChanges(before: Record<string, string>): string[] {
		const after = configHash(this.d.paths.agentDir);
		return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
	}
}

const VERBS = new Set(["kept", "merged", "generalized", "dropped"]);
const HEDGE = /\b(plausible|untested|unsupported|unverified|speculative|without (?:a |any )?(?:rollout )?contrast|no (?:rollout )?contrast|not (?:yet )?(?:tested|exercised|observed))\b/i;

/**
 * Evidence gate for the consolidator: every component that survives must cite the library
 * entry whose rollout contrast supports it, and must not be hedged as unsupported.
 */
export function checkConsolidateNotes(notes: string, entries: string[]): string[] {
	const errs: string[] = [];
	const lines = notes.split("\n").map((l) => l.replace(/^[\s>*`-]+/, "").trim()).filter((l) => /^[A-Za-z_]+\s*->/.test(l));
	if (!lines.length) return ["<notes> has no decision lines (`kept|merged|generalized|dropped -> <component> -> <evidence>`)"];
	for (const l of lines) {
		const verb = l.split(/\s*->/)[0].toLowerCase();
		if (verb === "keep_base") continue;
		if (!VERBS.has(verb)) {
			errs.push(`notes: unknown decision \`${verb}\` in "${l.slice(0, 120)}"; use kept, merged, generalized or dropped`);
			continue;
		}
		if (verb === "dropped") continue;
		if (!entries.some((e) => l.includes(e)))
			errs.push(`notes: "${l.slice(0, 120)}" cites no library entry (${entries.join(", ")}); drop the component or cite the entry whose rollout contrast supports it`);
		const h = HEDGE.exec(l);
		if (h) errs.push(`notes: "${l.slice(0, 120)}" keeps a component described as "${h[0]}"; unsupported components must be dropped`);
	}
	return errs;
}
