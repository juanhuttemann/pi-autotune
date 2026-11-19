import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parseEvents } from "./events.ts";
import { HEAVY, type EditCall, type SnapMeta, snapDir } from "./snapshot.ts";
import { definedNames, distinctiveNames } from "./surface.ts";
import { readTree, treeDiff } from "./tree.ts";
import { mkdirp, readJson, rmrf, runProc, sha256 } from "./util.ts";

export interface Score {
	passed: number;
	total: number;
	detail?: string;
}

export interface Task {
	id: string;
	kind: "folder" | "session";
	/** One line for lists and reports. */
	title: string;
	prompt: string;
	/** Create the agent's workspace under `dst`; returns the directory the agent starts in. */
	prepareWorkspace(dst: string): Promise<string>;
	/** Read-only copy of the task's inputs for the editors (no grader material). */
	sourceForEditors(dst: string): Promise<void>;
	/** What a run changed, as a unified diff. */
	deliverable(workspaceRoot: string): Promise<string>;
	/** Strings that must never appear in any model's context (grader paths). */
	hiddenMarkers: string[];
	/** Retrospective grader, only for --verify reports. Never steers anything. */
	check?: (workspaceRoot: string) => Promise<Score | null>;
	/** Distinctive names from this task's inputs, for the generality tripwire. */
	names(touched: string[]): Promise<string[]>;
	/** Content hash of everything the task consists of (frozen held-out sets). */
	fingerprint(): string;
	/** The user's original interactive session as a trajectory, when the task came from one. */
	original?: string;
}

// ---------------------------------------------------------------- task folders

/**
 * A task folder:
 *   task.md       the request
 *   workspace/    the agent's starting files
 *   check         optional; run as `check <workspace>` after a run. It prints a last line
 *                 {"passed": n, "total": m}, or exits 0 for pass / non-zero for fail.
 *   task.json     optional {"check": ["python3", "check.py"]} to run the grader another way
 * Everything outside workspace/ and task.md is hidden from every model.
 */
export function loadFolderTasks(paths: string[]): Task[] {
	const out: Task[] = [];
	for (const p0 of paths) {
		const p = resolve(p0);
		if (!existsSync(p)) throw new Error(`no such task folder: ${p0}`);
		if (existsSync(join(p, "task.md"))) out.push(folderTask(p));
		else
			for (const name of readdirSync(p).sort()) {
				const d = join(p, name);
				if (statSync(d).isDirectory() && existsSync(join(d, "task.md"))) out.push(folderTask(d));
			}
	}
	if (!out.length) throw new Error(`no task folders (with task.md) under: ${paths.join(", ")}`);
	return out;
}

function listFiles(root: string, skip: (rel: string) => boolean = () => false): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			const rel = relative(root, p).split(sep).join("/");
			if (skip(rel)) continue;
			if (statSync(p).isDirectory()) walk(p);
			else out.push(rel);
		}
	};
	if (existsSync(root)) walk(root);
	return out.sort();
}

