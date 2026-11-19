import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Semaphore } from "./util.ts";

/*
 * Per-provider request limiter. Never assume how many requests a model server can take:
 * a local GPU server may serve one stream at a time, and a single pi run can fan out
 * through subagents. Every pi process this tool starts gets a models.json whose provider
 * base URLs point here; the cap therefore holds for every request those processes make
 * (the run itself, its subagents, nested pi), and a run that is idle while its subagent
 * works holds no slot, so there is no self-deadlock.
 *
 * URL layout: /r/<runId>/<provider>/<base64url(upstream base URL)>/<rest of the path>
 */

export interface RunQueueStats {
	requests: number;
	queueMs: number;
	maxQueueMs: number;
}

export class Limiter {
	private server?: http.Server;
	private port = 0;
	private sems = new Map<string, Semaphore>();
	private runs = new Map<string, RunQueueStats>();

	private limitFor: (provider: string) => number;
	constructor(limitFor: (provider: string) => number) {
		this.limitFor = limitFor;
	}

	async start(): Promise<void> {
		if (this.server) return;
		this.server = http.createServer((req, res) => void this.handle(req, res));
		this.server.keepAliveTimeout = 5000;
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.port = (this.server.address() as AddressInfo).port;
	}

	async stop(): Promise<void> {
		const s = this.server;
		this.server = undefined;
		if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
		s?.closeAllConnections?.();
	}

	baseUrlFor(runId: string, provider: string, upstream: string): string {
		if (!this.server) throw new Error("limiter not started");
		const enc = Buffer.from(upstream.replace(/\/+$/, "")).toString("base64url");
		return `http://127.0.0.1:${this.port}/r/${encodeURIComponent(runId)}/${encodeURIComponent(provider)}/${enc}`;
	}

	stats(runId: string): RunQueueStats {
		return this.runs.get(runId) ?? { requests: 0, queueMs: 0, maxQueueMs: 0 };
	}

	private sem(provider: string): Semaphore {
		let s = this.sems.get(provider);
		if (!s) {
			s = new Semaphore(Math.max(1, this.limitFor(provider)));
			this.sems.set(provider, s);
		}
		return s;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const m = /^\/r\/([^/]+)\/([^/]+)\/([A-Za-z0-9_-]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? "");
		if (!m) {
			res.writeHead(404).end("pi-autotune limiter: unknown route");
			return;
		}
		const runId = decodeURIComponent(m[1]);
		const provider = decodeURIComponent(m[2]);
		let upstream: URL;
		try {
			upstream = new URL(Buffer.from(m[3], "base64url").toString() + (m[4] ?? "") + (m[5] ?? ""));
		} catch {
			res.writeHead(400).end("pi-autotune limiter: bad upstream");
			return;
		}
		// Only model calls are limited; GETs (model listings, health) pass straight through.
		const limited = req.method !== "GET" && req.method !== "HEAD";
		const t0 = Date.now();
		const release = limited ? await this.sem(provider).acquire() : () => {};
		const waited = Date.now() - t0;
		if (limited) {
			const st = this.runs.get(runId) ?? { requests: 0, queueMs: 0, maxQueueMs: 0 };
			st.requests++;
			st.queueMs += waited;
			st.maxQueueMs = Math.max(st.maxQueueMs, waited);
			this.runs.set(runId, st);
		}
		let done = false;
		const finish = () => {
			if (!done) {
				done = true;
				release();
			}
		};
		const headers = { ...req.headers, host: upstream.host };
		const lib = upstream.protocol === "https:" ? https : http;
		const up = lib.request(upstream, { method: req.method, headers }, (ur) => {
			res.writeHead(ur.statusCode ?? 502, ur.headers);
			ur.pipe(res);
			ur.on("end", finish);
			ur.on("error", finish);
		});
		up.on("error", (e) => {
			finish();
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end(`pi-autotune limiter: upstream error: ${e.message}`);
		});
		res.on("close", () => {
			finish();
			up.destroy();
		});
		req.pipe(up);
	}
}

/** Hosts that are almost certainly one machine's GPU: default them to one request at a time. */
export function looksLocal(baseUrl: string): boolean {
	try {
		const h = new URL(baseUrl).hostname;
		return (
			h === "localhost" ||
			h.endsWith(".local") ||
			h.endsWith(".lan") ||
			h.endsWith(".internal") ||
			/^127\./.test(h) ||
			/^10\./.test(h) ||
			/^192\.168\./.test(h) ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
			/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
			h === "::1" ||
			h === "[::1]" ||
			!h.includes(".")
		);
	} catch {
		return true;
	}
}
