import { cpSync, existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readTree, type Tree, writeTree } from "./tree.ts";
import { escapeRe, mkdirp, readJson, rmrf, writeJson, writeText } from "./util.ts";

/*
 * The experience library R of the improvement harness (Harness², §2.3, Eq. 4):
 *
 *     R_{t+1} = Update(R_t, H*_t, D_t)
 *
 * Each entry is the full adopted harness of a task plus an EXPERIENCE.md (situation,
 * lessons, supporting evidence), added only when an execution contrast supports it, and
 * listed in an index that later sessions inspect on demand. Later editors reuse entries
 * selectively, through Propose, and re-verify them.
 *
 * Beyond the paper (its Appendix G names these as next steps: "revise outdated
 * experience", "consolidate overlapping components", "refine retrieval"):
 *   - every reuse of an entry is recorded: which task, whether an editor cited it, how much
 *     of the new harness came from it (the paper's provenance/containment measure, App. E.2),
 *     and whether that material survived the probes into the adopted harness;
 *   - the reflector revises the EXPERIENCE.md of entries a task reused, with that task's
 *     rollout evidence, and retires entries that the evidence contradicts or supersedes;
 *   - the index shows that history, so later editors can weigh entries by how they held up.
 * None of this uses a score: it is all behavioral evidence from runs.
 */

export interface Use {
	job: string;
	task: string;
	at: string;
	/** An editor or the composer named this entry in its notes. */
	cited: boolean;
	/** Share of the new harness's added lines found in this entry (max over candidates). */
	containment: number;
	/** That material is still in the adopted harness after probe and compose. */
	kept: boolean;
}

export interface EntryStats {
	domain: string;
	created: string;
	job: string;
	task: string;
	uses: Use[];
	revisions: Array<{ job: string; task: string; at: string; summary: string }>;
	status: "active" | "retired";
	retiredReason?: string;
}

const ARCHIVE = "_archive";

export function domainOf(experience: string): string {
	const m = /^##\s*Domain\s*\n+\s*([^\n]+)/im.exec(experience);
	return (m?.[1] ?? "general").trim().replace(/[`*]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general";
}

/** "## Status\nretired: <reason>" retires an entry. */
export function retiredReason(experience: string): string | null {
	const m = /^##\s*Status\s*\n+\s*retired\b[:\s-]*([^\n]*)/im.exec(experience);
	return m ? m[1].trim() || "retired by the reflector" : null;
}

function cueOf(experience: string): string {
	const m = /##\s*Situation\s*\n([\s\S]+?)(\n##|$)/.exec(experience);
	return (m ? m[1] : experience).replace(/\s+/g, " ").trim().slice(0, 220);
}

export class Library {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}

	/** Active entries, oldest first. */
	entries(): string[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((e) => e !== ARCHIVE && existsSync(join(this.dir, e, "EXPERIENCE.md")))
			.filter((e) => this.stats(e).status === "active")
			.sort((a, b) => this.stats(a).created.localeCompare(this.stats(b).created));
	}

	experience(e: string): string {
		return readFileSync(join(this.dir, e, "EXPERIENCE.md"), "utf8");
	}

	harness(e: string): Tree {
		return readTree(join(this.dir, e, "harness"));
	}

	names(e: string): string[] {
		return readJson<string[]>(join(this.dir, e, "names.json"), []);
	}

	/** Entries written before stats existed get defaults read from their EXPERIENCE.md. */
	stats(e: string): EntryStats {
		const p = join(this.dir, e, "stats.json");
		const s = readJson<Partial<EntryStats>>(p, {});
		const exp = existsSync(join(this.dir, e, "EXPERIENCE.md")) ? this.experience(e) : "";
		return {
			domain: s.domain ?? domainOf(exp),
			created: s.created ?? "",
			job: s.job ?? "",
			task: s.task ?? e,
			uses: s.uses ?? [],
			revisions: s.revisions ?? [],
			status: s.status ?? "active",
			retiredReason: s.retiredReason,
		};
	}

	private saveStats(e: string, s: EntryStats): void {
		writeJson(join(this.dir, e, "stats.json"), s);
	}

	add(e: string, harness: Tree, experience: string, names: string[], job: string, task: string): void {
		const d = join(this.dir, e);
		// Re-learning the same task replaces its entry but keeps the entry's track record.
		const prior = existsSync(join(d, "EXPERIENCE.md")) ? this.stats(e) : null;
		if (prior) cpSync(join(d, "EXPERIENCE.md"), join(this.dir, `${e}.EXPERIENCE.prev.md`));
		rmrf(d);
		writeTree(harness, join(d, "harness"));
		writeText(join(d, "EXPERIENCE.md"), experience);
		writeJson(join(d, "names.json"), names);
		this.saveStats(e, {
			domain: domainOf(experience),
			created: prior?.created || new Date().toISOString(),
			job,
			task,
			uses: prior?.uses ?? [],
			revisions: [...(prior?.revisions ?? []), ...(prior ? [{ job, task, at: new Date().toISOString(), summary: "re-learned from the same task" }] : [])],
			status: "active",
		});
		this.writeIndex();
	}

	recordUse(e: string, use: Use): void {
		const s = this.stats(e);
		s.uses.push(use);
		this.saveStats(e, s);
	}

	/** Replace an entry's EXPERIENCE.md with the reflector's revision; the old one is kept. */
	revise(e: string, experience: string, job: string, task: string, summary: string): void {
		const s = this.stats(e);
		const n = s.revisions.length + 1;
		cpSync(join(this.dir, e, "EXPERIENCE.md"), join(this.dir, e, `EXPERIENCE.v${n}.md`));
		writeText(join(this.dir, e, "EXPERIENCE.md"), experience);
		s.revisions.push({ job, task, at: new Date().toISOString(), summary });
		s.domain = domainOf(experience) === "general" ? s.domain : domainOf(experience);
		this.saveStats(e, s);
	}

	/** Retired entries leave the index and every model's context; nothing is deleted. */
	retire(e: string, reason: string): void {
		const s = this.stats(e);
		s.status = "retired";
		s.retiredReason = reason;
		this.saveStats(e, s);
		mkdirp(join(this.dir, ARCHIVE));
		rmrf(join(this.dir, ARCHIVE, e));
		renameSync(join(this.dir, e), join(this.dir, ARCHIVE, e));
	}

	/** One line per active entry, grouped by domain, with its reuse history. */
	indexText(exclude: string[] = []): string {
		const rows = this.entries()
			.filter((e) => !exclude.includes(e))
			.map((e) => ({ e, s: this.stats(e) }));
		const domains = [...new Set(rows.map((r) => r.s.domain))].sort();
		const out = ["# Library index", ""];
		if (!rows.length) out.push("(empty)");
		for (const d of domains) {
			out.push(`## ${d}`, "");
			for (const { e, s } of rows.filter((r) => r.s.domain === d)) {
				const reused = s.uses.length;
				const kept = s.uses.filter((u) => u.kept).length;
				const hist = reused ? `reused ${reused}×, kept after probing ${kept}×` : "not reused yet";
				out.push(`- \`${e}/\`: ${cueOf(this.experience(e))}  _(${hist}${s.revisions.length ? `; revised ${s.revisions.length}×` : ""})_`);
			}
			out.push("");
		}
		return `${out.join("\n").trimEnd()}\n`;
	}

	writeIndex(): void {
		mkdirp(this.dir);
		writeText(join(this.dir, "INDEX.md"), this.indexText());
	}

	/** What a model session gets: active entries (harness + EXPERIENCE.md) and the index. */
	exportTo(dst: string, exclude: string[] = []): void {
		mkdirp(dst);
		writeText(join(dst, "INDEX.md"), this.indexText(exclude));
		for (const e of this.entries().filter((x) => !exclude.includes(x))) {
			writeTree(this.harness(e), join(dst, e, "harness"));
			writeText(join(dst, e, "EXPERIENCE.md"), this.experience(e));
		}
	}

	/** Entries named in editor/composer notes, as `<entry>/` or the bare entry id. */
	cited(notes: string): string[] {
		return this.entries().filter((e) => new RegExp(`(?<![\\w-])${escapeRe(e)}(?![\\w-])`).test(notes));
	}
}

