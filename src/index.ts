import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { configHash } from "./agentdir.ts";
import { type Args, parseArgs, USAGE } from "./args.ts";
import { type Config, loadConfig, loadInstalled, paths, saveConfig } from "./config.ts";
import { Job, STAGES, type TaskSummary } from "./engine.ts";
import { install, undo } from "./install.ts";
import { familiarModels, searchModels } from "./pick.ts";
import { type PickerState, rankModels, renderPicker } from "./picker.ts";
import { CHILD_ENV } from "./pi.ts";
import { Library } from "./library.ts";
import { Limiter, looksLocal } from "./proxy.ts";
import { captureStart, loadSnap, reconstructStart } from "./snapshot.ts";
import { learnTask, loadFolderTasks, readSession, type Task } from "./tasks.ts";
import { type Tree, treeDiff, treesEqual } from "./tree.ts";
import { rmrf, stamp, writeText } from "./util.ts";
import { clock, type Progress, renderProgress } from "./widget.ts";
import { type AblationResult, ablateLibrary, ablationTable, type VerifyResult, verify, verifyTable } from "./verify.ts";

export default function (pi: ExtensionAPI) {
	// Inside the pi processes /learn starts (probes, editors) this extension does nothing.
	if (process.env[CHILD_ENV]) return;

	let ui: ExtensionContext | undefined; // the newest context; old ones go stale on session switch
	let running: { job: string; abort: AbortController } | undefined;
	let snapping: Promise<unknown> | undefined;
	const log: string[] = [];
	const prog: Progress = { task: "", taskNo: 0, tasks: 0, steps: [], stage: "", detail: "", started: 0, stageStarted: 0, state: "running" };
	let ticker: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", (_e, ctx) => {
		ui = ctx;
		if (running) mountWidget();
		// Remember how the folder looked before this session touched it, so /learn can
		// replay the work from the same starting point.
		const sm = ctx.sessionManager;
		const fresh = !sm.getEntries().some((e) => e.type === "message");
		const id = sm.getSessionId();
		if (fresh && id && sm.getSessionFile()) {
			snapping = captureStart(paths(getAgentDir()).work, id, ctx.cwd).catch(() => undefined);
		}
	});
	pi.on("before_agent_start", async () => {
		// The first request must not change files before the starting state is saved.
		if (snapping) await Promise.race([snapping, new Promise((r) => setTimeout(r, 30_000))]);
		snapping = undefined;
	});

	/**
	 * In the terminal UI the widget is a live component: it reads `prog` on every frame and
	 * animates itself (spinner, shimmering bar) only while a job runs. Other modes get the
	 * same lines as plain text.
	 */
	const mountWidget = () => {
		try {
			if (!ui) return;
			if (ui.mode === "tui") {
				ui.ui.setWidget("learn", (tui, theme) => {
					let frame = 0;
					const paint = (c: string, t: string) => {
						try {
							return theme.fg(c as never, t);
						} catch {
							return t;
						}
					};
					const timer = setInterval(() => {
						frame++;
						if (prog.state === "running" || frame % 12 === 0) tui.requestRender();
					}, 80);
					timer.unref?.();
					return {
						render: (width: number) => renderProgress(prog, width, frame, Date.now(), paint),
						invalidate() {},
						dispose() {
							clearInterval(timer);
						},
					};
				});
			} else ui.ui.setWidget("learn", renderProgress(prog, 100, 0, Date.now()));
		} catch {
			/* stale context during a session switch */
		}
	};
	const unmountWidget = () => {
		try {
			ui?.ui.setWidget("learn", undefined);
			ui?.ui.setStatus("learn", undefined);
		} catch {
			/* stale */
		}
	};
	/** Footer status (once a second) and, outside the TUI, the text widget. */
	const show = () => {
		try {
			if (!running) return;
			ui?.ui.setStatus("learn", `learn ${clock(Date.now() - prog.started)} · /learn stop`);
			if (ui && ui.mode !== "tui") ui.ui.setWidget("learn", renderProgress(prog, 100, 0, Date.now()));
		} catch {
			/* stale */
		}
	};
	const say = (msg: string, level: "info" | "warning" | "error" = "info") => {
		try {
			ui?.ui.notify(msg, level);
		} catch {
			/* stale */
		}
	};

	pi.registerCommand("learn", {
		description: "Learn from this session in the background and propose a better pi harness (asks before applying)",
		getArgumentCompletions: (prefix) => {
			const items = ["undo", "stop", "model", "help", "--verify"].filter((x) => x.startsWith(prefix));
			return items.length ? items.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (raw, ctx) => {
			ui = ctx;
			if (!ctx.hasUI) {
				console.error("/learn needs the interactive UI");
				return;
			}
			let args: Args;
			try {
				args = parseArgs(raw);
			} catch (e) {
				ctx.ui.notify(String((e as Error).message), "error");
				return;
			}
			const p = paths(getAgentDir());
			if (args.sub === "help") return void ctx.ui.notify(USAGE, "info");
			if (args.sub === "stop") {
				if (!running) return void ctx.ui.notify("Nothing is running.", "info");
				running.abort.abort();
				return void ctx.ui.notify("Stopping after the current step…", "info");
			}
			if (args.sub === "undo") {
				if (running) return void ctx.ui.notify('Learning is still running. Stop it first with "/learn stop".', "info");
				const ok = await ctx.ui.confirm("Undo the last applied change?", "Your pi files are restored from the backup taken before it was applied.");
				if (ok) ctx.ui.notify(`${undo(p)} Run /reload to load it.`, "info");
				return;
			}
			if (args.sub === "model") {
				const config = loadConfig(p);
				const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "?";
				const improvedNow = config.worker ?? `session model (${sessionModel})`;
				const IMPROVED = `Improved: ${improvedNow}`;
				const role = await ctx.ui.select("Change which model?", [IMPROVED, `Improver: ${config.improver ?? "not set"}`]);
				if (!role) return;
				const later = running ? " (from the next run)" : "";
				if (role === IMPROVED) {
					const pick = await pickModel(ctx, p.agentDir, "Model to improve", config.worker ?? AUTO, true);
					if (!pick) return;
					if (pick === AUTO) delete config.worker;
					else config.worker = pick;
					saveConfig(p, config);
					return void ctx.ui.notify(`Improved model: ${pick === AUTO ? "session model (whichever model the session used)" : pick}${later}.`, "info");
				}
				const pick = await pickModel(ctx, p.agentDir, "Improver model", config.improver);
				if (!pick) return;
				config.improver = pick;
				saveConfig(p, config);
				return void ctx.ui.notify(`Improver: ${pick}${later}.`, "info");
			}
			if (running) return void ctx.ui.notify('Already learning in the background.\nTo cancel: "/learn stop"', "info");

			// ---------------------------------------------------------------- what to learn from
			let tasks: Task[];
			let notes: string[] = [];
			let sessionModel: string | null = null;
			try {
				if (args.folders.length) tasks = loadFolderTasks(args.folders);
				else {
					const file = ctx.sessionManager.getSessionFile();
					if (!file) return void ctx.ui.notify("This session isn't saved (--no-session), so there is nothing to learn from.", "warning");
					const rec = readSession(file);
					if (!rec.prompts.length) return void ctx.ui.notify("Nothing to learn yet: give pi a task first, then /learn.", "info");
					const snap = loadSnap(p.work, rec.id) ?? (await reconstructStart(p.work, rec.id, rec.cwd, rec.started, rec.edits, rec.writes));
					notes = snap.notes;
					sessionModel = rec.model;
					tasks = [learnTask(rec, snap, p.work)];
				}
			} catch (e) {
				return void ctx.ui.notify(`Can't learn from this session: ${(e as Error).message}`, "warning");
			}
			let verifyTasks: Task[] = [];
			if (args.verify) {
				try {
					verifyTasks = loadFolderTasks([args.verify]);
				} catch (e) {
					return void ctx.ui.notify(String((e as Error).message), "error");
				}
				const noCheck = verifyTasks.filter((t) => !t.check).map((t) => t.id);
				if (noCheck.length) return void ctx.ui.notify(`--verify tasks need a check: ${noCheck.join(", ")}`, "error");
				const clash = verifyTasks.filter((v) => tasks.some((t) => t.fingerprint() === v.fingerprint())).map((t) => t.id);
				if (clash.length) return void ctx.ui.notify(`--verify tasks must be held out from training: ${clash.join(", ")}`, "error");
			}

			// ---------------------------------------------------------------- one-time setup
			const config = loadConfig(p);
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const worker = config.worker ?? sessionModel ?? current;
			if (!worker) return void ctx.ui.notify("No model selected. Pick one with /model first.", "error");
			if (!config.improver) {
				const pick = await pickModel(ctx, p.agentDir, `Improver model (studies the runs of ${worker})`);
				if (!pick) return;
				config.improver = pick;
			}
			const improver = config.improver;
			const routes: Array<{ provider: string; baseUrl: string }> = [];
			for (const m of [worker, improver]) {
				const [prov, ...rest] = m.split("/");
				const model = ctx.modelRegistry.find(prov, rest.join("/"));
				if (!model) return void ctx.ui.notify(`Model ${m} is not available. Check /model, or edit ${join(p.state, "config.json")}.`, "error");
				if (model.baseUrl && !routes.some((r) => r.provider === prov)) routes.push({ provider: prov, baseUrl: model.baseUrl });
				// Never assume a server can take parallel requests: local ones get 1. Cloud APIs
				// get 4. Both are shown when /learn starts and can be changed in the config.
				if (config.concurrency[prov] === undefined) config.concurrency[prov] = !model.baseUrl || looksLocal(model.baseUrl) ? 1 : 4;
			}
			saveConfig(p, config);

			// ---------------------------------------------------------------- go (background)
			const runs = args.runs ?? config.verifyRuns;
			// Learning: per task 1 replay + up to 2 candidates + 1 check. Verifying: current vs proposed
			// (2 × runs per task), plus, once the library has entries, the library test (two
			// improvement passes of up to 6 runs, sharing one replay, then 2 × runs).
			const libEntries = new Library(join(p.state, "library")).entries().length;
			const workerRuns = tasks.length * 4 + verifyTasks.length * (runs * 2 + (libEntries ? 7 + runs * 2 : 0));
			const jobId = `job-${stamp()}`;
			const abort = new AbortController();
			running = { job: jobId, abort };
			log.length = 0;
			ctx.ui.notify(
				[
					verifyTasks.length
						? `Learning in the background: up to ${workerRuns} runs of ${worker} (${tasks.length * 4} to learn, ${workerRuns - tasks.length * 4} to verify), studied by ${improver}.`
						: `Learning in the background: up to ${workerRuns} runs of ${worker} (1 replay of your task, up to 2 candidate fixes, 1 check of the merged fix)${tasks.length > 1 ? ` per task × ${tasks.length}` : ""}, studied by ${improver}.`,
					`Requests at once: ${Object.entries(config.concurrency).map(([k, v]) => `${k} ${v}`).join(", ")} (change in ${join(p.state, "config.json")}).`,
					"Keep working. Nothing in your pi changes until you say yes at the end.",
					'To cancel: "/learn stop"',
					...notes.map((n) => `Note: ${n}`),
				].join("\n"),
				"info",
			);
			const frozen = Object.fromEntries(verifyTasks.map((t) => [t.id, t.fingerprint()]));
			void runJob({ jobId, p, config, worker, improver, routes, tasks, verifyTasks, runs, frozen, abort }).finally(() => {
				running = undefined;
				unmountWidget();
			});
		},
	});

	async function runJob(o: {
		jobId: string;
		p: ReturnType<typeof paths>;
		config: Config;
		worker: string;
		improver: string;
		routes: Array<{ provider: string; baseUrl: string }>;
		tasks: Task[];
		verifyTasks: Task[];
		runs: number;
		frozen: Record<string, string>;
		abort: AbortController;
	}): Promise<void> {
		const limiter = new Limiter((prov) => o.config.concurrency[prov] ?? 1);
		const owned: Tree = loadInstalled(o.p)?.overlay ?? {};
		const job = new Job(o.jobId, {
			paths: o.p,
			config: o.config,
			worker: o.worker,
			improver: o.improver,
			limiter,
			routes: o.routes,
			owned,
			signal: o.abort.signal,
			log: (line) => {
				log.push(`  ${line}`);
				show();
			},
			stage: (s, detail) => {
				if (s !== prog.stage) prog.stageStarted = Date.now();
				prog.stage = s;
				prog.detail = detail;
				show();
			},
		});
		const before = configHash(o.p.agentDir);
		Object.assign(prog, {
			task: "",
			taskNo: 0,
			tasks: o.tasks.length,
			steps: STAGES.filter((st) => st !== "verify" || o.verifyTasks.length > 0),
			stage: "",
			detail: "",
			started: Date.now(),
			stageStarted: Date.now(),
			state: "running",
		});
		mountWidget();
		ticker = setInterval(() => show(), 1000);
		ticker.unref?.();
		try {
			await limiter.start();
			show();
			await job.init();
			const summaries: TaskSummary[] = [];
			for (const [i, t] of o.tasks.entries()) {
				Object.assign(prog, { task: t.id.replace(/-[0-9a-f]{8}$/i, ""), taskNo: i + 1 });
				show();
				try {
					summaries.push(await job.trainTask(t));
				} catch (e) {
					if (o.abort.signal.aborted) throw e;
					job.ledger({ stage: "task-error", task: t.id, error: String(e) });
					summaries.push({ task: t.id, title: t.title, adoptedChanged: false, adopted: owned, notes: {}, library: false, provenance: {}, used: [], revised: [], retired: [], skipped: String((e as Error).message) });
				}
			}
			const cons = await job.consolidate();
			const proposed = cons.tree;
			let ver: VerifyResult | undefined;
			if (o.verifyTasks.length && !treesEqual(proposed, owned)) {
				ver = await verify(job, o.verifyTasks, o.runs, owned, proposed, o.frozen, (d, n) => {
					prog.stage = "verify";
					prog.detail = `held-out check, run ${d}/${n}`;
					show();
				});
			}
			let abl: AblationResult | undefined;
			if (o.verifyTasks.length && job.lib.entries().length) {
				abl = await ablateLibrary(job, o.verifyTasks, o.runs, job.lib, o.frozen, (detail) => {
					prog.stage = "verify";
					prog.detail = detail;
					show();
				});
			}
			const changed = job.configChanges(before);
			const report = buildReport(o, job, summaries, owned, proposed, cons.notes, ver, abl, changed);
			const reportPath = join(o.p.state, "reports", `${o.jobId}.md`);
			writeText(reportPath, report);
			pi.sendMessage({ customType: "pi-autotune-report", content: report, display: true, details: { reportPath } });
			if (treesEqual(proposed, owned)) {
				say("/learn finished: no change is supported by the evidence, so there is nothing to apply.");
				return;
			}
			prog.state = "waiting";
			prog.detail = "ready: read the report above and answer below";
			show();
			const yes = await ui?.ui.confirm(
				"Apply these changes to your pi?",
				// Two short lines: a long body pushes the Yes/No choices off-screen.
				`${countChanges(owned, proposed)}. The diff and the evidence are in the report above.\nA backup is kept: "/learn undo" restores it.`,
			);
			if (yes) {
				install(o.p, proposed, o.jobId);
				say("Applied. Run /reload (or start a new session) to load it. /learn undo reverts.");
			} else say("Not applied. The proposal stays in the report.");
		} catch (e) {
			say(o.abort.signal.aborted ? "/learn stopped. Nothing in your pi was changed." : `/learn failed: ${(e as Error).message}`, o.abort.signal.aborted ? "info" : "error");
			job.ledger({ stage: "job-error", error: String(e) });
		} finally {
			if (ticker) clearInterval(ticker);
			ticker = undefined;
			await limiter.stop();
			rmrf(join(job.dir, "scratch"));
		}
	}
}

