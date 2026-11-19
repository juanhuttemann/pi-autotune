import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job, RunMeta, TaskSummary } from "./engine.ts";
import type { Library } from "./library.ts";
import { median, permTest, stratifiedPerm } from "./stats.ts";
import { skillNames } from "./surface.ts";
import type { Task } from "./tasks.ts";
import type { Tree } from "./tree.ts";

export interface ArmRow {
	n: number;
	graded: number;
	meanPct: number | null;
	perfect: number;
	runs: string[];
	medianSecs: number | null;
	medianFirstInput: number | null;
	timeouts: number;
	skillReads: number;
	overlayLoaded: number;
	leaks: number;
}

export interface VerifyRow {
	task: string;
	current: ArmRow;
	proposed: ArmRow;
	p: number | null;
}

export interface VerifyResult {
	rows: VerifyRow[];
	pooledP: number | null;
	fingerprintsOk: boolean;
}

/**
 * Held-out check: the user's pi as it is now ("current") vs with the proposed overlay
 * ("proposed"), on task folders no model saw during training. Arms are interleaved and
 * their order alternates every round, so drift in server speed hits both equally.
 * Grades are read only here, after everything was chosen.
 */
export async function verify(
	job: Job,
	tasks: Task[],
	n: number,
	current: Tree,
	proposed: Tree,
	frozen: Record<string, string>,
	onProgress: (done: number, total: number) => void,
): Promise<VerifyResult> {
	const fingerprintsOk = tasks.every((t) => frozen[t.id] === t.fingerprint());
	if (!fingerprintsOk) throw new Error("verify tasks changed after they were frozen; refusing to report on them");
	const order: Array<[Task, Tree, string]> = [];
	for (let i = 1; i <= n; i++)
		for (const t of tasks) {
			const arms: Array<[Tree, string]> = [
				[current, `verify_current_${i}`],
				[proposed, `verify_proposed_${i}`],
			];
			for (const [ov, lab] of i % 2 ? arms : arms.reverse()) order.push([t, ov, lab]);
		}
	let done = 0;
	for (const [t, ov, lab] of order) {
		await job.execute(t, ov, lab);
		onProgress(++done, order.length);
	}
	const rows: VerifyRow[] = [];
	const groups: Array<[number[], number[]]> = [];
	for (const t of tasks) {
		const arm = (name: "current" | "proposed", ov: Tree): [ArmRow, number[]] => {
			const metas: RunMeta[] = [];
			const fr: number[] = [];
			const runs: string[] = [];
			for (let i = 1; i <= n; i++) {
				const lab = `verify_${name}_${i}`;
				const m = jobMeta(job, t, lab);
				if (!m) continue;
				metas.push(m);
				const g = job.grade(t, lab);
				if (g) {
					fr.push(g.passed / g.total);
					runs.push(`${g.passed}/${g.total}`);
				} else runs.push("ungraded");
			}
			const head = (ov["APPEND_SYSTEM.md"] ?? "").trim().split("\n")[0]?.slice(0, 60) ?? "";
			const sk = skillNames(ov);
			const loaded = metas.filter(
				(m) => (head || sk.length) && (!head || m.system.addendum.includes(head)) && sk.every((s) => m.system.skills.includes(s)),
			).length;
			return [
				{
					n: metas.length,
					graded: fr.length,
					// An ungraded run is missing, not a zero.
					meanPct: fr.length ? Math.round((1000 * fr.reduce((a, b) => a + b, 0)) / fr.length) / 10 : null,
					perfect: fr.filter((f) => f === 1).length,
					runs,
					medianSecs: median(metas.map((m) => m.secs - m.queueSecs)),
					medianFirstInput: median(metas.map((m) => m.firstInputTokens ?? 0)),
					timeouts: metas.filter((m) => m.rc === "timeout").length,
					skillReads: metas.reduce((a, m) => a + m.skillReads, 0),
					overlayLoaded: loaded,
					leaks: metas.filter((m) => m.leaks.length).length,
				},
				fr,
			];
		};
		const [cur, fc] = arm("current", current);
		const [pro, fp] = arm("proposed", proposed);
		const p = fc.length && fp.length ? permTest(fc, fp) : null;
		if (p !== null) groups.push([fc, fp]);
		rows.push({ task: t.id, current: cur, proposed: pro, p });
	}
	return { rows, pooledP: groups.length ? stratifiedPerm(groups) : null, fingerprintsOk };
}