// ---------------------------------------------------------------- provenance (App. E.2)

function meaningful(line: string): boolean {
	const t = line.trim();
	if (t.length < 12) return false;
	if (/^(---|```|name:|description:|#+\s*$)/.test(t)) return false;
	return /[A-Za-z]{3}/.test(t);
}

const norm = (l: string) => l.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Containment: the share of non-boilerplate lines that `next` adds over `base` and that
 * appear in `source`. 1 = everything new was taken from the source.
 */
export function containment(next: string, base: string, source: string): number {
	const baseLines = new Set(base.split("\n").map(norm));
	const added = next.split("\n").filter((l) => meaningful(l) && !baseLines.has(norm(l)));
	if (!added.length) return 0;
	const src = new Set(source.split("\n").map(norm));
	return added.filter((l) => src.has(norm(l))).length / added.length;
}

/** Per library entry: how much of `tree` (over `base`) came from that entry, same component paths. */
export function provenance(tree: Tree, base: Tree, lib: Library, entries = lib.entries()): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of entries) {
		const h = lib.harness(e);
		let added = 0;
		let found = 0;
		for (const [path, text] of Object.entries(tree)) {
			if (text === base[path]) continue;
			const baseLines = new Set((base[path] ?? "").split("\n").map(norm));
			const lines = text.split("\n").filter((l) => meaningful(l) && !baseLines.has(norm(l)));
			added += lines.length;
			// Same component: the same path, or (for a skill copied under a new name) the same
			// file inside any of the entry's skills.
			const sub = /^skills\/[^/]+\/(.+)$/.exec(path)?.[1];
			const sources = h[path] !== undefined ? [h[path]] : sub ? Object.entries(h).filter(([q]) => q.startsWith("skills/") && q.endsWith(`/${sub}`)).map(([, t]) => t) : [];
			const srcSet = new Set(sources.join("\n").split("\n").map(norm));
			found += lines.filter((l) => srcSet.has(norm(l))).length;
		}
		out[e] = added ? Math.round((1000 * found) / added) / 1000 : 0;
	}
	return out;
}
