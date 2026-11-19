import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./util.ts";

/**
 * The models this user actually uses, best first: their default model, their scoped
 * models, then the models that answered most in their recent sessions.
 */
export function familiarModels(agentDir: string, scoped: string[], recentFiles = 30): string[] {
	const out: string[] = [];
	const add = (m: string | undefined) => {
		if (m && !out.includes(m)) out.push(m);
	};
	const s = readJson<{ defaultProvider?: string; defaultModel?: string }>(join(agentDir, "settings.json"), {});
	if (s.defaultProvider && s.defaultModel) add(`${s.defaultProvider}/${s.defaultModel}`);
	for (const m of scoped) add(m);
	const counts = new Map<string, number>();
	const root = join(agentDir, "sessions");
	if (existsSync(root)) {
		const files: Array<{ f: string; t: number }> = [];
		for (const d of readdirSync(root)) {
			const dd = join(root, d);
			if (!statSync(dd).isDirectory()) continue;
			for (const f of readdirSync(dd)) if (f.endsWith(".jsonl")) files.push({ f: join(dd, f), t: statSync(join(dd, f)).mtimeMs });
		}
		for (const { f } of files.sort((a, b) => b.t - a.t).slice(0, recentFiles)) {
			for (const line of readFileSync(f, "utf8").split("\n")) {
				if (!line.includes('"assistant"')) continue;
				try {
					const m = JSON.parse(line).message as { role?: string; provider?: string; model?: string } | undefined;
					if (m?.role === "assistant" && m.provider && m.model) counts.set(`${m.provider}/${m.model}`, (counts.get(`${m.provider}/${m.model}`) ?? 0) + 1);
				} catch {
					/* partial line */
				}
			}
		}
	}
	for (const [m] of [...counts].sort((a, b) => b[1] - a[1])) add(m);
	return out;
}

/** Models whose "provider/id" contains every word of the query (case-insensitive). */
export function searchModels(available: string[], query: string): string[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const hits = available.filter((m) => words.every((w) => m.toLowerCase().includes(w)));
	const exact = hits.find((m) => m.toLowerCase() === query.trim().toLowerCase());
	return exact ? [exact] : hits;
}
