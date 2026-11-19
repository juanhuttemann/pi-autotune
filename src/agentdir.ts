import { existsSync, lstatSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, cpSync, unlinkSync } from "node:fs";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import type { Limiter } from "./proxy.ts";
import { type Tree, writeTree } from "./tree.ts";
import { mkdirp, rmrf, runProc, sha256, writeJson } from "./util.ts";

export const STATE_DIR_NAME = "pi-autotune";
export const BEGIN = "<!-- pi-autotune:begin -->";
export const END = "<!-- pi-autotune:end -->";

/** Entries of the real agent dir that never go into a copy. */
const SKIP = (name: string) =>
	name === "sessions" || name === "auth.json" || name === STATE_DIR_NAME || /\.bak/.test(name) || name === ".DS_Store";

async function cloneDir(src: string, dst: string, allowHardlinks: boolean): Promise<void> {
	// Copy-on-write when the filesystem supports it (btrfs, xfs, APFS): near-free and safe.
	const attempts: Array<[string, string[]]> =
		process.platform === "darwin"
			? [["cp", ["-ac", src, dst]], ["cp", ["-a", src, dst]]]
			: [["cp", ["-a", "--reflink=always", src, dst]]];
	if (allowHardlinks && process.platform !== "darwin") attempts.push(["cp", ["-al", src, dst]]);
	for (const [cmd, args] of attempts) {
		const r = await runProc(cmd, args, { timeoutMs: 600_000 });
		if (r.code === 0) return;
		rmrf(dst);
	}
	cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

/** Remove the overlay this tool installed earlier, so candidates replace it instead of stacking. */
export function stripOwned(dir: string, owned: Tree): void {
	const ap = join(dir, "APPEND_SYSTEM.md");
	if (existsSync(ap)) {
		const cur = readFileSync(ap, "utf8");
		const re = new RegExp(`\\n*${BEGIN}[\\s\\S]*?${END}\\n?`, "g");
		const next = cur.replace(re, "\n").replace(/\n{3,}/g, "\n\n");
		if (next !== cur) {
			if (next.trim()) writeFileSync(ap, next.replace(/^\n+/, ""));
			else unlinkSync(ap);
		}
	}
	const skillDirs = new Set<string>();
	for (const rel of Object.keys(owned)) {
		if (rel === "APPEND_SYSTEM.md") continue;
		const m = /^skills\/([^/]+)\//.exec(rel);
		if (m) skillDirs.add(m[1]);
		else rmrf(join(dir, rel));
	}
	for (const s of skillDirs) rmrf(join(dir, "skills", s));
}

/** Add an overlay exactly as a real install would: APPEND_SYSTEM.md gets a marked block. */
export function applyOverlay(dir: string, overlay: Tree): void {
	for (const [rel, text] of Object.entries(overlay)) {
		if (rel === "APPEND_SYSTEM.md") {
			if (!text.trim()) continue;
			const p = join(dir, rel);
			const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
			writeFileSync(p, `${cur.trim() ? `${cur.trimEnd()}\n\n` : ""}${BEGIN}\n${text.trim()}\n${END}\n`);
		} else {
			if (existsSync(join(dir, rel))) throw new Error(`overlay would overwrite an existing file: ${rel}`);
			writeTree({ [rel]: text }, dir);
		}
	}
}

/** One frozen copy of the user's real config per job, minus sessions, credentials and our own overlay. */
export async function snapshot(realDir: string, dst: string, owned: Tree): Promise<void> {
	if (existsSync(join(dst, ".complete"))) return;
	rmrf(dst);
	mkdirp(dst);
	for (const name of readdirSync(realDir)) {
		if (SKIP(name)) continue;
		const src = join(realDir, name);
		const lst = lstatSync(src);
		if (lst.isSymbolicLink() || lst.isFile()) cpSync(src, join(dst, name), { verbatimSymlinks: true });
		else await cloneDir(src, join(dst, name), false);
	}
	stripOwned(dst, owned);
	writeFileSync(join(dst, ".complete"), new Date().toISOString());
}

export interface Route {
	provider: string;
	baseUrl: string;
}

/** Point every provider base URL in this copy's models.json at the limiter. */
export function routeModels(dir: string, runId: string, limiter: Limiter, extra: Route[]): void {
	const p = join(dir, "models.json");
	let cfg: { providers?: Record<string, { baseUrl?: string; models?: Array<{ baseUrl?: string }> }> } = {};
	if (existsSync(p)) cfg = JSON.parse(readFileSync(p, "utf8"));
	cfg.providers ??= {};
	for (const [prov, pc] of Object.entries(cfg.providers)) {
		if (pc.baseUrl) pc.baseUrl = limiter.baseUrlFor(runId, prov, pc.baseUrl);
		for (const m of pc.models ?? []) if (m.baseUrl) m.baseUrl = limiter.baseUrlFor(runId, prov, m.baseUrl);
	}
	for (const r of extra) {
		const pc = (cfg.providers[r.provider] ??= {});
		if (!pc.baseUrl) pc.baseUrl = limiter.baseUrlFor(runId, r.provider, r.baseUrl);
	}
	if (existsSync(p)) unlinkSync(p); // the copy may be a reflink/hardlink: never write through
	writeFileSync(p, JSON.stringify(cfg, null, 1));
}

/** The user's real pi + one overlay, for one worker run. */
export async function makeProbeAgent(
	snap: string,
	dst: string,
	realDir: string,
	overlay: Tree,
	route: (dir: string) => void,
): Promise<void> {
	rmrf(dst);
	await cloneDir(snap, dst, true);
	rmrf(join(dst, ".complete"));
	// Top-level files (settings.json, models.json, APPEND_SYSTEM.md, ...) may be rewritten by
	// pi or by us: break any hardlink to the snapshot so one run cannot affect the next.
	for (const f of readdirSync(dst)) {
		const p = join(dst, f);
		const st = lstatSync(p);
		if (st.isFile() && st.nlink > 1) {
			const text = readFileSync(p);
			unlinkSync(p);
			writeFileSync(p, text);
		}
	}
	if (existsSync(join(realDir, "auth.json"))) symlinkSync(join(realDir, "auth.json"), join(dst, "auth.json"));
	absolutizeLocalPaths(dst, realDir);
	applyOverlay(dst, overlay);
	route(dst);
}

/** Editors are the improver, not the subject: a minimal config with only the improver model. */
export function makeEditorAgent(dst: string, realDir: string, model: string, route: (dir: string) => void): void {
	rmrf(dst);
	mkdirp(dst);
	if (existsSync(join(realDir, "models.json"))) cpSync(join(realDir, "models.json"), join(dst, "models.json"));
	if (existsSync(join(realDir, "auth.json"))) symlinkSync(join(realDir, "auth.json"), join(dst, "auth.json"));
	const [provider, ...rest] = model.split("/");
	writeJson(join(dst, "settings.json"), { defaultProvider: provider, defaultModel: rest.join("/") });
	route(dst);
}

/** Content hash of the real config (minus sessions and our state), to show runs never wrote to it. */
export function configHash(realDir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const rel = relative(realDir, p).split(sep).join("/");
			if (rel === "sessions" || rel === STATE_DIR_NAME || rel === "npm" || rel === "cache" || rel === "tmp" || rel === "models-store.json") continue; // pi-managed caches
			const st = lstatSync(p);
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) walk(p);
			else if (st.isFile() && statSync(p).size < 50_000_000) out[rel] = sha256(readFileSync(p)).slice(0, 16);
		}
	};
	walk(realDir);
	return out;
}

/**
 * settings.json may list local packages/extensions by a path relative to the settings file.
 * In a copy that path points somewhere else, so make it absolute against the real dir.
 */
export function absolutizeLocalPaths(dir: string, realDir: string): void {
	const p = join(dir, "settings.json");
	if (!existsSync(p)) return;
	const s = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
	let changed = false;
	const fix = (v: unknown): unknown => {
		if (typeof v === "string" && (v.startsWith("./") || v.startsWith("../"))) {
			changed = true;
			return resolvePath(realDir, v);
		}
		if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { source?: unknown }).source === "string")
			return { ...(v as object), source: fix((v as { source: string }).source) };
		return v;
	};
	for (const k of ["packages", "extensions", "skills", "prompts", "themes"]) if (Array.isArray(s[k])) s[k] = (s[k] as unknown[]).map(fix);
	if (changed) {
		unlinkSync(p);
		writeFileSync(p, JSON.stringify(s, null, 2));
	}
}
