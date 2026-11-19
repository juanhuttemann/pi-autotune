import { constants, copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { mkdirp, readJson, rmrf, runProc, writeJson } from "./util.ts";

/*
 * The starting state of a session's working directory, so /learn can replay the work from
 * where it began. Taken at the start of every new session (cheap: copy-on-write where the
 * filesystem supports it). For sessions that started before this existed, it is rebuilt from
 * file creation times and the session's own edits.
 */

/** Directories that are environment, not work: never copied, never diffed. */
export const HEAVY = /(^|\/)(\.git|node_modules|\.venv|venv|env|__pycache__|\.cache|\.pytest_cache|\.mypy_cache|\.tox|\.next|dist|build|target|\.gradle|\.idea|\.vscode)(\/|$)/;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 20_000;

export interface SnapMeta {
	sessionId: string;
	cwd: string;
	started: string;
	kind: "git" | "dir";
	/** git: repository root, commit, and the cwd relative to the root */
	root?: string;
	head?: string;
	sub?: string;
	/** dir: true when rebuilt after the fact rather than captured at the start */
	reconstructed?: boolean;
	notes: string[];
}

export function snapDir(work: string, sessionId: string): string {
	return join(work, "snapshots", sessionId.replace(/[^A-Za-z0-9_.-]/g, "_"));
}

export function loadSnap(work: string, sessionId: string): SnapMeta | null {
	const d = snapDir(work, sessionId);
	return existsSync(join(d, ".complete")) ? readJson<SnapMeta | null>(join(d, "meta.json"), null) : null;
}

function unsuitable(cwd: string): string | null {
	const c = resolve(cwd);
	if (c === "/" || c === resolve(homedir())) return "the session ran in your home directory; there is no project folder to replay";
	return null;
}

function walk(root: string, visit: (rel: string, abs: string) => boolean | void): void {
	const go = (d: string) => {
		for (const n of readdirSync(d)) {
			const abs = join(d, n);
			const rel = relative(root, abs).split(sep).join("/");
			if (HEAVY.test(rel)) continue;
			const st = lstatSync(abs);
			if (st.isDirectory()) go(abs);
			else if (st.isFile() && visit(rel, abs) === false) throw new StopWalk();
		}
	};
	try {
		go(root);
	} catch (e) {
		if (!(e instanceof StopWalk)) throw e;
	}
}
class StopWalk extends Error {}

function copyIn(abs: string, dst: string): void {
	mkdirp(dirname(dst));
	copyFileSync(abs, dst, constants.COPYFILE_FICLONE); // reflink when possible, copy otherwise
}

async function gitInfo(cwd: string): Promise<{ root: string; head: string } | null> {
	const r = await runProc("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 20_000 });
	if (r.code !== 0) return null;
	const root = r.stdout.trim();
	const h = await runProc("git", ["-C", root, "rev-parse", "HEAD"], { timeoutMs: 20_000 });
	return h.code === 0 ? { root, head: h.stdout.trim() } : null;
}

/** Capture the starting state of a new session's directory. */
export async function captureStart(work: string, sessionId: string, cwd: string): Promise<SnapMeta | null> {
	if (loadSnap(work, sessionId)) return loadSnap(work, sessionId);
	if (unsuitable(cwd)) return null;
	const d = snapDir(work, sessionId);
	rmrf(d);
	mkdirp(d);
	const meta: SnapMeta = { sessionId, cwd, started: new Date().toISOString(), kind: "dir", notes: [] };
	const g = await gitInfo(cwd);
	if (g) {
		// Commit + uncommitted changes + untracked files: the exact working tree.
		meta.kind = "git";
		meta.root = g.root;
		meta.head = g.head;
		meta.sub = relative(g.root, cwd);
		const diff = await runProc("git", ["-C", g.root, "diff", "--binary", "HEAD"], { timeoutMs: 60_000 });
		writeFileSync(join(d, "uncommitted.patch"), diff.stdout);
		const un = await runProc("git", ["-C", g.root, "ls-files", "--others", "--exclude-standard", "-z"], { timeoutMs: 60_000 });
		let bytes = 0;
		for (const rel of un.stdout.split("\0").filter(Boolean)) {
			if (HEAVY.test(rel)) continue;
			const abs = join(g.root, rel);
			if (!existsSync(abs) || !statSync(abs).isFile()) continue;
			bytes += statSync(abs).size;
			if (bytes > MAX_BYTES) {
				meta.notes.push("some untracked files were too large to capture");
				break;
			}
			copyIn(abs, join(d, "untracked", rel));
		}
	} else {
		let bytes = 0;
		let files = 0;
		let complete = true;
		walk(cwd, (rel, abs) => {
			bytes += statSync(abs).size;
			if (++files > MAX_FILES || bytes > MAX_BYTES) return (complete = false);
			copyIn(abs, join(d, "files", rel));
		});
		if (!complete) {
			rmrf(d);
			return null; // too big to copy at every session start; /learn falls back to rebuilding
		}
		mkdirp(join(d, "files"));
	}
	writeJson(join(d, "meta.json"), meta);
	writeFileSync(join(d, ".complete"), meta.started);
	prune(work);
	return meta;
}

function prune(work: string, keep = 40): void {
	const root = join(work, "snapshots");
	if (!existsSync(root)) return;
	const dirs = readdirSync(root)
		.map((n) => ({ n, t: statSync(join(root, n)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	for (const { n } of dirs.slice(keep)) rmrf(join(root, n));
}

export interface EditCall {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
}

/**
 * Rebuild the starting state of a session that has no captured snapshot:
 * - in a git repo: the last commit before the session started;
 * - otherwise: the files that already existed when it started (creation time), with the
 *   session's own `edit` tool changes reversed. What can't be undone is listed in notes.
 */
export async function reconstructStart(
	work: string,
	sessionId: string,
	cwd: string,
	started: string,
	edits: EditCall[],
	writes: string[],
): Promise<SnapMeta> {
	const why = unsuitable(cwd);
	if (why) throw new Error(why);
	if (!existsSync(cwd)) throw new Error(`the session's folder ${cwd} no longer exists`);
	const d = snapDir(work, sessionId);
	rmrf(d);
	mkdirp(d);
	const t0 = Date.parse(started);
	const meta: SnapMeta = { sessionId, cwd, started, kind: "dir", reconstructed: true, notes: [] };
	const g = await gitInfo(cwd);
	if (g) {
		const c = await runProc("git", ["-C", g.root, "rev-list", "-1", `--before=${started}`, "HEAD"], { timeoutMs: 20_000 });
		if (c.code === 0 && c.stdout.trim()) {
			meta.kind = "git";
			meta.root = g.root;
			meta.head = c.stdout.trim();
			meta.sub = relative(g.root, cwd);
			meta.notes.push("rebuilt from the last commit before the session; uncommitted changes at that time are not included");
			writeFileSync(join(d, "uncommitted.patch"), "");
			writeJson(join(d, "meta.json"), meta);
			writeFileSync(join(d, ".complete"), started);
			return meta;
		}
	}
	const abs = (p: string) => resolve(cwd, p);
	const editsByFile = new Map<string, EditCall[]>();
	for (const e of edits) editsByFile.set(abs(e.path), [...(editsByFile.get(abs(e.path)) ?? []), e]);
	const written = new Set(writes.map(abs));
	let bytes = 0;
	walk(cwd, (rel, a) => {
		const st = statSync(a);
		const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
		if (born >= t0) return; // created during the session
		bytes += st.size;
		if (bytes > MAX_BYTES) {
			meta.notes.push("folder too large; later files were skipped");
			return false;
		}
		const dst = join(d, "files", rel);
		const mine = editsByFile.get(a);
		if (mine) {
			let text = readFileSync(a, "utf8");
			let ok = true;
			for (const call of [...mine].reverse())
				for (const ed of [...call.edits].reverse()) {
					const i = text.indexOf(ed.newText);
					if (i < 0) ok = false;
					else text = text.slice(0, i) + ed.oldText + text.slice(i + ed.newText.length);
				}
			mkdirp(dirname(dst));
			writeFileSync(dst, text);
			if (!ok) meta.notes.push(`${rel}: some of the session's edits could not be reversed`);
		} else {
			copyIn(a, dst);
			if (written.has(a)) meta.notes.push(`${rel}: overwritten during the session; its earlier content is unknown`);
			else if (st.mtimeMs >= t0) meta.notes.push(`${rel}: changed during the session by a command; its earlier content is unknown`);
		}
	});
	mkdirp(join(d, "files"));
	writeJson(join(d, "meta.json"), meta);
	writeFileSync(join(d, ".complete"), started);
	return meta;
}
