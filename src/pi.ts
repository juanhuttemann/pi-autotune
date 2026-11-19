import { createWriteStream, readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseEvents, type RunStats } from "./events.ts";
import { runProc, writeText } from "./util.ts";

/**
 * How to start pi again from inside pi. Upstream pi runs as `node .../cli.js`; compiled
 * builds are a single executable. `override` is a configured command, e.g. ["pi"].
 */
export function piCommand(override?: string[]): string[] {
	if (override?.length) return override;
	const exe = process.execPath;
	const script = process.argv[1];
	if (/^(node|bun|deno)(\.exe)?$/i.test(basename(exe)) && script && !script.startsWith("/$bunfs")) return [exe, script];
	return [exe];
}

export const CHILD_ENV = "AUTOTUNE_CHILD";

export interface PiRun {
	agentDir: string;
	cwd: string;
	prompt: string;
	model: string; // provider/model
	eventsPath: string;
	timeoutSec: number;
	flags?: string[];
	signal?: AbortSignal;
	command?: string[];
}

export interface PiResult extends RunStats {
	rc: number | "timeout" | null;
	secs: number;
	stderrTail: string;
}

export async function runPi(r: PiRun): Promise<PiResult> {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("PI_")) env[k] = v;
	env.PI_CODING_AGENT_DIR = r.agentDir;
	env.PI_SKIP_VERSION_CHECK = "1";
	env[CHILD_ENV] = "1"; // pi-autotune stays inert inside the pi processes it starts
	const [cmd, ...pre] = piCommand(r.command);
	const slash = r.model.indexOf("/");
	const args = [
		...pre,
		"--mode",
		"json",
		"--no-session",
		...(r.flags ?? []),
		"--provider",
		r.model.slice(0, slash),
		"--model",
		r.model.slice(slash + 1),
		"--",
		r.prompt,
	];
	const out = createWriteStream(r.eventsPath);
	const t0 = Date.now();
	const p = await runProc(cmd, args, {
		cwd: r.cwd,
		env,
		timeoutMs: r.timeoutSec * 1000,
		signal: r.signal,
		stdoutFile: (c) => out.write(c),
		maxCapture: 1,
	});
	await new Promise<void>((resolve) => out.end(resolve));
	const secs = Math.round((Date.now() - t0) / 100) / 10;
	writeText(r.eventsPath.replace(/\.jsonl$/, ".stderr"), p.stderr);
	const stats = parseEvents(readFileSync(r.eventsPath, "utf8"));
	return { ...stats, rc: p.timedOut ? "timeout" : p.code, secs, stderrTail: p.stderr.slice(-2000) };
}