function jobMeta(job: Job, t: Task, label: string): RunMeta | null {
	const p = join(job.dir, "tasks", t.id, "runs", label, "meta.json");
	return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as RunMeta) : null;
}

export function verifyTable(v: VerifyResult): string {
	const pct = (x: number | null) => (x === null ? "n/a" : `${x}%`);
	const lines = [
		"| Task | current pi: mean (perfect) | proposed: mean (perfect) | p |",
		"|---|---|---|---|",
		...v.rows.map(
			(r) =>
				`| ${r.task} | ${pct(r.current.meanPct)} (${r.current.perfect}/${r.current.graded}) | ${pct(r.proposed.meanPct)} (${r.proposed.perfect}/${r.proposed.graded}) | ${r.p === null ? "n/a" : r.p.toFixed(3)} |`,
		),
		"",
		`Pooled (stratified permutation, two-sided): p = ${v.pooledP === null ? "n/a" : v.pooledP.toFixed(4)}`,
		"",
		"| Task | median run time current → proposed | first-request input tokens | overlay loaded | skill reads | timeouts | leaks |",
		"|---|---|---|---|---|---|---|",
		...v.rows.map(
			(r) =>
				`| ${r.task} | ${r.current.medianSecs}s → ${r.proposed.medianSecs}s | ${r.current.medianFirstInput} → ${r.proposed.medianFirstInput} | ${r.proposed.overlayLoaded}/${r.proposed.n} | ${r.current.skillReads} → ${r.proposed.skillReads} | ${r.current.timeouts} / ${r.proposed.timeouts} | ${r.current.leaks + r.proposed.leaks} |`,
		),
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------- does the library improve improvement?

export interface AblationRow {
	task: string;
	withLib: ArmRow;
	withoutLib: ArmRow;
	p: number | null;
	/** Share of the with-library harness's new lines that came from library entries. */
	provenance: Record<string, number>;
	usedEntries: string[];
	changed: { withLib: boolean; withoutLib: boolean };
}

export interface AblationResult {
	rows: AblationRow[];
	pooledP: number | null;
	entries: number;
}

/**
 * The paper's w/o-library ablation, on held-out tasks: run the whole task-level loop on each
 * task twice, once with the frozen library and once with an empty one (same reference run,
 * nothing written back), then run each adopted harness n times, interleaved and alternating,
 * and grade them. A difference measures what the library adds to the improvement process.
 */
export async function ablateLibrary(
	job: Job,
	tasks: Task[],
	n: number,
	lib: Library,
	frozen: Record<string, string>,
	onProgress: (detail: string) => void,
): Promise<AblationResult> {
	if (!tasks.every((t) => frozen[t.id] === t.fingerprint())) throw new Error("verify tasks changed after they were frozen; refusing to report on them");
	const rows: AblationRow[] = [];
	const groups: Array<[number[], number[]]> = [];
	for (const [k, t] of tasks.entries()) {
		onProgress(`library test ${k + 1}/${tasks.length}: improving with the library`);
		const a: TaskSummary = await job.trainTask(t, { library: lib, write: false, arm: "lib_" });
		onProgress(`library test ${k + 1}/${tasks.length}: improving without it`);
		const b: TaskSummary = await job.trainTask(t, { library: null, write: false, arm: "nolib_" });
		for (let i = 1; i <= n; i++) {
			onProgress(`library test ${k + 1}/${tasks.length}: run ${i}/${n}`);
			const arms: Array<[Tree, string]> = [
				[a.adopted, `ablate_lib_${i}`],
				[b.adopted, `ablate_nolib_${i}`],
			];
			for (const [ov, lab] of i % 2 ? arms : arms.reverse()) await job.execute(t, ov, lab);
		}
		const [rl, fl] = armRow(job, t, "ablate_lib", n, a.adopted);
		const [rn, fn] = armRow(job, t, "ablate_nolib", n, b.adopted);
		const p = fl.length && fn.length ? permTest(fn, fl) : null;
		if (p !== null) groups.push([fn, fl]);
		rows.push({
			task: t.id,
			withLib: rl,
			withoutLib: rn,
			p,
			provenance: a.provenance,
			usedEntries: a.used.map((u) => u.entry),
			changed: { withLib: a.adoptedChanged, withoutLib: b.adoptedChanged },
		});
	}
	return { rows, pooledP: groups.length ? stratifiedPerm(groups) : null, entries: lib.entries().length };
}

function armRow(job: Job, t: Task, prefix: string, n: number, ov: Tree): [ArmRow, number[]] {
	const metas: RunMeta[] = [];
	const fr: number[] = [];
	const runs: string[] = [];
	for (let i = 1; i <= n; i++) {
		const m = jobMeta(job, t, `${prefix}_${i}`);
		if (!m) continue;
		metas.push(m);
		const g = job.grade(t, `${prefix}_${i}`);
		if (g) {
			fr.push(g.passed / g.total);
			runs.push(`${g.passed}/${g.total}`);
		} else runs.push("ungraded");
	}
	const head = (ov["APPEND_SYSTEM.md"] ?? "").trim().split("\n")[0]?.slice(0, 60) ?? "";
	const sk = skillNames(ov);
	return [
		{
			n: metas.length,
			graded: fr.length,
			meanPct: fr.length ? Math.round((1000 * fr.reduce((x, y) => x + y, 0)) / fr.length) / 10 : null,
			perfect: fr.filter((f) => f === 1).length,
			runs,
			medianSecs: median(metas.map((m) => m.secs - m.queueSecs)),
			medianFirstInput: median(metas.map((m) => m.firstInputTokens ?? 0)),
			timeouts: metas.filter((m) => m.rc === "timeout").length,
			skillReads: metas.reduce((x, m) => x + m.skillReads, 0),
			overlayLoaded: metas.filter((m) => (head || sk.length) && (!head || m.system.addendum.includes(head)) && sk.every((s) => m.system.skills.includes(s))).length,
			leaks: metas.filter((m) => m.leaks.length).length,
		},
		fr,
	];
}

export function ablationTable(r: AblationResult): string {
	const pct = (x: number | null) => (x === null ? "n/a" : `${x}%`);
	const prov = (p: Record<string, number>) => {
		const best = Object.entries(p).sort((x, y) => y[1] - x[1])[0];
		return best && best[1] > 0 ? `${Math.round(best[1] * 100)}% from \`${best[0]}\`` : "none";
	};
	return [
		`Library: ${r.entries} entr${r.entries === 1 ? "y" : "ies"}, frozen for this test (nothing was written back).`,
		"",
		"| Held-out task | improved WITH library: mean (perfect) | WITHOUT library: mean (perfect) | p | taken from the library |",
		"|---|---|---|---|---|",
		...r.rows.map(
			(x) =>
				`| ${x.task} | ${pct(x.withLib.meanPct)} (${x.withLib.perfect}/${x.withLib.graded})${x.changed.withLib ? "" : " · kept base"} | ${pct(x.withoutLib.meanPct)} (${x.withoutLib.perfect}/${x.withoutLib.graded})${x.changed.withoutLib ? "" : " · kept base"} | ${x.p === null ? "n/a" : x.p.toFixed(3)} | ${prov(x.provenance)} |`,
		),
		"",
		`Pooled (stratified permutation, two-sided): p = ${r.pooledP === null ? "n/a" : r.pooledP.toFixed(4)}`,
	].join("\n");
}