function folderTask(dir: string): Task {
	const ws = join(dir, "workspace");
	if (!existsSync(ws)) throw new Error(`${dir}: missing workspace/`);
	const prompt = readFileSync(join(dir, "task.md"), "utf8");
	const meta = readJson<{ check?: string[] }>(join(dir, "task.json"), {});
	const checkCmd = meta.check ?? (existsSync(join(dir, "check")) ? [join(dir, "check")] : undefined);
	const hidden = listFiles(dir, (rel) => rel === "workspace" || rel.startsWith("workspace/") || rel === "task.md");
	const isNoise = (rel: string) => /(^|\/)(__pycache__|\.pytest_cache|node_modules)(\/|$)|\.pyc$/.test(rel);
	const markers = new Set<string>([dir]);
	for (const rel of hidden) {
		if (isNoise(rel)) continue;
		if (rel.includes("/")) markers.add(rel);
		if (basename(rel).includes(".")) markers.add(basename(rel));
	}
	// A hidden file that shares its name with a workspace file is not a usable marker.
	const wsNames = new Set(listFiles(ws).map((r) => basename(r)));
	for (const m of [...markers]) if (wsNames.has(m)) markers.delete(m);
	return {
		id: basename(dir),
		kind: "folder",
		title: `${basename(dir)}: ${prompt.split("\n").find((l) => l.trim())?.slice(0, 80) ?? ""}`,
		prompt: `${prompt.trim()}\n\nWork in the current directory.`,
		hiddenMarkers: [...markers],
		async prepareWorkspace(dst) {
			rmrf(dst);
			cpSync(ws, dst, { recursive: true });
			return dst;
		},
		async sourceForEditors(dst) {
			cpSync(ws, dst, { recursive: true, filter: (s) => !isNoise(relative(ws, s)) });
		},
		async deliverable(root) {
			const strip = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => !isNoise(k)));
			return treeDiff(strip(readTree(ws)), strip(readTree(root))) || "(no changes)";
		},
		check: checkCmd
			? async (root) => {
					const [c, ...a] = checkCmd;
					const r = await runProc(c, [...a, root], { cwd: dir, timeoutMs: 300_000 });
					const last = r.stdout.trim().split("\n").pop() ?? "";
					try {
						const j = JSON.parse(last) as { passed?: number; total?: number };
						if (typeof j.passed === "number" && typeof j.total === "number" && j.total > 0)
							return { passed: j.passed, total: j.total, detail: r.stdout.slice(-2000) };
					} catch {
						/* exit-code grader */
					}
					if (r.code === null) return null;
					return { passed: r.code === 0 ? 1 : 0, total: 1, detail: (r.stdout + r.stderr).slice(-2000) };
				}
			: undefined,
		async names() {
			const files = listFiles(ws, isNoise);
			const names = files.map((f) => basename(f));
			for (const f of files) {
				if (/\.(py|ts|js|mjs|go|rs|java|rb|kt|swift|c|h|cpp|cs)$/.test(f))
					names.push(...definedNames(readFileSync(join(ws, f), "utf8")));
			}
			return [...distinctiveNames(names)];
		},
		fingerprint() {
			const files = listFiles(dir, isNoise);
			return sha256(files.map((f) => `${f}\0${sha256(readFileSync(join(dir, f)))}`).join("\n"));
		},
	};
}

// ---------------------------------------------------------------- the current session

export interface SessionRecord {
	id: string;
	file: string;
	cwd: string;
	started: string;
	prompts: string[];
	/** provider/model that produced most of the assistant turns */
	model: string | null;
	edits: EditCall[];
	writes: string[];
	trajectory: string;
}

type Entry = { type?: string; id?: string; cwd?: string; timestamp?: string; message?: Record<string, unknown> };

/** Read a pi session file: the user's requests, the model used, the edits made, the transcript. */
export function readSession(file: string): SessionRecord {
	const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
	const entries: Entry[] = lines.flatMap((l) => {
		try {
			return [JSON.parse(l) as Entry];
		} catch {
			return [];
		}
	});
	const head = entries.find((e) => e.type === "session") ?? {};
	const prompts: string[] = [];
	const models = new Map<string, number>();
	const edits: EditCall[] = [];
	const writes: string[] = [];
	const asEvents: string[] = [];
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		const m = e.message as { role?: string; content?: unknown; provider?: string; model?: string };
		asEvents.push(JSON.stringify({ type: "message_end", message: m }));
		if (m.role === "user") {
			const c = m.content;
			const text = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "").trim();
			if (text && !text.startsWith("/")) prompts.push(text);
		} else if (m.role === "assistant") {
			if (m.provider && m.model) models.set(`${m.provider}/${m.model}`, (models.get(`${m.provider}/${m.model}`) ?? 0) + 1);
			for (const b of (Array.isArray(m.content) ? m.content : []) as Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>) {
				if (b.type !== "toolCall") continue;
				const a = b.arguments ?? {};
				const path = typeof a.path === "string" ? a.path : null;
				if (!path) continue;
				if (b.name === "edit") {
					const list = Array.isArray(a.edits) ? (a.edits as EditCall["edits"]) : typeof a.oldText === "string" ? [{ oldText: a.oldText as string, newText: String(a.newText ?? "") }] : [];
					edits.push({ path, edits: list.filter((x) => typeof x?.oldText === "string" && typeof x?.newText === "string") });
				} else if (b.name === "write") writes.push(path);
			}
		}
	}
	let model: string | null = null;
	let best = 0;
	for (const [k, n] of models) if (n >= best) [model, best] = [k, n]; // ties go to the later one
	return {
		id: String(head.id ?? basename(file)),
		file,
		cwd: String(head.cwd ?? ""),
		started: String(head.timestamp ?? ""),
		prompts,
		model,
		edits,
		writes,
		trajectory: parseEvents(asEvents.join("\n")).trajectory,
	};
}

