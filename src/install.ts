import { copyFileSync, existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyOverlay, stripOwned } from "./agentdir.ts";
import { type Installed, loadInstalled, type Paths } from "./config.ts";
import type { Tree } from "./tree.ts";
import { mkdirp, readJson, rmrf, stamp, writeJson } from "./util.ts";

interface BackupManifest {
	created: string;
	/** rel path -> whether it existed before the change (and so has a copy under files/). */
	files: Record<string, boolean>;
	previous: Installed | null;
}

function touchedPaths(...trees: Tree[]): string[] {
	const s = new Set<string>(["APPEND_SYSTEM.md"]);
	for (const t of trees) for (const k of Object.keys(t)) s.add(k);
	return [...s].sort();
}

/** Replace what was applied before with `overlay`. Everything touched is backed up first. */
export function install(p: Paths, overlay: Tree, job: string): Installed {
	const prev = loadInstalled(p);
	let backup = join(p.state, "backups", stamp());
	for (let i = 2; existsSync(backup); i++) backup = join(p.state, "backups", `${stamp()}-${i}`);
	const manifest: BackupManifest = { created: new Date().toISOString(), files: {}, previous: prev };
	for (const rel of touchedPaths(prev?.overlay ?? {}, overlay)) {
		const src = join(p.agentDir, rel);
		manifest.files[rel] = existsSync(src);
		if (manifest.files[rel]) {
			mkdirp(dirname(join(backup, "files", rel)));
			copyFileSync(src, join(backup, "files", rel));
		}
	}
	writeJson(join(backup, "manifest.json"), manifest);
	stripOwned(p.agentDir, prev?.overlay ?? {});
	applyOverlay(p.agentDir, overlay);
	const inst: Installed = { overlay, installedAt: new Date().toISOString(), job, backup };
	writeJson(join(p.state, "installed.json"), inst);
	return inst;
}

/** Put every file back exactly as it was before the last install. */
export function undo(p: Paths): string {
	const cur = loadInstalled(p);
	if (!cur) return "Nothing to undo: no change has been applied yet.";
	const m = readJson<BackupManifest | null>(join(cur.backup, "manifest.json"), null);
	if (!m) return `Backup not found at ${cur.backup}; nothing changed.`;
	stripOwned(p.agentDir, cur.overlay);
	// APPEND_SYSTEM.md may hold the user's own text, edited since the install: only our marked
	// block is swapped back, never the whole file.
	const prevAlways = m.previous?.overlay["APPEND_SYSTEM.md"];
	if (prevAlways?.trim()) applyOverlay(p.agentDir, { "APPEND_SYSTEM.md": prevAlways });
	for (const [rel, existed] of Object.entries(m.files)) {
		if (rel === "APPEND_SYSTEM.md") continue;
		const dst = join(p.agentDir, rel);
		if (existed) {
			mkdirp(dirname(dst));
			copyFileSync(join(cur.backup, "files", rel), dst);
		} else if (existsSync(dst)) unlinkSync(dst);
	}
	for (const rel of Object.keys(m.files)) pruneEmpty(p.agentDir, dirname(rel));
	if (m.previous) writeJson(join(p.state, "installed.json"), m.previous);
	else rmrf(join(p.state, "installed.json"));
	return `Restored ${Object.keys(m.files).length} path(s) from ${cur.backup}.`;
}

function pruneEmpty(root: string, rel: string): void {
	while (rel && rel !== ".") {
		const d = join(root, rel);
		if (!existsSync(d) || readdirSync(d).length) return;
		rmdirSync(d);
		rel = dirname(rel);
	}
}
