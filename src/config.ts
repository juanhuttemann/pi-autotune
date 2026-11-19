import { homedir } from "node:os";
import { join } from "node:path";
import { STATE_DIR_NAME } from "./agentdir.ts";
import type { Tree } from "./tree.ts";
import { readJson, writeJson } from "./util.ts";

export interface Config {
	/** The model being improved (provider/model). Default: the session's current model. */
	worker?: string;
	/** The model that edits the harness (provider/model). Asked for on first use. */
	improver?: string;
	/** Max in-flight model requests per provider. Asked for on first use of each provider. */
	concurrency: Record<string, number>;
	workerTimeoutSec: number;
	editorTimeoutSec: number;
	/** Hard cap on the always-on text (sent with every request). */
	alwaysOnMax: number;
	/** Runs per arm on each --verify task. */
	verifyRuns: number;
	/** Command used to start pi (default: the running pi). */
	piCommand?: string[];
}

export const DEFAULTS: Config = {
	concurrency: {},
	workerTimeoutSec: 900,
	editorTimeoutSec: 1200,
	alwaysOnMax: 4000,
	verifyRuns: 5,
};

export interface Paths {
	agentDir: string;
	state: string; // small, durable: config, library, installed overlay, backups, reports
	work: string; // big, disposable: run folders, config copies
}

export function paths(agentDir: string): Paths {
	const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return { agentDir, state: join(agentDir, STATE_DIR_NAME), work: join(cache, "pi-autotune") };
}

export function loadConfig(p: Paths): Config {
	return { ...DEFAULTS, ...readJson<Partial<Config>>(join(p.state, "config.json"), {}) };
}

export function saveConfig(p: Paths, c: Config): void {
	writeJson(join(p.state, "config.json"), c);
}

/** What /learn applied last time (the part of the harness it owns and may replace). */
export interface Installed {
	overlay: Tree;
	installedAt: string;
	job: string;
	backup: string;
}

export function loadInstalled(p: Paths): Installed | null {
	return readJson<Installed | null>(join(p.state, "installed.json"), null);
}
