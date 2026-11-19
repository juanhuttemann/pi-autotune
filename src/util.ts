import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function mkdirp(dir: string): string {
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function rmrf(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

export function writeText(path: string, text: string): void {
	mkdirp(dirname(path));
	writeFileSync(path, text);
}

export function writeJson(path: string, value: unknown): void {
	writeText(path, `${JSON.stringify(value, null, 1)}\n`);
}

export function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Keep head and tail of a long text; the middle is replaced by a marker. */
export function trunc(s: string, n: number): string {
	if (s.length <= n) return s;
	const half = Math.floor(n / 2);
	return `${s.slice(0, half)}\n...[${s.length - n} chars truncated]...\n${s.slice(-half)}`;
}

export function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Counting semaphore. FIFO, so waiters are served in arrival order. */
export class Semaphore {
	private queue: Array<() => void> = [];
	private active = 0;
	private limit: number;
	constructor(limit: number) {
		this.limit = limit;
		if (!(limit >= 1)) throw new Error(`concurrency must be >= 1, got ${limit}`);
	}
	async acquire(): Promise<() => void> {
		if (this.active < this.limit) {
			this.active++;
		} else {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.queue.shift();
			if (next) next();
			else this.active--;
		};
	}
	async with<T>(fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}
	get pending(): number {
		return this.queue.length;
	}
}

export interface ProcResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Run a program without a shell. stdin is /dev/null (pi reads a non-TTY stdin as extra
 * prompt input and would wait forever on an inherited pipe). On timeout or abort the whole
 * process group is killed, so children (subagents, test runners) die too.
 */
export function runProc(
	cmd: string,
	args: string[],
	opts: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		timeoutMs?: number;
		signal?: AbortSignal;
		stdoutFile?: (chunk: Buffer) => void;
		maxCapture?: number;
	} = {},
): Promise<ProcResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const max = opts.maxCapture ?? 8 * 1024 * 1024;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let finished = false;
		let grace: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			if (!child.pid) return;
			// The whole tree: the process group, plus descendants that started their own
			// session (setsid) and so escaped the group. Collected before anything dies, so
			// none of them is re-parented out of reach.
			for (const pid of [...descendants(child.pid), child.pid]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* already gone */
			}
			// Never wait on a pipe some stray process still holds open.
			grace = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				done(null);
			}, 3000);
		};
		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					kill();
				}, opts.timeoutMs)
			: undefined;
		const onAbort = () => kill();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (c: Buffer) => {
			opts.stdoutFile?.(c);
			if (stdout.length < max) stdout += c.toString();
		});
		child.stderr.on("data", (c: Buffer) => {
			if (stderr.length < max) stderr += c.toString();
		});
		const done = (code: number | null) => {
			if (finished) return;
			finished = true;
			if (grace) clearTimeout(grace);
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut });
		};
		child.on("error", (e) => {
			stderr += String(e);
			done(null);
		});
		child.on("close", (code) => done(code));
	});
}

/** All descendant pids of `root` (Linux /proc; elsewhere only the process group is used). */
function descendants(root: number): number[] {
	if (process.platform !== "linux") return [];
	const kids = new Map<number, number[]>();
	try {
		for (const d of readdirSync("/proc")) {
			if (!/^\d+$/.test(d)) continue;
			try {
				const stat = readFileSync(`/proc/${d}/stat`, "utf8");
				const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
				kids.set(ppid, [...(kids.get(ppid) ?? []), Number(d)]);
			} catch {
				/* exited meanwhile */
			}
		}
	} catch {
		return [];
	}
	const out: number[] = [];
	const stack = [root];
	while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) (out.push(k), stack.push(k));
	return out;
}

export function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