/** The request replayed from a session: the first message, then the user's follow-ups in order. */
export function sessionPrompt(prompts: string[]): string {
	if (prompts.length <= 1) return prompts[0] ?? "";
	return `${prompts[0]}\n\nLater in the same conversation the user also said, in order:\n${prompts
		.slice(1)
		.map((p, i) => `${i + 1}. ${p}`)
		.join("\n")}\n\nDo all of it.`;
}

const HEAVY_SPECS = ["**/.git/**", "**/node_modules/**", "**/.venv/**", "**/venv/**", "**/__pycache__/**", "**/.cache/**", "**/dist/**", "**/build/**", "**/target/**"].map((g) => `:(exclude,glob)${g}`);

function textTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(dir)) return out;
	for (const rel of listFiles(dir, (r) => HEAVY.test(r))) {
		const p = join(dir, rel);
		const st = statSync(p);
		if (st.size > 1_000_000) {
			out[rel] = `(large file, ${st.size} bytes)\n`;
			continue;
		}
		const buf = readFileSync(p);
		out[rel] = buf.includes(0) ? `(binary file, ${st.size} bytes, sha ${sha256(buf).slice(0, 12)})\n` : buf.toString("utf8");
	}
	return out;
}

export function learnTask(rec: SessionRecord, snap: SnapMeta, work: string): Task {
	const sd = snapDir(work, snap.sessionId);
	const name = basename(snap.cwd).replace(/[^A-Za-z0-9_.-]/g, "_") || "session";
	const git = async (args: string[]) => {
		const r = await runProc("git", args, { timeoutMs: 120_000 });
		if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
		return r;
	};
	const prepare = async (dst: string): Promise<string> => {
		rmrf(dst);
		if (snap.kind === "git") {
			// A clone, never a worktree: nothing is written into the user's repository, and the
			// remote is removed so a replayed request cannot push anywhere.
			await git(["clone", "--quiet", "--shared", "--no-checkout", snap.root!, dst]);
			await git(["-C", dst, "checkout", "--quiet", "--detach", snap.head!]);
			await git(["-C", dst, "remote", "remove", "origin"]);
			const patch = join(sd, "uncommitted.patch");
			if (existsSync(patch) && statSync(patch).size) await git(["-C", dst, "apply", "--binary", "--whitespace=nowarn", patch]);
			if (existsSync(join(sd, "untracked"))) cpSync(join(sd, "untracked"), dst, { recursive: true });
			return snap.sub ? join(dst, snap.sub) : dst;
		}
		cpSync(join(sd, "files"), dst, { recursive: true });
		return dst;
	};
	return {
		id: `${name}-${rec.id.slice(-8)}`,
		kind: "session",
		title: `${snap.cwd}: ${rec.prompts[0]?.replace(/\s+/g, " ").slice(0, 80) ?? ""}`,
		prompt: sessionPrompt(rec.prompts),
		hiddenMarkers: [],
		original: rec.trajectory,
		prepareWorkspace: prepare,
		async sourceForEditors(dst) {
			await prepare(dst);
			rmrf(join(dst, ".git"));
		},
		async deliverable(root) {
			if (snap.kind === "git") {
				await runProc("git", ["-C", root, "add", "-A", "-N", "."], { timeoutMs: 60_000 });
				const d = await runProc("git", ["-C", root, "diff", "--no-color", "--no-ext-diff", "--", ".", ...HEAVY_SPECS], { timeoutMs: 60_000 });
				return d.stdout.trim() ? d.stdout : "(no changes)";
			}
			return treeDiff(textTree(join(sd, "files")), textTree(root)) || "(no changes)";
		},
		async names(touched) {
			const names: string[] = [];
			const base = snap.kind === "git" ? null : join(sd, "files");
			for (const rel of touched) {
				names.push(basename(rel));
				const p = base ? join(base, rel) : join(snap.root!, rel);
				if (!rel.startsWith("..") && existsSync(p) && statSync(p).isFile() && statSync(p).size < 1_000_000)
					names.push(...definedNames(readFileSync(p, "utf8")));
			}
			return [...distinctiveNames(names)];
		},
		fingerprint() {
			return sha256(`${snap.sessionId}\0${rec.prompts.join("\0")}`);
		},
	};
}