/** Harnessing-level recursion, made visible: what the library contributed and how it changed. */
function learningLines(job: Job, summaries: TaskSummary[]): string[] {
	const lines: string[] = [];
	for (const s of summaries) {
		if (s.skipped) continue;
		const used = s.used.length
			? s.used
					.map((u) => `\`${u.entry}\` (${u.cited ? "cited" : "not cited"}, ${Math.round(u.containment * 100)}% of a candidate taken from it, ${u.kept ? "survived the probes" : "did not survive"})`)
					.join("; ")
			: "none";
		lines.push(`- **${s.task}**: reused from the library: ${used}.`);
		if (s.revised.length) lines.push(`  Revised with this task's evidence: ${s.revised.map((e) => `\`${e}\``).join(", ")}.`);
		if (s.retired.length) lines.push(`  Retired (contradicted or superseded): ${s.retired.map((e) => `\`${e}\``).join(", ")}.`);
		lines.push(`  ${s.library ? "Added its own entry to the library." : "Added no entry (no lesson the runs support)."}`);
	}
	const entries = job.lib.entries();
	const reusedEver = entries.filter((e) => job.lib.stats(e).uses.length).length;
	lines.push("", `Library now: ${entries.length} active entr${entries.length === 1 ? "y" : "ies"}, ${reusedEver} of them reused by a later task at least once.`);
	return lines;
}

function countChanges(a: Tree, b: Tree): string {
	let add = 0;
	let change = 0;
	let remove = 0;
	for (const rel of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (a[rel] === b[rel]) continue;
		if (a[rel] === undefined) add++;
		else if (b[rel] === undefined) remove++;
		else change++;
	}
	const parts = [change && `${change} changed`, add && `${add} added`, remove && `${remove} removed`].filter(Boolean);
	return `${add + change + remove} file${add + change + remove === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

function summarize(a: Tree, b: Tree): string {
	const lines: string[] = [];
	for (const rel of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
		if (a[rel] === b[rel]) continue;
		lines.push(`${a[rel] === undefined ? "+ add   " : b[rel] === undefined ? "- remove" : "~ change"} ${rel}`);
	}
	return lines.join("\n");
}

function buildReport(
	o: { jobId: string; worker: string; improver: string; tasks: Task[]; verifyTasks: Task[]; runs: number },
	job: Job,
	summaries: TaskSummary[],
	owned: Tree,
	proposed: Tree,
	notes: string,
	ver: VerifyResult | undefined,
	abl: AblationResult | undefined,
	changed: string[],
): string {
	const out = [
		`# /learn report (${o.jobId})`,
		"",
		`Worker (improved): \`${o.worker}\` · Improver: \`${o.improver}\` · Tasks: ${o.tasks.length}`,
		"",
		"## What happened per task",
		"",
		...summaries.map(
			(s) =>
				`- **${s.task}**: ${s.skipped ? `skipped (${s.skipped})` : `${s.adoptedChanged ? "harness changed" : "kept the harness"}; ${s.library ? "lesson saved to the library" : "no supported lesson"}`}  \n  ${s.title}`,
		),
		"",
		"## How the improvement process learned",
		"",
		...learningLines(job, summaries),
		"",
		"## Proposed change to your pi",
		"",
		treesEqual(owned, proposed) ? "_None._" : `\`\`\`\n${summarize(owned, proposed)}\n\`\`\`\n\n\`\`\`diff\n${treeDiff(owned, proposed)}\`\`\``,
		"",
		"## Why (consolidator notes)",
		"",
		notes || "_none_",
		"",
	];
	if (ver) {
		out.push(
			`## Held-out check (${o.runs} runs per arm, tasks the improver never saw)`,
			"",
			verifyTable(ver),
			"",
			"Small samples: read effects as direction. An ungraded run is missing, not a zero.",
			"",
		);
	} else if (o.verifyTasks.length) out.push("## Held-out check", "", "_Skipped: nothing to compare._", "");
	if (abl) {
		out.push(
			"## Does the library improve the improvement? (held-out ablation)",
			"",
			"Each held-out task was improved twice from the same reference run: with the library, and with an empty one. Each resulting harness was then run on that task.",
			"",
			ablationTable(abl),
			"",
		);
	}
	out.push(
		"## Cost and safety",
		"",
		`- Improver cost: $${job.editorCost.toFixed(4)}; worker cost: $${job.workerCost.toFixed(4)} (local models report $0).`,
		`- Your real pi config during the job: ${changed.length ? `changed outside this tool: ${changed.join(", ")} (e.g. by your own pi session)` : "unchanged"}.`,
		`- Records: \`${job.dir}\``,
	);
	return `${out.join("\n")}\n`;
}

/** Not a model id (it has a space): "improve whichever model the session used". */
const AUTO = "session model";

/**
 * One searchable list: your models first, type to filter (every word, anywhere in the name).
 * `withAuto` puts "session model" (whichever model the session used) on top. Outside the terminal UI it falls
 * back to a short list plus a typed search.
 */
async function pickModel(ctx: ExtensionContext, agentDir: string, heading: string, current?: string, withAuto = false): Promise<string | undefined> {
	const available = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
	const scoped = ctx.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`);
	const all = withAuto ? [AUTO, ...available] : available;
	const familiar = [...(withAuto ? [AUTO] : []), ...familiarModels(agentDir, scoped).filter((m) => available.includes(m))];
	const title = current ? `${heading} (now: ${current})` : heading;
	if (ctx.mode === "tui") {
		const mineSet = new Set(familiar.filter((m) => m !== AUTO));
		return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
			const st: PickerState = { query: "", selected: 0 };
			let matches = rankModels("", all, familiar, current);
			const paint = (c: string, t: string) => {
				try {
					return theme.fg(c as never, t);
				} catch {
					return t;
				}
			};
			const refilter = () => {
				matches = rankModels(st.query, all, familiar, current);
				st.selected = 0;
			};
			return {
				render: (width: number) => renderPicker(title, st, matches, all.length, mineSet, width, paint),
				invalidate() {},
				handleInput(data: string) {
					if (keybindings.matches(data, "tui.select.up")) st.selected = matches.length ? (st.selected - 1 + matches.length) % matches.length : 0;
					else if (keybindings.matches(data, "tui.select.down")) st.selected = matches.length ? (st.selected + 1) % matches.length : 0;
					else if (keybindings.matches(data, "tui.select.confirm")) {
						if (matches[st.selected]) done(matches[st.selected]);
						return;
					} else if (keybindings.matches(data, "tui.select.cancel")) {
						done(undefined);
						return;
					} else if (data === "\x7f" || data === "\b") {
						st.query = st.query.slice(0, -1);
						refilter();
					} else if (data === "\x15") {
						st.query = ""; // ctrl+u clears the search
						refilter();
					} else if (/^[\x20-\x7e\u00a0-\uffff]+$/.test(data)) {
						st.query += data; // typed or pasted text
						refilter();
					} else return;
					tui.requestRender();
				},
			};
		});
	}
	const TYPE = "Type a model name…";
	const short = [...(current && all.includes(current) ? [current] : []), ...familiar.filter((m) => m !== current)].slice(0, 8);
	if (short.length) {
		const choice = await ctx.ui.select(title, [...short, TYPE]);
		if (choice !== TYPE) return choice;
	}
	for (let attempt = 0; attempt < 5; attempt++) {
		const q = await ctx.ui.input(`${title}: model name, or part of it`, "provider/model");
		if (q === undefined) return undefined;
		const hits = searchModels(all, q);
		if (hits.length === 1) return hits[0];
		if (hits.length > 1) return ctx.ui.select(`Models matching "${q}":`, hits);
		ctx.ui.notify(`No model matches "${q}".`, "info");
	}
	return undefined;
}
